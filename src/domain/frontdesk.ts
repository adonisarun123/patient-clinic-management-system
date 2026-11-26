// OP-027 repeating appointment series, OP-028 waitlist, CL-031 referrals (inbound and outbound).
import { z } from 'zod';
import { withTenant, type Tx } from '@/lib/db';
import { AppError, invalid, notFound, rule } from '@/lib/errors';
import { authorize, staffId, type Actor } from '@/lib/actor';
import { audit, emit } from '@/lib/events';
import { cancelAppointment, confirmInTx, createHoldTx, bookDirect } from './scheduling';
import type { Tenant } from './tenants';

// ------------------------------------------------------------------ repeating series (OP-027)
export const seriesInput = z.object({
  patientId: z.uuid(), serviceId: z.uuid(), clinicianId: z.uuid(),
  firstStart: z.iso.datetime({ offset: true }),
  freq: z.enum(['daily', 'weekly']), everyN: z.coerce.number().int().min(1).max(8),
  count: z.coerce.number().int().min(2).max(52),
  skipConflicts: z.boolean().default(false),
  notes: z.string().max(1000).optional(),
});

export type SeriesResult = { seriesId: string; booked: { start: string; bookingRef: string }[]; skipped: { start: string; reason: string }[] };

/**
 * Books every occurrence at the same local clock time (correct across DST changes) in one transaction.
 * Each occurrence goes through the normal hold → confirm path, so the database still prevents double booking.
 * With skipConflicts off, one unavailable date books nothing and names the date; with it on, the free ones are booked.
 */
