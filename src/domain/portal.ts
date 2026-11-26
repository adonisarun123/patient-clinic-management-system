import { z } from 'zod';
import { randomInt } from 'node:crypto';
import { withTenant, type Tx } from '@/lib/db';
import { AppError, invalid, notFound, rule } from '@/lib/errors';
import { authorize, staffId, type Actor } from '@/lib/actor';
import { audit, emit } from '@/lib/events';
import { randomToken, sha256, hmacSha256, safeEqual } from '@/lib/crypto';
import { normalizePhone } from '@/lib/identity';
import { sendOtpSms } from '@/lib/sms';
import { requireModule, type Tenant } from './tenants';

const OTP_MINUTES = 5;
const OTP_MAX_ATTEMPTS = 5;
const SESSION_HOURS = 2;

const otpHash = (tenantId: string, phone: string, code: string) =>
  hmacSha256(process.env.APP_ENCRYPTION_KEY ?? 'dev-otp-pepper', `${tenantId}:${phone}:${code}`);

/**
 * OP-010: a one-time code proves control of a phone number — nothing more. The response is identical whether or not the
 * number is known, so the portal never confirms that a person is a patient here.
 */
export async function requestOtp(tenant: Tenant, phoneRaw: string, ip: string) {
  requireModule(tenant, 'portal');
  const phone = normalizePhone(phoneRaw);
  if (!phone) throw invalid('Enter a valid mobile number');
  return withTenant(tenant.id, async (tx) => {
    const recent = await tx.one<{ n: number }>(
      `SELECT count(*)::int AS n FROM portal_otp WHERE phone_e164 = $1 AND created_at > now() - interval '15 minutes'`, [phone]);
    if (recent.n >= 3) throw new AppError('RATE_LIMITED', 'Too many codes requested. Try again in 15 minutes.');
    const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
    const sms = await sendOtpSms(tx, phone, code, tenant.name);
    await tx.exec(`INSERT INTO portal_otp (tenant_id, phone_e164, code_hash, expires_at, delivery) VALUES (app_tenant_id(), $1, $2, now() + make_interval(mins => $3), $4)`,
      [phone, otpHash(tenant.id, phone, code), OTP_MINUTES, `${sms.driver}:${sms.delivered ? 'sent' : sms.detail}`]);
    await tx.exec(`INSERT INTO audit_event (tenant_id, actor_kind, action, entity_kind, ip, data) VALUES (app_tenant_id(), 'public', 'portal.otp_requested', 'portal_account', $1, $2)`,
      [ip, JSON.stringify({ phone: `…${phone.slice(-4)}`, driver: sms.driver })]);
    if (!sms.delivered) throw new AppError('INTERNAL', 'We could not send the code right now. Please call the clinic.');
    return { sent: true, expiresInMinutes: OTP_MINUTES, devCode: sms.driver === 'dev' && process.env.NODE_ENV !== 'production' ? code : undefined };
  });
}

