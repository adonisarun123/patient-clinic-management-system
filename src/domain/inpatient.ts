import { z } from 'zod';
import { withTenant, type Tx } from '@/lib/db';
import { AppError, invalid, notFound, rule } from '@/lib/errors';
import { authorize, staffId, type Actor } from '@/lib/actor';
import { audit, emit } from '@/lib/events';
import { canonicalJson, sha256 } from '@/lib/crypto';
import { requireModule, type Tenant } from './tenants';
import { assertChartAccess } from './access';

/** Beds, orders, MAR and discharge serve both inpatient wards and day care. */
function requireWard(tenant: Tenant) {
  if (!tenant.settings.modules.inpatient && !tenant.settings.modules.daycare) requireModule(tenant, 'inpatient');
}

/**
 * Inpatient care (CL-036–039, HS-001–008). An admission owns an inpatient encounter, so notes, vitals, orders and
 * prescriptions reuse the outpatient record. Bed occupancy uses two exclusion constraints (one patient per bed,
 * one bed per admission) and transfers close and open stays at the same instant.
 */
const localDay = (d: Date | string, tz: string) => new Date(d).toLocaleDateString('en-CA', { timeZone: tz });

export async function upsertBed(actor: Actor, tenant: Tenant, b: { id?: string; wardId: string; code: string; category?: string; dailyRatePaise: number; active?: boolean }) {
  requireWard(tenant);
  authorize(actor, 'settings.manage');
  if (!b.code?.trim()) throw invalid('Bed code is required');
  return withTenant(tenant.id, async (tx) => {
    const ward = await tx.maybe<{ kind: string }>(`SELECT kind FROM location WHERE id = $1`, [b.wardId]);
    if (ward?.kind !== 'ward') throw invalid('Choose a location of type “ward”');
    const r = b.id
      ? await tx.one<{ id: string }>(`UPDATE bed SET ward_id=$2, code=$3, category=$4, daily_rate_paise=$5, active=$6 WHERE id=$1 RETURNING id`,
        [b.id, b.wardId, b.code.toUpperCase(), b.category ?? 'general', b.dailyRatePaise, b.active ?? true])
      : await tx.one<{ id: string }>(`INSERT INTO bed (tenant_id, ward_id, code, category, daily_rate_paise) VALUES (app_tenant_id(), $1,$2,$3,$4) RETURNING id`,
        [b.wardId, b.code.toUpperCase(), b.category ?? 'general', b.dailyRatePaise]);
    await audit(tx, actor, 'bed.saved', 'bed', r.id);
    return r.id;
  });
}

export type BedBoardRow = { bed_id: string; code: string; category: string; status: string; ward_id: string; ward: string; daily_rate_paise: number;
  admission_id: string | null; admission_no: string | null; patient_id: string | null; full_name: string | null; uhid: string | null; admitted_at: Date | null; clinician: string | null };

/** HS-002 live bed board. */
export async function bedBoard(actor: Actor, tenant: Tenant) {
  requireWard(tenant);
  authorize(actor, 'schedule.read');
  return withTenant(tenant.id, (tx) => tx.many<BedBoardRow>(
    `SELECT b.id AS bed_id, b.code, b.category, b.status, b.ward_id, w.name AS ward, b.daily_rate_paise,
            a.id AS admission_id, a.admission_no, p.id AS patient_id, p.full_name, p.uhid, a.admitted_at, c.display_name AS clinician
       FROM bed b JOIN location w ON w.id = b.ward_id
       LEFT JOIN bed_stay s ON s.bed_id = b.id AND s.period @> now()
       LEFT JOIN admission a ON a.id = s.admission_id LEFT JOIN patient p ON p.id = a.patient_id LEFT JOIN clinician c ON c.id = a.admitting_clinician_id
      WHERE b.active ORDER BY w.name, b.code`));
}

export const admitInput = z.object({
  patientId: z.uuid(), bedId: z.uuid(), departmentId: z.uuid(), admittingClinicianId: z.uuid(), reason: z.string().trim().min(3).max(1000),
  sourceEncounterId: z.uuid().nullish(), expectedDischarge: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  careType: z.enum(['inpatient', 'daycare']).default('inpatient'),
  plannedEndAt: z.iso.datetime({ offset: true }).optional(),          // day care: expected discharge time
});

