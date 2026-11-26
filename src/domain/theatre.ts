import { z } from 'zod';
import { withTenant, type Tx } from '@/lib/db';
import { AppError, invalid, notFound, rule } from '@/lib/errors';
import { authorize, staffId, type Actor } from '@/lib/actor';
import { audit, emit } from '@/lib/events';
import { canonicalJson, sha256 } from '@/lib/crypto';
import { requireModule, type Tenant } from './tenants';
import { assertChartAccess } from './access';

/* ======================================================================= theatres */
export async function upsertTheatre(actor: Actor, tenant: Tenant, t: { id?: string; code: string; name: string; hourlyRatePaise: number; turnoverMinutes: number; active?: boolean }) {
  requireModule(tenant, 'theatre');
  authorize(actor, 'settings.manage');
  if (!t.code.trim() || !t.name.trim()) throw invalid('Give a code and a name');
  if (!Number.isInteger(t.hourlyRatePaise) || t.hourlyRatePaise < 0) throw invalid('Hourly rate must be zero or more');
  return withTenant(tenant.id, async (tx) => {
    const r = t.id
      ? await tx.one<{ id: string }>(`UPDATE theatre SET code=$2, name=$3, hourly_rate_paise=$4, turnover_minutes=$5, active=$6 WHERE id=$1 RETURNING id`,
        [t.id, t.code.trim(), t.name.trim(), t.hourlyRatePaise, t.turnoverMinutes, t.active ?? true])
      : await tx.one<{ id: string }>(`INSERT INTO theatre (tenant_id, code, name, hourly_rate_paise, turnover_minutes) VALUES (app_tenant_id(), $1,$2,$3,$4) RETURNING id`,
        [t.code.trim(), t.name.trim(), t.hourlyRatePaise, t.turnoverMinutes]);
    await audit(tx, actor, 'theatre.saved', 'theatre', r.id, { data: t });
    return r.id;
  });
}

export async function listTheatres(actor: Actor, tenant: Tenant) {
  return withTenant(tenant.id, (tx) => tx.many<{ id: string; code: string; name: string; hourly_rate_paise: string; turnover_minutes: number; active: boolean }>(
    `SELECT * FROM theatre ORDER BY active DESC, code`));
}

/* ======================================================================= scheduling */
export const caseInput = z.object({
  patientId: z.uuid(), theatreId: z.uuid(), surgeonId: z.uuid(), anaesthetistId: z.uuid().nullish(), admissionId: z.uuid().nullish(),
  procedureName: z.string().trim().min(3).max(300), laterality: z.enum(['left', 'right', 'bilateral', 'na']),
  anaesthesia: z.enum(['general', 'spinal', 'epidural', 'regional_block', 'local', 'sedation', 'none']).default('general'),
  priority: z.enum(['elective', 'urgent', 'emergency']).default('elective'), serviceId: z.uuid().nullish(),
  start: z.iso.datetime({ offset: true }), durationMin: z.number().int().min(10).max(16 * 60), notes: z.string().max(1000).optional(),
});

const CLASH: Record<string, string> = {
  surgery_theatre_excl: 'The theatre is already booked (including cleaning time) for part of that slot',
  surgery_surgeon_excl: 'The surgeon is already operating at that time',
  surgery_anaesthetist_excl: 'The anaesthetist is already booked at that time',
  surgery_patient_excl: 'This patient already has an operation at that time',
};
function clash(e: unknown): never {
  if (e instanceof AppError && e.code === 'SLOT_TAKEN') {
    const c = (e.details as { constraint?: string } | undefined)?.constraint;
    throw new AppError('SLOT_TAKEN', CLASH[c ?? ''] ?? e.message);
  }
  throw e;
}