export async function verifyOtp(tenant: Tenant, phoneRaw: string, code: string, ip: string) {
  requireModule(tenant, 'portal');
  const phone = normalizePhone(phoneRaw);
  if (!phone || !/^\d{6}$/.test(code)) throw new AppError('UNAUTHENTICATED', 'The code is incorrect or has expired');
  return withTenant(tenant.id, async (tx) => {
    const otp = await tx.maybe<{ id: string; code_hash: string; attempts: number }>(
      `SELECT id, code_hash, attempts FROM portal_otp WHERE phone_e164 = $1 AND consumed_at IS NULL AND expires_at > now()
        ORDER BY created_at DESC LIMIT 1 FOR UPDATE`, [phone]);
    if (!otp || otp.attempts >= OTP_MAX_ATTEMPTS) throw new AppError('UNAUTHENTICATED', 'The code is incorrect or has expired');
    if (!safeEqual(otp.code_hash, otpHash(tenant.id, phone, code))) {
      await tx.exec(`UPDATE portal_otp SET attempts = attempts + 1 WHERE id = $1`, [otp.id]);
      return { ok: false as const };
    }
    await tx.exec(`UPDATE portal_otp SET consumed_at = now() WHERE id = $1`, [otp.id]);
    const acct = await tx.one<{ id: string; status: string }>(
      `INSERT INTO portal_account (tenant_id, phone_e164) VALUES (app_tenant_id(), $1)
       ON CONFLICT (tenant_id, phone_e164) DO UPDATE SET last_login_at = now() RETURNING id, status`, [phone]);
    if (acct.status !== 'active') throw new AppError('FORBIDDEN', 'This portal account is locked. Please contact the clinic.');
    const token = randomToken(32);
    await tx.exec(`INSERT INTO portal_session (tenant_id, account_id, token_hash, expires_at) VALUES (app_tenant_id(), $1, $2, now() + make_interval(hours => $3))`,
      [acct.id, sha256(token), SESSION_HOURS]);
    await tx.exec(`INSERT INTO audit_event (tenant_id, actor_kind, actor_id, action, entity_kind, entity_id, ip) VALUES (app_tenant_id(), 'public', $1, 'portal.login', 'portal_account', $2, $3)`,
      [`portal:${acct.id}`, acct.id, ip]);
    return { ok: true as const, token, maxAge: SESSION_HOURS * 3600 };
  }).then((r) => {
    if (!r.ok) throw new AppError('UNAUTHENTICATED', 'The code is incorrect or has expired');
    return r;
  });
}

export type PortalLink = { link_id: string; patient_id: string; full_name: string; uhid: string; relation: string; can_schedule: boolean; can_view_documents: boolean; can_pay: boolean };
export type PortalSession = { accountId: string; phone: string; links: PortalLink[] };

/** Every portal request re-reads the account's live links, so a revocation takes effect at once. */
export async function portalSession(tenant: Tenant, token: string | undefined): Promise<PortalSession | null> {
  if (!tenant.settings.modules.portal || !token) return null;
  return withTenant(tenant.id, async (tx) => {
    const s = await tx.maybe<{ account_id: string; phone_e164: string }>(
      `SELECT s.account_id, a.phone_e164 FROM portal_session s JOIN portal_account a ON a.id = s.account_id
        WHERE s.token_hash = $1 AND s.revoked_at IS NULL AND s.expires_at > now() AND a.status = 'active'`, [sha256(token)]);
    if (!s) return null;
    const links = await tx.many<PortalLink>(
      `SELECT l.id AS link_id, p.id AS patient_id, p.full_name, p.uhid, l.relation, l.can_schedule, l.can_view_documents, l.can_pay
         FROM portal_link l JOIN patient p ON p.id = l.patient_id
        WHERE l.account_id = $1 AND l.revoked_at IS NULL AND (l.valid_until IS NULL OR l.valid_until >= current_date) AND p.status <> 'merged'
        ORDER BY (l.relation = 'self') DESC, p.full_name`, [s.account_id]);
    return { accountId: s.account_id, phone: s.phone_e164, links };
  });
}

export async function portalLogout(tenant: Tenant, token: string) {
  await withTenant(tenant.id, (tx) => tx.exec(`UPDATE portal_session SET revoked_at = now() WHERE token_hash = $1`, [sha256(token)]));
}

/** Server-side check on every portal action (API-001): the account must hold a live link with that permission. */
export function portalCan(s: PortalSession, patientId: string, perm: 'can_schedule' | 'can_view_documents' | 'can_pay') {
  const l = s.links.find((x) => x.patient_id === patientId);
  if (!l || !l[perm]) throw new AppError('NOT_FOUND', 'Not found');
  return l;
}

