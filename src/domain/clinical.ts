import { z } from 'zod';
import { withTenant, type Tx } from '@/lib/db';
import { AppError, invalid, notFound, rule } from '@/lib/errors';
import { authorize, actorId, staffId, type Actor } from '@/lib/actor';
import { audit, emit } from '@/lib/events';
import { canonicalJson, sha256 } from '@/lib/crypto';
import { financialYear } from '@/lib/money';
import { chartIds } from './patients';
import { assertChartAccess } from './access';
import type { Tenant } from './tenants';

const today = (tz: string) => new Date().toLocaleDateString('en-CA', { timeZone: tz });

function requireClinician(actor: Actor): asserts actor is Extract<Actor, { kind: 'staff' }> & { clinicianId: string } {
  if (actor.kind !== 'staff' || !actor.clinicianId) {
    throw new AppError('FORBIDDEN', 'Only a registered clinician with a clinician profile can do this.');
  }
}

// ------------------------------------------------------------------ encounter lifecycle
/** Start a consultation from a queue ticket. Moves the booking to in-service and creates one primary encounter. */
export async function startEncounter(actor: Actor, tenant: Tenant, ticketId: string, opts: { chiefComplaint?: string; leadClinicianId?: string } = {}) {
  authorize(actor, 'clinical.write');
  return withTenant(tenant.id, async (tx) => {
    const t = await tx.maybe<{ id: string; status: string; patient_id: string; appointment_id: string | null; department_id: string;
      clinician_id: string | null; service_id: string | null }>(`SELECT * FROM queue_ticket WHERE id = $1 FOR UPDATE`, [ticketId]);
    if (!t) throw notFound('Queue ticket');
    const existing = await tx.maybe<{ id: string }>(`SELECT id FROM encounter WHERE queue_ticket_id = $1`, [ticketId]);
    if (existing) return { encounterId: existing.id, replay: true };
    if (!['waiting', 'called'].includes(t.status)) throw rule('This patient is not waiting.');
    const lead = opts.leadClinicianId ?? (actor.kind === 'staff' ? actor.clinicianId : null) ?? t.clinician_id;
    if (!lead) throw invalid('Choose the treating doctor');
    const enc = await tx.one<{ id: string }>(
      `INSERT INTO encounter (tenant_id, patient_id, appointment_id, queue_ticket_id, department_id, lead_clinician_id, service_id, chief_complaint, created_by)
       VALUES (app_tenant_id(), $1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
      [t.patient_id, t.appointment_id, t.id, t.department_id, lead, t.service_id, opts.chiefComplaint ?? null, staffId(actor)]);
    await tx.exec(`UPDATE queue_ticket SET status = 'in_room', clinician_id = COALESCE(clinician_id, $2), updated_at = now() WHERE id = $1`, [t.id, lead]);
    if (t.appointment_id) {
      const a = await tx.one<{ state: string }>(`SELECT state FROM appointment WHERE id = $1 FOR UPDATE`, [t.appointment_id]);
      if (a.state === 'arrived') {
        await tx.exec(`UPDATE appointment SET state = 'in_service', version = version + 1, updated_at = now() WHERE id = $1`, [t.appointment_id]);
        await tx.exec(`INSERT INTO appointment_event (tenant_id, appointment_id, action, from_state, to_state, actor_kind, actor_id)
                       VALUES (app_tenant_id(), $1, 'consultation_started', 'arrived', 'in_service', $2, $3)`, [t.appointment_id, actor.kind, actorId(actor)]);
      }
    }
    await audit(tx, actor, 'encounter.started', 'encounter', enc.id, { patientId: t.patient_id });
    return { encounterId: enc.id, replay: false };
  });
}

export async function getEncounter(actor: Actor, tenant: Tenant, encounterId: string) {
  authorize(actor, 'clinical.read');
  return withTenant(tenant.id, async (tx) => {
    const encounter = await tx.maybe<{ id: string; patient_id: string; appointment_id: string | null; status: string; lead_clinician_id: string;
      clinician_name: string; department_name: string; service_id: string | null; service_name: string | null; chief_complaint: string | null;
      started_at: Date; ended_at: Date | null; version: number }>(
      `SELECT e.*, c.display_name AS clinician_name, d.name AS department_name, s.name AS service_name
         FROM encounter e JOIN clinician c ON c.id = e.lead_clinician_id JOIN department d ON d.id = e.department_id
         LEFT JOIN service s ON s.id = e.service_id WHERE e.id = $1`, [encounterId]);
    if (!encounter) throw notFound('Encounter');
    await assertChartAccess(tx, actor, tenant, encounter.patient_id);
    // One connection per transaction: queries run sequentially.
    const vitals = await tx.many(`SELECT * FROM vitals WHERE encounter_id = $1 AND NOT entered_in_error ORDER BY measured_at DESC`, [encounterId]);
    const notes = await tx.many<NoteRow>(`SELECT n.*, s.full_name AS signer_name FROM clinical_note n LEFT JOIN staff s ON s.id = n.signed_by
                         WHERE encounter_id = $1 ORDER BY version_no DESC, created_at DESC`, [encounterId]);
    const prescriptions = await tx.many<RxRow>(`SELECT * FROM prescription WHERE encounter_id = $1 ORDER BY version_no DESC, created_at DESC`, [encounterId]);
    const followUps = await tx.many(`SELECT * FROM follow_up WHERE encounter_id = $1 ORDER BY due_date`, [encounterId]);
    const allergies = await tx.many(`SELECT * FROM allergy WHERE patient_id = $1 AND status = 'active' ORDER BY recorded_at DESC`, [encounter.patient_id]);
    const lines = prescriptions.length
      ? await tx.many<RxLine & { prescription_id: string }>(`SELECT * FROM rx_line WHERE prescription_id = ANY($1) ORDER BY sort_order`, [prescriptions.map((r) => r.id)])
      : [];
    await audit(tx, actor, 'encounter.viewed', 'encounter', encounterId, { patientId: encounter.patient_id });
    return {
      encounter, vitals, notes, followUps, allergies,
      prescriptions: prescriptions.map((r) => ({ ...r, lines: lines.filter((l) => l.prescription_id === r.id) })),
    };
  });
}

export const vitalsInput = z.object({
  systolic: z.number().int().optional(), diastolic: z.number().int().optional(), pulse: z.number().int().optional(),
  respRate: z.number().int().optional(), tempC: z.number().optional(), spo2: z.number().int().optional(),
  weightKg: z.number().optional(), heightCm: z.number().optional(),
});

export async function recordVitals(actor: Actor, tenant: Tenant, encounterId: string, input: z.input<typeof vitalsInput>) {
  authorize(actor, 'vitals.write');
  const v = vitalsInput.parse(input);
  if (Object.values(v).every((x) => x == null)) throw invalid('Enter at least one measurement');
  return withTenant(tenant.id, async (tx) => {
    const e = await openEncounter(tx, encounterId);
    await tx.exec(
      `INSERT INTO vitals (tenant_id, encounter_id, patient_id, systolic, diastolic, pulse, resp_rate, temp_c, spo2, weight_kg, height_cm, recorded_by)
       VALUES (app_tenant_id(), $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [encounterId, e.patient_id, v.systolic ?? null, v.diastolic ?? null, v.pulse ?? null, v.respRate ?? null, v.tempC ?? null,
        v.spo2 ?? null, v.weightKg ?? null, v.heightCm ?? null, staffId(actor)]);
    await audit(tx, actor, 'vitals.recorded', 'encounter', encounterId, { patientId: e.patient_id });
  });
}

async function openEncounter(tx: Tx, encounterId: string) {
  const e = await tx.maybe<{ id: string; patient_id: string; status: string; lead_clinician_id: string; appointment_id: string | null;
    queue_ticket_id: string | null; service_id: string | null; department_id: string; version: number }>(
    `SELECT * FROM encounter WHERE id = $1 FOR UPDATE`, [encounterId]);
  if (!e) throw notFound('Encounter');
  if (e.status !== 'open') throw rule('This encounter is closed. Start an addendum by amending a signed document.');
  return e;
}

// ------------------------------------------------------------------ notes
export type NoteContent = { subjective?: string; objective?: string; assessment?: string; plan?: string; diagnoses?: { code?: string; text: string }[] };
type NoteRow = { id: string; status: string; version_no: number; content: NoteContent; row_version: number; signed_at: Date | null; signer_name?: string; supersedes_id: string | null; amend_reason: string | null };

const noteInput = z.object({
  subjective: z.string().max(10000).optional(), objective: z.string().max(10000).optional(),
  assessment: z.string().max(10000).optional(), plan: z.string().max(10000).optional(),
  diagnoses: z.array(z.object({ code: z.string().max(20).optional(), text: z.string().min(1).max(300) })).max(20).optional(),
});

/** API-003: drafts carry a row version; a stale save is rejected rather than silently overwriting. */
export async function saveNoteDraft(actor: Actor, tenant: Tenant, encounterId: string, content: z.input<typeof noteInput>, opts: { noteId?: string; expectedRowVersion?: number } = {}) {
  authorize(actor, 'clinical.write');
  const c = noteInput.parse(content);
  return withTenant(tenant.id, async (tx) => {
    const e = await openEncounter(tx, encounterId);
    if (opts.noteId) {
      const n = await tx.maybe<{ status: string; row_version: number }>(`SELECT status, row_version FROM clinical_note WHERE id = $1 AND encounter_id = $2 FOR UPDATE`, [opts.noteId, encounterId]);
      if (!n) throw notFound('Note');
      if (n.status !== 'draft') throw rule('This note is signed. Use amend to create a new version.');
      if (opts.expectedRowVersion != null && Number(n.row_version) !== opts.expectedRowVersion) {
        throw new AppError('VERSION_CONFLICT', 'Another person saved this note. Reload to see their changes before saving.');
      }
      const r = await tx.one<{ row_version: number }>(`UPDATE clinical_note SET content = $2, row_version = row_version + 1 WHERE id = $1 RETURNING row_version`, [opts.noteId, JSON.stringify(c)]);
      return { noteId: opts.noteId, rowVersion: Number(r.row_version) };
    }
    const r = await tx.one<{ id: string; row_version: number }>(
      `INSERT INTO clinical_note (tenant_id, encounter_id, patient_id, author_id, content) VALUES (app_tenant_id(), $1,$2,$3,$4) RETURNING id, row_version`,
      [encounterId, e.patient_id, staffId(actor), JSON.stringify(c)]);
    return { noteId: r.id, rowVersion: Number(r.row_version) };
  });
}

export async function signNote(actor: Actor, tenant: Tenant, noteId: string, expectedRowVersion?: number) {
  authorize(actor, 'clinical.sign');
  requireClinician(actor);
  return withTenant(tenant.id, async (tx) => {
    const n = await tx.maybe<NoteRow & { encounter_id: string; patient_id: string }>(`SELECT * FROM clinical_note WHERE id = $1 FOR UPDATE`, [noteId]);
    if (!n) throw notFound('Note');
    if (n.status !== 'draft') throw rule('Already signed');
    if (expectedRowVersion != null && Number(n.row_version) !== expectedRowVersion) throw new AppError('VERSION_CONFLICT', 'The note changed since you reviewed it.');
    const c = n.content ?? {};
    if (!c.assessment?.trim() && !c.plan?.trim() && !(c.diagnoses?.length)) throw invalid('Add an assessment, diagnosis or plan before signing');
    const digest = sha256(canonicalJson({ content: c, patient: n.patient_id, encounter: n.encounter_id, version: n.version_no }));
    await tx.exec(`UPDATE clinical_note SET status = 'signed', signed_by = $2, signed_at = now(), content_digest = $3 WHERE id = $1`, [noteId, actor.staffId, digest]);
    if (n.supersedes_id) await tx.exec(`UPDATE clinical_note SET status = 'superseded' WHERE id = $1 AND status = 'signed'`, [n.supersedes_id]);
    await audit(tx, actor, 'note.signed', 'clinical_note', noteId, { patientId: n.patient_id, data: { digest } });
    return { digest };
  });
}

/** Amendment creates an attributable successor; the signed original is preserved byte-for-byte. */
export async function amendNote(actor: Actor, tenant: Tenant, noteId: string, reason: string) {
  authorize(actor, 'clinical.write');
  if (!reason?.trim()) throw invalid('Give the reason for amendment');
  return withTenant(tenant.id, async (tx) => {
    const n = await tx.one<NoteRow & { encounter_id: string; patient_id: string }>(`SELECT * FROM clinical_note WHERE id = $1`, [noteId]);
    if (n.status !== 'signed') throw rule('Only the current signed version can be amended');
    const pending = await tx.maybe(`SELECT 1 FROM clinical_note WHERE supersedes_id = $1 AND status = 'draft'`, [noteId]);
    if (pending) throw rule('An amendment draft already exists');
    // Amendments are permitted after the encounter closes; they do not reopen billing.
    const r = await tx.one<{ id: string }>(
      `INSERT INTO clinical_note (tenant_id, encounter_id, patient_id, author_id, content, version_no, supersedes_id, amend_reason)
       VALUES (app_tenant_id(), $1,$2,$3,$4,$5,$6,$7) RETURNING id`,
      [n.encounter_id, n.patient_id, staffId(actor), JSON.stringify(n.content), n.version_no + 1, noteId, reason]);
    await audit(tx, actor, 'note.amendment_started', 'clinical_note', r.id, { patientId: n.patient_id, reason });
    return { noteId: r.id };
  });
}

// ------------------------------------------------------------------ prescriptions
export type RxLine = { id?: string; drug_name: string; strength: string | null; form: string | null; dose: string; route: string; frequency: string;
  duration: string; quantity: string | null; prn: boolean; prn_indication: string | null; instructions: string | null; sort_order?: number };
type RxRow = { id: string; status: string; version_no: number; rx_number: string | null; advice: string | null; follow_up_in_days: number | null;
  row_version: number; snapshot: Record<string, unknown> | null; signed_at: Date | null; supersedes_id: string | null; patient_id: string;
  encounter_id: string; clinician_id: string; amend_reason: string | null };

export const rxLineInput = z.object({
  drugName: z.string().trim().min(2).max(200), strength: z.string().max(60).optional(), form: z.string().max(60).optional(),
  dose: z.string().trim().min(1).max(60), route: z.string().trim().min(1).max(60).default('oral'),
  frequency: z.string().trim().min(1).max(80), duration: z.string().trim().min(1).max(60),
  quantity: z.string().max(60).optional(), prn: z.boolean().default(false), prnIndication: z.string().max(200).optional(),
  instructions: z.string().max(500).optional(),
});
export const rxDraftInput = z.object({
  lines: z.array(rxLineInput).max(30),
  advice: z.string().max(4000).optional(),
  followUpInDays: z.number().int().min(0).max(3650).nullish(),
  expectedRowVersion: z.number().int().optional(),
});

export async function saveRxDraft(actor: Actor, tenant: Tenant, encounterId: string, input: z.input<typeof rxDraftInput>, rxId?: string) {
  authorize(actor, 'clinical.write');
  const r = rxDraftInput.safeParse(input);
  if (!r.success) throw invalid('Check the prescription lines', r.error.issues);
  const p = r.data;
  return withTenant(tenant.id, async (tx) => {
    const e = await tx.one<{ patient_id: string; lead_clinician_id: string; status: string }>(`SELECT patient_id, lead_clinician_id, status FROM encounter WHERE id = $1`, [encounterId]);
    let id = rxId;
    if (id) {
      const rx = await tx.maybe<{ status: string; row_version: number }>(`SELECT status, row_version FROM prescription WHERE id = $1 AND encounter_id = $2 FOR UPDATE`, [id, encounterId]);
      if (!rx) throw notFound('Prescription');
      if (rx.status !== 'draft') throw rule('This prescription is signed. Amend it to make changes.');
      if (p.expectedRowVersion != null && Number(rx.row_version) !== p.expectedRowVersion) throw new AppError('VERSION_CONFLICT', 'The prescription changed. Reload before saving.');
      await tx.exec(`UPDATE prescription SET advice = $2, follow_up_in_days = $3, row_version = row_version + 1 WHERE id = $1`, [id, p.advice ?? null, p.followUpInDays ?? null]);
      await tx.exec(`DELETE FROM rx_line WHERE prescription_id = $1`, [id]);
    } else {
      if (e.status !== 'open') throw rule('This encounter is closed.');
      const clinician = (actor.kind === 'staff' && actor.clinicianId) || e.lead_clinician_id;
      id = (await tx.one<{ id: string }>(
        `INSERT INTO prescription (tenant_id, encounter_id, patient_id, clinician_id, advice, follow_up_in_days)
         VALUES (app_tenant_id(), $1,$2,$3,$4,$5) RETURNING id`,
        [encounterId, e.patient_id, clinician, p.advice ?? null, p.followUpInDays ?? null])).id;
    }
    let i = 0;
    for (const l of p.lines) {
      await tx.exec(
        `INSERT INTO rx_line (tenant_id, prescription_id, sort_order, drug_name, strength, form, dose, route, frequency, duration, quantity, prn, prn_indication, instructions)
         VALUES (app_tenant_id(), $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
        [id, i++, l.drugName, l.strength ?? null, l.form ?? null, l.dose, l.route, l.frequency, l.duration, l.quantity ?? null, l.prn,
          l.prn ? l.prnIndication ?? null : null, l.instructions ?? null]);
    }
    const rv = await tx.one<{ row_version: number }>(`SELECT row_version FROM prescription WHERE id = $1`, [id]);
    return { prescriptionId: id, rowVersion: Number(rv.row_version) };
  });
}

/**
 * Sign a prescription: confirm patient, clinician credential and allergy review; freeze lines, demographics and
 * clinician identity into a snapshot with a digest. The snapshot is what every print or re-print renders.
 */
export async function signPrescription(actor: Actor, tenant: Tenant, rxId: string, opts: { expectedRowVersion?: number; patientConfirmed: boolean; safetyOverrideReason?: string }) {
  authorize(actor, 'clinical.sign');
  requireClinician(actor);
  if (!opts.patientConfirmed) throw rule('Confirm the patient identity shown on the banner before signing.');
  return withTenant(tenant.id, async (tx) => {
    const rx = await tx.maybe<RxRow>(`SELECT * FROM prescription WHERE id = $1 FOR UPDATE`, [rxId]);
    if (!rx) throw notFound('Prescription');
    if (rx.status !== 'draft') throw rule('Already signed');
    if (opts.expectedRowVersion != null && Number(rx.row_version) !== opts.expectedRowVersion) throw new AppError('VERSION_CONFLICT', 'The prescription changed since you reviewed it.');
    const lines = await tx.many<RxLine>(`SELECT * FROM rx_line WHERE prescription_id = $1 ORDER BY sort_order`, [rxId]);
    if (!lines.length && !rx.advice?.trim()) throw invalid('Add at least one medicine or written advice');
    const clinician = await tx.one<{ id: string; display_name: string; qualification: string | null; registration_council: string | null; registration_number: string | null; active: boolean }>(
      `SELECT * FROM clinician WHERE id = $1`, [actor.clinicianId]);
    if (!clinician.active || !clinician.registration_number) {
      throw rule('Your clinician profile needs an active medical council registration number before you can sign prescriptions.');
    }
    const patient = await tx.one<{ uhid: string; full_name: string; sex: string; birth_date: string | null; birth_precision: string; estimated_age_years: number | null; age_as_of: string | null; allergy_status: string; phone_e164: string | null }>(
      `SELECT uhid, full_name, sex, birth_date, birth_precision, estimated_age_years, age_as_of, allergy_status, phone_e164 FROM patient WHERE id = $1`, [rx.patient_id]);
    const allergies = await tx.many<{ substance: string; reaction: string | null; severity: string | null }>(
      `SELECT substance, reaction, severity FROM allergy WHERE patient_id = $1 AND status = 'active'`, [rx.patient_id]);
    if (lines.length && patient.allergy_status === 'not_reviewed' && tenant.settings.requireAllergyReviewToSign && !opts.safetyOverrideReason) {
      throw new AppError('RULE_VIOLATION', 'Allergies have not been reviewed for this patient. Record allergies or “no known allergies”, or give an override reason.', { needs: 'allergy_review' });
    }
    // Simple name match against recorded allergens. Not a substitute for a licensed interaction database.
    const hits = lines.filter((l) => allergies.some((a) => l.drug_name.toLowerCase().includes(a.substance.toLowerCase()) || a.substance.toLowerCase().includes(l.drug_name.toLowerCase().split(' ')[0])));
    if (hits.length && !opts.safetyOverrideReason) {
      throw new AppError('RULE_VIOLATION', `Possible allergy match: ${hits.map((h) => h.drug_name).join(', ')}. Review or give an override reason.`, { needs: 'allergy_override', drugs: hits.map((h) => h.drug_name) });
    }
    const fy = financialYear(today(tenant.timezone));
    const rxNumber = rx.rx_number ?? `RX/${fy}/${String((await tx.one<{ v: number }>(`SELECT next_doc_number($1) AS v`, [`rx:${fy}`])).v).padStart(6, '0')}`;
    const enc = await tx.one<{ started_at: Date; department: string }>(
      `SELECT e.started_at, d.name AS department FROM encounter e JOIN department d ON d.id = e.department_id WHERE e.id = $1`, [rx.encounter_id]);
    const snapshot = {
      rxNumber, version: rx.version_no, issuedAt: new Date().toISOString(), timezone: tenant.timezone,
      facility: { name: tenant.name, ...tenant.branding },
      patient: { uhid: patient.uhid, name: patient.full_name, sex: patient.sex, birthDate: patient.birth_date, birthPrecision: patient.birth_precision,
        estimatedAgeYears: patient.estimated_age_years, ageAsOf: patient.age_as_of },
      allergies: patient.allergy_status === 'no_known_allergies' ? 'No known allergies' : patient.allergy_status === 'not_reviewed' ? 'Not reviewed' : allergies,
      clinician: { name: clinician.display_name, qualification: clinician.qualification, council: clinician.registration_council, registrationNumber: clinician.registration_number },
      encounter: { date: enc.started_at, department: enc.department },
      lines: lines.map((l) => ({ drug: l.drug_name, strength: l.strength, form: l.form, dose: l.dose, route: l.route, frequency: l.frequency,
        duration: l.duration, quantity: l.quantity, prn: l.prn, prnIndication: l.prn_indication, instructions: l.instructions })),
      advice: rx.advice, followUpInDays: rx.follow_up_in_days, supersedes: rx.supersedes_id ? { id: rx.supersedes_id, reason: rx.amend_reason } : null,
      safetyOverride: opts.safetyOverrideReason ?? null,
    };
    const digest = sha256(canonicalJson(snapshot));
    await tx.exec(`UPDATE prescription SET status = 'signed', rx_number = $2, snapshot = $3, content_digest = $4, signed_by = $5, signed_at = now(),
                     safety_override_reason = $6 WHERE id = $1`,
      [rxId, rxNumber, JSON.stringify(snapshot), digest, actor.staffId, opts.safetyOverrideReason ?? null]);
    if (rx.supersedes_id) await tx.exec(`UPDATE prescription SET status = 'superseded' WHERE id = $1 AND status = 'signed'`, [rx.supersedes_id]);
    await audit(tx, actor, 'prescription.signed', 'prescription', rxId, { patientId: rx.patient_id, reason: opts.safetyOverrideReason, data: { rxNumber, digest } });
    await emit(tx, 'prescription.signed', 'prescription', rxId, { rxNumber, encounterId: rx.encounter_id });
    if (tenant.settings.modules.portal && tenant.settings.autoReleasePrescriptions) {
      await tx.exec(`UPDATE document_release SET revoked_at = now() WHERE doc_kind = 'prescription' AND doc_id = $1 AND revoked_at IS NULL`, [rx.supersedes_id]);
      await tx.exec(`INSERT INTO document_release (tenant_id, patient_id, doc_kind, doc_id, released_by, note) VALUES (app_tenant_id(), $1, 'prescription', $2, $3, 'auto on signing')
                     ON CONFLICT DO NOTHING`, [rx.patient_id, rxId, actor.staffId]);
    }
    return { rxNumber, digest };
  });
}

export async function amendPrescription(actor: Actor, tenant: Tenant, rxId: string, reason: string) {
  authorize(actor, 'clinical.write');
  requireClinician(actor);
  if (!reason?.trim()) throw invalid('Give the reason for amendment');
  return withTenant(tenant.id, async (tx) => {
    const rx = await tx.one<RxRow>(`SELECT * FROM prescription WHERE id = $1`, [rxId]);
    if (rx.status !== 'signed') throw rule('Only the current signed version can be amended');
    if (await tx.maybe(`SELECT 1 FROM prescription WHERE supersedes_id = $1 AND status = 'draft'`, [rxId])) throw rule('An amendment draft already exists');
    const id = (await tx.one<{ id: string }>(
      `INSERT INTO prescription (tenant_id, encounter_id, patient_id, clinician_id, rx_number, version_no, supersedes_id, advice, follow_up_in_days, amend_reason)
       VALUES (app_tenant_id(), $1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
      [rx.encounter_id, rx.patient_id, actor.clinicianId, null, rx.version_no + 1, rxId, rx.advice, rx.follow_up_in_days, reason])).id;
    await tx.exec(
      `INSERT INTO rx_line (tenant_id, prescription_id, sort_order, drug_name, strength, form, dose, route, frequency, duration, quantity, prn, prn_indication, instructions)
       SELECT tenant_id, $2, sort_order, drug_name, strength, form, dose, route, frequency, duration, quantity, prn, prn_indication, instructions
         FROM rx_line WHERE prescription_id = $1`, [rxId, id]);
    await audit(tx, actor, 'prescription.amendment_started', 'prescription', id, { patientId: rx.patient_id, reason });
    return { prescriptionId: id };
  });
}

export async function getPrescriptionForPrint(actor: Actor, tenant: Tenant, rxId: string) {
  authorize(actor, 'clinical.read');
  return withTenant(tenant.id, async (tx) => {
    const rx = await tx.maybe<RxRow & { content_digest: string }>(`SELECT * FROM prescription WHERE id = $1`, [rxId]);
    if (!rx || !rx.snapshot) throw notFound('Signed prescription');
    await assertChartAccess(tx, actor, tenant, rx.patient_id);
    await audit(tx, actor, 'prescription.printed', 'prescription', rxId, { patientId: rx.patient_id });
    return rx;
  });
}

// ------------------------------------------------------------------ completion, charges, follow-up
/**
 * Completes the visit clinically. Billing state is independent (OP-029): an unpaid visit can still complete.
 * The consultation charge is captured once, keyed by encounter + service.
 */
export async function completeEncounter(actor: Actor, tenant: Tenant, encounterId: string) {
  authorize(actor, 'clinical.write');
  return withTenant(tenant.id, async (tx) => {
    const e = await openEncounter(tx, encounterId);
    const drafts = await tx.one<{ n: number }>(
      `SELECT (SELECT count(*) FROM clinical_note WHERE encounter_id = $1 AND status = 'draft')
            + (SELECT count(*) FROM prescription WHERE encounter_id = $1 AND status = 'draft') AS n`, [encounterId]);
    if (Number(drafts.n) > 0) throw rule('Sign or discard the draft note/prescription before completing the visit.');
    const signed = await tx.maybe(`SELECT 1 FROM clinical_note WHERE encounter_id = $1 AND status = 'signed'`, [encounterId]);
    if (!signed) throw rule('Sign a consultation note before completing the visit.');
    await tx.exec(`UPDATE encounter SET status = 'completed', ended_at = now(), version = version + 1 WHERE id = $1`, [encounterId]);
    if (e.queue_ticket_id) await tx.exec(`UPDATE queue_ticket SET status = 'done', updated_at = now() WHERE id = $1`, [e.queue_ticket_id]);
    if (e.appointment_id) {
      await tx.exec(`UPDATE appointment SET state = 'completed', version = version + 1, updated_at = now() WHERE id = $1 AND state IN ('arrived','in_service')`, [e.appointment_id]);
      await tx.exec(`INSERT INTO appointment_event (tenant_id, appointment_id, action, from_state, to_state, actor_kind, actor_id)
                     VALUES (app_tenant_id(), $1, 'completed', 'in_service', 'completed', $2, $3)`, [e.appointment_id, actor.kind, actorId(actor)]);
      await emit(tx, 'appointment.completed', 'appointment', e.appointment_id, { encounterId });
    }
    let charged = false;
    if (e.service_id) {
      const svc = await tx.one<{ name: string; price_paise: number; tax_rate_bp: number; department_id: string; follow_up_free_days: number }>(
        `SELECT name, price_paise, tax_rate_bp, department_id, follow_up_free_days FROM service WHERE id = $1`, [e.service_id]);
      const appt = e.appointment_id ? await tx.maybe<{ quoted_price_paise: number }>(`SELECT quoted_price_paise FROM appointment WHERE id = $1`, [e.appointment_id]) : null;
      let price = appt ? Number(appt.quoted_price_paise) : Number(svc.price_paise);
      let note: string | null = null;
      // Free follow-up window: a prior completed paid visit to the same clinician within N days.
      if (svc.follow_up_free_days > 0) {
        const prior = await tx.maybe(
          `SELECT 1 FROM encounter p WHERE p.patient_id = ANY($1) AND p.lead_clinician_id = $2 AND p.id <> $3 AND p.status = 'completed'
              AND p.ended_at > now() - make_interval(days => $4)`,
          [await chartIds(tx, e.patient_id), e.lead_clinician_id, encounterId, svc.follow_up_free_days]);
        if (prior) { price = 0; note = `Free follow-up within ${svc.follow_up_free_days} days`; }
      }
      const r = await tx.exec(
        `INSERT INTO charge_item (tenant_id, patient_id, encounter_id, appointment_id, service_id, clinician_id, department_id, description,
            unit_price_paise, tax_rate_bp, source_key, discount_reason, created_by)
         VALUES (app_tenant_id(), $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) ON CONFLICT (tenant_id, source_key) DO NOTHING`,
        [e.patient_id, encounterId, e.appointment_id, e.service_id, e.lead_clinician_id, svc.department_id, svc.name, price, svc.tax_rate_bp,
          `encounter:${encounterId}:service:${e.service_id}`, note, staffId(actor)]);
      charged = r > 0;
    }
    const rx = await tx.maybe<{ follow_up_in_days: number | null }>(
      `SELECT follow_up_in_days FROM prescription WHERE encounter_id = $1 AND status = 'signed' AND follow_up_in_days IS NOT NULL ORDER BY version_no DESC LIMIT 1`, [encounterId]);
    if (rx?.follow_up_in_days) {
      await tx.exec(
        `INSERT INTO follow_up (tenant_id, patient_id, encounter_id, clinician_id, owner_id, due_date, reason)
         SELECT app_tenant_id(), $1, $2, $3, c.staff_id, ($4::date + $5::int), 'Review as advised'
           FROM clinician c WHERE c.id = $3
          AND NOT EXISTS (SELECT 1 FROM follow_up WHERE encounter_id = $2)`,
        [e.patient_id, encounterId, e.lead_clinician_id, today(tenant.timezone), rx.follow_up_in_days]);
    }
    await audit(tx, actor, 'encounter.completed', 'encounter', encounterId, { patientId: e.patient_id, data: { charged } });
    return { charged };
  });
}

export const followUpInput = z.object({
  patientId: z.uuid(), encounterId: z.uuid().nullish(), clinicianId: z.uuid().nullish(), ownerId: z.uuid().nullish(),
  dueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), reason: z.string().trim().min(3).max(500),
});

export async function addFollowUp(actor: Actor, tenant: Tenant, input: z.input<typeof followUpInput>) {
  authorize(actor, 'clinical.read');
  const p = followUpInput.parse(input);
  return withTenant(tenant.id, async (tx) => {
    const r = await tx.one<{ id: string }>(
      `INSERT INTO follow_up (tenant_id, patient_id, encounter_id, clinician_id, owner_id, due_date, reason)
       VALUES (app_tenant_id(), $1,$2,$3,$4,$5,$6) RETURNING id`,
      [p.patientId, p.encounterId ?? null, p.clinicianId ?? null, p.ownerId ?? staffId(actor), p.dueDate, p.reason]);
    await audit(tx, actor, 'follow_up.created', 'follow_up', r.id, { patientId: p.patientId });
    await emit(tx, 'follow_up.created', 'follow_up', r.id, { dueDate: p.dueDate });
    return r.id;
  });
}

export async function closeFollowUp(actor: Actor, tenant: Tenant, id: string, status: 'completed' | 'cancelled' | 'booked', outcome: string, appointmentId?: string) {
  authorize(actor, 'schedule.read');
  if (!outcome?.trim()) throw invalid('Record the outcome');
  return withTenant(tenant.id, async (tx) => {
    const f = await tx.one<{ patient_id: string }>(
      `UPDATE follow_up SET status = $2, outcome = $3, appointment_id = $4, closed_at = CASE WHEN $2 = 'booked' THEN NULL ELSE now() END
        WHERE id = $1 RETURNING patient_id`, [id, status, outcome, appointmentId ?? null]);
    await audit(tx, actor, `follow_up.${status}`, 'follow_up', id, { patientId: f.patient_id });
  });
}

export async function followUpWorklist(actor: Actor, tenant: Tenant, opts: { ownerId?: string; horizonDays?: number } = {}) {
  authorize(actor, 'schedule.read');
  return withTenant(tenant.id, (tx) => tx.many<{ id: string; due_date: string; reason: string; status: string; patient_id: string; uhid: string;
    full_name: string; phone_e164: string | null; clinician_name: string | null; owner_name: string | null; overdue: boolean }>(
    `SELECT f.*, p.uhid, p.full_name, p.phone_e164, c.display_name AS clinician_name, s.full_name AS owner_name,
            f.due_date < $1::date AS overdue
       FROM follow_up f JOIN patient p ON p.id = f.patient_id LEFT JOIN clinician c ON c.id = f.clinician_id
       LEFT JOIN staff s ON s.id = f.owner_id
      WHERE f.status = 'open' AND f.due_date <= ($1::date + $2::int) AND ($3::uuid IS NULL OR f.owner_id = $3)
      ORDER BY f.due_date, p.full_name`, [today(tenant.timezone), opts.horizonDays ?? 14, opts.ownerId ?? null]));
}

/** GET /v1/patients/{id}/timeline: distinguishes signed vs superseded and service time vs entry time. */
export async function patientTimeline(actor: Actor, tenant: Tenant, patientId: string) {
  authorize(actor, 'clinical.read');
  return withTenant(tenant.id, async (tx) => {
    await assertChartAccess(tx, actor, tenant, patientId);
    const ids = await chartIds(tx, patientId);
    const encounters = await tx.many<{ id: string; started_at: Date; ended_at: Date | null; status: string; clinician_name: string; department_name: string; service_name: string | null; chief_complaint: string | null; patient_id: string }>(
      `SELECT e.id, e.started_at, e.ended_at, e.status, e.chief_complaint, e.patient_id, c.display_name AS clinician_name,
              d.name AS department_name, s.name AS service_name
         FROM encounter e JOIN clinician c ON c.id = e.lead_clinician_id JOIN department d ON d.id = e.department_id
         LEFT JOIN service s ON s.id = e.service_id WHERE e.patient_id = ANY($1) ORDER BY e.started_at DESC LIMIT 100`, [ids]);
    const notes = await tx.many<{ id: string; encounter_id: string; status: string; version_no: number; content: NoteContent; signed_at: Date | null }>(
      `SELECT id, encounter_id, status, version_no, content, signed_at FROM clinical_note WHERE patient_id = ANY($1) AND status IN ('signed','superseded') ORDER BY signed_at DESC`, [ids]);
    const prescriptions = await tx.many<{ id: string; encounter_id: string; status: string; rx_number: string; version_no: number; signed_at: Date; snapshot: { lines: { drug: string; dose: string; frequency: string; duration: string }[] } }>(
      `SELECT id, encounter_id, status, rx_number, version_no, signed_at, snapshot FROM prescription WHERE patient_id = ANY($1) AND status IN ('signed','superseded') ORDER BY signed_at DESC`, [ids]);
    const allergies = await tx.many(`SELECT * FROM allergy WHERE patient_id = ANY($1) ORDER BY status, recorded_at DESC`, [ids]);
    const vitals = await tx.many(`SELECT * FROM vitals WHERE patient_id = ANY($1) AND NOT entered_in_error ORDER BY measured_at DESC LIMIT 20`, [ids]);
    const appointments = await tx.many<{ id: string; booking_ref: string; state: string; start_at: Date; clinician_name: string; service_name: string }>(
      `SELECT a.id, a.booking_ref, a.state, lower(a.period) AS start_at, c.display_name AS clinician_name, s.name AS service_name
         FROM appointment a JOIN clinician c ON c.id = a.clinician_id JOIN service s ON s.id = a.service_id
        WHERE a.patient_id = ANY($1) ORDER BY lower(a.period) DESC LIMIT 50`, [ids]);
    const followUps = await tx.many(`SELECT * FROM follow_up WHERE patient_id = ANY($1) ORDER BY due_date DESC LIMIT 50`, [ids]);
    await audit(tx, actor, 'chart.viewed', 'patient', patientId, { patientId });
    return { encounters, notes, prescriptions, allergies, vitals, appointments, followUps, mergedIds: ids.filter((i) => i !== patientId) };
  });
}