export async function scheduleCase(actor: Actor, tenant: Tenant, input: z.input<typeof caseInput>) {
  requireModule(tenant, 'theatre');
  authorize(actor, 'theatre.schedule');
  const r = caseInput.safeParse(input);
  if (!r.success) throw invalid('Check the operation details', r.error.issues);
  const p = r.data;
  if (p.anaesthetistId && p.anaesthetistId === p.surgeonId) throw invalid('Surgeon and anaesthetist must be different people');
  if (['general', 'spinal', 'epidural', 'regional_block', 'sedation'].includes(p.anaesthesia) && !p.anaesthetistId) throw invalid('Name the anaesthetist for this type of anaesthesia');
  const start = new Date(p.start);
  if (p.priority === 'elective' && start.getTime() < Date.now() - 5 * 60_000) throw invalid('Elective operations cannot be scheduled in the past');
  return withTenant(tenant.id, async (tx) => {
    const pt = await tx.maybe<{ status: string }>(`SELECT status FROM patient WHERE id = $1`, [p.patientId]);
    if (!pt || pt.status === 'merged') throw notFound('Patient');
    await assertChartAccess(tx, actor, tenant, p.patientId);
    const th = await tx.maybe<{ active: boolean; turnover_minutes: number }>(`SELECT active, turnover_minutes FROM theatre WHERE id = $1`, [p.theatreId]);
    if (!th?.active) throw rule('That theatre is not in use');
    if (p.admissionId) {
      const a = await tx.maybe<{ patient_id: string; status: string }>(`SELECT patient_id, status FROM admission WHERE id = $1`, [p.admissionId]);
      if (!a || a.patient_id !== p.patientId || a.status !== 'admitted') throw rule('The admission must be active and belong to this patient');
    }
    const end = new Date(start.getTime() + p.durationMin * 60_000);
    const blockedEnd = new Date(end.getTime() + th.turnover_minutes * 60_000);
    const n = await tx.one<{ v: number }>(`SELECT next_doc_number('surgery') AS v`);
    const caseNo = `OT${String(n.v).padStart(6, '0')}`;
    const row = await tx.one<{ id: string }>(
      `INSERT INTO surgery_case (tenant_id, case_no, patient_id, admission_id, theatre_id, surgeon_id, anaesthetist_id, procedure_name, laterality, anaesthesia, priority, service_id,
         planned, blocked, notes, created_by)
       VALUES (app_tenant_id(), $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11, tstzrange($12,$13,'[)'), tstzrange($12,$14,'[)'), $15,$16) RETURNING id`,
      [caseNo, p.patientId, p.admissionId ?? null, p.theatreId, p.surgeonId, p.anaesthetistId ?? null, p.procedureName, p.laterality, p.anaesthesia, p.priority,
        p.serviceId ?? null, start, end, blockedEnd, p.notes ?? null, staffId(actor)]).catch(clash);
    await audit(tx, actor, 'surgery.scheduled', 'surgery_case', row.id, { patientId: p.patientId, data: { caseNo, procedure: p.procedureName, start: p.start } });
    return { caseId: row.id, caseNo };
  });
}

export async function rescheduleCase(actor: Actor, tenant: Tenant, caseId: string, s: { start: string; durationMin: number; theatreId?: string; reason: string }) {
  requireModule(tenant, 'theatre');
  authorize(actor, 'theatre.schedule');
  if (!s.reason?.trim()) throw invalid('Give a reason');
  return withTenant(tenant.id, async (tx) => {
    const c = await lockCase(tx, caseId);
    if (c.status !== 'scheduled') throw rule('Only a scheduled case can be moved');
    const theatreId = s.theatreId ?? c.theatre_id;
    const th = await tx.one<{ active: boolean; turnover_minutes: number }>(`SELECT active, turnover_minutes FROM theatre WHERE id = $1`, [theatreId]);
    if (!th.active) throw rule('That theatre is not in use');
    const start = new Date(s.start); const end = new Date(start.getTime() + s.durationMin * 60_000);
    await tx.exec(`UPDATE surgery_case SET theatre_id=$2, planned=tstzrange($3,$4,'[)'), blocked=tstzrange($3,$5,'[)'), version=version+1 WHERE id=$1`,
      [caseId, theatreId, start, end, new Date(end.getTime() + th.turnover_minutes * 60_000)]).catch(clash);
    await audit(tx, actor, 'surgery.rescheduled', 'surgery_case', caseId, { patientId: c.patient_id, reason: s.reason, data: { start: s.start } });
  });
}

export async function cancelCase(actor: Actor, tenant: Tenant, caseId: string, reason: string) {
  authorize(actor, 'theatre.schedule');
  if (!reason?.trim()) throw invalid('Give a reason');
  return withTenant(tenant.id, async (tx) => {
    const c = await lockCase(tx, caseId);
    if (c.status !== 'scheduled') throw rule(c.status === 'in_theatre' ? 'The patient is already in theatre; complete or abandon the case in the operation note instead' : 'This case is already closed');
    const used = await tx.one<{ n: number }>(`SELECT count(*)::int AS n FROM surgery_consumable WHERE case_id = $1 AND status = 'used'`, [caseId]);
    if (used.n) throw rule('Return the recorded consumables first');
    await tx.exec(`UPDATE surgery_case SET status='cancelled', cancel_reason=$2, version=version+1 WHERE id=$1`, [caseId, reason.trim()]);
    await audit(tx, actor, 'surgery.cancelled', 'surgery_case', caseId, { patientId: c.patient_id, reason });
  });
}

