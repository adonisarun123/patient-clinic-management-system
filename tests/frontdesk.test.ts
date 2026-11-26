import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { makeClinic, tomorrowAt } from './helpers';
import { pool, withTenant } from '../src/lib/db';
import { AppError, toAppError } from '../src/lib/errors';
import { registerPatient } from '../src/domain/patients';
import { bookDirect, cancelAppointment } from '../src/domain/scheduling';
import * as fd from '../src/domain/frontdesk';

after(async () => { await pool().end(); });
const code = async (p: Promise<unknown>) => { try { await p; return 'OK'; } catch (e) { const x = toAppError(e); return x instanceof AppError ? x.code : `RAW:${(e as Error).message}`; } };

test('series: books every occurrence at the same local time; a clash books nothing unless skipping; cancel stops only future visits', async () => {
  const c = await makeClinic();
  const p = await registerPatient(c.reception, c.tenant, { fullName: 'Course Patient', birthDate: '1980-05-05', phone: '9811111111' });
  const other = await registerPatient(c.reception, c.tenant, { fullName: 'Other Patient', birthDate: '1981-05-05', phone: '9822222222' });
  const first = tomorrowAt(c.tenant.timezone, '10:00');
  // Someone else holds the third week's slot.
  const third = new Date(+new Date(first) + 14 * 86400_000).toISOString();
  await bookDirect(c.reception, c.tenant, { serviceId: c.service, clinicianId: c.clinicianId, start: third, patientId: other.id });
  const base = { patientId: p.id, serviceId: c.service, clinicianId: c.clinicianId, firstStart: first, freq: 'weekly' as const, everyN: 1, count: 4 };
  assert.equal(await code(fd.bookSeries(c.reception, c.tenant, base)), 'RULE_VIOLATION');
  const none = await withTenant(c.tenant.id, (tx) => tx.one<{ n: number }>(`SELECT count(*)::int AS n FROM appointment WHERE patient_id = $1`, [p.id]));
  assert.equal(none.n, 0, 'all-or-nothing by default');
  const r = await fd.bookSeries(c.reception, c.tenant, { ...base, skipConflicts: true });
  assert.equal(r.booked.length, 3); assert.equal(r.skipped.length, 1);
  // Same local clock time every week.
  const local = r.booked.map((b) => new Date(b.start).toLocaleTimeString('en-GB', { timeZone: c.tenant.timezone, hour: '2-digit', minute: '2-digit' }));
  assert.deepEqual([...new Set(local)], ['10:00']);
  // Receptionist cannot book a series without schedule.book? (reception has it) — a nurse cannot.
  const cancelled = await fd.cancelSeries(c.reception, c.tenant, r.seriesId, 'Patient stopped therapy');
  assert.equal(cancelled.cancelled, 3);
  const states = await withTenant(c.tenant.id, (tx) => tx.many<{ state: string }>(`SELECT state FROM appointment WHERE series_id = $1`, [r.seriesId]));
  assert.ok(states.every((s) => s.state === 'cancelled'));
});

