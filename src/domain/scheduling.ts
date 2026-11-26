import { z } from 'zod';
import { withTenant, type Tx } from '@/lib/db';
import { AppError, invalid, notFound, rule } from '@/lib/errors';
import { authorize, actorId, staffId, type Actor } from '@/lib/actor';
import { audit, emit } from '@/lib/events';
import { idempotent } from '@/lib/idempotency';
import { sha256, randomToken } from '@/lib/crypto';
import type { Tenant } from './tenants';

export type Slot = { clinician_id: string; location_id: string; start_at: Date; end_at: Date };

/**
 * OP-013..018. Expands weekly sessions in the tenant zone, adds approved extra sessions, subtracts leave/closures
 * and every live claim on the doctor or room, and keeps the whole occupied interval (with buffers) inside a session.
 * Half-open ranges: a visit ending 10:30 abuts one starting 10:30 when buffers are zero.
 */
const AVAILABILITY_SQL = `
WITH svc AS (SELECT * FROM service WHERE id = $1 AND active),
cl AS (
  SELECT sc.clinician_id FROM service_clinician sc JOIN clinician c ON c.id = sc.clinician_id AND c.active
   WHERE sc.service_id = $1 AND ($2::uuid IS NULL OR sc.clinician_id = $2)),
days AS (SELECT d::date AS day FROM generate_series($3::date, $4::date, interval '1 day') d),
sessions AS (
  SELECT t.clinician_id, t.location_id, t.slot_step_min,
         ((days.day + t.start_time) AT TIME ZONE $5) AS s_start,
         ((days.day + t.end_time)   AT TIME ZONE $5) AS s_end
    FROM days JOIN schedule_template t
      ON t.weekday = extract(dow FROM days.day)::int AND days.day >= t.valid_from AND (t.valid_to IS NULL OR days.day <= t.valid_to)
   WHERE t.clinician_id IN (SELECT clinician_id FROM cl)
  UNION ALL
  SELECT e.clinician_id, e.location_id, e.slot_step_min, lower(e.period), upper(e.period)
    FROM schedule_exception e
   WHERE e.kind = 'extra' AND e.clinician_id IN (SELECT clinician_id FROM cl)
     AND e.period && tstzrange(($3::date)::timestamp AT TIME ZONE $5, (($4::date) + 1)::timestamp AT TIME ZONE $5)),
cand AS (
  SELECT s.clinician_id, s.location_id, gs AS start_at,
         gs + make_interval(mins => svc.duration_min) AS end_at,
         tstzrange(gs - make_interval(mins => svc.buffer_before_min),
                   gs + make_interval(mins => svc.duration_min + svc.buffer_after_min), '[)') AS occ,
         s.s_start, s.s_end
    FROM sessions s CROSS JOIN svc
    CROSS JOIN LATERAL generate_series(s.s_start, s.s_end - make_interval(mins => svc.duration_min),
                                       make_interval(mins => s.slot_step_min)) gs
   WHERE ($8::timestamptz IS NULL OR gs = $8))
SELECT DISTINCT ON (c.clinician_id, c.start_at) c.clinician_id, c.location_id, c.start_at, c.end_at
  FROM cand c
 WHERE lower(c.occ) >= c.s_start AND upper(c.occ) <= c.s_end
   AND c.start_at >= now() + make_interval(mins => $6)
   AND c.start_at <  now() + make_interval(days => $7)
   AND NOT EXISTS (SELECT 1 FROM schedule_exception e
                    WHERE e.kind IN ('leave','closure') AND (e.clinician_id IS NULL OR e.clinician_id = c.clinician_id)
                      AND e.period && c.occ)
   AND NOT EXISTS (SELECT 1 FROM resource_claim r
                    WHERE r.status IN ('hold','booked') AND (r.status = 'booked' OR r.expires_at > now())
                      AND ((r.resource_kind = 'clinician' AND r.resource_id = c.clinician_id)
                        OR (r.resource_kind = 'location'  AND r.resource_id = c.location_id))
                      AND r.period && c.occ)
 ORDER BY c.clinician_id, c.start_at, c.location_id`;

type Window = { from: string; to: string; leadMin: number; horizonDays: number };

