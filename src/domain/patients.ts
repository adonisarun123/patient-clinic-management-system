import { z } from 'zod';
import { withTenant, type Tx } from '@/lib/db';
import { AppError, invalid, notFound, rule } from '@/lib/errors';
import { authorize, actorId, staffId, type Actor } from '@/lib/actor';
import { audit, emit } from '@/lib/events';
import { idempotent } from '@/lib/idempotency';
import { normalizeName, normalizePhone } from '@/lib/identity';
import { executeMerge } from './records';
import type { Tenant } from './tenants';

export type Patient = {
  id: string; uhid: string; status: string; temp_label: string | null; full_name: string; preferred_name: string | null;
  birth_date: string | null; birth_precision: string; estimated_age_years: number | null; age_as_of: string | null;
  sex: string; phone_e164: string | null; phone_status: string; email: string | null;
  address: Record<string, string>; preferred_language: string | null; emergency_contact: Record<string, string> | null;
  registration_source: string; identity_review: boolean; allergy_status: string; merged_into_id: string | null;
  version: number; created_at: Date;
};

export const registerInput = z.object({
  fullName: z.string().trim().min(1).max(200),
  preferredName: z.string().trim().max(200).optional(),
  birthDate: z.string().regex(/^\d{4}(-\d{2}(-\d{2})?)?$/).optional(),        // YYYY, YYYY-MM or YYYY-MM-DD
  estimatedAgeYears: z.number().int().min(0).max(130).optional(),
  birthUnknown: z.enum(['unknown', 'declined']).optional(),
  sex: z.enum(['female', 'male', 'other', 'unknown', 'declined']).default('unknown'),
  phone: z.string().max(30).optional(),
  phoneStatus: z.enum(['unverified', 'verified', 'none', 'declined', 'unavailable']).optional(),
  email: z.email().optional().or(z.literal('')),
  address: z.object({ line1: z.string().max(200).optional(), city: z.string().max(100).optional(),
    state: z.string().max(100).optional(), pincode: z.string().max(12).optional() }).default({}),
  preferredLanguage: z.string().max(40).optional(),
  emergencyContact: z.object({ name: z.string().max(200), phone: z.string().max(30), relation: z.string().max(60).optional() }).optional(),
  source: z.enum(['staff', 'walk_in', 'widget', 'api']).default('staff'),
  // OP-005: when a high-confidence candidate exists, staff must give a reason to create a new chart.
  overrideDuplicateReason: z.string().max(500).optional(),
  temporary: z.object({ label: z.string().min(1).max(100) }).optional(),   // OP-006 unidentified arrival
});
export type RegisterInput = z.input<typeof registerInput>;

function birthFields(p: z.infer<typeof registerInput>, today: string) {
  if (p.temporary && !p.birthDate && p.estimatedAgeYears == null) return { birth_date: null, birth_precision: 'unknown', est: null, asOf: null };
  if (p.birthDate) {
    const parts = p.birthDate.split('-');
    const precision = parts.length === 3 ? 'day' : parts.length === 2 ? 'month' : 'year';
    // Store a representative date but keep precision so outputs never print an invented day/month (DM-003).
    const iso = parts.length === 3 ? p.birthDate : parts.length === 2 ? `${p.birthDate}-01` : `${p.birthDate}-01-01`;
    if (iso > today) throw invalid('Date of birth cannot be in the future');
    return { birth_date: iso, birth_precision: precision, est: null, asOf: null };
  }
  if (p.estimatedAgeYears != null) return { birth_date: null, birth_precision: 'estimated', est: p.estimatedAgeYears, asOf: today };
  return { birth_date: null, birth_precision: p.birthUnknown ?? 'unknown', est: null, asOf: null };
}

export type Candidate = { id: string; uhid: string; full_name: string; birth_date: string | null; birth_precision: string; sex: string; phone_e164: string | null; status: string; score: number; reason: string };