type CaseRow = { id: string; case_no: string; patient_id: string; admission_id: string | null; theatre_id: string; surgeon_id: string; anaesthetist_id: string | null; status: string;
  procedure_name: string; laterality: string; service_id: string | null; wheels_in_at: Date | null; incision_at: Date | null; closure_at: Date | null; wheels_out_at: Date | null; consent_confirmed: boolean };
async function lockCase(tx: Tx, caseId: string) {
  const c = await tx.maybe<CaseRow>(`SELECT * FROM surgery_case WHERE id = $1 FOR UPDATE`, [caseId]);
  if (!c) throw notFound('Operation');
  return c;
}

/* ======================================================================= WHO Surgical Safety Checklist
 * Items follow the WHO Surgical Safety Checklist (2009). WHO encourages local adaptation; changes to this list
 * should be agreed by the clinic's surgical and anaesthesia leads.
 */
type Item = { key: string; text: string; allowed: string[]; mustBe?: string[]; requiresIfYes?: string };
export const CHECKLIST: Record<'sign_in' | 'time_out' | 'sign_out', { title: string; when: string; items: Item[] }> = {
  sign_in: { title: 'Sign in', when: 'Before induction of anaesthesia', items: [
    { key: 'identity_site_procedure_consent', text: 'Patient has confirmed identity, site, procedure and consent', allowed: ['yes', 'no'], mustBe: ['yes'] },
    { key: 'site_marked', text: 'Site marked', allowed: ['yes', 'na', 'no'], mustBe: ['yes', 'na'] },
    { key: 'anaesthesia_check', text: 'Anaesthesia machine and medication check complete', allowed: ['yes', 'no'], mustBe: ['yes'] },
    { key: 'pulse_oximeter', text: 'Pulse oximeter on patient and functioning', allowed: ['yes', 'no'], mustBe: ['yes'] },
    { key: 'known_allergy', text: 'Does the patient have a known allergy?', allowed: ['no', 'yes'] },
    { key: 'difficult_airway', text: 'Difficult airway or aspiration risk?', allowed: ['no', 'yes'], requiresIfYes: 'airway_equipment' },
    { key: 'airway_equipment', text: 'If yes: equipment and assistance available', allowed: ['yes', 'no', 'na'] },
    { key: 'blood_loss_risk', text: 'Risk of >500 ml blood loss (7 ml/kg in children)?', allowed: ['no', 'yes'], requiresIfYes: 'iv_access_fluids' },
    { key: 'iv_access_fluids', text: 'If yes: two IVs / central access and fluids planned', allowed: ['yes', 'no', 'na'] },
  ] },
  time_out: { title: 'Time out', when: 'Before skin incision', items: [
    { key: 'team_introduced', text: 'All team members have introduced themselves by name and role', allowed: ['yes', 'no'], mustBe: ['yes'] },
    { key: 'confirmed_patient_site_procedure', text: 'Surgeon, anaesthetist and nurse confirm patient, site and procedure', allowed: ['yes', 'no'], mustBe: ['yes'] },
    { key: 'antibiotic_prophylaxis', text: 'Antibiotic prophylaxis given within the last 60 minutes', allowed: ['yes', 'na', 'no'], mustBe: ['yes', 'na'] },
    { key: 'surgeon_critical_steps', text: 'Surgeon reviewed critical or non-routine steps, duration and anticipated blood loss', allowed: ['yes', 'no'], mustBe: ['yes'] },
    { key: 'anaesthesia_concerns', text: 'Anaesthesia team reviewed patient-specific concerns', allowed: ['yes', 'no'], mustBe: ['yes'] },
    { key: 'sterility_equipment', text: 'Nursing confirmed sterility (including indicator results) and equipment issues', allowed: ['yes', 'no'], mustBe: ['yes'] },
    { key: 'imaging_displayed', text: 'Essential imaging displayed', allowed: ['yes', 'na', 'no'], mustBe: ['yes', 'na'] },
  ] },
  sign_out: { title: 'Sign out', when: 'Before the patient leaves the operating room', items: [
    { key: 'procedure_recorded', text: 'Name of the procedure recorded', allowed: ['yes', 'no'], mustBe: ['yes'] },
    { key: 'counts', text: 'Instrument, sponge and needle counts', allowed: ['correct', 'incorrect', 'na'] },
    { key: 'specimen_labelled', text: 'Specimen labelled (read aloud, including patient name)', allowed: ['yes', 'na', 'no'], mustBe: ['yes', 'na'] },
    { key: 'equipment_problems', text: 'Any equipment problems to be addressed', allowed: ['none', 'yes'] },
    { key: 'recovery_concerns', text: 'Surgeon, anaesthetist and nurse reviewed key concerns for recovery', allowed: ['yes', 'no'], mustBe: ['yes'] },
  ] },
};
export type Phase = keyof typeof CHECKLIST;
const ORDER: Phase[] = ['sign_in', 'time_out', 'sign_out'];

