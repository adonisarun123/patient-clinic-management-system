import { test, after } from 'node:test';
import bcrypt from 'bcryptjs';
import assert from 'node:assert/strict';
import { makeClinic, tomorrowAt } from './helpers';
import { pool, withTenant } from '../src/lib/db';
import { registerPatient, searchPatients, getPatient, recordAllergyReview, linkIntoExisting } from '../src/domain/patients';
import { getAvailability, createHold, confirmAppointment, bookDirect, reschedule, cancelAppointment, checkIn, markNoShow } from '../src/domain/scheduling';
import { addWalkIn, listQueue } from '../src/domain/queue';
import { startEncounter, saveNoteDraft, signNote, saveRxDraft, signPrescription, completeEncounter, amendPrescription } from '../src/domain/clinical';
import { billCharges, recordPayment, requestRefund, decideRefund, payRefund, patientAccount, voidInvoice } from '../src/domain/billing';
import { summary } from '../src/domain/reports';
import { login, sessionFromToken, changePassword, setStaffActive } from '../src/domain/staff';
import { AppError } from '../src/lib/errors';
import type { Actor } from '../src/lib/actor';

after(async () => { await pool().end(); });

const code = async (p: Promise<unknown>) => { try { await p; return 'OK'; } catch (e) { return e instanceof AppError ? e.code : `RAW:${(e as Error).message}`; } };

test('tenant isolation: a clinic cannot read another clinic’s patients, even by id', async () => {
  const a = await makeClinic(); const b = await makeClinic();
  const p = await registerPatient(a.reception, a.tenant, { fullName: 'Asha Devi', birthDate: '1990-01-01', phone: '9876512345' });
  assert.equal(await code(getPatient(b.reception, p.id)), 'NOT_FOUND');
  const rows = await withTenant(b.tenant.id, (tx) => tx.many(`SELECT id FROM patient`));
  assert.equal(rows.length, 0);
  // Writing a row tagged with another tenant is rejected by the RLS WITH CHECK clause.
  assert.match(await code(withTenant(b.tenant.id, (tx) => tx.exec(`INSERT INTO department (tenant_id, code, name) VALUES ($1, 'X', 'X')`, [a.tenant.id]))), /RAW:.*row-level security/);
  // No tenant bound → no rows at all (fail closed).
  const none = await pool().query(`SELECT count(*)::int AS n FROM patient`);
  assert.equal(none.rows[0].n, 0);
});

test('registration: per-clinic UHIDs, idempotent replay, duplicate warning, precision kept', async () => {
  const c = await makeClinic();
  const input = { fullName: 'Ravi Shankar', birthDate: '1985-06', phone: '+91 98765 11111' };
  const r1 = await registerPatient(c.reception, c.tenant, input, 'key-1');
  const r2 = await registerPatient(c.reception, c.tenant, input, 'key-1');
  assert.equal(r1.uhid, r2.uhid);
  assert.match(r1.uhid, /^MRN\d{6}$/);
  assert.equal(await code(registerPatient(c.reception, c.tenant, { ...input, fullName: 'Other' }, 'key-1')), 'IDEMPOTENCY_MISMATCH');
  assert.equal(await code(registerPatient(c.reception, c.tenant, input)), 'CONFLICT');      // high-confidence duplicate
  assert.equal(await code(registerPatient(c.reception, c.tenant, { ...input, overrideDuplicateReason: 'Twin brother, verified ID' })), 'OK');
  const p = await getPatient(c.reception, r1.id);
  assert.equal(p.birth_precision, 'month');
  assert.equal(p.phone_e164, '+919876511111');
  assert.equal(p.allergy_status, 'not_reviewed');
  const hits = await searchPatients(c.reception, '9876511111');
  assert.ok(hits.length >= 2 && hits[0].score >= 70);
  const temp = await registerPatient(c.reception, c.tenant, { fullName: 'Unknown male', temporary: { label: 'Unknown A' } });
  assert.match(temp.uhid, /^TMP-/);
});