/** OP-005 ranking: exact UHID, then same phone, then exact name+DOB, then partial name with supporting demographics. */
export async function findCandidates(tx: Tx, q: { uhid?: string; phone?: string | null; fullName?: string; birthDate?: string | null; birthYear?: number | null }, limit = 10): Promise<Candidate[]> {
  const phone = normalizePhone(q.phone ?? null);
  const name = q.fullName ? normalizeName(q.fullName) : null;
  const year = q.birthYear ?? (q.birthDate ? Number(q.birthDate.slice(0, 4)) : null);
  return tx.many<Candidate>(
    `WITH c AS (
       SELECT p.*,
         CASE
           WHEN $1::text IS NOT NULL AND upper(p.uhid) = upper($1) THEN 100
           WHEN $1::text IS NOT NULL AND EXISTS (SELECT 1 FROM patient_identifier i WHERE i.patient_id = p.id AND upper(i.value) = upper($1)) THEN 95
           WHEN $1::text IS NOT NULL AND EXISTS (SELECT 1 FROM patient_abha a WHERE a.patient_id = p.id AND a.status = 'active'
                  AND (a.abha_number = regexp_replace($1, '[\s-]', '', 'g') OR a.abha_address = lower($1))) THEN 95
           WHEN $2::text IS NOT NULL AND p.phone_e164 = $2 AND $3::text IS NOT NULL AND p.name_norm = $3 THEN 90
           WHEN $3::text IS NOT NULL AND p.name_norm = $3 AND $5::int IS NOT NULL AND extract(year FROM p.birth_date) = $5 THEN 80
           WHEN $2::text IS NOT NULL AND p.phone_e164 = $2 THEN 70
           WHEN $3::text IS NOT NULL AND p.name_norm = $3 THEN 50
           WHEN $3::text IS NOT NULL AND length($3) >= 3 AND p.name_norm LIKE '%' || $3 || '%' THEN 30
           ELSE 0 END AS score
       FROM patient p WHERE p.status <> 'merged')
     SELECT id, uhid, full_name, birth_date, birth_precision, sex, phone_e164, status, score,
       CASE WHEN score = 100 THEN 'UHID' WHEN score = 95 THEN 'ID number (legacy or ABHA)' WHEN score = 90 THEN 'Phone and name'
            WHEN score = 80 THEN 'Name and birth year' WHEN score = 70 THEN 'Same phone (may be family)'
            WHEN score = 50 THEN 'Same name' ELSE 'Similar name' END AS reason
       FROM c WHERE score > 0 ORDER BY score DESC, full_name, id LIMIT $4`,
    [q.uhid ?? null, phone, name, limit, year]);
}

export async function searchPatients(actor: Actor, query: string) {
  authorize(actor, 'patient.read');
  const q = query.trim();
  if (q.length < 2) return [];
  return withTenant(actor.tenantId, async (tx) => {
    const phone = normalizePhone(q);
    const rows = await findCandidates(tx, {
      uhid: q,
      phone, fullName: phone ? undefined : q,
    }, 25);
    await audit(tx, actor, 'patient.search', 'patient', null, { data: { resultCount: rows.length, kind: phone ? 'phone' : 'text' } });
    return rows;
  });
}

async function allocateUhid(tx: Tx, prefix: string, temporary: boolean) {
  const n = await tx.one<{ v: number }>(`SELECT next_doc_number($1) AS v`, [temporary ? 'uhid-temp' : 'uhid']);
  return temporary ? `TMP-${String(n.v).padStart(5, '0')}` : `${prefix}${String(n.v).padStart(6, '0')}`;
}