async function querySlots(tx: Tx, tz: string, serviceId: string, clinicianId: string | null, w: Window, exactStart: string | null = null) {
  const rows = await tx.many<Slot>(AVAILABILITY_SQL,
    [serviceId, clinicianId, w.from, w.to, tz, w.leadMin, w.horizonDays, exactStart]);
  return rows.sort((a, b) => +a.start_at - +b.start_at);
}

const iso = (d: Date) => d.toISOString();
const localDate = (d: Date, tz: string) => d.toLocaleDateString('en-CA', { timeZone: tz });
function addDays(date: string, n: number) {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function windowFor(tenant: Tenant, actor: Actor, from: string, to: string): Window {
  const internal = actor.kind === 'staff';
  return {
    from, to,
    leadMin: internal ? 0 : tenant.settings.minLeadMinutes,
    horizonDays: internal ? 366 : tenant.settings.bookingHorizonDays,
  };
}

export const availabilityInput = z.object({
  serviceId: z.uuid(),
  clinicianId: z.uuid().nullish(),
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  days: z.number().int().min(1).max(31).default(7),
});

/** OP-017: no other patient's details ever appear in availability responses. */
export async function getAvailability(actor: Actor, tenant: Tenant, input: z.input<typeof availabilityInput>) {
  if (actor.kind === 'staff') authorize(actor, 'schedule.read');
  const p = availabilityInput.parse(input);
  return withTenant(tenant.id, async (tx) => {
    const svc = await tx.maybe<{ public_bookable: boolean; duration_min: number; price_paise: number; version: number }>(
      `SELECT public_bookable, duration_min, price_paise, version FROM service WHERE id = $1 AND active`, [p.serviceId]);
    if (!svc || (actor.kind === 'public' && !svc.public_bookable)) throw notFound('Service');
    const slots = await querySlots(tx, tenant.timezone, p.serviceId, p.clinicianId ?? null,
      windowFor(tenant, actor, p.from, addDays(p.from, p.days - 1)));
    return {
      timezone: tenant.timezone, serviceVersion: Number(svc.version), durationMin: svc.duration_min,
      pricePaise: Number(svc.price_paise), currency: tenant.currency,
      slots: slots.map((s) => ({ clinicianId: s.clinician_id, start: iso(s.start_at), end: iso(s.end_at) })),
    };
  });
}

// ------------------------------------------------------------------ holds
export const holdInput = z.object({
  serviceId: z.uuid(),
  clinicianId: z.uuid(),
  start: z.iso.datetime({ offset: true }),
});

type HoldResult = { holdId: string; expiresAt: string; clinicianId: string; locationId: string; start: string; end: string };

/**
 * OP-019: lock resource rows in canonical id order, release elapsed holds on them, re-read availability and insert
 * all claims or none. The exclusion constraint is the final guard; a lost race returns fresh alternatives.
 */
async function createHoldTx(tx: Tx, actor: Actor, tenant: Tenant, input: z.infer<typeof holdInput>): Promise<HoldResult> {
  const start = new Date(input.start);
  if (Number.isNaN(+start)) throw invalid('Invalid start time');
  const svc = await tx.maybe<{ duration_min: number; buffer_before_min: number; buffer_after_min: number; public_bookable: boolean }>(
    `SELECT duration_min, buffer_before_min, buffer_after_min, public_bookable FROM service WHERE id = $1 AND active`, [input.serviceId]);
  if (!svc || (actor.kind === 'public' && !svc.public_bookable)) throw notFound('Service');

  const actorRef = actor.kind === 'public' ? sha256(actor.journey) : actorId(actor);
  const live = await tx.one<{ n: number }>(
    `SELECT count(*)::int AS n FROM booking_hold WHERE actor_ref = $1 AND status = 'active' AND expires_at > now()`, [actorRef]);
  if (live.n >= (actor.kind === 'staff' ? 20 : 2)) throw new AppError('RATE_LIMITED', 'Too many reservations in progress');

  const day = localDate(start, tenant.timezone);
  const w = windowFor(tenant, actor, addDays(day, -1), addDays(day, 1));
  // First pass ignores nothing; it tells us the session's room. Locks then make the decision authoritative.
  let match = (await querySlots(tx, tenant.timezone, input.serviceId, input.clinicianId, w, start.toISOString()))[0];
  const locationId = match?.location_id ?? (await tx.maybe<{ location_id: string }>(
    `SELECT location_id FROM schedule_template WHERE clinician_id = $1 LIMIT 1`, [input.clinicianId]))?.location_id;
  if (!locationId) throw new AppError('SLOT_TAKEN', 'That time is not available.');

  // Same lock order on every path (doctor, then room) so concurrent bookings cannot deadlock.
  await tx.exec(`SELECT id FROM clinician WHERE id = $1 FOR UPDATE`, [input.clinicianId]);
  await tx.exec(`SELECT id FROM location WHERE id = $1 FOR UPDATE`, [locationId]);
  // Expire elapsed holds touching these resources (correctness does not depend on the cleanup job).
  await tx.exec(
    `WITH x AS (
       UPDATE resource_claim SET status = 'released', released_at = now()
        WHERE status = 'hold' AND expires_at <= now()
          AND ((resource_kind = 'clinician' AND resource_id = $1) OR (resource_kind = 'location' AND resource_id = $2))
       RETURNING hold_id)
     UPDATE booking_hold SET status = 'expired' WHERE id IN (SELECT hold_id FROM x) AND status = 'active'`,
    [input.clinicianId, locationId]);
  match = (await querySlots(tx, tenant.timezone, input.serviceId, input.clinicianId, w, start.toISOString()))[0];
  if (!match) {
    throw new AppError('SLOT_TAKEN', 'That time is no longer available.', {
      alternatives: (await querySlots(tx, tenant.timezone, input.serviceId, input.clinicianId, w)).slice(0, 6)
        .map((s) => ({ clinicianId: s.clinician_id, start: iso(s.start_at), end: iso(s.end_at) })),
    });
  }
  const hold = await tx.one<{ id: string; expires_at: Date }>(
    `INSERT INTO booking_hold (tenant_id, service_id, clinician_id, location_id, visit_period, expires_at, actor_kind, actor_ref)
     VALUES (app_tenant_id(), $1, $2, $3, tstzrange($4, $5, '[)'), now() + make_interval(mins => $6), $7, $8)
     RETURNING id, expires_at`,
    [input.serviceId, input.clinicianId, match.location_id, match.start_at, match.end_at, tenant.settings.holdMinutes,
      actor.kind === 'staff' ? 'staff' : actor.kind === 'api_key' ? 'api_key' : 'public', actorRef]);
  const occStart = new Date(+match.start_at - svc.buffer_before_min * 60_000);
  const occEnd = new Date(+match.end_at + svc.buffer_after_min * 60_000);
  for (const [kind, id] of [['clinician', input.clinicianId], ['location', match.location_id]] as const) {
    await tx.exec(
      `INSERT INTO resource_claim (tenant_id, resource_kind, resource_id, period, status, hold_id, expires_at)
       VALUES (app_tenant_id(), $1, $2, tstzrange($3, $4, '[)'), 'hold', $5, $6)`,
      [kind, id, occStart, occEnd, hold.id, hold.expires_at]);
  }
  return { holdId: hold.id, expiresAt: iso(hold.expires_at), clinicianId: input.clinicianId, locationId: match.location_id, start: iso(match.start_at), end: iso(match.end_at) };
}

export async function createHold(actor: Actor, tenant: Tenant, input: z.input<typeof holdInput>) {
  if (actor.kind === 'staff') authorize(actor, 'schedule.book');
  if (actor.kind === 'public' && !tenant.settings.publicBookingEnabled) throw new AppError('FORBIDDEN', 'Online booking is not enabled');
  const p = holdInput.parse(input);
  return withTenant(tenant.id, (tx) => createHoldTx(tx, actor, tenant, p));
}

export async function releaseHold(actor: Actor, tenant: Tenant, holdId: string) {
  return withTenant(tenant.id, async (tx) => {
    const actorRef = actor.kind === 'public' ? sha256(actor.journey) : actorId(actor);
    const n = await tx.exec(`UPDATE booking_hold SET status = 'released' WHERE id = $1 AND actor_ref = $2 AND status = 'active'`, [holdId, actorRef]);
    if (n) await tx.exec(`UPDATE resource_claim SET status = 'released', released_at = now() WHERE hold_id = $1 AND status = 'hold'`, [holdId]);
  });
}

// ------------------------------------------------------------------ appointments
export const confirmInput = z.object({
  holdId: z.uuid(),
  patientId: z.uuid(),
  source: z.enum(['staff', 'widget', 'api', 'phone', 'portal', 'import']).default('staff'),
  notes: z.string().max(1000).optional(),
});

export async function confirmInTx(tx: Tx, actor: Actor, tenant: Tenant, p: z.infer<typeof confirmInput>) {
  const hold = await tx.maybe<{ id: string; service_id: string; clinician_id: string; location_id: string; visit_period: string;
    expires_at: Date; status: string; actor_ref: string; expired: boolean; start_at: Date; end_at: Date }>(
    `SELECT *, expires_at <= now() AS expired, lower(visit_period) AS start_at, upper(visit_period) AS end_at
       FROM booking_hold WHERE id = $1 FOR UPDATE`, [p.holdId]);
  if (!hold) throw notFound('Reservation');
  const actorRef = actor.kind === 'public' ? sha256(actor.journey) : actorId(actor);
  const sameActor = hold.actor_ref === actorRef || (actor.kind === 'staff' && ['owner', 'admin', 'reception'].includes(actor.role));
  if (!sameActor) throw notFound('Reservation');
  if (hold.status !== 'active' || hold.expired) {
    if (hold.status === 'active') {
      await tx.exec(`UPDATE booking_hold SET status = 'expired' WHERE id = $1`, [hold.id]);
      await tx.exec(`UPDATE resource_claim SET status = 'released', released_at = now() WHERE hold_id = $1 AND status = 'hold'`, [hold.id]);
    }
    throw new AppError('HOLD_EXPIRED', 'Your reserved time expired before confirmation. Please choose a time again.');
  }
  const patient = await tx.maybe<{ id: string; status: string }>(`SELECT id, status FROM patient WHERE id = $1 FOR UPDATE`, [p.patientId]);
  if (!patient || patient.status === 'merged' || patient.status === 'inactive') throw notFound('Patient');
  // OP-021: the same patient cannot hold two overlapping direct appointments.
  const clash = await tx.maybe(
    `SELECT booking_ref FROM appointment WHERE patient_id = $1 AND state IN ('booked','arrived','in_service')
        AND period && tstzrange($2, $3, '[)')`, [p.patientId, hold.start_at, hold.end_at]);
  if (clash) throw rule('This patient already has an appointment at an overlapping time.');
  const svc = await tx.one<{ department_id: string; price_paise: number; version: number; name: string; modality: string }>(
    `SELECT department_id, price_paise, version, name, modality FROM service WHERE id = $1`, [hold.service_id]);
  const n = await tx.one<{ v: number }>(`SELECT next_doc_number('booking') AS v`);
  const bookingRef = `BK${String(n.v).padStart(6, '0')}`;
  const appt = await tx.one<{ id: string; version: number }>(
    `INSERT INTO appointment (tenant_id, booking_ref, patient_id, clinician_id, service_id, service_version, department_id, location_id,
        period, source, quoted_price_paise, notes, requested_clinician_id, created_by, modality)
     VALUES (app_tenant_id(), $1,$2,$3,$4,$5,$6,$7, tstzrange($8,$9,'[)'), $10,$11,$12,$3,$13,$14) RETURNING id, version`,
    [bookingRef, p.patientId, hold.clinician_id, hold.service_id, svc.version, svc.department_id, hold.location_id,
      hold.start_at, hold.end_at, p.source, svc.price_paise, p.notes ?? null, staffId(actor), svc.modality]);
  const switched = await tx.exec(
    `UPDATE resource_claim SET status = 'booked', appointment_id = $2, expires_at = NULL WHERE hold_id = $1 AND status = 'hold'`,
    [hold.id, appt.id]);
  if (switched !== 2) throw new AppError('HOLD_EXPIRED', 'Your reserved time was released. Please choose a time again.');
  await tx.exec(`UPDATE booking_hold SET status = 'confirmed' WHERE id = $1`, [hold.id]);
  await tx.exec(
    `INSERT INTO appointment_event (tenant_id, appointment_id, action, to_state, data, actor_kind, actor_id)
     VALUES (app_tenant_id(), $1, 'booked', 'booked', $2, $3, $4)`,
    [appt.id, JSON.stringify({ source: p.source, holdId: hold.id }), actor.kind, actorId(actor)]);
  await audit(tx, actor, 'appointment.booked', 'appointment', appt.id, { patientId: p.patientId });
  // Outbound messages are queued only with the committed booking (OP-020).
  await emit(tx, 'appointment.booked', 'appointment', appt.id,
    { bookingRef, start: iso(hold.start_at), end: iso(hold.end_at), clinicianId: hold.clinician_id, serviceId: hold.service_id, patientId: p.patientId, source: p.source }, 1);
  return { appointmentId: appt.id, bookingRef, start: iso(hold.start_at), end: iso(hold.end_at), clinicianId: hold.clinician_id, serviceName: svc.name, pricePaise: Number(svc.price_paise), modality: svc.modality };
}

export async function confirmAppointment(actor: Actor, tenant: Tenant, input: z.input<typeof confirmInput>, requestKey?: string | null) {
  if (actor.kind === 'staff') authorize(actor, 'schedule.book');
  const p = confirmInput.parse(input);
  return withTenant(tenant.id, (tx) => idempotent(tx, actorId(actor), 'appointment.confirm', requestKey, p, () => confirmInTx(tx, actor, tenant, p)));
}

/** Staff booking: hold and confirm in one transaction. */
export async function bookDirect(actor: Actor, tenant: Tenant, input: z.input<typeof holdInput> & { patientId: string; notes?: string; source?: 'staff' | 'phone' }, requestKey?: string | null) {
  authorize(actor, 'schedule.book');
  const h = holdInput.parse(input);
  return withTenant(tenant.id, (tx) => idempotent(tx, actorId(actor), 'appointment.book', requestKey, input, async () => {
    const hold = await createHoldTx(tx, actor, tenant, h);
    return confirmInTx(tx, actor, tenant, { holdId: hold.holdId, patientId: input.patientId, source: input.source ?? 'staff', notes: input.notes });
  }));
}

type Appt = { id: string; state: string; version: number; patient_id: string; clinician_id: string; service_id: string; location_id: string;
  department_id: string; booking_ref: string; start_at: Date; end_at: Date };

async function lockAppt(tx: Tx, id: string, expectedVersion?: number) {
  const a = await tx.maybe<Appt>(`SELECT *, lower(period) AS start_at, upper(period) AS end_at FROM appointment WHERE id = $1 FOR UPDATE`, [id]);
  if (!a) throw notFound('Appointment');
  if (expectedVersion != null && Number(a.version) !== expectedVersion) {
    throw new AppError('VERSION_CONFLICT', 'This appointment changed. Reload it before trying again.');
  }
  return a;
}

async function recordTransition(tx: Tx, actor: Actor, a: Appt, action: string, to: string, reason?: string | null, data: Record<string, unknown> = {}) {
  await tx.exec(`UPDATE appointment SET state = $2, version = version + 1, updated_at = now(),
                   cancel_reason = CASE WHEN $2 IN ('cancelled','no_show','left_before_seen') THEN $3 ELSE cancel_reason END WHERE id = $1`,
    [a.id, to, reason ?? null]);
  await tx.exec(
    `INSERT INTO appointment_event (tenant_id, appointment_id, action, from_state, to_state, reason, data, actor_kind, actor_id)
     VALUES (app_tenant_id(), $1, $2, $3, $4, $5, $6, $7, $8)`,
    [a.id, action, a.state, to, reason ?? null, JSON.stringify(data), actor.kind, actorId(actor)]);
  await audit(tx, actor, `appointment.${action}`, 'appointment', a.id, { patientId: a.patient_id, reason });
}

async function releaseClaims(tx: Tx, appointmentId: string) {
  await tx.exec(`UPDATE resource_claim SET status = 'released', released_at = now() WHERE appointment_id = $1 AND status = 'booked'`, [appointmentId]);
}

export const rescheduleInput = z.object({
  expectedVersion: z.number().int(),
  start: z.iso.datetime({ offset: true }),
  clinicianId: z.uuid().optional(),
  reason: z.string().trim().min(3).max(500),
});

/** OP-023 / OP-024: atomic move; the appointment id is stable; failure keeps the original reservation. */
export async function reschedule(actor: Actor, tenant: Tenant, appointmentId: string, input: z.input<typeof rescheduleInput>, requestKey?: string | null) {
  authorize(actor, 'schedule.book');
  const p = rescheduleInput.parse(input);
  return withTenant(tenant.id, (tx) => idempotent(tx, actorId(actor), `appointment.reschedule:${appointmentId}`, requestKey, p, async () => {
    const a = await lockAppt(tx, appointmentId, p.expectedVersion);
    if (a.state !== 'booked') throw rule('Only a booked appointment that has not arrived can be rescheduled.');
    const clinicianId = p.clinicianId ?? a.clinician_id;
    const moved = await tx.savepoint(async () => {
      await releaseClaims(tx, a.id);
      const hold = await createHoldTx(tx, actor, tenant, { serviceId: a.service_id, clinicianId, start: p.start });
      const n = await tx.exec(`UPDATE resource_claim SET status = 'booked', appointment_id = $2, expires_at = NULL WHERE hold_id = $1`, [hold.holdId, a.id]);
      if (n !== 2) throw new AppError('SLOT_TAKEN', 'That time is no longer available.');
      await tx.exec(`UPDATE booking_hold SET status = 'confirmed' WHERE id = $1`, [hold.holdId]);
      return hold;
    });
    await tx.exec(`UPDATE appointment SET period = tstzrange($2, $3, '[)'), clinician_id = $4, location_id = $5 WHERE id = $1`,
      [a.id, moved.start, moved.end, clinicianId, moved.locationId]);
    await recordTransition(tx, actor, a, 'rescheduled', 'booked', p.reason, {
      before: { start: iso(a.start_at), clinicianId: a.clinician_id }, after: { start: moved.start, clinicianId } });
    await emit(tx, 'appointment.rescheduled', 'appointment', a.id,
      { bookingRef: a.booking_ref, previousStart: iso(a.start_at), start: moved.start, end: moved.end, clinicianId }, Number(a.version) + 1);
    return { appointmentId: a.id, version: Number(a.version) + 1, start: moved.start, end: moved.end };
  }));
}

export async function cancelAppointment(actor: Actor, tenant: Tenant, appointmentId: string, reason: string, opts: { expectedVersion?: number; patientInitiated?: boolean } = {}) {
  if (actor.kind === 'staff') authorize(actor, 'schedule.book');
  if (!reason?.trim()) throw invalid('Give a cancellation reason');
  return withTenant(tenant.id, async (tx) => {
    const a = await lockAppt(tx, appointmentId, opts.expectedVersion);
    if (a.state === 'cancelled') return { state: 'cancelled' };
    if (a.state !== 'booked') throw rule('Only a booked appointment can be cancelled. Use “left before seen” after arrival.');
    await releaseClaims(tx, a.id);
    await recordTransition(tx, actor, a, 'cancelled', 'cancelled', reason, { patientInitiated: !!opts.patientInitiated });
    await emit(tx, 'appointment.cancelled', 'appointment', a.id, { bookingRef: a.booking_ref, start: iso(a.start_at) });
    return { state: 'cancelled' };
  });
}

/** OP-025: no-show only after the configured grace period for an unarrived appointment. */
export async function markNoShow(actor: Actor, tenant: Tenant, appointmentId: string) {
  authorize(actor, 'schedule.book');
  return withTenant(tenant.id, async (tx) => {
    const a = await lockAppt(tx, appointmentId);
    if (a.state !== 'booked') throw rule('Only a booked, unarrived appointment can be marked no-show.');
    if (+a.start_at + tenant.settings.noShowGraceMinutes * 60_000 > Date.now()) {
      throw rule(`No-show can be recorded ${tenant.settings.noShowGraceMinutes} minutes after the start time.`);
    }
    await releaseClaims(tx, a.id);
    await recordTransition(tx, actor, a, 'no_show', 'no_show', 'Did not arrive');
    await emit(tx, 'appointment.no_show', 'appointment', a.id, { bookingRef: a.booking_ref });
  });
}

/** OP-029/030: one arrival and one queue ticket per booking; replay returns the same ticket. */
export async function checkIn(actor: Actor, tenant: Tenant, appointmentId: string, opts: { identityConfirmed: boolean }) {
  authorize(actor, 'queue.manage');
  if (!opts.identityConfirmed) throw rule('Confirm two identifiers (e.g. name and date of birth) before check-in.');
  return withTenant(tenant.id, async (tx) => {
    const a = await lockAppt(tx, appointmentId);
    const existing = await tx.maybe<{ id: string; token_no: number }>(`SELECT id, token_no FROM queue_ticket WHERE appointment_id = $1`, [a.id]);
    if (existing) return { ticketId: existing.id, token: existing.token_no, replay: true };
    if (a.state !== 'booked') throw rule(`Cannot check in an appointment that is ${a.state.replace(/_/g, ' ')}.`);
    const serviceDate = localDate(new Date(), tenant.timezone);
    const ticket = await issueTicket(tx, {
      departmentId: a.department_id, serviceDate, patientId: a.patient_id, appointmentId: a.id, clinicianId: a.clinician_id,
      serviceId: a.service_id, kind: 'booked', dueAt: a.start_at, priority: 0, locationId: a.location_id,
    });
    await recordTransition(tx, actor, a, 'checked_in', 'arrived', null, { token: ticket.token });
    await emit(tx, 'appointment.checked_in', 'appointment', a.id, { bookingRef: a.booking_ref, token: ticket.token });
    return { ticketId: ticket.id, token: ticket.token, replay: false };
  });
}

export async function issueTicket(tx: Tx, t: { departmentId: string; serviceDate: string; patientId: string; appointmentId?: string | null;
  clinicianId?: string | null; serviceId?: string | null; kind: 'booked' | 'walk_in'; dueAt: Date; priority: number; priorityReason?: string | null; locationId?: string | null }) {
  const n = await tx.one<{ v: number }>(`SELECT next_doc_number($1) AS v`, [`queue:${t.departmentId}:${t.serviceDate}`]);
  const row = await tx.one<{ id: string }>(
    `INSERT INTO queue_ticket (tenant_id, department_id, service_date, token_no, patient_id, appointment_id, clinician_id, service_id,
       kind, priority, priority_reason, due_at, location_id)
     VALUES (app_tenant_id(), $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`,
    [t.departmentId, t.serviceDate, n.v, t.patientId, t.appointmentId ?? null, t.clinicianId ?? null, t.serviceId ?? null,
      t.kind, t.priority, t.priorityReason ?? null, t.dueAt, t.locationId ?? null]);
  return { id: row.id, token: n.v };
}

/** OP-029: authorised correction of a mistaken transition, always with a reason. */
export async function correctState(actor: Actor, tenant: Tenant, appointmentId: string, to: 'booked' | 'left_before_seen', reason: string) {
  authorize(actor, 'schedule.override');
  if (!reason?.trim()) throw invalid('A reason is required');
  return withTenant(tenant.id, async (tx) => {
    const a = await lockAppt(tx, appointmentId);
    const allowed: Record<string, string[]> = { booked: ['no_show', 'cancelled'], left_before_seen: ['arrived'] };
    if (!allowed[to]?.includes(a.state)) throw rule(`Cannot change ${a.state} to ${to}.`);
    if (to === 'booked') {
      // Reinstatement must re-claim capacity; it fails if the slot has since been reused.
      const svc = await tx.one<{ buffer_before_min: number; buffer_after_min: number }>(`SELECT buffer_before_min, buffer_after_min FROM service WHERE id = $1`, [a.service_id]);
      const s = new Date(+a.start_at - svc.buffer_before_min * 60_000); const e = new Date(+a.end_at + svc.buffer_after_min * 60_000);
      for (const [kind, id] of [['clinician', a.clinician_id], ['location', a.location_id]] as const) {
        await tx.exec(`INSERT INTO resource_claim (tenant_id, resource_kind, resource_id, period, status, appointment_id)
                       VALUES (app_tenant_id(), $1, $2, tstzrange($3,$4,'[)'), 'booked', $5)`, [kind, id, s, e, a.id]);
      }
    } else {
      await tx.exec(`UPDATE queue_ticket SET status = 'left', updated_at = now() WHERE appointment_id = $1`, [a.id]);
      await releaseClaims(tx, a.id);
    }
    await recordTransition(tx, actor, a, `corrected_to_${to}`, to, reason);
  });
}

// ------------------------------------------------------------------ reads
export async function dayAppointments(actor: Actor, tenant: Tenant, date: string, filter: { clinicianId?: string; departmentId?: string } = {}) {
  authorize(actor, 'schedule.read');
  return withTenant(tenant.id, (tx) => tx.many<{
    id: string; booking_ref: string; state: string; version: number; start_at: Date; end_at: Date; source: string; notes: string | null;
    patient_id: string; uhid: string; full_name: string; phone_e164: string | null; patient_status: string;
    clinician_id: string; clinician_name: string; service_name: string; location_name: string; department_name: string; token_no: number | null; modality: string;
  }>(
    `SELECT a.id, a.booking_ref, a.state, a.version, a.modality, lower(a.period) AS start_at, upper(a.period) AS end_at, a.source, a.notes,
            p.id AS patient_id, p.uhid, p.full_name, p.phone_e164, p.status AS patient_status,
            c.id AS clinician_id, c.display_name AS clinician_name, s.name AS service_name, l.name AS location_name,
            d.name AS department_name, q.token_no
       FROM appointment a
       JOIN patient p ON p.id = a.patient_id JOIN clinician c ON c.id = a.clinician_id
       JOIN service s ON s.id = a.service_id JOIN location l ON l.id = a.location_id JOIN department d ON d.id = a.department_id
       LEFT JOIN queue_ticket q ON q.appointment_id = a.id
      WHERE a.period && tstzrange(($1::date)::timestamp AT TIME ZONE $2, (($1::date) + 1)::timestamp AT TIME ZONE $2)
        AND ($3::uuid IS NULL OR a.clinician_id = $3) AND ($4::uuid IS NULL OR a.department_id = $4)
      ORDER BY lower(a.period), c.display_name`,
    [date, tenant.timezone, filter.clinicianId ?? null, filter.departmentId ?? null]));
}

export async function appointmentDetail(actor: Actor, tenant: Tenant, id: string) {
  authorize(actor, 'schedule.read');
  return withTenant(tenant.id, async (tx) => {
    const a = await tx.maybe<Appt & { quoted_price_paise: number; notes: string | null; source: string; cancel_reason: string | null }>(
      `SELECT *, lower(period) AS start_at, upper(period) AS end_at FROM appointment WHERE id = $1`, [id]);
    if (!a) throw notFound('Appointment');
    const events = await tx.many(`SELECT e.*, s.full_name AS actor_name FROM appointment_event e
                                   LEFT JOIN staff s ON e.actor_kind = 'staff' AND s.id::text = e.actor_id
                                   WHERE appointment_id = $1 ORDER BY at`, [id]);
    return { appointment: a, events };
  });
}

/** Booked appointments overlapping published leave or closures — the OP-026 reassignment worklist. */
export async function impactedAppointments(actor: Actor, tenant: Tenant) {
  authorize(actor, 'schedule.read');
  return withTenant(tenant.id, (tx) => tx.many<{ id: string; booking_ref: string; start_at: Date; full_name: string; phone_e164: string | null; clinician_name: string; reason: string | null }>(
    `SELECT DISTINCT ON (a.id) a.id, a.booking_ref, lower(a.period) AS start_at, p.full_name, p.phone_e164, c.display_name AS clinician_name, e.reason
       FROM appointment a JOIN schedule_exception e
         ON e.kind IN ('leave','closure') AND a.period && e.period AND (e.clinician_id IS NULL OR e.clinician_id = a.clinician_id)
       JOIN patient p ON p.id = a.patient_id JOIN clinician c ON c.id = a.clinician_id
      WHERE a.state = 'booked' AND lower(a.period) > now()
      ORDER BY a.id, lower(a.period)`));
}

/** Background maintenance: release elapsed holds (booking correctness never depends on this running). */
export async function sweepExpiredHolds(tx: Tx) {
  await tx.exec(`UPDATE resource_claim SET status = 'released', released_at = now() WHERE status = 'hold' AND expires_at <= now()`);
  return tx.exec(`UPDATE booking_hold SET status = 'expired' WHERE status = 'active' AND expires_at <= now()`);
}

export function newJourneySecret() {
  return randomToken(24);
}