test('scheduling: the last slot can be won by exactly one of many concurrent callers', async () => {
  const c = await makeClinic();
  const start = tomorrowAt(c.tenant.timezone, '11:00');
  const attempts = await Promise.allSettled(Array.from({ length: 8 }, (_, i) => {
    const actor: Actor = i % 2 ? c.reception : { kind: 'public', tenantId: c.tenant.id, journey: `journey-${i}-xxxxxxxxxxxx` };
    return createHold(actor, c.tenant, { serviceId: c.service, clinicianId: c.clinicianId, start });
  }));
  const won = attempts.filter((r) => r.status === 'fulfilled');
  assert.equal(won.length, 1, `expected one winner, got ${won.length}`);
  for (const r of attempts) if (r.status === 'rejected') assert.equal((r.reason as AppError).code, 'SLOT_TAKEN');
  const claims = await withTenant(c.tenant.id, (tx) => tx.many(`SELECT * FROM resource_claim WHERE status IN ('hold','booked')`));
  assert.equal(claims.length, 2); // one doctor claim + one room claim
});

test('scheduling: availability hides held/booked time; abutting visits allowed; reschedule is atomic', async () => {
  const c = await makeClinic();
  const date = tomorrowAt(c.tenant.timezone, '08:00').slice(0, 10);
  const before = await getAvailability(c.reception, c.tenant, { serviceId: c.service, from: date, days: 1 });
  const p = await registerPatient(c.reception, c.tenant, { fullName: 'Meena K', birthDate: '1970-03-03' });
  const q = await registerPatient(c.reception, c.tenant, { fullName: 'Suresh P', birthDate: '1960-03-03' });
  const s10 = tomorrowAt(c.tenant.timezone, '10:00'); const s1030 = tomorrowAt(c.tenant.timezone, '10:30');
  const a1 = await bookDirect(c.reception, c.tenant, { serviceId: c.service, clinicianId: c.clinicianId, start: s10, patientId: p.id }, 'b1');
  const a1replay = await bookDirect(c.reception, c.tenant, { serviceId: c.service, clinicianId: c.clinicianId, start: s10, patientId: p.id }, 'b1');
  assert.equal(a1.appointmentId, a1replay.appointmentId);
  const a2 = await bookDirect(c.reception, c.tenant, { serviceId: c.service, clinicianId: c.clinicianId, start: s1030, patientId: q.id });
  const after = await getAvailability(c.reception, c.tenant, { serviceId: c.service, from: date, days: 1 });
  const starts = new Set(after.slots.map((s) => s.start));
  assert.ok(!starts.has(new Date(s10).toISOString()) && !starts.has(tomorrowAt(c.tenant.timezone, '10:20')));
  assert.ok(before.slots.length - after.slots.length >= 6);
  // Overlap with 10:30 booking fails and leaves the original 10:00 booking intact.
  assert.equal(await code(reschedule(c.reception, c.tenant, a1.appointmentId, { expectedVersion: 1, start: tomorrowAt(c.tenant.timezone, '10:20'), reason: 'patient asked' })), 'SLOT_TAKEN');
  const still = await withTenant(c.tenant.id, (tx) => tx.one<{ n: number }>(`SELECT count(*)::int n FROM resource_claim WHERE appointment_id = $1 AND status = 'booked'`, [a1.appointmentId]));
  assert.equal(still.n, 2);
  assert.equal(await code(reschedule(c.reception, c.tenant, a1.appointmentId, { expectedVersion: 7, start: tomorrowAt(c.tenant.timezone, '12:00'), reason: 'x x x' })), 'VERSION_CONFLICT');
  const moved = await reschedule(c.reception, c.tenant, a1.appointmentId, { expectedVersion: 1, start: tomorrowAt(c.tenant.timezone, '12:00'), reason: 'patient asked' });
  assert.equal(moved.appointmentId, a1.appointmentId);
  // The same doctor slot cannot be booked twice.
  assert.equal(await code(bookDirect(c.reception, c.tenant, { serviceId: c.service, clinicianId: c.clinicianId, start: tomorrowAt(c.tenant.timezone, '12:00', 2), patientId: q.id }).then(() =>
    bookDirect(c.reception, c.tenant, { serviceId: c.service, clinicianId: c.clinicianId, start: tomorrowAt(c.tenant.timezone, '12:00', 2), patientId: q.id }))), 'SLOT_TAKEN');
  await cancelAppointment(c.reception, c.tenant, a2.appointmentId, 'Patient unwell');
  const reopened = await getAvailability(c.reception, c.tenant, { serviceId: c.service, from: date, days: 1 });
  assert.ok(reopened.slots.some((s) => s.start === new Date(s1030).toISOString()));
  // No-show is refused before the grace period.
  const fut = await bookDirect(c.reception, c.tenant, { serviceId: c.service, clinicianId: c.clinicianId, start: tomorrowAt(c.tenant.timezone, '15:00'), patientId: p.id });
  assert.equal(await code(markNoShow(c.reception, c.tenant, fut.appointmentId)), 'RULE_VIOLATION');
});