/** HS-001: one active admission per patient; the bed is claimed in the same transaction. */
export async function admit(actor: Actor, tenant: Tenant, input: z.input<typeof admitInput>) {
  const p = admitInput.parse(input);
  requireModule(tenant, p.careType === 'daycare' ? 'daycare' : 'inpatient');
  authorize(actor, 'inpatient.admit');
  if (p.careType === 'daycare') {
    if (!p.plannedEndAt) throw invalid('Give the expected discharge time for day care');
    const end = new Date(p.plannedEndAt);
    const day = (d: Date) => d.toLocaleDateString('en-CA', { timeZone: tenant.timezone });
    if (end.getTime() <= Date.now() || day(end) !== day(new Date())) throw invalid('Day-care discharge must be later today; admit as an inpatient for an overnight stay');
  }
  return withTenant(tenant.id, async (tx) => {
    const pt = await tx.maybe<{ status: string }>(`SELECT status FROM patient WHERE id = $1 FOR UPDATE`, [p.patientId]);
    if (!pt || pt.status === 'merged') throw notFound('Patient');
    const bed = await tx.maybe<{ status: string; active: boolean }>(`SELECT status, active FROM bed WHERE id = $1 FOR UPDATE`, [p.bedId]);
    if (!bed?.active || bed.status !== 'available') throw rule('That bed is not available');
    const enc = await tx.one<{ id: string }>(
      `INSERT INTO encounter (tenant_id, patient_id, department_id, lead_clinician_id, kind, chief_complaint, created_by) VALUES (app_tenant_id(), $1,$2,$3,'inpatient',$4,$5) RETURNING id`,
      [p.patientId, p.departmentId, p.admittingClinicianId, p.reason, staffId(actor)]);
    const dc = p.careType === 'daycare';
    const n = await tx.one<{ v: number }>(`SELECT next_doc_number($1) AS v`, [dc ? 'daycare' : 'admission']);
    const adm = await tx.one<{ id: string; admission_no: string }>(
      `INSERT INTO admission (tenant_id, admission_no, patient_id, encounter_id, source_encounter_id, department_id, admitting_clinician_id, reason, expected_discharge, created_by, care_type, planned_end_at)
       VALUES (app_tenant_id(), $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id, admission_no`,
      [`${dc ? 'DC' : 'IP'}${String(n.v).padStart(6, '0')}`, p.patientId, enc.id, p.sourceEncounterId ?? null, p.departmentId, p.admittingClinicianId, p.reason,
        dc ? new Date(p.plannedEndAt!).toLocaleDateString('en-CA', { timeZone: tenant.timezone }) : p.expectedDischarge ?? null, staffId(actor), p.careType, dc ? p.plannedEndAt : null])
      .catch((e: AppError) => { if (e.code === 'CONFLICT') throw rule('This patient is already admitted'); throw e; });
    await tx.exec(`INSERT INTO bed_stay (tenant_id, admission_id, bed_id, period, reason, moved_by) VALUES (app_tenant_id(), $1, $2, tstzrange(now(), NULL, '[)'), 'admission', $3)`,
      [adm.id, p.bedId, staffId(actor)]).catch((e: AppError) => { if (e.code === 'SLOT_TAKEN') throw rule('That bed was just taken'); throw e; });
    await audit(tx, actor, 'admission.created', 'admission', adm.id, { patientId: p.patientId, data: { admissionNo: adm.admission_no, careType: p.careType } });
    await emit(tx, 'patient.admitted', 'admission', adm.id, { admissionNo: adm.admission_no });
    return { admissionId: adm.id, admissionNo: adm.admission_no, encounterId: enc.id };
  });
}

/** HS-003: close the old stay and open the new one at the same instant; failure keeps the original bed. */
export async function transferBed(actor: Actor, tenant: Tenant, admissionId: string, toBedId: string, reason: string) {
  requireWard(tenant);
  authorize(actor, 'inpatient.nursing');
  if (!reason?.trim()) throw invalid('Give the reason for transfer');
  return withTenant(tenant.id, async (tx) => {
    const a = await lockAdmission(tx, admissionId);
    const bed = await tx.maybe<{ status: string; active: boolean }>(`SELECT status, active FROM bed WHERE id = $1 FOR UPDATE`, [toBedId]);
    if (!bed?.active || bed.status !== 'available') throw rule('The receiving bed is not available');
    const cur = await tx.one<{ id: string; bed_id: string }>(`SELECT id, bed_id FROM bed_stay WHERE admission_id = $1 AND upper_inf(period) FOR UPDATE`, [admissionId]);
    if (cur.bed_id === toBedId) throw rule('Patient is already in that bed');
    const t = await tx.one<{ t: Date }>(`SELECT now() AS t`);
    await tx.exec(`UPDATE bed_stay SET period = tstzrange(lower(period), $2, '[)') WHERE id = $1`, [cur.id, t.t]);
    await tx.exec(`INSERT INTO bed_stay (tenant_id, admission_id, bed_id, period, reason, moved_by) VALUES (app_tenant_id(), $1,$2, tstzrange($3, NULL, '[)'), $4, $5)`,
      [admissionId, toBedId, t.t, reason, staffId(actor)]).catch((e: AppError) => { if (e.code === 'SLOT_TAKEN') throw rule('The receiving bed was just taken; the patient stays in the original bed'); throw e; });
    await tx.exec(`UPDATE bed SET status = 'cleaning' WHERE id = $1`, [cur.bed_id]);
    await audit(tx, actor, 'admission.transferred', 'admission', admissionId, { patientId: a.patient_id, reason });
  });
}