/** OP-001..006: register inside one transaction; replay with the same key returns the same UHID. */
export async function registerPatient(actor: Actor, tenant: Tenant, input: RegisterInput, requestKey?: string | null,
  opts: { tx?: Tx; skipDuplicateCheck?: boolean } = {}) {
  if (actor.kind !== 'public') authorize(actor, 'patient.write');
  const r = registerInput.safeParse(input);
  if (!r.success) throw invalid('Check the registration details', r.error.issues);
  const p = r.data;
  const today = new Date().toLocaleDateString('en-CA', { timeZone: tenant.timezone });
  const phone = normalizePhone(p.phone);
  if (p.phone && !phone) throw invalid('Phone number is not valid');

  const work = async (tx: Tx) => idempotent(tx, actorId(actor), 'patient.register', requestKey, p, async () => {
    const b = birthFields(p, today);
    const isPublic = actor.kind === 'public' || p.source === 'widget' || p.source === 'api';
    if (!p.temporary && !opts.skipDuplicateCheck && !isPublic) {
      const strong = (await findCandidates(tx, { phone, fullName: p.fullName, birthDate: b.birth_date }, 5)).filter((c) => c.score >= 80);
      if (strong.length && !p.overrideDuplicateReason) {
        // Only trained staff see candidates; public callers never reach this branch.
        throw new AppError('CONFLICT', 'Possible existing patient. Confirm two identifiers or give a reason to create a new record.',
          { candidates: strong });
      }
    }
    const uhid = await allocateUhid(tx, tenant.settings.uhidPrefix, !!p.temporary);
    const status = p.temporary ? 'temporary' : isPublic ? 'provisional' : 'active';
    const row = await tx.one<{ id: string; uhid: string }>(
      `INSERT INTO patient (tenant_id, uhid, status, temp_label, full_name, preferred_name, name_norm, birth_date, birth_precision,
          estimated_age_years, age_as_of, sex, phone_e164, phone_status, email, address, preferred_language, emergency_contact,
          registration_source, identity_review, created_by)
       VALUES (app_tenant_id(), $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20) RETURNING id, uhid`,
      [uhid, status, p.temporary?.label ?? null, p.fullName, p.preferredName ?? null, normalizeName(p.fullName),
        b.birth_date, b.birth_precision, b.est, b.asOf, p.sex, phone,
        phone ? (p.phoneStatus ?? 'unverified') : (p.phoneStatus ?? 'none'), p.email || null, JSON.stringify(p.address),
        p.preferredLanguage ?? null, p.emergencyContact ? JSON.stringify(p.emergencyContact) : null,
        p.temporary ? 'walk_in' : p.source, isPublic || !!p.temporary, staffId(actor)]);
    if (p.overrideDuplicateReason) {
      await audit(tx, actor, 'patient.duplicate_override', 'patient', row.id, { patientId: row.id, reason: p.overrideDuplicateReason });
    }
    await audit(tx, actor, 'patient.registered', 'patient', row.id, { patientId: row.id, data: { source: p.source, temporary: !!p.temporary } });
    await emit(tx, 'patient.registered', 'patient', row.id, { uhid: row.uhid, source: p.source });
    return { id: row.id, uhid: row.uhid, status };
  });
  return opts.tx ? work(opts.tx) : withTenant(actor.tenantId, work);
}

export async function getPatient(actor: Actor, id: string) {
  authorize(actor, 'patient.read');
  return withTenant(actor.tenantId, async (tx) => {
    const p = await tx.maybe<Patient>(`SELECT * FROM patient WHERE id = $1`, [id]);
    if (!p) throw notFound('Patient');
    await audit(tx, actor, 'patient.viewed', 'patient', id, { patientId: id });
    return p;
  });
}

const updatable = {
  full_name: 'fullName', preferred_name: 'preferredName', sex: 'sex', phone_e164: 'phone', email: 'email',
  preferred_language: 'preferredLanguage',
} as const;

export const updateInput = z.object({
  expectedVersion: z.number().int(),
  kind: z.enum(['correction', 'update']),
  reason: z.string().trim().min(3).max(500),
  fullName: z.string().trim().min(1).max(200).optional(),
  preferredName: z.string().trim().max(200).optional(),
  sex: z.enum(['female', 'male', 'other', 'unknown', 'declined']).optional(),
  phone: z.string().max(30).optional(),
  email: z.string().max(200).optional(),
  preferredLanguage: z.string().max(40).optional(),
  birthDate: z.string().regex(/^\d{4}(-\d{2}(-\d{2})?)?$/).optional(),
  address: z.object({ line1: z.string().optional(), city: z.string().optional(), state: z.string().optional(), pincode: z.string().optional() }).optional(),
});