test('public hold must be confirmed by the same journey and expires', async () => {
  const c = await makeClinic();
  const journey: Actor = { kind: 'public', tenantId: c.tenant.id, journey: 'secret-journey-aaaaaaaaaaaa' };
  const other: Actor = { kind: 'public', tenantId: c.tenant.id, journey: 'secret-journey-bbbbbbbbbbbb' };
  const h = await createHold(journey, c.tenant, { serviceId: c.service, clinicianId: c.clinicianId, start: tomorrowAt(c.tenant.timezone, '09:00') });
  const p = await registerPatient(journey, c.tenant, { fullName: 'Web Patient', phone: '9000000001', source: 'widget' });
  assert.equal(p.status, 'provisional');
  assert.equal(await code(confirmAppointment(other, c.tenant, { holdId: h.holdId, patientId: p.id, source: 'widget' })), 'NOT_FOUND');
  await withTenant(c.tenant.id, (tx) => tx.exec(`UPDATE booking_hold SET expires_at = now() - interval '1 second' WHERE id = $1`, [h.holdId]));
  await withTenant(c.tenant.id, (tx) => tx.exec(`UPDATE resource_claim SET expires_at = now() - interval '1 second' WHERE hold_id = $1`, [h.holdId]));
  assert.equal(await code(confirmAppointment(journey, c.tenant, { holdId: h.holdId, patientId: p.id, source: 'widget' })), 'HOLD_EXPIRED');
  // Expired hold no longer blocks anyone.
  await createHold(other, c.tenant, { serviceId: c.service, clinicianId: c.clinicianId, start: tomorrowAt(c.tenant.timezone, '09:00') });
});