export async function setBedStatus(actor: Actor, tenant: Tenant, bedId: string, status: 'available' | 'cleaning' | 'blocked') {
  requireWard(tenant);
  authorize(actor, 'inpatient.nursing');
  return withTenant(tenant.id, async (tx) => {
    if (status !== 'available') {
      const occ = await tx.maybe(`SELECT 1 FROM bed_stay WHERE bed_id = $1 AND period @> now()`, [bedId]);
      if (occ) throw rule('Bed is occupied');
    }
    await tx.exec(`UPDATE bed SET status = $2 WHERE id = $1`, [bedId, status]);
    await audit(tx, actor, 'bed.status', 'bed', bedId, { data: { status } });
  });
}

async function lockAdmission(tx: Tx, id: string) {
  const a = await tx.maybe<{ id: string; patient_id: string; status: string; encounter_id: string; admitted_at: Date; admitting_clinician_id: string; department_id: string }>(
    `SELECT * FROM admission WHERE id = $1 FOR UPDATE`, [id]);
  if (!a) throw notFound('Admission');
  if (a.status !== 'admitted') throw rule('This admission is closed');
  return a;
}

// ------------------------------------------------------------------ medication orders and MAR (HS-006–008)
export const medOrderInput = z.object({
  productId: z.uuid().nullish(), drugName: z.string().trim().min(2).max(200), dose: z.string().trim().min(1).max(60), route: z.string().trim().min(1).max(40),
  scheduleTimes: z.array(z.string().regex(/^\d{2}:\d{2}$/)).default([]), prn: z.boolean().default(false), prnIndication: z.string().max(200).optional(),
  startAt: z.string().optional(), instructions: z.string().max(500).optional(), replacesOrderId: z.uuid().optional(), changeReason: z.string().max(300).optional(),
});

/** Generates due occurrences in the next `hours` hours; the unique (order, due_at) index makes this idempotent. */
async function materialiseDoses(tx: Tx, tz: string, orderId: string, hours = 36) {
  await tx.exec(
    `INSERT INTO mar_dose (tenant_id, med_order_id, admission_id, due_at)
     SELECT app_tenant_id(), o.id, o.admission_id, ((d.day + t.hhmm::time) AT TIME ZONE $2)
       FROM med_order o
       CROSS JOIN LATERAL unnest(o.schedule_times) AS t(hhmm)
       -- ::date matters: generate_series over dates yields timestamptz, and timestamptz + time AT TIME ZONE converts
       -- the wrong way (result then depended on the server's TimeZone setting).
       CROSS JOIN LATERAL (SELECT g::date AS day FROM generate_series((now() AT TIME ZONE $2)::date, ((now() + make_interval(hours => $3)) AT TIME ZONE $2)::date, interval '1 day') g) AS d
      WHERE o.id = $1 AND o.status = 'active' AND NOT o.prn
        AND ((d.day + t.hhmm::time) AT TIME ZONE $2) >= o.start_at
        AND ((d.day + t.hhmm::time) AT TIME ZONE $2) < now() + make_interval(hours => $3)
        AND (o.stop_at IS NULL OR ((d.day + t.hhmm::time) AT TIME ZONE $2) < o.stop_at)
     ON CONFLICT DO NOTHING`, [orderId, tz, hours]);
}

/**
 * Signed ward medication order. A dose change supersedes the old order from an explicit effective time:
 * completed doses stay, untouched future doses are superseded, and new occurrences are emitted once (HS-007).
 */