/** OP-008: field-level history, version precondition (API-003), and verification reset on contact change. */
export async function updatePatient(actor: Actor, id: string, input: z.input<typeof updateInput>) {
  authorize(actor, 'patient.write');
  const p = updateInput.parse(input);
  return withTenant(actor.tenantId, async (tx) => {
    const cur = await tx.maybe<Patient>(`SELECT * FROM patient WHERE id = $1 FOR UPDATE`, [id]);
    if (!cur) throw notFound('Patient');
    if (cur.status === 'merged') throw rule('This record was merged; edit the surviving record');
    if (Number(cur.version) !== p.expectedVersion) throw new AppError('VERSION_CONFLICT', 'Someone else changed this patient. Reload and try again.');
    const sets: string[] = []; const vals: unknown[] = [id];
    const log = async (field: string, oldV: unknown, newV: unknown) => {
      await tx.exec(`INSERT INTO patient_change (tenant_id, patient_id, field, old_value, new_value, kind, reason, actor_id)
                     VALUES (app_tenant_id(), $1,$2,$3,$4,$5,$6,$7)`,
        [id, field, oldV == null ? null : String(oldV), newV == null ? null : String(newV), p.kind, p.reason, staffId(actor)]);
    };
    for (const [col, key] of Object.entries(updatable) as [keyof typeof updatable, (typeof updatable)[keyof typeof updatable]][]) {
      const raw = p[key];
      if (raw === undefined) continue;
      let v: unknown = raw === '' ? null : raw;
      if (col === 'phone_e164') {
        v = normalizePhone(raw as string);
        if (raw && !v) throw invalid('Phone number is not valid');
      }
      if ((cur as Record<string, unknown>)[col] === v) continue;
      vals.push(v); sets.push(`${col} = $${vals.length}`);
      if (col === 'full_name') { vals.push(normalizeName(String(v))); sets.push(`name_norm = $${vals.length}`); }
      if (col === 'phone_e164') sets.push(`phone_status = '${v ? 'unverified' : 'none'}'`);   // invalidate obsolete verification
      await log(col, (cur as Record<string, unknown>)[col], v);
    }
    if (p.birthDate !== undefined) {
      const parts = p.birthDate.split('-');
      const iso = parts.length === 3 ? p.birthDate : parts.length === 2 ? `${p.birthDate}-01` : `${p.birthDate}-01-01`;
      const prec = parts.length === 3 ? 'day' : parts.length === 2 ? 'month' : 'year';
      if (cur.birth_date !== iso || cur.birth_precision !== prec) {
        vals.push(iso); sets.push(`birth_date = $${vals.length}`);
        vals.push(prec); sets.push(`birth_precision = $${vals.length}`);
        sets.push('estimated_age_years = NULL', 'age_as_of = NULL');
        await log('birth_date', `${cur.birth_date ?? ''} (${cur.birth_precision})`, `${iso} (${prec})`);
      }
    }
    if (p.address) {
      vals.push(JSON.stringify(p.address)); sets.push(`address = $${vals.length}`);
      await log('address', JSON.stringify(cur.address), JSON.stringify(p.address));
    }
    if (!sets.length) return { version: Number(cur.version) };
    const row = await tx.one<{ version: number }>(
      `UPDATE patient SET ${sets.join(', ')}, version = version + 1, updated_at = now() WHERE id = $1 RETURNING version`, vals);
    await audit(tx, actor, 'patient.updated', 'patient', id, { patientId: id, reason: p.reason, data: { kind: p.kind, fields: sets.length } });
    return { version: Number(row.version) };
  });
}

export async function patientHistory(actor: Actor, id: string) {
  authorize(actor, 'patient.read');
  return withTenant(actor.tenantId, (tx) => tx.many(
    `SELECT pc.*, s.full_name AS actor_name FROM patient_change pc LEFT JOIN staff s ON s.id = pc.actor_id
      WHERE pc.patient_id = $1 ORDER BY pc.at DESC LIMIT 100`, [id]));
}

// ------------------------------------------------------------------ allergies (DM-003)
export async function recordAllergyReview(actor: Actor, patientId: string, input:
  { noKnownAllergies: true } | { substance: string; reaction?: string; severity?: 'mild' | 'moderate' | 'severe' | 'unknown' }) {
  authorize(actor, 'clinical.read');
  if (actor.kind !== 'staff' || !['doctor', 'nurse', 'owner'].includes(actor.role)) throw new AppError('FORBIDDEN', 'Only clinical staff can record allergies');
  return withTenant(actor.tenantId, async (tx) => {
    if ('noKnownAllergies' in input) {
      const active = await tx.maybe(`SELECT 1 FROM allergy WHERE patient_id = $1 AND status = 'active'`, [patientId]);
      if (active) throw rule('Active allergies are recorded; resolve them before marking “no known allergies”.');
      await tx.exec(`UPDATE patient SET allergy_status='no_known_allergies', allergy_reviewed_at=now(), allergy_reviewed_by=$2 WHERE id=$1`, [patientId, actor.staffId]);
    } else {
      if (!input.substance?.trim()) throw invalid('Enter the allergen or substance');
      await tx.exec(`INSERT INTO allergy (tenant_id, patient_id, substance, reaction, severity, recorded_by) VALUES (app_tenant_id(), $1,$2,$3,$4,$5)`,
        [patientId, input.substance.trim(), input.reaction ?? null, input.severity ?? 'unknown', actor.staffId]);
      await tx.exec(`UPDATE patient SET allergy_status='has_allergies', allergy_reviewed_at=now(), allergy_reviewed_by=$2 WHERE id=$1`, [patientId, actor.staffId]);
    }
    await audit(tx, actor, 'allergy.reviewed', 'patient', patientId, { patientId });
  });
}