export async function recordChecklist(actor: Actor, tenant: Tenant, caseId: string, phase: Phase, answers: Record<string, string>, opts: { concerns?: string; team?: string } = {}) {
  requireModule(tenant, 'theatre');
  authorize(actor, 'theatre.checklist');
  const def = CHECKLIST[phase];
  if (!def) throw invalid('Unknown checklist phase');
  const problems: string[] = [];
  for (const it of def.items) {
    const a = answers[it.key];
    if (!a || !it.allowed.includes(a)) { problems.push(`Answer “${it.text}”`); continue; }
    if (it.mustBe && !it.mustBe.includes(a)) problems.push(`Stop: “${it.text}” must be ${it.mustBe.join(' or ')} before continuing`);
    if (it.requiresIfYes && a === 'yes' && answers[it.requiresIfYes] !== 'yes') problems.push(`Stop: ${CHECKLIST[phase].items.find((x) => x.key === it.requiresIfYes)!.text}`);
  }
  if (phase === 'sign_out' && answers.counts === 'incorrect' && (opts.concerns?.trim().length ?? 0) < 10) problems.push('Counts are incorrect: record what was done (recount, imaging, escalation) in the concerns box');
  if (phase === 'sign_out' && answers.equipment_problems === 'yes' && !opts.concerns?.trim()) problems.push('Describe the equipment problem');
  if (problems.length) throw new AppError('RULE_VIOLATION', problems[0], { problems });
  return withTenant(tenant.id, async (tx) => {
    const c = await lockCase(tx, caseId);
    if (['completed', 'cancelled'].includes(c.status)) throw rule('This case is closed');
    const done = (await tx.many<{ phase: Phase }>(`SELECT phase FROM surgery_checklist WHERE case_id = $1`, [caseId])).map((r) => r.phase);
    const need = ORDER.slice(0, ORDER.indexOf(phase));
    const missing = need.find((ph) => !done.includes(ph));
    if (missing) throw rule(`Complete “${CHECKLIST[missing].title}” first`);
    if (done.includes(phase)) throw rule(`${def.title} is already recorded`);
    if (phase === 'sign_out' && !c.closure_at) throw rule('Record the closure time first');
    await tx.exec(`INSERT INTO surgery_checklist (tenant_id, case_id, phase, answers, concerns, team, completed_by) VALUES (app_tenant_id(), $1,$2,$3,$4,$5,$6)`,
      [caseId, phase, JSON.stringify(answers), opts.concerns?.trim() || null, opts.team?.trim() || null, staffId(actor)]);
    if (phase === 'sign_in') {
      await tx.exec(`UPDATE surgery_case SET status='in_theatre', consent_confirmed=true, wheels_in_at=COALESCE(wheels_in_at, now()), version=version+1 WHERE id=$1`, [caseId]);
    }
    await audit(tx, actor, `surgery.${phase}`, 'surgery_case', caseId, { patientId: c.patient_id, data: { answers, concerns: opts.concerns } });
    if (phase === 'sign_out' && answers.counts === 'incorrect') await emit(tx, 'surgery.count_discrepancy', 'surgery_case', caseId, { caseNo: c.case_no });
  });
}