test('end-to-end visit: check-in → consult → signed Rx → bill → pay → refund with dual control → balanced ledger', async () => {
  const c = await makeClinic();
  const p = await registerPatient(c.reception, c.tenant, { fullName: 'Kavya Reddy', birthDate: '1992-09-09', phone: '9123456780' });
  const appt = await bookDirect(c.reception, c.tenant, { serviceId: c.service, clinicianId: c.clinicianId, start: tomorrowAt(c.tenant.timezone, '09:30'), patientId: p.id });
  assert.equal(await code(checkIn(c.reception, c.tenant, appt.appointmentId, { identityConfirmed: false })), 'RULE_VIOLATION');
  const t1 = await checkIn(c.reception, c.tenant, appt.appointmentId, { identityConfirmed: true });
  const t2 = await checkIn(c.reception, c.tenant, appt.appointmentId, { identityConfirmed: true });
  assert.equal(t1.ticketId, t2.ticketId); assert.equal(t1.token, 1);
  // Reception cannot start a consultation; the doctor can.
  assert.equal(await code(startEncounter(c.reception, c.tenant, t1.ticketId)), 'FORBIDDEN');
  const { encounterId } = await startEncounter(c.doctor, c.tenant, t1.ticketId, { chiefComplaint: 'Fever 3 days' });
  const note = await saveNoteDraft(c.doctor, c.tenant, encounterId, { subjective: 'Fever', assessment: 'Viral fever', plan: 'Rest, fluids' });
  assert.equal(await code(saveNoteDraft(c.doctor, c.tenant, encounterId, { plan: 'x' }, { noteId: note.noteId, expectedRowVersion: 99 })), 'VERSION_CONFLICT');
  await signNote(c.doctor, c.tenant, note.noteId);
  const rx = await saveRxDraft(c.doctor, c.tenant, encounterId, { lines: [{ drugName: 'Paracetamol', strength: '650 mg', dose: '1 tablet', frequency: 'TDS', duration: '3 days' }], followUpInDays: 5 });
  // Allergy review is required before prescribing.
  assert.equal(await code(signPrescription(c.doctor, c.tenant, rx.prescriptionId, { patientConfirmed: true })), 'RULE_VIOLATION');
  await recordAllergyReview(c.doctor, p.id, { substance: 'Paracetamol', reaction: 'Rash', severity: 'moderate' });
  const blocked = await signPrescription(c.doctor, c.tenant, rx.prescriptionId, { patientConfirmed: true }).catch((e) => e as AppError);
  assert.equal((blocked as AppError).code, 'RULE_VIOLATION'); assert.match((blocked as AppError).message, /allergy match/i);
  const signed = await signPrescription(c.doctor, c.tenant, rx.prescriptionId, { patientConfirmed: true, safetyOverrideReason: 'Tolerated previously; rash was from another drug' });
  assert.match(signed.rxNumber, /^RX\/\d{4}-\d{2}\/\d{6}$/);
  // Signed prescriptions are immutable in the database itself.
  assert.equal(await code(withTenant(c.tenant.id, (tx) => tx.exec(`UPDATE prescription SET advice = 'tampered' WHERE id = $1`, [rx.prescriptionId]))), 'RULE_VIOLATION');
  assert.equal(await code(withTenant(c.tenant.id, (tx) => tx.exec(`UPDATE rx_line SET dose = '2 tablets' WHERE prescription_id = $1`, [rx.prescriptionId]))), 'RULE_VIOLATION');
  const amend = await amendPrescription(c.doctor, c.tenant, rx.prescriptionId, 'Dose change');
  assert.ok(amend.prescriptionId);
  assert.equal(await code(completeEncounter(c.doctor, c.tenant, encounterId)), 'RULE_VIOLATION'); // draft amendment open
  await signPrescription(c.doctor, c.tenant, amend.prescriptionId, { patientConfirmed: true, safetyOverrideReason: 'As above' });
  const done = await completeEncounter(c.doctor, c.tenant, encounterId);
  assert.equal(done.charged, true);
  const acct = await patientAccount(c.cashier, c.tenant, p.id);
  assert.equal(acct.charges.length, 1);
  const inv = await billCharges(c.cashier, c.tenant, p.id, acct.charges.map((x) => x.id), 'inv-1');
  assert.equal(inv.totalPaise, 50000);
  const again = await billCharges(c.cashier, c.tenant, p.id, acct.charges.map((x) => x.id), 'inv-1');
  assert.equal(again.number, inv.number);
  const pay = await recordPayment(c.cashier, c.tenant, { patientId: p.id, method: 'upi', amountPaise: 60000, reference: 'UPI123456' }, 'pay-1');
  assert.equal(pay.unallocatedPaise, 10000);
  assert.equal(await code(recordPayment(c.cashier, c.tenant, { patientId: p.id, method: 'upi', amountPaise: 100, reference: 'UPI123456' })), 'CONFLICT'); // duplicate UPI ref
  const acct2 = await patientAccount(c.cashier, c.tenant, p.id);
  assert.equal(acct2.duePaise, 0); assert.equal(acct2.advancePaise, 10000);
  // Refund: requester cannot approve own refund (not solo); admin can.
  const r = await requestRefund(c.cashier, c.tenant, { paymentId: pay.paymentId, amountPaise: 30000, method: 'upi', reason: 'Overcharged in error' });
  assert.equal(await code(decideRefund(c.cashier, c.tenant, r.refundId, true)), 'FORBIDDEN');
  await decideRefund(c.admin, c.tenant, r.refundId, true);
  await payRefund(c.cashier, c.tenant, r.refundId, 'UPIREF-9');
  const acct3 = await patientAccount(c.cashier, c.tenant, p.id);
  assert.equal(acct3.duePaise, 20000);     // 10,000 advance used + 20,000 released from the invoice
  assert.equal(acct3.advancePaise, 0);
  await voidInvoice(c.admin, c.tenant, inv.invoiceId, 'Billed wrong service');
  const rep = await summary(c.admin, c.tenant, '2000-01-01', '2100-01-01');
  assert.equal(rep.ledgerBalanced, true);
  // Every journal balances (also enforced by the deferred trigger).
  const unbalanced = await withTenant(c.tenant.id, (tx) => tx.many(`SELECT journal_id FROM journal_line GROUP BY journal_id HAVING sum(debit_paise) <> sum(credit_paise)`));
  assert.equal(unbalanced.length, 0);
  // Ledger rows are append-only.
  assert.equal(await code(withTenant(c.tenant.id, (tx) => tx.exec(`DELETE FROM journal_line`))), 'RULE_VIOLATION');
  const fu = await withTenant(c.tenant.id, (tx) => tx.many(`SELECT * FROM follow_up WHERE encounter_id = $1`, [encounterId]));
  assert.equal(fu.length, 1);
});