export async function setAllergyStatus(actor: Actor, allergyId: string, status: 'resolved' | 'entered_in_error') {
  authorize(actor, 'clinical.write');
  return withTenant(actor.tenantId, async (tx) => {
    const a = await tx.one<{ patient_id: string }>(`UPDATE allergy SET status=$2 WHERE id=$1 RETURNING patient_id`, [allergyId, status]);
    const left = await tx.maybe(`SELECT 1 FROM allergy WHERE patient_id=$1 AND status='active'`, [a.patient_id]);
    if (!left) await tx.exec(`UPDATE patient SET allergy_status='not_reviewed' WHERE id=$1`, [a.patient_id]);
    await audit(tx, actor, `allergy.${status}`, 'allergy', allergyId, { patientId: a.patient_id });
  });
}

// ------------------------------------------------------------------ identity resolution
/**
 * OP-011 (simplified for outpatient launch): link a provisional or temporary record into an existing chart.
 * Requires records permission. Outside solo practice, the approver must differ from the staff member who registered it.
 * Signed clinical documents keep the issuing identity; only references are re-pointed, and the alias is kept.
 */
export async function linkIntoExisting(actor: Actor, tenant: Tenant, sourceId: string, survivorId: string, reason: string) {
  authorize(actor, 'patient.merge');
  if (sourceId === survivorId) throw invalid('Choose two different records');
  if (!reason || reason.trim().length < 5) throw invalid('Give the evidence used to confirm identity');
  return withTenant(actor.tenantId, async (tx) => {
    const [a, b] = [sourceId, survivorId].sort();
    const rows = await tx.many<Patient & { created_by: string | null }>(`SELECT * FROM patient WHERE id IN ($1, $2) ORDER BY id FOR UPDATE`, [a, b]);
    const src = rows.find((r) => r.id === sourceId); const dst = rows.find((r) => r.id === survivorId);
    if (!src || !dst) throw notFound('Patient');
    if (src.status === 'merged' || dst.status === 'merged') throw rule('One of these records is already merged');
    if (!tenant.settings.soloPractice && actor.kind === 'staff' && src.created_by === actor.staffId) {
      throw rule('A second authorised person must confirm this link (dual control).');
    }
    // Shared engine: open work moves, signed facts stay and are read through the alias; recorded for undo.
    const r = await executeMerge(tx, actor, src, dst, reason.trim(), { requestedBy: src.created_by });
    return { survivor: r.survivor, retired: r.retired, moved: r.moved, mergeId: r.mergeId };
  });
}

export async function confirmIdentity(actor: Actor, patientId: string) {
  authorize(actor, 'patient.write');
  return withTenant(actor.tenantId, async (tx) => {
    await tx.exec(`UPDATE patient SET status = 'active', identity_review = false, version = version + 1 WHERE id = $1 AND status IN ('provisional','temporary','active')`, [patientId]);
    await audit(tx, actor, 'patient.identity_confirmed', 'patient', patientId, { patientId });
  });
}

export async function identityReviewQueue(actor: Actor) {
  authorize(actor, 'patient.read');
  return withTenant(actor.tenantId, (tx) => tx.many<Patient>(
    `SELECT * FROM patient WHERE identity_review AND status IN ('provisional','temporary') ORDER BY created_at LIMIT 200`));
}

/** The surviving chart plus every record merged into it, for longitudinal reads. */
export async function chartIds(tx: Tx, patientId: string): Promise<string[]> {
  const rows = await tx.many<{ id: string }>(
    `WITH RECURSIVE m AS (SELECT id FROM patient WHERE id = $1
       UNION SELECT p.id FROM patient p JOIN m ON p.merged_into_id = m.id)
     SELECT id FROM m`, [patientId]);
  return rows.map((r) => r.id);
}