export async function markTime(actor: Actor, tenant: Tenant, caseId: string, which: 'incision' | 'closure' | 'wheels_out', at?: string) {
  requireModule(tenant, 'theatre');
  authorize(actor, 'theatre.checklist');
  const when = at ? new Date(at) : new Date();
  if (Number.isNaN(when.getTime()) || when.getTime() > Date.now() + 5 * 60_000) throw invalid('Give a valid time, not in the future');
  return withTenant(tenant.id, async (tx) => {
    const c = await lockCase(tx, caseId);
    if (c.status !== 'in_theatre') throw rule('The patient is not in theatre');
    const phases = (await tx.many<{ phase: Phase }>(`SELECT phase FROM surgery_checklist WHERE case_id = $1`, [caseId])).map((r) => r.phase);
    if (which === 'incision') {
      if (!phases.includes('time_out')) throw rule('Complete the Time out before incision');
      if (c.incision_at) throw rule('Incision time is already recorded');
      await tx.exec(`UPDATE surgery_case SET incision_at=$2 WHERE id=$1`, [caseId, when]);
    } else if (which === 'closure') {
      if (!c.incision_at) throw rule('Record the incision first');
      if (when < c.incision_at) throw invalid('Closure cannot be before incision');
      await tx.exec(`UPDATE surgery_case SET closure_at=$2 WHERE id=$1`, [caseId, when]);
    } else {
      if (!phases.includes('sign_out')) throw rule('Complete the Sign out before the patient leaves theatre');
      await tx.exec(`UPDATE surgery_case SET wheels_out_at=$2 WHERE id=$1`, [caseId, when]);
    }
    await audit(tx, actor, `surgery.time_${which}`, 'surgery_case', caseId, { patientId: c.patient_id, data: { at: when.toISOString() } });
  });
}

/* ======================================================================= consumables & implants */
export async function recordConsumable(actor: Actor, tenant: Tenant, caseId: string, u: { lotId: string; locationId: string; qty: number; implantSerial?: string }) {
  requireModule(tenant, 'theatre');
  authorize(actor, 'theatre.checklist');
  if (!Number.isInteger(u.qty) || u.qty <= 0) throw invalid('Quantity must be a whole number above zero');
  return withTenant(tenant.id, async (tx) => {
    const c = await lockCase(tx, caseId);
    if (!['scheduled', 'in_theatre'].includes(c.status)) throw rule('Consumables can only be recorded before the case is completed');
    const lot = await tx.maybe<{ product_id: string; status: string; expiry_date: string; batch_no: string; name: string; price: string; tax: number }>(
      `SELECT l.product_id, l.status, l.expiry_date::text, l.batch_no, p.generic_name || COALESCE(' ' || p.strength, '') AS name, p.sale_price_paise AS price, p.tax_rate_bp AS tax
         FROM lot l JOIN product p ON p.id = l.product_id WHERE l.id = $1`, [u.lotId]);
    if (!lot) throw notFound('Batch');
    if (lot.status !== 'released') throw rule(`Batch ${lot.batch_no} is ${lot.status} and must not be used`);
    const today = new Date().toLocaleDateString('en-CA', { timeZone: tenant.timezone });
    if (lot.expiry_date < today) throw rule(`Batch ${lot.batch_no} expired on ${lot.expiry_date}`);
    const n = await tx.exec(`UPDATE stock_balance SET qty = qty - $3 WHERE lot_id = $1 AND location_id = $2 AND qty >= $3`, [u.lotId, u.locationId, u.qty]);
    if (!n) throw rule('Not enough stock of this batch in that store');
    const row = await tx.one<{ id: string }>(
      `INSERT INTO surgery_consumable (tenant_id, case_id, product_id, lot_id, location_id, qty, implant_serial, recorded_by) VALUES (app_tenant_id(), $1,$2,$3,$4,$5,$6,$7) RETURNING id`,
      [caseId, lot.product_id, u.lotId, u.locationId, u.qty, u.implantSerial?.trim() || null, staffId(actor)]);
    await tx.exec(`INSERT INTO stock_move (tenant_id, kind, lot_id, location_id, qty_delta, ref_kind, ref_id, reason, by_staff) VALUES (app_tenant_id(), 'ward_supply', $1,$2,$3,'surgery_case',$4,$5,$6)`,
      [u.lotId, u.locationId, -u.qty, caseId, `Theatre ${c.case_no}`, staffId(actor)]);
    if (Number(lot.price) > 0) {
      await tx.exec(`INSERT INTO charge_item (tenant_id, patient_id, description, quantity, unit_price_paise, tax_rate_bp, source_key, created_by) VALUES (app_tenant_id(), $1,$2,$3,$4,$5,$6,$7)`,
        [c.patient_id, `${lot.name} (batch ${lot.batch_no}${u.implantSerial ? `, serial ${u.implantSerial}` : ''}) — ${c.case_no}`, u.qty, lot.price, lot.tax, `otitem:${row.id}`, staffId(actor)]);
    }
    await audit(tx, actor, 'surgery.consumable_used', 'surgery_case', caseId, { patientId: c.patient_id, data: { lot: lot.batch_no, qty: u.qty, serial: u.implantSerial } });
    return row.id;
  });
}

