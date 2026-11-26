import { z } from 'zod';
import { withTenant, type Tx } from '@/lib/db';
import { AppError, invalid, notFound } from '@/lib/errors';
import { authorize, type Actor } from '@/lib/actor';
import { audit, emit } from '@/lib/events';
import { requireModule, type Tenant } from './tenants';

/**
 * SE-001/006: clinical content of a *restricted* chart is visible only to staff with a care relationship,
 * to medical records / owner, or under a time-limited emergency grant. Unrestricted charts follow role permissions.
 */
export async function assertChartAccess(tx: Tx, actor: Actor, tenant: Tenant, patientId: string) {
  if (!tenant.settings.modules.emergencyAccess) return;
  const p = await tx.maybe<{ restricted: boolean }>(`SELECT restricted FROM patient WHERE id = $1`, [patientId]);
  if (!p) throw notFound('Patient');
  if (!p.restricted) return;
  if (actor.kind === 'system') return;
  if (actor.kind !== 'staff') throw new AppError('FORBIDDEN', 'This record is restricted');
  if (['owner', 'records'].includes(actor.role)) return;
  const care = actor.clinicianId ? await tx.maybe(
    `SELECT 1 FROM encounter WHERE patient_id = $1 AND lead_clinician_id = $2 AND (status = 'open' OR started_at > now() - interval '90 days')
     UNION ALL SELECT 1 FROM queue_ticket WHERE patient_id = $1 AND clinician_id = $2 AND service_date >= current_date - 1
     UNION ALL SELECT 1 FROM admission WHERE patient_id = $1 AND admitting_clinician_id = $2 AND status = 'admitted' LIMIT 1`,
    [patientId, actor.clinicianId]) : null;
  if (care) return;
  if (actor.role === 'nurse') {
    const ward = await tx.maybe(`SELECT 1 FROM admission WHERE patient_id = $1 AND status = 'admitted'`, [patientId]);
    if (ward) return;
  }
  const grant = await tx.maybe(`SELECT 1 FROM emergency_access WHERE staff_id = $1 AND patient_id = $2 AND expires_at > now()`, [actor.staffId, patientId]);
  if (grant) return;
  throw new AppError('FORBIDDEN', 'This record is restricted. Use emergency access only if you need it for immediate care.', { needs: 'emergency_access', patientId });
}

export async function setRestricted(actor: Actor, tenant: Tenant, patientId: string, restricted: boolean, reason: string) {
  requireModule(tenant, 'emergencyAccess');
  authorize(actor, 'emergency.review');
  if (!reason?.trim()) throw invalid('Give the reason for restricting or releasing this record');
  return withTenant(tenant.id, async (tx) => {
    await tx.exec(`UPDATE patient SET restricted = $2, restricted_reason = $3, version = version + 1 WHERE id = $1`, [patientId, restricted, restricted ? reason : null]);
    await audit(tx, actor, restricted ? 'patient.restricted' : 'patient.unrestricted', 'patient', patientId, { patientId, reason });
  });
}

export const emergencyInput = z.object({ patientId: z.uuid(), reason: z.string().trim().min(10, 'Describe the immediate care need (at least 10 characters)') });

/** SE-007: the grant and its audit event commit together; the grant expires on its own. */
export async function requestEmergencyAccess(actor: Actor, tenant: Tenant, input: z.input<typeof emergencyInput>) {
  requireModule(tenant, 'emergencyAccess');
  const p = emergencyInput.parse(input);
  if (actor.kind !== 'staff' || !['doctor', 'nurse', 'owner'].includes(actor.role)) throw new AppError('FORBIDDEN', 'Only clinical staff can use emergency access');
  return withTenant(tenant.id, async (tx) => {
    const g = await tx.one<{ id: string; expires_at: Date }>(
      `INSERT INTO emergency_access (tenant_id, staff_id, patient_id, reason, expires_at)
       VALUES (app_tenant_id(), $1, $2, $3, now() + make_interval(mins => $4)) RETURNING id, expires_at`,
      [actor.staffId, p.patientId, p.reason, tenant.settings.emergencyAccessMinutes]);
    await audit(tx, actor, 'emergency_access.granted', 'patient', p.patientId, { patientId: p.patientId, reason: p.reason, data: { grantId: g.id } });
    await emit(tx, 'emergency_access.granted', 'patient', p.patientId, { grantId: g.id, staffId: actor.staffId, expiresAt: g.expires_at });
    return g;
  });
}

export async function emergencyReviewQueue(actor: Actor, tenant: Tenant) {
  authorize(actor, 'emergency.review');
  return withTenant(tenant.id, (tx) => tx.many<{ id: string; reason: string; granted_at: Date; expires_at: Date; staff_name: string; staff_role: string; full_name: string; uhid: string; patient_id: string; views: number }>(
    `SELECT e.id, e.reason, e.granted_at, e.expires_at, s.full_name AS staff_name, s.role AS staff_role, p.full_name, p.uhid, p.id AS patient_id,
            (SELECT count(*)::int FROM audit_event a WHERE a.actor_id = e.staff_id::text AND a.patient_id = e.patient_id AND a.at BETWEEN e.granted_at AND e.expires_at) AS views
       FROM emergency_access e JOIN staff s ON s.id = e.staff_id JOIN patient p ON p.id = e.patient_id
      WHERE e.reviewed_at IS NULL ORDER BY e.granted_at`));
}

export async function reviewEmergencyAccess(actor: Actor, tenant: Tenant, grantId: string, outcome: 'appropriate' | 'inappropriate' | 'needs_follow_up', note?: string) {
  authorize(actor, 'emergency.review');
  return withTenant(tenant.id, async (tx) => {
    const g = await tx.one<{ staff_id: string; patient_id: string }>(`SELECT staff_id, patient_id FROM emergency_access WHERE id = $1 FOR UPDATE`, [grantId]);
    if (actor.kind === 'staff' && g.staff_id === actor.staffId && !tenant.settings.soloPractice) throw new AppError('RULE_VIOLATION', 'Someone else must review your own emergency access');
    await tx.exec(`UPDATE emergency_access SET reviewed_by = $2, reviewed_at = now(), review_outcome = $3, review_note = $4,
                     expires_at = GREATEST(granted_at + interval '1 millisecond', LEAST(expires_at, now())) WHERE id = $1`,
      [grantId, actor.kind === 'staff' ? actor.staffId : null, outcome, note ?? null]);
    await audit(tx, actor, 'emergency_access.reviewed', 'emergency_access', grantId, { patientId: g.patient_id, reason: note, data: { outcome } });
  });
}