export async function orderMedication(actor: Actor, tenant: Tenant, admissionId: string, input: z.input<typeof medOrderInput>) {
  requireWard(tenant);
  authorize(actor, 'clinical.sign');
  if (actor.kind !== 'staff' || !actor.clinicianId) throw new AppError('FORBIDDEN', 'Only a clinician can order medicines');
  const p = medOrderInput.parse(input);
  if (!p.prn && !p.scheduleTimes.length) throw invalid('Give administration times, or mark the order as “when needed”');
  if (p.prn && !p.prnIndication) throw invalid('Say what the “when needed” dose is for');
  return withTenant(tenant.id, async (tx) => {
    const a = await lockAdmission(tx, admissionId);
    const start = p.startAt ? new Date(p.startAt) : new Date();
    if (Number.isNaN(+start)) throw invalid('Invalid start time');
    if (p.replacesOrderId) {
      if (!p.changeReason) throw invalid('Give the reason for the change');
      const old = await tx.one<{ status: string; admission_id: string }>(`SELECT status, admission_id FROM med_order WHERE id = $1 FOR UPDATE`, [p.replacesOrderId]);
      if (old.admission_id !== admissionId || old.status !== 'active') throw rule('Only an active order on this admission can be changed');
      await tx.exec(`UPDATE med_order SET status = 'superseded', stop_at = $2, stop_reason = $3 WHERE id = $1`, [p.replacesOrderId, start, p.changeReason]);
      await tx.exec(`UPDATE mar_dose SET status = 'superseded' WHERE med_order_id = $1 AND status = 'due' AND due_at >= $2`, [p.replacesOrderId, start]);
    }
    const o = await tx.one<{ id: string }>(
      `INSERT INTO med_order (tenant_id, admission_id, patient_id, product_id, drug_name, dose, route, schedule_times, prn, prn_indication, start_at, supersedes_id, instructions, ordered_by, clinician_id)
       VALUES (app_tenant_id(), $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING id`,
      [admissionId, a.patient_id, p.productId ?? null, p.drugName, p.dose, p.route, p.scheduleTimes, p.prn, p.prn ? p.prnIndication : null, start,
        p.replacesOrderId ?? null, p.instructions ?? null, actor.staffId, actor.clinicianId]);
    await materialiseDoses(tx, tenant.timezone, o.id);
    await audit(tx, actor, p.replacesOrderId ? 'med_order.changed' : 'med_order.created', 'med_order', o.id, { patientId: a.patient_id, reason: p.changeReason });
    return o.id;
  });
}

export async function stopMedication(actor: Actor, tenant: Tenant, orderId: string, reason: string) {
  requireWard(tenant);
  authorize(actor, 'clinical.sign');
  if (!reason?.trim()) throw invalid('Give the reason');
  return withTenant(tenant.id, async (tx) => {
    const o = await tx.one<{ patient_id: string; status: string }>(`SELECT patient_id, status FROM med_order WHERE id = $1 FOR UPDATE`, [orderId]);
    if (o.status !== 'active') throw rule('Order is not active');
    await tx.exec(`UPDATE med_order SET status = 'stopped', stop_at = now(), stop_reason = $2 WHERE id = $1`, [orderId, reason]);
    await tx.exec(`UPDATE mar_dose SET status = 'superseded' WHERE med_order_id = $1 AND status = 'due' AND due_at >= now()`, [orderId]);
    await audit(tx, actor, 'med_order.stopped', 'med_order', orderId, { patientId: o.patient_id, reason });
  });
}

export const doseInput = z.object({
  outcome: z.enum(['given', 'held', 'refused']), doseGiven: z.string().max(60).optional(), note: z.string().max(500).optional(),
  witnessStaffId: z.uuid().optional(), patientConfirmed: z.boolean(),
});

/** Record one scheduled dose. A second recording of the same occurrence is refused (one dose per occurrence). */
export async function recordDose(actor: Actor, tenant: Tenant, doseId: string, input: z.input<typeof doseInput>) {
  requireWard(tenant);
  authorize(actor, 'inpatient.nursing');
  const p = doseInput.parse(input);
  if (!p.patientConfirmed) throw rule('Confirm the patient’s identity band before recording a dose');
  if (p.outcome !== 'given' && !p.note?.trim()) throw invalid('Give the reason the dose was held or refused');
  return withTenant(tenant.id, async (tx) => {
    const d = await tx.maybe<{ status: string; admission_id: string; med_order_id: string; early_min: number }>(
      `SELECT status, admission_id, med_order_id, floor(extract(epoch FROM due_at - now()) / 60)::int AS early_min FROM mar_dose WHERE id = $1 FOR UPDATE`, [doseId]);
    if (!d) throw notFound('Dose');
    if (p.outcome === 'given' && d.early_min > 60 && !p.note?.trim()) throw rule(`This dose is due in ${d.early_min} minutes. Record the reason for giving it early.`);
    if (d.status !== 'due' && d.status !== 'missed') throw rule(`This dose is already recorded as ${d.status}`);
    const o = await tx.one<{ status: string; patient_id: string }>(`SELECT status, patient_id FROM med_order WHERE id = $1`, [d.med_order_id]);
    if (o.status !== 'active') throw rule('This order is no longer active');
    await tx.exec(`UPDATE mar_dose SET status = $2, given_at = now(), given_by = $3, dose_given = $4, note = $5, witness_by = $6, recorded_at = now() WHERE id = $1`,
      [doseId, p.outcome, staffId(actor), p.doseGiven ?? null, p.note ?? null, p.witnessStaffId ?? null]);
    await audit(tx, actor, `mar.${p.outcome}`, 'mar_dose', doseId, { patientId: o.patient_id, reason: p.note });
  });
}