export async function returnConsumable(actor: Actor, tenant: Tenant, consumableId: string, reason: string) {
  authorize(actor, 'theatre.checklist');
  if (!reason?.trim()) throw invalid('Give a reason');
  return withTenant(tenant.id, async (tx) => {
    const u = await tx.maybe<{ case_id: string; lot_id: string; location_id: string; qty: number; status: string }>(`SELECT * FROM surgery_consumable WHERE id = $1 FOR UPDATE`, [consumableId]);
    if (!u || u.status !== 'used') throw notFound('Consumable');
    const c = await lockCase(tx, u.case_id);
    if (!['scheduled', 'in_theatre'].includes(c.status)) throw rule('The case is closed; correct this through billing and a stock adjustment');
    const ch = await tx.maybe<{ status: string }>(`SELECT status FROM charge_item WHERE source_key = $1`, [`otitem:${consumableId}`]);
    if (ch && ch.status !== 'unbilled') throw rule('This item is already billed; issue a credit through billing');
    await tx.exec(`UPDATE charge_item SET status = 'voided' WHERE source_key = $1 AND status = 'unbilled'`, [`otitem:${consumableId}`]);
    await tx.exec(`UPDATE stock_balance SET qty = qty + $3 WHERE lot_id = $1 AND location_id = $2`, [u.lot_id, u.location_id, u.qty]);
    await tx.exec(`INSERT INTO stock_move (tenant_id, kind, lot_id, location_id, qty_delta, ref_kind, ref_id, reason, by_staff) VALUES (app_tenant_id(), 'return', $1,$2,$3,'surgery_case',$4,$5,$6)`,
      [u.lot_id, u.location_id, u.qty, u.case_id, reason.trim(), staffId(actor)]);
    await tx.exec(`UPDATE surgery_consumable SET status = 'returned' WHERE id = $1`, [consumableId]);
    await audit(tx, actor, 'surgery.consumable_returned', 'surgery_case', u.case_id, { patientId: c.patient_id, reason });
  });
}

/* ======================================================================= operation note */
export const opNoteInput = z.object({
  preOpDiagnosis: z.string().max(1000).default(''), postOpDiagnosis: z.string().max(1000).default(''),
  procedurePerformed: z.string().max(1000).default(''), assistants: z.string().max(300).default(''),
  indication: z.string().max(2000).default(''), findings: z.string().max(4000).default(''), technique: z.string().max(8000).default(''),
  bloodLossMl: z.number().int().min(0).max(20000).nullable().default(null), specimens: z.string().max(1000).default(''),
  implants: z.string().max(1000).default(''), drains: z.string().max(500).default(''), complications: z.string().max(2000).default(''),
  postOpInstructions: z.string().max(4000).default(''),
});
export type OpNote = z.infer<typeof opNoteInput>;

export async function saveOpNote(actor: Actor, tenant: Tenant, caseId: string, input: z.input<typeof opNoteInput>) {
  requireModule(tenant, 'theatre');
  authorize(actor, 'clinical.write');
  const p = opNoteInput.safeParse(input);
  if (!p.success) throw invalid('Check the operation note', p.error.issues);
  return withTenant(tenant.id, async (tx) => {
    const c = await lockCase(tx, caseId);
    if (c.status === 'cancelled' || c.status === 'scheduled') throw rule('Write the operation note once the patient is in theatre');
    const cur = await tx.maybe<{ status: string }>(`SELECT status FROM operation_note WHERE case_id = $1 FOR UPDATE`, [caseId]);
    if (cur?.status === 'signed') throw rule('The operation note is signed');
    if (cur) await tx.exec(`UPDATE operation_note SET content=$2, updated_at=now() WHERE case_id=$1`, [caseId, JSON.stringify(p.data)]);
    else await tx.exec(`INSERT INTO operation_note (tenant_id, case_id, content, author_id) VALUES (app_tenant_id(), $1,$2,$3)`, [caseId, JSON.stringify(p.data), staffId(actor)]);
  });
}