export async function bookSeries(actor: Actor, tenant: Tenant, input: z.input<typeof seriesInput>): Promise<SeriesResult> {
  authorize(actor, 'schedule.book');
  const p = seriesInput.parse(input);
  return withTenant(tenant.id, async (tx) => {
    const starts = await tx.many<{ s: Date }>(
      `SELECT ((($1::timestamptz AT TIME ZONE $2) + make_interval(days => (g * $3)))) AT TIME ZONE $2 AS s
         FROM generate_series(0, $4 - 1) g ORDER BY g`,
      [p.firstStart, tenant.timezone, p.freq === 'weekly' ? 7 * p.everyN : p.everyN, p.count]);
    const series = await tx.one<{ id: string }>(
      `INSERT INTO appointment_series (tenant_id, patient_id, service_id, clinician_id, freq, every_n, requested, first_start, notes, created_by)
       VALUES (app_tenant_id(), $1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
      [p.patientId, p.serviceId, p.clinicianId, p.freq, p.everyN, p.count, p.firstStart, p.notes ?? null, staffId(actor)]);
    const booked: SeriesResult['booked'] = []; const skipped: SeriesResult['skipped'] = [];
    for (const [i, { s }] of starts.entries()) {
      const start = s.toISOString();
      try {
        const r = await tx.savepoint(async () => {
          const hold = await createHoldTx(tx, actor, tenant, { serviceId: p.serviceId, clinicianId: p.clinicianId, start });
          return confirmInTx(tx, actor, tenant, { holdId: hold.holdId, patientId: p.patientId, source: 'staff', notes: p.notes });
        });
        await tx.exec(`UPDATE appointment SET series_id = $2, series_seq = $3 WHERE id = $1`, [r.appointmentId, series.id, i + 1]);
        booked.push({ start, bookingRef: r.bookingRef });
      } catch (e) {
        if (!(e instanceof AppError) || !['SLOT_TAKEN', 'RULE_VIOLATION', 'HOLD_EXPIRED'].includes(e.code)) throw e;
        if (!p.skipConflicts) throw rule(`Occurrence ${i + 1} (${start}) is not available: ${e.message} Nothing was booked. Choose another time, or allow skipping unavailable dates.`);
        skipped.push({ start, reason: e.message });
      }
    }
    if (!booked.length) throw rule('None of the dates were available. Nothing was booked.');
    await audit(tx, actor, 'appointment_series.booked', 'appointment_series', series.id, { patientId: p.patientId, data: { booked: booked.length, skipped: skipped.length } });
    return { seriesId: series.id, booked, skipped };
  });
}

/** Cancels the remaining (future, not yet arrived) visits of a series; past and attended visits are untouched. */
export async function cancelSeries(actor: Actor, tenant: Tenant, seriesId: string, reason: string) {
  authorize(actor, 'schedule.book');
  if (!reason?.trim()) throw invalid('Give a reason');
  const ids = await withTenant(tenant.id, async (tx) => {
    const s = await tx.maybe<{ id: string; cancelled_at: Date | null }>(`SELECT id, cancelled_at FROM appointment_series WHERE id = $1 FOR UPDATE`, [seriesId]);
    if (!s) throw notFound('Series');
    await tx.exec(`UPDATE appointment_series SET cancelled_at = coalesce(cancelled_at, now()), cancel_reason = coalesce(cancel_reason, $2) WHERE id = $1`, [seriesId, reason]);
    await audit(tx, actor, 'appointment_series.cancelled', 'appointment_series', seriesId, { reason });
    return (await tx.many<{ id: string }>(`SELECT id FROM appointment WHERE series_id = $1 AND state = 'booked' AND lower(period) > now() ORDER BY lower(period)`, [seriesId])).map((r) => r.id);
  });
  for (const id of ids) await cancelAppointment(actor, tenant, id, `Series cancelled: ${reason}`);
  return { cancelled: ids.length };
}

export async function seriesDetail(actor: Actor, tenant: Tenant, seriesId: string) {
  authorize(actor, 'schedule.read');
  return withTenant(tenant.id, async (tx) => ({
    series: await tx.one<{ id: string; patient_id: string; freq: string; every_n: number; requested: number; cancelled_at: Date | null; cancel_reason: string | null }>(
      `SELECT * FROM appointment_series WHERE id = $1`, [seriesId]),
    visits: await tx.many<{ id: string; booking_ref: string; state: string; start_at: Date; series_seq: number }>(
      `SELECT id, booking_ref, state, lower(period) AS start_at, series_seq FROM appointment WHERE series_id = $1 ORDER BY lower(period)`, [seriesId]),
  }));
}

// ------------------------------------------------------------------ waitlist (OP-028)
export const waitlistInput = z.object({
  patientId: z.uuid(), serviceId: z.uuid(), clinicianId: z.uuid().nullish(),
  earliestDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), latestDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  timePref: z.enum(['any', 'morning', 'afternoon', 'evening']).default('any'),
  priority: z.coerce.number().int().min(0).max(2).default(0),
  notes: z.string().max(500).optional(),
});

export async function addToWaitlist(actor: Actor, tenant: Tenant, input: z.input<typeof waitlistInput>) {
  authorize(actor, 'schedule.book');
  const p = waitlistInput.parse(input);
  if (p.latestDate < p.earliestDate) throw invalid('The latest date must be on or after the earliest date');
  return withTenant(tenant.id, async (tx) => {
    const dup = await tx.maybe(`SELECT 1 FROM waitlist_entry WHERE patient_id = $1 AND service_id = $2 AND status = 'waiting'`, [p.patientId, p.serviceId]);
    if (dup) throw rule('This patient is already waiting for this service. Edit the existing entry instead.');
    const r = await tx.one<{ id: string }>(
      `INSERT INTO waitlist_entry (tenant_id, patient_id, service_id, clinician_id, earliest_date, latest_date, time_pref, priority, notes, created_by)
       VALUES (app_tenant_id(), $1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
      [p.patientId, p.serviceId, p.clinicianId ?? null, p.earliestDate, p.latestDate, p.timePref, p.priority, p.notes ?? null, staffId(actor)]);
    await audit(tx, actor, 'waitlist.added', 'waitlist_entry', r.id, { patientId: p.patientId });
    return r.id;
  });
}

export async function listWaitlist(actor: Actor, tenant: Tenant, status: 'waiting' | 'booked' | 'removed' = 'waiting') {
  authorize(actor, 'schedule.read');
  return withTenant(tenant.id, (tx) => tx.many<{ id: string; patient_id: string; full_name: string; uhid: string; phone: string | null; service_id: string; service_name: string;
      clinician_id: string | null; earliest_date: string; latest_date: string; time_pref: string; priority: number; notes: string | null; status: string;
      match_start: Date | null; match_clinician: string | null; created_at: Date; appointment_id: string | null }>(
    `SELECT w.*, w.earliest_date::text AS earliest_date, w.latest_date::text AS latest_date, p.full_name, p.uhid, p.phone_e164 AS phone, s.name AS service_name
       FROM waitlist_entry w JOIN patient p ON p.id = w.patient_id JOIN service s ON s.id = w.service_id
      WHERE w.status = $1 ORDER BY (w.match_start IS NOT NULL AND w.match_start > now()) DESC, w.priority DESC, w.created_at`, [status]));
}

/** Books the matched (or a chosen) time for a waitlist entry and closes the entry. */
export async function bookFromWaitlist(actor: Actor, tenant: Tenant, entryId: string, slot: { start: string; clinicianId: string }, requestKey?: string | null) {
  authorize(actor, 'schedule.book');
  const e = await withTenant(tenant.id, (tx) => tx.maybe<{ patient_id: string; service_id: string; status: string }>(`SELECT patient_id, service_id, status FROM waitlist_entry WHERE id = $1`, [entryId]));
  if (!e) throw notFound('Waitlist entry');
  if (e.status !== 'waiting') throw rule('This entry is no longer waiting');
  const r = await bookDirect(actor, tenant, { serviceId: e.service_id, clinicianId: slot.clinicianId, start: slot.start, patientId: e.patient_id, notes: 'Booked from waitlist' }, requestKey);
  await withTenant(tenant.id, async (tx) => {
    await tx.exec(`UPDATE waitlist_entry SET status = 'booked', appointment_id = $2, updated_at = now() WHERE id = $1 AND status = 'waiting'`, [entryId, r.appointmentId]);
    await audit(tx, actor, 'waitlist.booked', 'waitlist_entry', entryId, { patientId: e.patient_id });
  });
  return r;
}

export async function removeFromWaitlist(actor: Actor, tenant: Tenant, entryId: string, reason: string) {
  authorize(actor, 'schedule.book');
  if (!reason?.trim()) throw invalid('Give a reason');
  await withTenant(tenant.id, async (tx) => {
    const n = await tx.exec(`UPDATE waitlist_entry SET status = 'removed', removed_reason = $2, updated_at = now() WHERE id = $1 AND status = 'waiting'`, [entryId, reason]);
    if (!n) throw rule('This entry is no longer waiting');
    await audit(tx, actor, 'waitlist.removed', 'waitlist_entry', entryId, { reason });
  });
}

/** Clears a match the patient declined, so the entry keeps waiting for the next freed slot. */
export async function declineWaitlistMatch(actor: Actor, tenant: Tenant, entryId: string) {
  authorize(actor, 'schedule.book');
  await withTenant(tenant.id, (tx) => tx.exec(`UPDATE waitlist_entry SET match_start = NULL, match_clinician = NULL, updated_at = now() WHERE id = $1`, [entryId]));
}

// ------------------------------------------------------------------ referrals (CL-031)
export const referrerInput = z.object({
  id: z.uuid().optional(), name: z.string().trim().min(2).max(200), specialty: z.string().max(120).optional(), organisation: z.string().max(200).optional(),
  phone: z.string().max(20).optional(), email: z.email().optional().or(z.literal('')), registrationNo: z.string().max(60).optional(), active: z.boolean().default(true),
});

export async function upsertReferrer(actor: Actor, tenant: Tenant, input: z.input<typeof referrerInput>) {
  authorize(actor, 'patient.write');
  const p = referrerInput.parse(input);
  return withTenant(tenant.id, async (tx) => {
    const vals = [p.name, p.specialty || null, p.organisation || null, p.phone || null, p.email || null, p.registrationNo || null, p.active];
    const r = p.id
      ? await tx.one<{ id: string }>(`UPDATE referrer SET name=$2, specialty=$3, organisation=$4, phone=$5, email=$6, registration_no=$7, active=$8 WHERE id=$1 RETURNING id`, [p.id, ...vals])
      : await tx.one<{ id: string }>(`INSERT INTO referrer (tenant_id, name, specialty, organisation, phone, email, registration_no, active) VALUES (app_tenant_id(), $1,$2,$3,$4,$5,$6,$7) RETURNING id`, vals);
    await audit(tx, actor, p.id ? 'referrer.updated' : 'referrer.created', 'referrer', r.id);
    return r.id;
  });
}

export async function listReferrers(actor: Actor, tenant: Tenant) {
  authorize(actor, 'patient.read');
  return withTenant(tenant.id, (tx) => tx.many<{ id: string; name: string; specialty: string | null; organisation: string | null; phone: string | null; email: string | null;
      registration_no: string | null; active: boolean; inbound_90d: number; inbound_total: number; outbound_total: number }>(
    `SELECT r.*, count(f.id) FILTER (WHERE f.direction = 'inbound' AND f.created_at > now() - interval '90 days')::int AS inbound_90d,
            count(f.id) FILTER (WHERE f.direction = 'inbound')::int AS inbound_total,
            count(f.id) FILTER (WHERE f.direction = 'outbound')::int AS outbound_total
       FROM referrer r LEFT JOIN referral f ON f.referrer_id = r.id
      GROUP BY r.id ORDER BY r.active DESC, inbound_90d DESC, r.name`));
}

export const outboundInput = z.object({
  patientId: z.uuid(), encounterId: z.uuid().nullish(), referrerId: z.uuid().nullish(), toSpecialty: z.string().trim().max(120).optional(),
  urgency: z.enum(['routine', 'soon', 'urgent']).default('routine'),
  reason: z.string().trim().min(5).max(2000), clinicalSummary: z.string().max(8000).optional(),
});

async function nextRef(tx: Tx) {
  const n = await tx.one<{ v: number }>(`SELECT next_doc_number('referral') AS v`);
  return `RF${String(n.v).padStart(6, '0')}`;
}

/** Outbound referral letter: drafted by a clinician; signing freezes the content (DB trigger). */
export async function draftOutboundReferral(actor: Actor, tenant: Tenant, input: z.input<typeof outboundInput>) {
  authorize(actor, 'clinical.write');
  const p = outboundInput.parse(input);
  if (!p.referrerId && !p.toSpecialty) throw invalid('Choose who the patient is referred to, or at least the specialty');
  return withTenant(tenant.id, async (tx) => {
    const r = await tx.one<{ id: string }>(
      `INSERT INTO referral (tenant_id, ref_number, direction, patient_id, encounter_id, referrer_id, to_specialty, urgency, reason, clinical_summary, status, clinician_id, created_by)
       VALUES (app_tenant_id(), $1, 'outbound', $2,$3,$4,$5,$6,$7,$8, 'draft', $9, $10) RETURNING id`,
      [await nextRef(tx), p.patientId, p.encounterId ?? null, p.referrerId ?? null, p.toSpecialty ?? null, p.urgency, p.reason, p.clinicalSummary ?? null,
        actor.kind === 'staff' ? actor.clinicianId : null, staffId(actor)]);
    await audit(tx, actor, 'referral.drafted', 'referral', r.id, { patientId: p.patientId });
    return r.id;
  });
}

export async function updateDraftReferral(actor: Actor, tenant: Tenant, id: string, input: z.input<typeof outboundInput>) {
  authorize(actor, 'clinical.write');
  const p = outboundInput.parse(input);
  await withTenant(tenant.id, async (tx) => {
    const n = await tx.exec(`UPDATE referral SET referrer_id=$2, to_specialty=$3, urgency=$4, reason=$5, clinical_summary=$6, updated_at=now() WHERE id=$1 AND status='draft'`,
      [id, p.referrerId ?? null, p.toSpecialty ?? null, p.urgency, p.reason, p.clinicalSummary ?? null]);
    if (!n) throw rule('Only a draft can be edited');
    await audit(tx, actor, 'referral.edited', 'referral', id);
  });
}

export async function signReferral(actor: Actor, tenant: Tenant, id: string) {
  authorize(actor, 'clinical.sign');
  if (actor.kind !== 'staff' || !actor.clinicianId) throw new AppError('FORBIDDEN', 'Only a registered clinician can sign a referral letter');
  await withTenant(tenant.id, async (tx) => {
    const r = await tx.maybe<{ status: string; direction: string; patient_id: string }>(`SELECT status, direction, patient_id FROM referral WHERE id = $1 FOR UPDATE`, [id]);
    if (!r) throw notFound('Referral');
    if (r.direction !== 'outbound' || r.status !== 'draft') throw rule('Only a draft outbound referral can be signed');
    const reg = await tx.maybe<{ registration_number: string | null }>(`SELECT registration_number FROM clinician WHERE id = $1`, [actor.clinicianId]);
    if (!reg?.registration_number) throw rule('Your registration number is missing from your doctor profile; it is printed on the letter.');
    await tx.exec(`UPDATE referral SET status = 'signed', signed_by = $2, signed_at = now(), clinician_id = $3, updated_at = now() WHERE id = $1`, [id, actor.staffId, actor.clinicianId]);
    await audit(tx, actor, 'referral.signed', 'referral', id, { patientId: r.patient_id });
  });
}

/** Records that the signed letter went out (handed to patient, emailed, faxed …). */
export async function markReferralSent(actor: Actor, tenant: Tenant, id: string, how: string) {
  authorize(actor, 'patient.write');
  await withTenant(tenant.id, async (tx) => {
    const r = await tx.maybe<{ patient_id: string; referrer_id: string | null }>(`UPDATE referral SET status = 'sent', outcome_notes = coalesce(outcome_notes || E'\\n', '') || $2, updated_at = now()
       WHERE id = $1 AND direction = 'outbound' AND status = 'signed' RETURNING patient_id, referrer_id`, [id, `Sent: ${how}`]);
    if (!r) throw rule('Only a signed referral can be marked sent');
    await audit(tx, actor, 'referral.sent', 'referral', id, { patientId: r.patient_id });
    await emit(tx, 'referral.sent', 'referral', id, { patientId: r.patient_id, referrerId: r.referrer_id });
  });
}

export const inboundInput = z.object({
  patientId: z.uuid(), referrerId: z.uuid(), urgency: z.enum(['routine', 'soon', 'urgent']).default('routine'),
  reason: z.string().trim().min(3).max(2000), clinicalSummary: z.string().max(8000).optional(), clinicianId: z.uuid().nullish(),
});

/** Inbound referral from an outside doctor: recorded at the desk, later linked to the visit it produced. */
export async function recordInboundReferral(actor: Actor, tenant: Tenant, input: z.input<typeof inboundInput>) {
  authorize(actor, 'patient.write');
  const p = inboundInput.parse(input);
  return withTenant(tenant.id, async (tx) => {
    const r = await tx.one<{ id: string }>(
      `INSERT INTO referral (tenant_id, ref_number, direction, patient_id, referrer_id, urgency, reason, clinical_summary, status, clinician_id, created_by)
       VALUES (app_tenant_id(), $1, 'inbound', $2,$3,$4,$5,$6, 'received', $7, $8) RETURNING id`,
      [await nextRef(tx), p.patientId, p.referrerId, p.urgency, p.reason, p.clinicalSummary ?? null, p.clinicianId ?? null, staffId(actor)]);
    await audit(tx, actor, 'referral.received', 'referral', r.id, { patientId: p.patientId });
    await emit(tx, 'referral.received', 'referral', r.id, { patientId: p.patientId, referrerId: p.referrerId, urgency: p.urgency });
    return r.id;
  });
}

export async function linkReferralAppointment(actor: Actor, tenant: Tenant, id: string, appointmentId: string) {
  authorize(actor, 'schedule.book');
  await withTenant(tenant.id, async (tx) => {
    const a = await tx.maybe<{ patient_id: string }>(`SELECT patient_id FROM appointment WHERE id = $1`, [appointmentId]);
    const r = await tx.maybe<{ patient_id: string; status: string; direction: string }>(`SELECT patient_id, status, direction FROM referral WHERE id = $1 FOR UPDATE`, [id]);
    if (!a || !r) throw notFound('Referral or appointment');
    if (a.patient_id !== r.patient_id) throw rule('That appointment belongs to a different patient');
    if (r.direction !== 'inbound' || !['received', 'booked'].includes(r.status)) throw rule('Only an open inbound referral can be linked to a visit');
    await tx.exec(`UPDATE referral SET appointment_id = $2, status = 'booked', updated_at = now() WHERE id = $1`, [id, appointmentId]);
    await audit(tx, actor, 'referral.booked', 'referral', id, { patientId: r.patient_id });
  });
}

export async function closeReferral(actor: Actor, tenant: Tenant, id: string, status: 'completed' | 'declined' | 'cancelled', notes: string) {
  authorize(actor, 'patient.write');
  if (!notes?.trim()) throw invalid('Add a short note');
  await withTenant(tenant.id, async (tx) => {
    const n = await tx.exec(`UPDATE referral SET status = $2, outcome_notes = coalesce(outcome_notes || E'\\n', '') || $3, updated_at = now()
       WHERE id = $1 AND status NOT IN ('completed','declined','cancelled')`, [id, status, notes]);
    if (!n) throw rule('This referral is already closed');
    await audit(tx, actor, `referral.${status}`, 'referral', id, { reason: notes });
  });
}

export async function listReferrals(actor: Actor, tenant: Tenant, f: { direction?: 'inbound' | 'outbound'; open?: boolean; patientId?: string } = {}) {
  authorize(actor, 'patient.read');
  return withTenant(tenant.id, (tx) => tx.many<{ id: string; ref_number: string; direction: string; status: string; urgency: string; reason: string; created_at: Date;
      patient_id: string; full_name: string; uhid: string; referrer_name: string | null; to_specialty: string | null; appointment_id: string | null }>(
    `SELECT f.id, f.ref_number, f.direction, f.status, f.urgency, f.reason, f.created_at, f.patient_id, p.full_name, p.uhid, r.name AS referrer_name, f.to_specialty, f.appointment_id
       FROM referral f JOIN patient p ON p.id = f.patient_id LEFT JOIN referrer r ON r.id = f.referrer_id
      WHERE ($1::text IS NULL OR f.direction = $1) AND ($2::uuid IS NULL OR f.patient_id = $2)
        AND (NOT $3 OR f.status NOT IN ('completed','declined','cancelled'))
      ORDER BY CASE f.urgency WHEN 'urgent' THEN 0 WHEN 'soon' THEN 1 ELSE 2 END, f.created_at DESC LIMIT 300`,
    [f.direction ?? null, f.patientId ?? null, !!f.open]));
}

export async function referralDetail(actor: Actor, tenant: Tenant, id: string) {
  authorize(actor, 'patient.read');
  return withTenant(tenant.id, async (tx) => {
    const r = await tx.maybe<{ id: string; ref_number: string; direction: string; status: string; urgency: string; reason: string; clinical_summary: string | null;
        patient_id: string; encounter_id: string | null; referrer_id: string | null; to_specialty: string | null; signed_at: Date | null; created_at: Date;
        appointment_id: string | null; outcome_notes: string | null; clinician_name: string | null; qualification: string | null; registration_number: string | null;
        registration_council: string | null; referrer_name: string | null; referrer_specialty: string | null; referrer_org: string | null }>(
      `SELECT f.*, c.display_name AS clinician_name, c.qualification, c.registration_number, c.registration_council,
              r.name AS referrer_name, r.specialty AS referrer_specialty, r.organisation AS referrer_org
         FROM referral f LEFT JOIN clinician c ON c.id = f.clinician_id LEFT JOIN referrer r ON r.id = f.referrer_id WHERE f.id = $1`, [id]);
    if (!r) throw notFound('Referral');
    return r;
  });
}