/** PRN administration: a new occurrence row with no due time. */
export async function recordPrnDose(actor: Actor, tenant: Tenant, orderId: string, input: z.input<typeof doseInput>) {
  requireWard(tenant);
  authorize(actor, 'inpatient.nursing');
  const p = doseInput.parse(input);
  if (!p.patientConfirmed) throw rule('Confirm the patient’s identity band before recording a dose');
  return withTenant(tenant.id, async (tx) => {
    const o = await tx.one<{ status: string; prn: boolean; admission_id: string; patient_id: string }>(`SELECT status, prn, admission_id, patient_id FROM med_order WHERE id = $1 FOR UPDATE`, [orderId]);
    if (o.status !== 'active' || !o.prn) throw rule('Not an active “when needed” order');
    const recent = await tx.maybe(`SELECT 1 FROM mar_dose WHERE med_order_id = $1 AND status = 'given' AND given_at > now() - interval '1 hour'`, [orderId]);
    if (recent && !p.note?.trim()) throw rule('A dose was given within the last hour. Record the clinical reason to give another.');
    await tx.exec(`INSERT INTO mar_dose (tenant_id, med_order_id, admission_id, status, given_at, given_by, dose_given, note, witness_by, recorded_at)
                   VALUES (app_tenant_id(), $1,$2,$3, now(), $4,$5,$6,$7, now())`,
      [orderId, o.admission_id, p.outcome, staffId(actor), p.doseGiven ?? null, p.note ?? null, p.witnessStaffId ?? null]);
    await audit(tx, actor, `mar.prn_${p.outcome}`, 'med_order', orderId, { patientId: o.patient_id, reason: p.note });
  });
}

// ------------------------------------------------------------------ handover (HS-004)
export async function createHandover(actor: Actor, tenant: Tenant, admissionId: string, toStaffId: string, summary: string) {
  requireWard(tenant);
  authorize(actor, 'inpatient.nursing');
  if (!summary?.trim()) throw invalid('Write the handover summary');
  return withTenant(tenant.id, async (tx) => {
    const a = await lockAdmission(tx, admissionId);
    const id = (await tx.one<{ id: string }>(`INSERT INTO handover (tenant_id, admission_id, from_staff, to_staff, summary) VALUES (app_tenant_id(), $1,$2,$3,$4) RETURNING id`,
      [admissionId, staffId(actor), toStaffId, summary])).id;
    await audit(tx, actor, 'handover.created', 'handover', id, { patientId: a.patient_id });
    return id;
  });
}

export async function acceptHandover(actor: Actor, tenant: Tenant, handoverId: string) {
  authorize(actor, 'inpatient.nursing');
  return withTenant(tenant.id, async (tx) => {
    const n = await tx.exec(`UPDATE handover SET accepted_at = now() WHERE id = $1 AND to_staff = $2 AND accepted_at IS NULL`, [handoverId, staffId(actor)]);
    if (!n) throw rule('Only the receiving person can accept this handover');
    await audit(tx, actor, 'handover.accepted', 'handover', handoverId);
  });
}

// ------------------------------------------------------------------ discharge (CL-038)
export const dischargeSummaryInput = z.object({
  diagnosis: z.string().trim().min(3), courseInHospital: z.string().trim().min(3), conditionAtDischarge: z.string().trim().min(2),
  medicationsOnDischarge: z.string().max(4000).optional(), followUp: z.string().max(2000).optional(), instructions: z.string().max(4000).optional(),
});