export async function signOpNote(actor: Actor, tenant: Tenant, caseId: string) {
  requireModule(tenant, 'theatre');
  authorize(actor, 'clinical.sign');
  if (actor.kind !== 'staff' || !actor.clinicianId) throw new AppError('FORBIDDEN', 'Only a clinician can sign');
  return withTenant(tenant.id, async (tx) => {
    const c = await lockCase(tx, caseId);
    if (actor.clinicianId !== c.surgeon_id) throw rule('The operating surgeon signs the operation note');
    const n = await tx.maybe<{ content: OpNote; status: string }>(`SELECT content, status FROM operation_note WHERE case_id = $1 FOR UPDATE`, [caseId]);
    if (!n) throw rule('Write the operation note first');
    if (n.status === 'signed') throw rule('Already signed');
    const missing = (['postOpDiagnosis', 'procedurePerformed', 'findings', 'technique', 'postOpInstructions'] as const).filter((k) => !String(n.content[k] ?? '').trim());
    if (missing.length) throw rule(`Complete before signing: ${missing.join(', ')}`);
    if (!c.incision_at || !c.closure_at) throw rule('Record incision and closure times before signing');
    const frozen = { case: c.case_no, procedure: c.procedure_name, laterality: c.laterality, incisionAt: c.incision_at, closureAt: c.closure_at, note: n.content };
    await tx.exec(`UPDATE operation_note SET status='signed', signed_by_clinician=$2, signed_at=now(), content_digest=$3 WHERE case_id=$1`, [caseId, actor.clinicianId, sha256(canonicalJson(frozen))]);
    await audit(tx, actor, 'surgery.op_note_signed', 'surgery_case', caseId, { patientId: c.patient_id });
  });
}

/* ======================================================================= completion & charges */
export async function completeCase(actor: Actor, tenant: Tenant, caseId: string) {
  requireModule(tenant, 'theatre');
  authorize(actor, 'theatre.checklist');
  return withTenant(tenant.id, async (tx) => {
    const c = await lockCase(tx, caseId);
    if (c.status !== 'in_theatre') throw rule('Only a case in theatre can be completed');
    if (!c.wheels_out_at) throw rule('Record when the patient left theatre');
    const th = await tx.one<{ hourly_rate_paise: string; code: string }>(`SELECT hourly_rate_paise, code FROM theatre WHERE id = $1`, [c.theatre_id]);
    const minutes = Math.max(1, Math.round((c.wheels_out_at.getTime() - c.wheels_in_at!.getTime()) / 60_000));
    const halfHours = Math.ceil(minutes / 30);
    const encounterId = c.admission_id ? (await tx.one<{ encounter_id: string }>(`SELECT encounter_id FROM admission WHERE id = $1`, [c.admission_id])).encounter_id : null;
    if (Number(th.hourly_rate_paise) > 0) {
      await tx.exec(`INSERT INTO charge_item (tenant_id, patient_id, encounter_id, description, quantity, unit_price_paise, source_key, created_by) VALUES (app_tenant_id(), $1,$2,$3,$4,$5,$6,$7)
                     ON CONFLICT (tenant_id, source_key) DO NOTHING`,
        [c.patient_id, encounterId, `Theatre ${th.code} — ${minutes} min (${halfHours} × 30 min) — ${c.case_no}`, halfHours, Math.round(Number(th.hourly_rate_paise) / 2), `ottime:${caseId}`, staffId(actor)]);
    }
    if (c.service_id) {
      const svc = await tx.one<{ name: string; price: string; tax: number; department_id: string }>(
        `SELECT name, service_price_on(id, $2::date) AS price, tax_rate_bp AS tax, department_id FROM service WHERE id = $1`, [c.service_id, new Date().toLocaleDateString('en-CA', { timeZone: tenant.timezone })]);
      await tx.exec(`INSERT INTO charge_item (tenant_id, patient_id, encounter_id, service_id, clinician_id, department_id, description, unit_price_paise, tax_rate_bp, source_key, created_by)
                     VALUES (app_tenant_id(), $1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT (tenant_id, source_key) DO NOTHING`,
        [c.patient_id, encounterId, c.service_id, c.surgeon_id, svc.department_id, `${svc.name} — ${c.procedure_name} — ${c.case_no}`, svc.price, svc.tax, `otfee:${caseId}`, staffId(actor)]);
    }
    await tx.exec(`UPDATE surgery_case SET status='completed', version=version+1 WHERE id=$1`, [caseId]);
    await audit(tx, actor, 'surgery.completed', 'surgery_case', caseId, { patientId: c.patient_id, data: { minutes } });
    return { minutes };
  });
}