// ------------------------------------------------------------------ staff side: links (OP-009)
export const linkInput = z.object({
  patientId: z.uuid(), phone: z.string().min(8), relation: z.enum(['self', 'parent', 'guardian', 'spouse', 'child', 'representative']),
  canSchedule: z.boolean().default(true), canViewDocuments: z.boolean().default(true), canPay: z.boolean().default(true),
  evidence: z.string().trim().min(5, 'Record how identity and authority were verified'), validUntil: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
});

export async function grantPortalAccess(actor: Actor, tenant: Tenant, input: z.input<typeof linkInput>) {
  requireModule(tenant, 'portal');
  authorize(actor, 'portal.manage');
  const p = linkInput.parse(input);
  const phone = normalizePhone(p.phone);
  if (!phone) throw invalid('Enter a valid mobile number');
  return withTenant(tenant.id, async (tx) => {
    const acct = await tx.one<{ id: string }>(
      `INSERT INTO portal_account (tenant_id, phone_e164) VALUES (app_tenant_id(), $1) ON CONFLICT (tenant_id, phone_e164) DO UPDATE SET phone_e164 = EXCLUDED.phone_e164 RETURNING id`, [phone]);
    const r = await tx.one<{ id: string }>(
      `INSERT INTO portal_link (tenant_id, account_id, patient_id, relation, can_schedule, can_view_documents, can_pay, evidence, verified_by, valid_until)
       VALUES (app_tenant_id(), $1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
      [acct.id, p.patientId, p.relation, p.canSchedule, p.canViewDocuments, p.canPay, p.evidence, staffId(actor), p.validUntil ?? null]);
    await audit(tx, actor, 'portal.link_granted', 'portal_link', r.id, { patientId: p.patientId, reason: p.evidence, data: { relation: p.relation, phone: `…${phone.slice(-4)}` } });
    return r.id;
  });
}

/** Revocation removes access immediately and ends every portal session of that account. */
export async function revokePortalAccess(actor: Actor, tenant: Tenant, linkId: string, reason: string) {
  authorize(actor, 'portal.manage');
  if (!reason?.trim()) throw invalid('Give a reason');
  return withTenant(tenant.id, async (tx) => {
    const l = await tx.one<{ account_id: string; patient_id: string }>(
      `UPDATE portal_link SET revoked_at = now(), revoked_by = $2, revoke_reason = $3 WHERE id = $1 AND revoked_at IS NULL RETURNING account_id, patient_id`, [linkId, staffId(actor), reason]);
    await tx.exec(`UPDATE portal_session SET revoked_at = now() WHERE account_id = $1 AND revoked_at IS NULL`, [l.account_id]);
    await audit(tx, actor, 'portal.link_revoked', 'portal_link', linkId, { patientId: l.patient_id, reason });
  });
}

export async function patientPortalLinks(actor: Actor, tenant: Tenant, patientId: string) {
  if (!tenant.settings.modules.portal) return [];
  authorize(actor, 'patient.read');
  return withTenant(tenant.id, (tx) => tx.many<{ id: string; phone_e164: string; relation: string; can_schedule: boolean; can_view_documents: boolean; can_pay: boolean; evidence: string; verified_at: Date; verifier: string; valid_until: string | null }>(
    `SELECT l.id, a.phone_e164, l.relation, l.can_schedule, l.can_view_documents, l.can_pay, l.evidence, l.verified_at, s.full_name AS verifier, l.valid_until
       FROM portal_link l JOIN portal_account a ON a.id = l.account_id JOIN staff s ON s.id = l.verified_by
      WHERE l.patient_id = $1 AND l.revoked_at IS NULL ORDER BY l.verified_at`, [patientId]));
}

// ------------------------------------------------------------------ document release (CL-033)
export async function releaseDocument(actor: Actor, tenant: Tenant, d: { patientId: string; kind: 'prescription' | 'invoice' | 'result' | 'attachment' | 'discharge'; docId: string; note?: string }, txIn?: Tx) {
  requireModule(tenant, 'portal');
  authorize(actor, 'clinical.read');
  const work = async (tx: Tx) => {
    await tx.exec(`INSERT INTO document_release (tenant_id, patient_id, doc_kind, doc_id, released_by, note) VALUES (app_tenant_id(), $1,$2,$3,$4,$5)
                   ON CONFLICT DO NOTHING`, [d.patientId, d.kind, d.docId, staffId(actor), d.note ?? null]);
    await audit(tx, actor, 'document.released', d.kind, d.docId, { patientId: d.patientId });
    await emit(tx, 'document.released', d.kind, d.docId, { kind: d.kind });
  };
  return txIn ? work(txIn) : withTenant(tenant.id, work);
}

export async function revokeRelease(actor: Actor, tenant: Tenant, kind: string, docId: string) {
  authorize(actor, 'clinical.read');
  return withTenant(tenant.id, async (tx) => {
    await tx.exec(`UPDATE document_release SET revoked_at = now() WHERE doc_kind = $1 AND doc_id = $2 AND revoked_at IS NULL`, [kind, docId]);
    await audit(tx, actor, 'document.release_revoked', kind, docId);
  });
}

export async function releasedIds(tenant: Tenant, patientId: string) {
  return withTenant(tenant.id, (tx) => tx.many<{ doc_kind: string; doc_id: string }>(
    `SELECT doc_kind, doc_id FROM document_release WHERE patient_id = $1 AND revoked_at IS NULL`, [patientId]));
}

/** What the portal can see for one patient: only released documents, own appointments and invoices. */
export async function portalPatientView(tenant: Tenant, s: PortalSession, patientId: string) {
  const link = portalCan(s, patientId, 'can_view_documents');
  return withTenant(tenant.id, async (tx) => {
    const appointments = await tx.many<{ id: string; booking_ref: string; state: string; start_at: Date; clinician_name: string; service_name: string; modality: string; tele_room: string | null }>(
      `SELECT a.id, a.booking_ref, a.state, lower(a.period) AS start_at, c.display_name AS clinician_name, s.name AS service_name, a.modality, ts.room_name AS tele_room
         FROM appointment a JOIN clinician c ON c.id = a.clinician_id JOIN service s ON s.id = a.service_id LEFT JOIN tele_session ts ON ts.appointment_id = a.id
        WHERE a.patient_id = $1 ORDER BY lower(a.period) DESC LIMIT 50`, [patientId]);
    const docs = await tx.many<{ doc_kind: string; doc_id: string; released_at: Date; title: string | null }>(
      `SELECT r.doc_kind, r.doc_id, r.released_at,
              CASE r.doc_kind WHEN 'prescription' THEN (SELECT 'Prescription ' || rx_number FROM prescription WHERE id = r.doc_id AND status IN ('signed','superseded'))
                              WHEN 'invoice' THEN (SELECT 'Invoice ' || number FROM invoice WHERE id = r.doc_id)
                              WHEN 'result' THEN (SELECT t.name || ' result' FROM service_order o JOIN lab_test t ON t.id = o.test_id WHERE o.id = r.doc_id)
                              WHEN 'attachment' THEN (SELECT title FROM attachment WHERE id = r.doc_id AND status = 'active')
                              WHEN 'discharge' THEN 'Discharge summary' END AS title
         FROM document_release r WHERE r.patient_id = $1 AND r.revoked_at IS NULL ORDER BY r.released_at DESC`, [patientId]);
    const dues = link.can_pay ? await tx.many<{ invoice_id: string; number: string; total_paise: number; due_paise: number }>(
      `SELECT invoice_id, number, total_paise, due_paise FROM invoice_balance WHERE patient_id = $1 AND status = 'posted' AND due_paise > 0 ORDER BY number`, [patientId]) : [];
    await tx.exec(`INSERT INTO audit_event (tenant_id, actor_kind, actor_id, action, entity_kind, entity_id, patient_id) VALUES (app_tenant_id(), 'public', $1, 'portal.viewed', 'patient', $2, $2)`,
      [`portal:${s.accountId}`, patientId]);
    return { link, appointments, docs: docs.filter((d) => d.title), dues };
  });
}

/** Released prescription snapshot for the portal (exact signed content). */
export async function portalDocument(tenant: Tenant, s: PortalSession, kind: string, docId: string) {
  return withTenant(tenant.id, async (tx) => {
    const rel = await tx.maybe<{ patient_id: string }>(`SELECT patient_id FROM document_release WHERE doc_kind = $1 AND doc_id = $2 AND revoked_at IS NULL`, [kind, docId]);
    if (!rel) throw notFound();
    portalCan(s, rel.patient_id, 'can_view_documents');
    await tx.exec(`INSERT INTO audit_event (tenant_id, actor_kind, actor_id, action, entity_kind, entity_id, patient_id) VALUES (app_tenant_id(), 'public', $1, 'portal.document_viewed', $2, $3, $4)`,
      [`portal:${s.accountId}`, kind, docId, rel.patient_id]);
    if (kind === 'prescription') return { kind, rx: await tx.one<{ snapshot: Record<string, unknown>; status: string; content_digest: string }>(`SELECT snapshot, status, content_digest FROM prescription WHERE id = $1`, [docId]) };
    if (kind === 'attachment') return { kind, file: await tx.one<{ filename: string; content_type: string; data: Buffer }>(`SELECT filename, content_type, data FROM attachment WHERE id = $1 AND status = 'active'`, [docId]) };
    if (kind === 'result') return { kind, result: await tx.one<Record<string, unknown>>(
      `SELECT t.name, trim_scale(v.value_num) AS value_num, v.value_text, v.unit, v.ref_range, v.flag, v.report_text, v.status, v.verified_at, v.attachment_id
         FROM service_order o JOIN lab_test t ON t.id = o.test_id JOIN LATERAL (SELECT * FROM result_version WHERE order_id = o.id ORDER BY version_no DESC LIMIT 1) v ON true WHERE o.id = $1`, [docId]) };
    if (kind === 'invoice') return { kind, invoice: await tx.one<Record<string, unknown>>(`SELECT i.number, i.total_paise, i.business_date, b.due_paise, b.paid_paise FROM invoice i JOIN invoice_balance b ON b.invoice_id = i.id WHERE i.id = $1`, [docId]) };
    if (kind === 'discharge') return { kind, note: await tx.one<{ content: Record<string, string> }>(`SELECT content FROM clinical_note WHERE id = $1 AND status = 'signed'`, [docId]) };
    throw notFound();
  });
}

export async function portalCancel(tenant: Tenant, s: PortalSession, appointmentId: string) {
  const { cancelAppointment } = await import('./scheduling');
  const a = await withTenant(tenant.id, (tx) => tx.maybe<{ patient_id: string }>(`SELECT patient_id FROM appointment WHERE id = $1`, [appointmentId]));
  if (!a) throw notFound();
  portalCan(s, a.patient_id, 'can_schedule');
  return cancelAppointment({ kind: 'system', tenantId: tenant.id }, tenant, appointmentId, 'Cancelled by patient via portal', { patientInitiated: true });
}

// ------------------------------------------------------------------ records requests (CL-034, PR-018)
export const recordsRequestInput = z.object({
  patientId: z.uuid().nullish(), requesterKind: z.enum(['patient', 'representative', 'third_party']), requesterName: z.string().trim().min(2),
  requesterContact: z.string().max(200).optional(), authorityNote: z.string().max(1000).optional(),
  requestType: z.enum(['copy', 'correction', 'access_log', 'erasure', 'consent_withdrawal', 'other']).default('copy'),
  scope: z.string().trim().min(3).max(2000), dateFrom: z.string().optional(), dateTo: z.string().optional(),
  delivery: z.enum(['portal', 'print', 'email', 'in_person']).default('portal'),
});

export async function createRecordsRequest(actor: Actor | null, tenant: Tenant, input: z.input<typeof recordsRequestInput>, source: 'staff' | 'portal' = 'staff') {
  if (actor) authorize(actor, 'records.requests');
  const p = recordsRequestInput.parse(input);
  return withTenant(tenant.id, async (tx) => {
    const n = await tx.one<{ v: number }>(`SELECT next_doc_number('records_request') AS v`);
    const caseNo = `RR${String(n.v).padStart(6, '0')}`;
    const r = await tx.one<{ id: string; due_at: Date }>(
      `INSERT INTO records_request (tenant_id, case_no, patient_id, requester_kind, requester_name, requester_contact, authority_note, request_type, scope, date_from, date_to, delivery, due_at, source)
       VALUES (app_tenant_id(), $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11, now() + make_interval(days => $12), $13) RETURNING id, due_at`,
      [caseNo, p.patientId ?? null, p.requesterKind, p.requesterName, p.requesterContact ?? null, p.authorityNote ?? null, p.requestType, p.scope,
        p.dateFrom || null, p.dateTo || null, p.delivery, tenant.settings.recordsRequestDays, source]);
    await tx.exec(`INSERT INTO audit_event (tenant_id, actor_kind, actor_id, action, entity_kind, entity_id, patient_id) VALUES (app_tenant_id(), $1, $2, 'records_request.received', 'records_request', $3, $4)`,
      [actor ? actor.kind : 'public', actor && actor.kind === 'staff' ? actor.staffId : 'portal', r.id, p.patientId ?? null]);
    await emit(tx, 'records_request.received', 'records_request', r.id, { caseNo, dueAt: r.due_at });
    return { id: r.id, caseNo, dueAt: r.due_at };
  });
}

export async function listRecordsRequests(actor: Actor, tenant: Tenant) {
  authorize(actor, 'records.requests');
  return withTenant(tenant.id, (tx) => tx.many<{ id: string; case_no: string; status: string; requester_name: string; requester_kind: string; request_type: string; scope: string;
    received_at: Date; due_at: Date; overdue: boolean; full_name: string | null; uhid: string | null; patient_id: string | null; outcome: string | null; delivery: string; source: string; authority_note: string | null }>(
    `SELECT r.*, p.full_name, p.uhid, (r.status IN ('received','in_review') AND r.due_at < now()) AS overdue
       FROM records_request r LEFT JOIN patient p ON p.id = r.patient_id ORDER BY (r.status IN ('received','in_review')) DESC, r.due_at`));
}

export async function updateRecordsRequest(actor: Actor, tenant: Tenant, id: string, status: 'in_review' | 'fulfilled' | 'rejected' | 'withdrawn', outcome: string) {
  authorize(actor, 'records.requests');
  if (status !== 'in_review' && !outcome?.trim()) throw invalid('Record the outcome or reason');
  return withTenant(tenant.id, async (tx) => {
    const r = await tx.one<{ patient_id: string | null; status: string }>(`SELECT patient_id, status FROM records_request WHERE id = $1 FOR UPDATE`, [id]);
    if (['fulfilled', 'rejected', 'withdrawn'].includes(r.status)) throw rule('This request is closed');
    await tx.exec(`UPDATE records_request SET status = $2, outcome = COALESCE(NULLIF($3, ''), outcome), assigned_to = COALESCE(assigned_to, $4),
                     closed_at = CASE WHEN $2 IN ('fulfilled','rejected','withdrawn') THEN now() END WHERE id = $1`, [id, status, outcome ?? '', staffId(actor)]);
    await audit(tx, actor, `records_request.${status}`, 'records_request', id, { patientId: r.patient_id, reason: outcome });
  });
}