test('waitlist: a cancellation flags matching entries by priority; booking from the match closes the entry', async () => {
  const c = await makeClinic();
  const booked = await registerPatient(c.reception, c.tenant, { fullName: 'Has Slot', birthDate: '1970-01-01', phone: '9833333333' });
  const routine = await registerPatient(c.reception, c.tenant, { fullName: 'Routine Wait', birthDate: '1971-01-01', phone: '9844444444' });
  const urgent = await registerPatient(c.reception, c.tenant, { fullName: 'Urgent Wait', birthDate: '1972-01-01', phone: '9855555555' });
  const evening = await registerPatient(c.reception, c.tenant, { fullName: 'Evening Only', birthDate: '1973-01-01', phone: '9866666666' });
  const start = tomorrowAt(c.tenant.timezone, '09:00');
  const day = new Date(start).toLocaleDateString('en-CA', { timeZone: c.tenant.timezone });
  const appt = await bookDirect(c.reception, c.tenant, { serviceId: c.service, clinicianId: c.clinicianId, start, patientId: booked.id });
  const w = { serviceId: c.service, earliestDate: day, latestDate: day };
  const eRoutine = await fd.addToWaitlist(c.reception, c.tenant, { ...w, patientId: routine.id });
  const eUrgent = await fd.addToWaitlist(c.reception, c.tenant, { ...w, patientId: urgent.id, priority: 2 });
  const eEvening = await fd.addToWaitlist(c.reception, c.tenant, { ...w, patientId: evening.id, timePref: 'evening' });
  assert.equal(await code(fd.addToWaitlist(c.reception, c.tenant, { ...w, patientId: routine.id })), 'RULE_VIOLATION', 'no duplicate waiting entry');
  await cancelAppointment(c.reception, c.tenant, appt.appointmentId, 'Patient unwell');
  const list = await fd.listWaitlist(c.reception, c.tenant);
  const byId = Object.fromEntries(list.map((x) => [x.id, x]));
  assert.ok(byId[eUrgent].match_start && byId[eRoutine].match_start, 'morning slot offered to any-time entries');
  assert.equal(byId[eEvening].match_start, null, 'evening-only entry not offered a 9 am slot');
  assert.equal(list[0].id, eUrgent, 'urgent first');
  const ev = await withTenant(c.tenant.id, (tx) => tx.one<{ n: number }>(`SELECT count(*)::int AS n FROM outbox_event WHERE type = 'waitlist.slot_available'`));
  assert.equal(ev.n, 2);
  const r = await fd.bookFromWaitlist(c.reception, c.tenant, eUrgent, { start: new Date(byId[eUrgent].match_start!).toISOString(), clinicianId: byId[eUrgent].match_clinician! });
  assert.ok(r.bookingRef);
  // The same slot can't go to the routine patient too — the diary refuses it.
  assert.equal(await code(fd.bookFromWaitlist(c.reception, c.tenant, eRoutine, { start: new Date(byId[eRoutine].match_start!).toISOString(), clinicianId: byId[eRoutine].match_clinician! })), 'SLOT_TAKEN');
  assert.equal((await fd.listWaitlist(c.reception, c.tenant, 'booked')).length, 1);
});

test('referrals: outbound letter signed by a registered doctor becomes immutable; inbound links to a visit; referrer stats', async () => {
  const c = await makeClinic();
  const p = await registerPatient(c.reception, c.tenant, { fullName: 'Referred Person', birthDate: '1960-02-02', phone: '9877777777' });
  const gp = await fd.upsertReferrer(c.reception, c.tenant, { name: 'Dr GP Rao', specialty: 'General practice', organisation: 'Rao Clinic' });
  const card = await fd.upsertReferrer(c.reception, c.tenant, { name: 'Dr Heart', specialty: 'Cardiology' });

  assert.equal(await code(fd.draftOutboundReferral(c.reception, c.tenant, { patientId: p.id, referrerId: card, reason: 'Chest pain on exertion' })), 'FORBIDDEN');
  const out = await fd.draftOutboundReferral(c.doctor, c.tenant, { patientId: p.id, referrerId: card, reason: 'Chest pain on exertion', clinicalSummary: 'ECG attached', urgency: 'soon' });
  assert.equal(await code(fd.markReferralSent(c.reception, c.tenant, out, 'emailed')), 'RULE_VIOLATION', 'unsigned letter cannot be sent');
  await fd.signReferral(c.doctor, c.tenant, out);
  assert.equal(await code(fd.updateDraftReferral(c.doctor, c.tenant, out, { patientId: p.id, reason: 'Changed after signing' })), 'RULE_VIOLATION');
  const raw = await code(withTenant(c.tenant.id, (tx) => tx.exec(`UPDATE referral SET reason = 'tamper' WHERE id = $1`, [out])));
  assert.notEqual(raw, 'OK', 'database refuses edits to a signed letter');
  await fd.markReferralSent(c.reception, c.tenant, out, 'emailed');

  const inbound = await fd.recordInboundReferral(c.reception, c.tenant, { patientId: p.id, referrerId: gp, reason: 'Knee pain review' });
  const appt = await bookDirect(c.reception, c.tenant, { serviceId: c.service, clinicianId: c.clinicianId, start: tomorrowAt(c.tenant.timezone, '11:00'), patientId: p.id });
  await fd.linkReferralAppointment(c.reception, c.tenant, inbound, appt.appointmentId);
  assert.equal((await fd.referralDetail(c.reception, c.tenant, inbound)).status, 'booked');
  await fd.closeReferral(c.reception, c.tenant, inbound, 'completed', 'Seen and reply sent');
  assert.equal(await code(fd.closeReferral(c.reception, c.tenant, inbound, 'completed', 'again')), 'RULE_VIOLATION');
  const stats = await fd.listReferrers(c.reception, c.tenant);
  assert.equal(stats.find((r) => r.id === gp)?.inbound_90d, 1);
  assert.equal(stats.find((r) => r.id === card)?.outbound_total, 1);
});