/** Signs the discharge summary as an immutable clinical note on the admission's encounter. */
export async function signDischargeSummary(actor: Actor, tenant: Tenant, admissionId: string, input: z.input<typeof dischargeSummaryInput>) {
  requireWard(tenant);
  authorize(actor, 'inpatient.discharge');
  if (actor.kind !== 'staff' || !actor.clinicianId) throw new AppError('FORBIDDEN', 'A clinician must sign the discharge summary');
  const p = dischargeSummaryInput.parse(input);
  return withTenant(tenant.id, async (tx) => {
    const a = await lockAdmission(tx, admissionId);
    const content = { assessment: p.diagnosis, subjective: p.courseInHospital, objective: p.conditionAtDischarge, plan: [p.medicationsOnDischarge, p.followUp, p.instructions].filter(Boolean).join('\n\n'),
      discharge: p };
    const prev = await tx.maybe<{ id: string; version_no: number }>(`SELECT id, version_no FROM clinical_note WHERE id = (SELECT discharge_summary_id FROM admission WHERE id = $1)`, [admissionId]);
    const n = await tx.one<{ id: string }>(
      `INSERT INTO clinical_note (tenant_id, encounter_id, patient_id, author_id, content, note_type, status, version_no, supersedes_id, signed_by, signed_at, content_digest)
       VALUES (app_tenant_id(), $1,$2,$3,$4,'discharge','signed',$5,$6,$3, now(), $7) RETURNING id`,
      [a.encounter_id, a.patient_id, actor.staffId, JSON.stringify(content), (prev?.version_no ?? 0) + 1, prev?.id ?? null, sha256(canonicalJson(content))]);
    if (prev) await tx.exec(`UPDATE clinical_note SET status = 'superseded' WHERE id = $1`, [prev.id]);
    await tx.exec(`UPDATE admission SET discharge_summary_id = $2, version = version + 1 WHERE id = $1`, [admissionId, n.id]);
    await audit(tx, actor, 'discharge_summary.signed', 'admission', admissionId, { patientId: a.patient_id });
    return n.id;
  });
}

/** Bed-day charges: one per local calendar day occupied (admission day counted, discharge day not), by bed rate. */
async function captureBedCharges(tx: Tx, tenant: Tenant, actor: Actor, admissionId: string, patientId: string, until: Date) {
  const stays = await tx.many<{ start: Date; end: Date | null; code: string; rate: number; category: string }>(
    `SELECT lower(s.period) AS start, upper(s.period) AS end, b.code, b.daily_rate_paise AS rate, b.category FROM bed_stay s JOIN bed b ON b.id = s.bed_id WHERE s.admission_id = $1 ORDER BY lower(s.period)`, [admissionId]);
  const days = new Map<string, { rate: number; code: string; category: string }>();
  const next = (d: string) => { const x = new Date(`${d}T12:00:00Z`); x.setUTCDate(x.getUTCDate() + 1); return x.toISOString().slice(0, 10); };
  for (const s of stays) {
    const endDay = localDay(s.end ?? until, tenant.timezone);
    for (let d = localDay(s.start, tenant.timezone); d < endDay; d = next(d)) days.set(d, { rate: Number(s.rate), code: s.code, category: s.category });
  }
  // A same-day admission and discharge is charged as one day.
  if (!days.size && stays.length) days.set(localDay(stays[0].start, tenant.timezone), { rate: Number(stays[0].rate), code: stays[0].code, category: stays[0].category });
  for (const [day, v] of days) {
    if (v.rate <= 0) continue;
    await tx.exec(`INSERT INTO charge_item (tenant_id, patient_id, description, unit_price_paise, source_key, created_by) VALUES (app_tenant_id(), $1,$2,$3,$4,$5)
                   ON CONFLICT (tenant_id, source_key) DO NOTHING`,
      [patientId, `Bed ${v.code} (${v.category}) — ${day}`, v.rate, `bedday:${admissionId}:${day}`, staffId(actor)]);
  }
  return days.size;
}

export const dischargeInput = z.object({
  disposition: z.enum(['home', 'referred', 'lama', 'absconded', 'death', 'transferred_out']),
  financialClearance: z.string().max(300).optional(),
});

/**
 * Discharge requires: a signed discharge summary (except LAMA/absconded/death, where the reason is recorded),
 * all active medication orders stopped, and financial clearance — bills settled, or a named authorisation for credit.
 */