/* ======================================================================= reads */
export async function theatreList(actor: Actor, tenant: Tenant, day: string) {
  authorize(actor, 'clinical.read');
  return withTenant(tenant.id, (tx) => tx.many<{ id: string; case_no: string; status: string; procedure_name: string; laterality: string; priority: string; anaesthesia: string;
    start_at: Date; end_at: Date; theatre_code: string; theatre_id: string; patient_id: string; full_name: string; uhid: string; surgeon: string; anaesthetist: string | null; phases: string[] }>(
    `SELECT c.id, c.case_no, c.status, c.procedure_name, c.laterality, c.priority, c.anaesthesia, lower(c.planned) AS start_at, upper(c.planned) AS end_at,
            t.code AS theatre_code, t.id AS theatre_id, p.id AS patient_id, p.full_name, p.uhid, s.display_name AS surgeon, a.display_name AS anaesthetist,
            COALESCE((SELECT array_agg(phase) FROM surgery_checklist k WHERE k.case_id = c.id), '{}') AS phases
       FROM surgery_case c JOIN theatre t ON t.id = c.theatre_id JOIN patient p ON p.id = c.patient_id JOIN clinician s ON s.id = c.surgeon_id LEFT JOIN clinician a ON a.id = c.anaesthetist_id
      WHERE (lower(c.planned) AT TIME ZONE $2)::date = $1::date OR c.status = 'in_theatre'
      ORDER BY t.code, lower(c.planned)`, [day, tenant.timezone]));
}

export async function caseDetail(actor: Actor, tenant: Tenant, caseId: string) {
  authorize(actor, 'clinical.read');
  return withTenant(tenant.id, async (tx) => {
    const c = await tx.maybe<CaseRow & { planned_start: Date; planned_end: Date; theatre_code: string; full_name: string; uhid: string; surgeon: string; anaesthetist: string | null;
      anaesthesia: string; priority: string; cancel_reason: string | null; notes: string | null; admission_no: string | null; service_name: string | null }>(
      `SELECT c.*, lower(c.planned) AS planned_start, upper(c.planned) AS planned_end, t.code AS theatre_code, p.full_name, p.uhid, s.display_name AS surgeon,
              a.display_name AS anaesthetist, ad.admission_no, sv.name AS service_name
         FROM surgery_case c JOIN theatre t ON t.id = c.theatre_id JOIN patient p ON p.id = c.patient_id JOIN clinician s ON s.id = c.surgeon_id
         LEFT JOIN clinician a ON a.id = c.anaesthetist_id LEFT JOIN admission ad ON ad.id = c.admission_id LEFT JOIN service sv ON sv.id = c.service_id WHERE c.id = $1`, [caseId]);
    if (!c) throw notFound('Operation');
    await assertChartAccess(tx, actor, tenant, c.patient_id);
    const checklist = await tx.many<{ phase: Phase; answers: Record<string, string>; concerns: string | null; team: string | null; completed_at: Date; by: string }>(
      `SELECT k.phase, k.answers, k.concerns, k.team, k.completed_at, s.full_name AS by FROM surgery_checklist k JOIN staff s ON s.id = k.completed_by WHERE k.case_id = $1 ORDER BY k.completed_at`, [caseId]);
    const note = await tx.maybe<{ content: OpNote; status: string; signed_at: Date | null; content_digest: string | null }>(`SELECT content, status, signed_at, content_digest FROM operation_note WHERE case_id = $1`, [caseId]);
    const items = await tx.many<{ id: string; name: string; batch_no: string; qty: number; implant_serial: string | null; status: string; recorded_at: Date }>(
      `SELECT u.id, pr.generic_name || COALESCE(' ' || pr.strength, '') AS name, l.batch_no, u.qty, u.implant_serial, u.status, u.recorded_at
         FROM surgery_consumable u JOIN product pr ON pr.id = u.product_id JOIN lot l ON l.id = u.lot_id WHERE u.case_id = $1 ORDER BY u.recorded_at`, [caseId]);
    return { c, checklist, note, items };
  });
}

/** Released, unexpired batches with stock, for the consumables picker. */
export async function theatreStock(actor: Actor, tenant: Tenant) {
  authorize(actor, 'theatre.checklist');
  return withTenant(tenant.id, (tx) => tx.many<{ lot_id: string; location_id: string; label: string }>(
    `SELECT b.lot_id, b.location_id, p.generic_name || COALESCE(' ' || p.strength, '') || ' · batch ' || l.batch_no || ' · exp ' || l.expiry_date || ' · ' || loc.name || ' (' || b.qty || ')' AS label
       FROM stock_balance b JOIN lot l ON l.id = b.lot_id JOIN product p ON p.id = l.product_id JOIN location loc ON loc.id = b.location_id
      WHERE b.qty > 0 AND l.status = 'released' AND l.expiry_date >= (now() AT TIME ZONE $1)::date ORDER BY p.generic_name, l.expiry_date LIMIT 500`, [tenant.timezone]));
}