test('solo practice can self-approve refunds (flagged); walk-in queue ordering by priority', async () => {
  const c = await makeClinic({ solo: true });
  const p = await registerPatient(c.reception, c.tenant, { fullName: 'Solo Patient', birthDate: '2001-01-01' });
  const pay = await recordPayment(c.admin, c.tenant, { patientId: p.id, method: 'cash', amountPaise: 20000 });
  const r = await requestRefund(c.admin, c.tenant, { paymentId: pay.paymentId, amountPaise: 20000, method: 'cash', reason: 'Visit cancelled' });
  await decideRefund(c.admin, c.tenant, r.refundId, true);
  const row = await withTenant(c.tenant.id, (tx) => tx.one<{ self_approved: boolean }>(`SELECT self_approved FROM refund WHERE id = $1`, [r.refundId]));
  assert.equal(row.self_approved, true);
  const q1 = await registerPatient(c.reception, c.tenant, { fullName: 'Walk One', birthDate: '1999-01-01' });
  const q2 = await registerPatient(c.reception, c.tenant, { fullName: 'Walk Two', birthDate: '1998-01-01' });
  await addWalkIn(c.reception, c.tenant, { patientId: q1.id, departmentId: c.dept, identityConfirmed: true });
  assert.equal(await code(addWalkIn(c.reception, c.tenant, { patientId: q2.id, departmentId: c.dept, priority: 2, priorityReason: 'chest pain', identityConfirmed: true })), 'FORBIDDEN');
  await addWalkIn(c.doctor, c.tenant, { patientId: q2.id, departmentId: c.dept, priority: 2, priorityReason: 'Chest pain', identityConfirmed: true });
  const q = await listQueue(c.reception, c.tenant, {});
  assert.deepEqual(q.map((x) => x.full_name), ['Walk Two', 'Walk One']);
});

test('linking a provisional web registration keeps signed history and moves open bookings', async () => {
  const c = await makeClinic();
  const existing = await registerPatient(c.reception, c.tenant, { fullName: 'Anil Kumar', birthDate: '1980-02-02', phone: '9811111111' });
  const web: Actor = { kind: 'public', tenantId: c.tenant.id, journey: 'journey-web-zzzzzzzzzzzz' };
  const prov = await registerPatient(web, c.tenant, { fullName: 'Anil Kumar', phone: '9811111111', source: 'widget' });
  const h = await createHold(web, c.tenant, { serviceId: c.service, clinicianId: c.clinicianId, start: tomorrowAt(c.tenant.timezone, '16:00') });
  const appt = await confirmAppointment(web, c.tenant, { holdId: h.holdId, patientId: prov.id, source: 'widget' });
  const res = await linkIntoExisting(c.admin, c.tenant, prov.id, existing.id, 'Confirmed name + DOB + phone at desk');
  assert.equal(res.moved.appointment, 1);
  const a = await withTenant(c.tenant.id, (tx) => tx.one<{ patient_id: string }>(`SELECT patient_id FROM appointment WHERE id = $1`, [appt.appointmentId]));
  assert.equal(a.patient_id, existing.id);
});

test('staff login: session works, bad password fails, deactivation revokes access', async () => {
  const c = await makeClinic();
  const email = `rec@${c.slug}.test`;
  await withTenant(c.tenant.id, (tx) => tx.exec(`UPDATE staff SET password_hash = $1 WHERE lower(email) = $2`, [bcrypt.hashSync('Correct-horse-1', 4), email]));
  assert.equal(await code(login(c.tenant.id, email, 'wrong')), 'UNAUTHENTICATED');
  const s = await login(c.tenant.id, email, 'Correct-horse-1', '127.0.0.1');
  assert.ok(s.kind === 'session');
  const sess = await sessionFromToken(c.tenant.id, s.token);
  assert.equal(sess?.role, 'reception');
  // A session token from one clinic is useless at another.
  const other = await makeClinic();
  assert.equal(await sessionFromToken(other.tenant.id, s.token), null);
  await changePassword(c.reception, 'Correct-horse-1', 'Another-pass-22');
  await setStaffActive(c.admin, c.reception.kind === 'staff' ? c.reception.staffId : '', false);
  assert.equal(await sessionFromToken(c.tenant.id, s.token), null);
});