export async function discharge(actor: Actor, tenant: Tenant, admissionId: string, input: z.input<typeof dischargeInput>) {
  requireWard(tenant);
  authorize(actor, 'inpatient.discharge');
  const p = dischargeInput.parse(input);
  return withTenant(tenant.id, async (tx) => {
    const a = await lockAdmission(tx, admissionId);
    const adm = await tx.one<{ discharge_summary_id: string | null }>(`SELECT discharge_summary_id FROM admission WHERE id = $1`, [admissionId]);
    if (!adm.discharge_summary_id && !['lama', 'absconded', 'death'].includes(p.disposition)) throw rule('Sign the discharge summary first');
    const active = await tx.one<{ n: number }>(`SELECT count(*)::int AS n FROM med_order WHERE admission_id = $1 AND status = 'active'`, [admissionId]);
    if (active.n > 0) throw rule(`Stop or reconcile ${active.n} active medication order(s) before discharge`);
    const now = new Date();
    await captureBedCharges(tx, tenant, actor, admissionId, a.patient_id, now);
    const owed = await tx.one<{ unbilled: number; due: number }>(
      `SELECT (SELECT COALESCE(sum(unit_price_paise * quantity - discount_paise), 0) FROM charge_item WHERE patient_id = $1 AND status = 'unbilled')::bigint AS unbilled,
              (SELECT COALESCE(sum(due_paise), 0) FROM invoice_balance WHERE patient_id = $1 AND status = 'posted')::bigint AS due`, [a.patient_id]);
    const outstanding = Number(owed.unbilled) + Number(owed.due);
    if (outstanding > 0 && !p.financialClearance?.trim() && !['death', 'absconded', 'lama'].includes(p.disposition)) {
      throw new AppError('RULE_VIOLATION', `Outstanding amount ${(outstanding / 100).toFixed(2)} — bill and collect, or record who authorised discharge on credit.`, { outstandingPaise: outstanding });
    }
    await tx.exec(`UPDATE bed_stay SET period = tstzrange(lower(period), $2, '[)') WHERE admission_id = $1 AND upper_inf(period)`, [admissionId, now]);
    await tx.exec(`UPDATE bed SET status = 'cleaning' WHERE id IN (SELECT bed_id FROM bed_stay WHERE admission_id = $1 AND upper(period) = $2)`, [admissionId, now]);
    await tx.exec(`UPDATE mar_dose SET status = 'superseded' WHERE admission_id = $1 AND status = 'due'`, [admissionId]);
    await tx.exec(`UPDATE admission SET status = 'discharged', discharged_at = $2, disposition = $3, financial_clearance = $4, version = version + 1 WHERE id = $1`,
      [admissionId, now, p.disposition, outstanding > 0 ? `Credit authorised: ${p.financialClearance ?? p.disposition}` : 'Settled']);
    await tx.exec(`UPDATE encounter SET status = 'completed', ended_at = $2 WHERE id = (SELECT encounter_id FROM admission WHERE id = $1)`, [admissionId, now]);
    await audit(tx, actor, 'admission.discharged', 'admission', admissionId, { patientId: a.patient_id, reason: p.financialClearance, data: { disposition: p.disposition, outstanding } });
    await emit(tx, 'patient.discharged', 'admission', admissionId, { disposition: p.disposition });
    return { outstandingPaise: outstanding };
  });
}

/** A day-care patient who must stay overnight becomes an inpatient: same admission, bed and orders; audited. */
export async function convertToInpatient(actor: Actor, tenant: Tenant, admissionId: string, reason: string) {
  requireModule(tenant, 'inpatient');
  authorize(actor, 'inpatient.admit');
  if (!reason?.trim() || reason.trim().length < 5) throw invalid('Give the clinical reason for the overnight stay');
  return withTenant(tenant.id, async (tx) => {
    const a = await lockAdmission(tx, admissionId);
    const cur = await tx.one<{ care_type: string; admission_no: string }>(`SELECT care_type, admission_no FROM admission WHERE id = $1`, [admissionId]);
    if (cur.care_type !== 'daycare') throw rule('This is already an inpatient admission');
    await tx.exec(`UPDATE admission SET care_type='inpatient', converted_at=now(), converted_reason=$2, expected_discharge=NULL, version=version+1 WHERE id=$1`, [admissionId, reason.trim()]);
    await audit(tx, actor, 'admission.converted_to_inpatient', 'admission', admissionId, { patientId: a.patient_id, reason });
    return { admissionNo: cur.admission_no };
  });
}

/** Day-care board: today's day-care patients, flagged when past their expected discharge time. */
export async function dayCareBoard(actor: Actor, tenant: Tenant) {
  requireModule(tenant, 'daycare');
  authorize(actor, 'clinical.read');
  return withTenant(tenant.id, (tx) => tx.many<{ id: string; admission_no: string; patient_id: string; full_name: string; uhid: string; reason: string; admitted_at: Date;
    planned_end_at: Date | null; bed: string | null; overdue: boolean; status: string; discharged_at: Date | null; summary_signed: boolean }>(
    `SELECT a.id, a.admission_no, a.patient_id, p.full_name, p.uhid, a.reason, a.admitted_at, a.planned_end_at, a.status, a.discharged_at,
            (SELECT b.code FROM bed_stay s JOIN bed b ON b.id = s.bed_id WHERE s.admission_id = a.id ORDER BY lower(s.period) DESC LIMIT 1) AS bed,
            (a.status = 'admitted' AND a.planned_end_at < now()) AS overdue, a.discharge_summary_id IS NOT NULL AS summary_signed
       FROM admission a JOIN patient p ON p.id = a.patient_id
      WHERE a.care_type = 'daycare' AND (a.status = 'admitted' OR (a.admitted_at AT TIME ZONE $1)::date = (now() AT TIME ZONE $1)::date)
      ORDER BY a.status, a.planned_end_at`, [tenant.timezone]));
}

