import { withTenant } from '@/lib/db';
import { AppError, invalid, notFound, rule } from '@/lib/errors';
import { authorize, staffId, type Actor } from '@/lib/actor';
import { audit } from '@/lib/events';
import type { Tenant } from './tenants';
import { assertChartAccess } from './access';

/**
 * ABHA number: 14 digits, commonly written 12-3456-7890-1234. Only the length and digits are checked here — no public,
 * authoritative check-digit rule has been confirmed, so none is applied. ABHA address: "name@abdm" (production) or
 * "name@sbx" (sandbox).
 */
export function normaliseAbhaNumber(v: string): string | null {
  const d = v.replace(/[\s-]/g, '');
  return /^\d{14}$/.test(d) ? d : null;
}
export function formatAbhaNumber(d: string) { return `${d.slice(0, 2)}-${d.slice(2, 6)}-${d.slice(6, 10)}-${d.slice(10)}`; }
export function maskAbhaNumber(d: string) { return `XX-XXXX-XXXX-${d.slice(10)}`; }
export function normaliseAbhaAddress(v: string): string | null {
  const a = v.trim().toLowerCase();
  return /^[a-z0-9._]{3,40}@[a-z]{2,10}$/.test(a) ? a : null;
}

export async function recordAbha(actor: Actor, tenant: Tenant, patientId: string, input: { abhaNumber?: string; abhaAddress?: string; verification: 'self_declared' | 'card_seen'; consent: boolean; consentNote?: string }) {
  authorize(actor, 'patient.write');
  const num = input.abhaNumber?.trim() ? normaliseAbhaNumber(input.abhaNumber) : null;
  const addr = input.abhaAddress?.trim() ? normaliseAbhaAddress(input.abhaAddress) : null;
  if (input.abhaNumber?.trim() && !num) throw invalid('An ABHA number has 14 digits (e.g. 12-3456-7890-1234)');
  if (input.abhaAddress?.trim() && !addr) throw invalid('An ABHA address looks like name@abdm');
  if (!num && !addr) throw invalid('Enter the ABHA number or ABHA address');
  if (!input.consent) throw invalid('Record the patient’s consent to store and use their ABHA');
  if (!['self_declared', 'card_seen'].includes(input.verification)) throw invalid('Choose how the ABHA was checked');
  return withTenant(tenant.id, async (tx) => {
    const p = await tx.maybe<{ status: string }>(`SELECT status FROM patient WHERE id = $1`, [patientId]);
    if (!p || p.status === 'merged') throw notFound('Patient');
    await assertChartAccess(tx, actor, tenant, patientId);
    const other = await tx.maybe<{ uhid: string }>(
      `SELECT pt.uhid FROM patient_abha a JOIN patient pt ON pt.id = a.patient_id WHERE a.status = 'active' AND a.patient_id <> $1 AND (a.abha_number = $2 OR a.abha_address = $3)`, [patientId, num, addr]);
    if (other) throw rule(`This ABHA is already recorded on chart ${other.uhid}. If they are the same person, merge the charts; otherwise check the number.`);
    await tx.exec(`UPDATE patient_abha SET status='removed', removed_by=$2, removed_at=now(), removed_reason='Replaced' WHERE patient_id=$1 AND status='active'`, [patientId, staffId(actor)]);
    const { id } = await tx.one<{ id: string }>(
      `INSERT INTO patient_abha (tenant_id, patient_id, abha_number, abha_address, verification, consent_given, consent_note, recorded_by)
       VALUES (app_tenant_id(), $1,$2,$3,$4,true,$5,$6) RETURNING id`, [patientId, num, addr, input.verification, input.consentNote?.trim() || null, staffId(actor)]);
    await audit(tx, actor, 'patient.abha_recorded', 'patient', patientId, { patientId, data: { verification: input.verification, last4: num?.slice(10) ?? null, address: addr } });
    return id;
  });
}

export async function removeAbha(actor: Actor, tenant: Tenant, patientId: string, reason: string) {
  authorize(actor, 'patient.write');
  if (!reason?.trim()) throw invalid('Give a reason (e.g. patient withdrew consent)');
  return withTenant(tenant.id, async (tx) => {
    const n = await tx.exec(`UPDATE patient_abha SET status='removed', removed_by=$2, removed_at=now(), removed_reason=$3 WHERE patient_id=$1 AND status='active'`, [patientId, staffId(actor), reason.trim()]);
    if (!n) throw notFound('ABHA record');
    await audit(tx, actor, 'patient.abha_removed', 'patient', patientId, { patientId, reason });
  });
}

export async function patientAbha(actor: Actor, tenant: Tenant, patientId: string) {
  authorize(actor, 'patient.read');
  return withTenant(tenant.id, (tx) => tx.maybe<{ abha_number: string | null; abha_address: string | null; verification: string; recorded_at: Date; consent_note: string | null }>(
    `SELECT abha_number, abha_address, verification, recorded_at, consent_note FROM patient_abha WHERE patient_id = $1 AND status = 'active'`, [patientId]));
}

export { AppError };