// ------------------------------------------------------------------ reads
export async function admissionDetail(actor: Actor, tenant: Tenant, admissionId: string) {
  requireWard(tenant);
  authorize(actor, 'clinical.read');
  return withTenant(tenant.id, async (tx) => {
    const a = await tx.maybe<{ id: string; admission_no: string; patient_id: string; encounter_id: string; status: string; reason: string; admitted_at: Date; discharged_at: Date | null;
      disposition: string | null; expected_discharge: string | null; clinician: string; department: string; discharge_summary_id: string | null; financial_clearance: string | null;
      care_type: string; planned_end_at: Date | null; converted_reason: string | null }>(
      `SELECT a.*, c.display_name AS clinician, d.name AS department FROM admission a JOIN clinician c ON c.id = a.admitting_clinician_id JOIN department d ON d.id = a.department_id WHERE a.id = $1`, [admissionId]);
    if (!a) throw notFound('Admission');
    await assertChartAccess(tx, actor, tenant, a.patient_id);
    const orders = await tx.many<{ id: string; drug_name: string; dose: string; route: string; schedule_times: string[]; prn: boolean; prn_indication: string | null; status: string; start_at: Date; stop_at: Date | null; stop_reason: string | null; instructions: string | null }>(
      `SELECT * FROM med_order WHERE admission_id = $1 ORDER BY (status = 'active') DESC, start_at DESC`, [admissionId]);
    for (const o of orders.filter((x) => x.status === 'active')) await materialiseDoses(tx, tenant.timezone, o.id);
    await tx.exec(`UPDATE mar_dose SET status = 'missed' WHERE admission_id = $1 AND status = 'due' AND due_at < now() - interval '2 hours'`, [admissionId]);
    const doses = await tx.many<{ id: string; med_order_id: string; due_at: Date | null; status: string; given_at: Date | null; given_by_name: string | null; dose_given: string | null; note: string | null }>(
      `SELECT m.*, s.full_name AS given_by_name FROM mar_dose m LEFT JOIN staff s ON s.id = m.given_by
        WHERE m.admission_id = $1 AND (m.due_at IS NULL OR m.due_at BETWEEN now() - interval '24 hours' AND now() + interval '24 hours' OR m.given_at > now() - interval '24 hours')
        ORDER BY COALESCE(m.due_at, m.given_at)`, [admissionId]);
    const stays = await tx.many<{ code: string; ward: string; start: Date; end: Date | null; reason: string | null }>(
      `SELECT b.code, w.name AS ward, lower(s.period) AS start, upper(s.period) AS end, s.reason FROM bed_stay s JOIN bed b ON b.id = s.bed_id JOIN location w ON w.id = b.ward_id
        WHERE s.admission_id = $1 ORDER BY lower(s.period)`, [admissionId]);
    const handovers = await tx.many<{ id: string; summary: string; created_at: Date; accepted_at: Date | null; from_name: string; to_name: string; to_staff: string }>(
      `SELECT h.*, f.full_name AS from_name, t.full_name AS to_name FROM handover h JOIN staff f ON f.id = h.from_staff JOIN staff t ON t.id = h.to_staff WHERE h.admission_id = $1 ORDER BY h.created_at DESC`, [admissionId]);
    const summary = a.discharge_summary_id ? await tx.maybe<{ content: { discharge?: Record<string, string> }; signed_at: Date; version_no: number }>(
      `SELECT content, signed_at, version_no FROM clinical_note WHERE id = $1`, [a.discharge_summary_id]) : null;
    await audit(tx, actor, 'admission.viewed', 'admission', admissionId, { patientId: a.patient_id });
    return { admission: a, orders, doses, stays, handovers, summary };
  });
}

export async function activeAdmissions(tenantId: string) {
  return withTenant(tenantId, (tx) => tx.many<{ id: string; patient_id: string; admission_no: string }>(`SELECT id, patient_id, admission_no FROM admission WHERE status = 'admitted'`));
}
