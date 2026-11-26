import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { makeClinic, tomorrowAt } from './helpers';
import { pool, withTenant } from '../src/lib/db';
import { hmacSha256 } from '../src/lib/crypto';
import { AppError, toAppError } from '../src/lib/errors';
import type { Actor } from '../src/lib/actor';
import { getTenantBySlug, setModules, setSecret, invalidateTenantCache, type Tenant } from '../src/domain/tenants';
import { createStaff } from '../src/domain/staff';
import { upsertLocation, upsertService, addScheduleTemplate } from '../src/domain/catalog';
import { registerPatient, recordAllergyReview } from '../src/domain/patients';
import { bookDirect, checkIn } from '../src/domain/scheduling';
import { startEncounter, saveNoteDraft, signNote, saveRxDraft, signPrescription, completeEncounter, getEncounter } from '../src/domain/clinical';
import { billCharges, patientAccount } from '../src/domain/billing';
import * as labs from '../src/domain/labs';
import * as portal from '../src/domain/portal';
import * as pay from '../src/domain/payments';
import * as tele from '../src/domain/telemedicine';
import * as access from '../src/domain/access';
import * as rx from '../src/domain/pharmacy';
import * as ip from '../src/domain/inpatient';
import * as imp from '../src/domain/importer';

after(async () => { await pool().end(); });
const code = async (p: Promise<unknown>) => { try { await p; return 'OK'; } catch (e) { const x = toAppError(e); return x instanceof AppError ? x.code : `RAW:${(e as Error).message}`; } };

async function clinicWith(mods: Partial<Record<string, boolean>>, opts: { solo?: boolean } = {}) {
  const c = await makeClinic(opts);
  await setModules(c.tenant, mods as never);
  invalidateTenantCache(c.slug);
  const tenant: Tenant = await getTenantBySlug(c.slug);
  const mk = async (role: 'nurse' | 'pharmacist' | 'doctor', clin = false) => {
    const s = await createStaff(c.sys, { email: `${role}${Math.random().toString(36).slice(2, 6)}@${c.slug}.test`, fullName: `${role} two`, role,
      clinician: clin ? { registrationNumber: `KMC-${Math.random().toString(36).slice(2, 6)}`, departmentIds: [c.dept] } : undefined });
    return { kind: 'staff', tenantId: tenant.id, staffId: s.staffId, role, clinicianId: s.clinicianId, name: role } as Actor;
  };
  return { ...c, tenant, mk };
}

async function visitWithRx(c: Awaited<ReturnType<typeof clinicWith>>, lines: { drugName: string; quantity?: string }[]) {
  const p = await registerPatient(c.reception, c.tenant, { fullName: `Pt ${Math.random().toString(36).slice(2, 7)}`, birthDate: '1990-01-01' });
  const a = await bookDirect(c.reception, c.tenant, { serviceId: c.service, clinicianId: c.clinicianId, start: tomorrowAt(c.tenant.timezone, '09:00'), patientId: p.id });
  const t = await checkIn(c.reception, c.tenant, a.appointmentId, { identityConfirmed: true });
  const { encounterId } = await startEncounter(c.doctor, c.tenant, t.ticketId);
  await recordAllergyReview(c.doctor, p.id, { noKnownAllergies: true });
  const r = await saveRxDraft(c.doctor, c.tenant, encounterId, { lines: lines.map((l) => ({ drugName: l.drugName, dose: '1', frequency: 'BD', duration: '5 days', quantity: l.quantity })) });
  await signPrescription(c.doctor, c.tenant, r.prescriptionId, { patientConfirmed: true });
  return { patientId: p.id, encounterId, rxId: r.prescriptionId, appointmentId: a.appointmentId };
}

test('modules are off by default and refuse use until enabled', async () => {
  const c = await makeClinic();
  assert.equal(await code(labs.upsertTest(c.admin, c.tenant, { code: 'CBC', name: 'Complete blood count' })), 'FORBIDDEN');
  assert.equal(await code(portal.requestOtp(c.tenant, '9876500000', '1.1.1.1')), 'FORBIDDEN');
});

test('labs: order → collect (charged once) → critical result → amendment needs reason and fresh acknowledgement', async () => {
  const c = await clinicWith({ labs: true });
  const v = await visitWithRx(c, [{ drugName: 'Paracetamol' }]);
  const testId = await labs.upsertTest(c.admin, c.tenant, { code: 'K', name: 'Serum potassium', unit: 'mmol/L', refLow: 3.5, refHigh: 5.1, criticalLow: 2.8, criticalHigh: 6.2, pricePaise: 25000 });
  assert.equal(await code(labs.placeOrders(c.reception, c.tenant, { patientId: v.patientId, testIds: [testId] })), 'FORBIDDEN');
  const [o] = await labs.placeOrders(c.doctor, c.tenant, { patientId: v.patientId, encounterId: v.encounterId, testIds: [testId], priority: 'urgent' });
  assert.equal(await code(labs.recordResult(c.doctor, c.tenant, o.id, { valueNum: 4 })), 'RULE_VIOLATION'); // not collected
  await labs.collect(c.doctor, c.tenant, o.id, { identityConfirmed: true });
  const r1 = await labs.recordResult(c.doctor, c.tenant, o.id, { valueNum: 6.8 });
  assert.equal(r1.flag, 'critical_high'); assert.equal(r1.critical, true);
  const ev = await withTenant(c.tenant.id, (tx) => tx.many(`SELECT 1 FROM outbox_event WHERE type = 'result.critical'`));
  assert.equal(ev.length, 1);
  assert.equal(await code(labs.recordResult(c.doctor, c.tenant, o.id, { valueNum: 4.4 })), 'RULE_VIOLATION'); // amendment without reason
  const r2 = await labs.recordResult(c.doctor, c.tenant, o.id, { valueNum: 4.4, amendReason: 'Haemolysed sample; repeat' });
  assert.equal(r2.status, 'amended'); assert.equal(r2.flag, 'normal');
  assert.equal(await code(labs.acknowledge(c.doctor, c.tenant, r1.resultVersionId, { action: 'acknowledged' })), 'RULE_VIOLATION'); // old version
  await labs.acknowledge(c.doctor, c.tenant, r2.resultVersionId, { action: 'patient_informed', note: 'Called patient' });
  const charges = await withTenant(c.tenant.id, (tx) => tx.many(`SELECT * FROM charge_item WHERE source_key = $1`, [`order:${o.id}`]));
  assert.equal(charges.length, 1);
  assert.equal(await code(withTenant(c.tenant.id, (tx) => tx.exec(`UPDATE result_version SET value_num = 1`))), 'RULE_VIOLATION'); // immutable
});

test('portal: OTP proves the phone only; family members see only linked charts; revocation ends access', async () => {
  const c = await clinicWith({ portal: true });
  const parent = await registerPatient(c.reception, c.tenant, { fullName: 'Parent One', birthDate: '1980-01-01', phone: '9811100000' });
  const child1 = await registerPatient(c.reception, c.tenant, { fullName: 'Child One', birthDate: '2015-01-01', phone: '9811100000', overrideDuplicateReason: 'family phone' });
  await registerPatient(c.reception, c.tenant, { fullName: 'Child Two', birthDate: '2017-01-01', phone: '9811100000', overrideDuplicateReason: 'family phone' });
  const r = await portal.requestOtp(c.tenant, '9811100000', 'ip');
  assert.ok(r.devCode);
  const s0 = await portal.verifyOtp(c.tenant, '9811100000', r.devCode!, 'ip');
  const sess0 = await portal.portalSession(c.tenant, s0.token);
  assert.equal(sess0!.links.length, 0, 'no roster from OTP alone');
  await portal.grantPortalAccess(c.reception, c.tenant, { patientId: parent.id, phone: '9811100000', relation: 'self', evidence: 'Aadhaar shown at desk' });
  const lk = await portal.grantPortalAccess(c.reception, c.tenant, { patientId: child1.id, phone: '9811100000', relation: 'parent', evidence: 'Birth certificate', canPay: false });
  const sess = await portal.portalSession(c.tenant, s0.token);
  assert.deepEqual(sess!.links.map((l) => l.full_name).sort(), ['Child One', 'Parent One']);
  assert.equal(await code(portal.portalPatientView(c.tenant, sess!, child1.id).then((v) => portal.portalCan(sess!, child1.id, 'can_pay'))), 'NOT_FOUND');
  await portal.revokePortalAccess(c.reception, c.tenant, lk, 'Custody dispute');
  assert.equal(await portal.portalSession(c.tenant, s0.token), null, 'revocation ends sessions');
  const r2 = await portal.requestOtp(c.tenant, '9811100000', 'ip');
  for (let i = 0; i < 5; i++) assert.equal(await code(portal.verifyOtp(c.tenant, '9811100000', '000000' === r2.devCode ? '111111' : '000000', 'ip')), 'UNAUTHENTICATED');
  assert.equal(await code(portal.verifyOtp(c.tenant, '9811100000', r2.devCode!, 'ip')), 'UNAUTHENTICATED', 'locked after 5 wrong attempts');
});

test('payments: sandbox checkout settles once; Razorpay webhook verified by HMAC; bad signatures logged not settled', async () => {
  const c = await clinicWith({ portal: true, payments: true });
  const v = await visitWithRx(c, [{ drugName: 'Cetirizine' }]);
  await saveNoteDraft(c.doctor, c.tenant, v.encounterId, { assessment: 'Allergic rhinitis' }).then((n) => signNote(c.doctor, c.tenant, n.noteId));
  await completeEncounter(c.doctor, c.tenant, v.encounterId);
  const acct = await patientAccount(c.cashier, c.tenant, v.patientId);
  const inv = await billCharges(c.cashier, c.tenant, v.patientId, acct.charges.map((x) => x.id));
  const pt = await withTenant(c.tenant.id, (tx) => tx.one<{ phone: string }>(`UPDATE patient SET phone_e164 = '+919822200000' WHERE id = $1 RETURNING phone_e164 AS phone`, [v.patientId]));
  await portal.grantPortalAccess(c.reception, c.tenant, { patientId: v.patientId, phone: pt.phone, relation: 'self', evidence: 'ID at desk' });
  const otp = await portal.requestOtp(c.tenant, pt.phone, 'ip');
  const sess = (await portal.portalSession(c.tenant, (await portal.verifyOtp(c.tenant, pt.phone, otp.devCode!, 'ip')).token))!;
  const co = await pay.createInvoiceCheckout(c.tenant, sess, inv.invoiceId);
  assert.equal(co.provider, 'sandbox'); assert.equal(co.amountPaise, 50000);
  const s1 = await pay.verifyCheckout(c.tenant, sess, co.gatewayOrderId, { razorpay_payment_id: 'sandbox_pay_1' });
  assert.equal(s1.outcome, 'settled');
  const s2 = await pay.verifyCheckout(c.tenant, sess, co.gatewayOrderId, { razorpay_payment_id: 'sandbox_pay_1' });
  assert.equal(s2.outcome, 'already_settled');
  assert.equal((await patientAccount(c.cashier, c.tenant, v.patientId)).duePaise, 0);
  // Razorpay path with configured secrets.
  await withTenant(c.tenant.id, async (tx) => {
    await setSecret(tx, 'razorpay_key_id', 'rzp_test_abc', null); await setSecret(tx, 'razorpay_key_secret', 'key_secret_x', null);
    await setSecret(tx, 'razorpay_webhook_secret', 'whk_secret_y', null);
    await tx.exec(`INSERT INTO gateway_order (tenant_id, provider, provider_order_id, patient_id, amount_paise, currency, created_via) VALUES (app_tenant_id(), 'razorpay', 'order_TEST1', $1, 12345, 'INR', 'staff')`, [v.patientId]);
  });
  const body = JSON.stringify({ event: 'payment.captured', payload: { payment: { entity: { id: 'pay_TEST1', order_id: 'order_TEST1', amount: 12345, status: 'captured' } } } });
  assert.deepEqual(await pay.handleRazorpayWebhook(c.tenant, body, 'deadbeef'), { ok: false, outcome: 'bad_signature' });
  assert.deepEqual(await pay.handleRazorpayWebhook(c.tenant, body, hmacSha256('whk_secret_y', body)), { ok: true, outcome: 'settled' });
  assert.deepEqual(await pay.handleRazorpayWebhook(c.tenant, body, hmacSha256('whk_secret_y', body)), { ok: true, outcome: 'already_settled' });
  assert.equal((await patientAccount(c.cashier, c.tenant, v.patientId)).advancePaise, 12345, 'payment with no invoice becomes an advance');
});

test('telemedicine: identity and consent recorded; encounter is video; join only near the time', async () => {
  const c = await clinicWith({ telemedicine: true, portal: true });
  const vid = await upsertService(c.sys, { departmentId: c.dept, code: 'VID', name: 'Video consult', durationMin: 15, pricePaise: 40000, clinicianIds: [c.clinicianId] });
  await withTenant(c.tenant.id, (tx) => tx.exec(`UPDATE service SET modality = 'video' WHERE id = $1`, [vid]));
  const p = await registerPatient(c.reception, c.tenant, { fullName: 'Video Pt', birthDate: '1985-05-05', phone: '9833300000' });
  const a = await bookDirect(c.reception, c.tenant, { serviceId: vid, clinicianId: c.clinicianId, start: tomorrowAt(c.tenant.timezone, '18:00'), patientId: p.id });
  assert.equal(await code(tele.startVideoVisit(c.doctor, c.tenant, a.appointmentId, { identityMethod: '', consentMethod: 'verbal_recorded' })), 'VALIDATION');
  const s = await tele.startVideoVisit(c.doctor, c.tenant, a.appointmentId, { identityMethod: 'Name and DOB stated; Aadhaar shown', consentMethod: 'verbal_recorded' });
  assert.match(s.joinUrl, /^https:\/\/meet\.jit\.si\/cc-/);
  const e = await getEncounter(c.doctor, c.tenant, s.encounterId);
  assert.equal((e.encounter as unknown as { kind: string }).kind, 'video');
  await portal.grantPortalAccess(c.reception, c.tenant, { patientId: p.id, phone: '9833300000', relation: 'self', evidence: 'ID at desk' });
  const otp = await portal.requestOtp(c.tenant, '9833300000', 'ip');
  const sess = (await portal.portalSession(c.tenant, (await portal.verifyOtp(c.tenant, '9833300000', otp.devCode!, 'ip')).token))!;
  assert.equal(await code(tele.portalJoin(c.tenant, sess, a.appointmentId, true)), 'RULE_VIOLATION'); // tomorrow: too early
});

test('restricted records need a care relationship or a time-limited, reviewed emergency grant', async () => {
  const c = await clinicWith({ emergencyAccess: true });
  const other = await c.mk('doctor', true);
  const p = await registerPatient(c.reception, c.tenant, { fullName: 'VIP Patient', birthDate: '1970-01-01' });
  const a = await bookDirect(c.reception, c.tenant, { serviceId: c.service, clinicianId: c.clinicianId, start: tomorrowAt(c.tenant.timezone, '10:00'), patientId: p.id });
  const t = await checkIn(c.reception, c.tenant, a.appointmentId, { identityConfirmed: true });
  const { encounterId } = await startEncounter(c.doctor, c.tenant, t.ticketId);
  const records: Actor = { ...c.admin, role: 'records' } as Actor;
  await access.setRestricted(records, c.tenant, p.id, true, 'Public figure');
  assert.equal(await code(getEncounter(c.doctor, c.tenant, encounterId)), 'OK', 'treating doctor keeps access');
  assert.equal(await code(getEncounter(other, c.tenant, encounterId)), 'FORBIDDEN');
  assert.equal(await code(access.requestEmergencyAccess(other, c.tenant, { patientId: p.id, reason: 'short' })), 'VALIDATION');
  await access.requestEmergencyAccess(other, c.tenant, { patientId: p.id, reason: 'Collapsed in waiting area, need allergy history' });
  assert.equal(await code(getEncounter(other, c.tenant, encounterId)), 'OK');
  const q = await access.emergencyReviewQueue(records, c.tenant);
  assert.equal(q.length, 1); assert.ok(q[0].views >= 1);
  await access.reviewEmergencyAccess(records, c.tenant, q[0].id, 'appropriate');
  assert.equal(await code(getEncounter(other, c.tenant, encounterId)), 'FORBIDDEN', 'review ends the grant');
});

test('pharmacy: FEFO, prescribed-quantity ceiling, no negative stock under concurrency, returns, recall, blind count with second approver', async () => {
  const c = await clinicWith({ pharmacy: true });
  const pharm = await c.mk('pharmacist');
  const store = await upsertLocation(c.sys, { code: 'PH', name: 'Pharmacy', kind: 'store' });
  const owner: Actor = { ...c.admin, role: 'owner' } as Actor;
  const prod = await rx.upsertProduct(pharm, c.tenant, { code: 'PCM650', genericName: 'Paracetamol', strength: '650 mg', form: 'Tablet', baseUnit: 'tablet', schedule: 'H', salePricePaise: 200 });
  const late = new Date(Date.now() + 400 * 86400000).toISOString().slice(0, 10);
  const soon = new Date(Date.now() + 40 * 86400000).toISOString().slice(0, 10);
  await rx.receiveStock(pharm, c.tenant, { locationId: store, productId: prod, batchNo: 'B-LATE', expiryDate: late, qty: 100 });
  const soonLot = await rx.receiveStock(pharm, c.tenant, { locationId: store, productId: prod, batchNo: 'B-SOON', expiryDate: soon, qty: 6 });
  assert.equal(await code(rx.receiveStock(pharm, c.tenant, { locationId: store, productId: prod, batchNo: 'B-OLD', expiryDate: '2020-01-01', qty: 5 })), 'RULE_VIOLATION');
  const v = await visitWithRx(c, [{ drugName: 'Paracetamol 650', quantity: '10' }]);
  const line = await withTenant(c.tenant.id, (tx) => tx.one<{ id: string }>(`SELECT id FROM rx_line WHERE prescription_id = $1`, [v.rxId]));
  assert.equal(await code(rx.dispense(pharm, c.tenant, { patientId: v.patientId, locationId: store, lines: [{ productId: prod, qty: 5 }] })), 'RULE_VIOLATION', 'schedule H needs prescription');
  const d = await rx.dispense(pharm, c.tenant, { prescriptionId: v.rxId, patientId: v.patientId, locationId: store, lines: [{ rxLineId: line.id, productId: prod, qty: 8 }] });
  assert.deepEqual(d.lines[0].lots, ['B-SOON', 'B-LATE'], 'first expiry first out');
  assert.equal(await code(rx.dispense(pharm, c.tenant, { prescriptionId: v.rxId, patientId: v.patientId, locationId: store, lines: [{ rxLineId: line.id, productId: prod, qty: 3 }] })), 'RULE_VIOLATION', 'beyond prescribed 10');
  // Concurrency: two dispenses racing for the last 98 tablets of a second product.
  const p2 = await rx.upsertProduct(pharm, c.tenant, { code: 'ORS', genericName: 'Oral rehydration salts', form: 'Sachet', baseUnit: 'sachet', schedule: 'OTC', salePricePaise: 2000 });
  await rx.receiveStock(pharm, c.tenant, { locationId: store, productId: p2, batchNo: 'O1', expiryDate: late, qty: 10 });
  const race = await Promise.allSettled([7, 7].map((q) => rx.dispense(pharm, c.tenant, { patientId: v.patientId, locationId: store, lines: [{ productId: p2, qty: q }] })));
  assert.equal(race.filter((r) => r.status === 'fulfilled').length, 1);
  const bal = await withTenant(c.tenant.id, (tx) => tx.one<{ q: number }>(`SELECT sum(qty)::int AS q FROM stock_balance b JOIN lot l ON l.id = b.lot_id WHERE l.product_id = $1`, [p2]));
  assert.equal(bal.q, 3);
  const dl = await withTenant(c.tenant.id, (tx) => tx.one<{ id: string }>(`SELECT id FROM dispense_line WHERE lot_id = (SELECT id FROM lot WHERE batch_no = 'B-LATE') LIMIT 1`));
  const ret = await rx.returnDispensed(pharm, c.tenant, dl.id, 1, { restock: true, reason: 'Patient returned unopened strip' });
  assert.equal(ret.restocked, true);
  const affected = await rx.recallLot(owner, c.tenant, soonLot, 'CDSCO-ALERT-123');
  assert.equal(affected.length, 1);
  const cnt = await rx.openCount(pharm, c.tenant, store);
  const lines = await withTenant(c.tenant.id, (tx) => tx.many<{ lot_id: string; system_qty: number }>(`SELECT lot_id, system_qty FROM stock_count_line WHERE count_id = $1`, [cnt]));
  await rx.enterCount(pharm, c.tenant, cnt, lines.map((l) => ({ lotId: l.lot_id, qty: l.system_qty - (l.system_qty > 0 ? 1 : 0) })));
  const pharmAsApprover: Actor = { ...(pharm as Extract<Actor, { kind: 'staff' }>), role: 'owner' };
  assert.equal(await code(rx.postCount(pharmAsApprover, c.tenant, cnt, 'Monthly count')), 'RULE_VIOLATION', 'counter cannot post own count');
  const res = await rx.postCount(owner, c.tenant, cnt, 'Monthly count');
  assert.ok(res.adjusted >= 1);
  assert.equal(await code(withTenant(c.tenant.id, (tx) => tx.exec(`UPDATE stock_balance SET qty = -1`))), 'VALIDATION', 'negative stock refused by DB');
});

test('inpatient: bed exclusivity, transfer, MAR one-dose-per-occurrence, dose change, discharge gates and bed charges', async () => {
  const c = await clinicWith({ inpatient: true });
  const nurse = await c.mk('nurse');
  const ward = await upsertLocation(c.sys, { code: 'W1', name: 'General Ward', kind: 'ward' });
  const b1 = await ip.upsertBed(c.admin, c.tenant, { wardId: ward, code: 'W1-01', dailyRatePaise: 150000 });
  const b2 = await ip.upsertBed(c.admin, c.tenant, { wardId: ward, code: 'W1-02', dailyRatePaise: 150000 });
  const p = await registerPatient(c.reception, c.tenant, { fullName: 'Inpatient One', birthDate: '1960-01-01' });
  const q = await registerPatient(c.reception, c.tenant, { fullName: 'Inpatient Two', birthDate: '1961-01-01' });
  const adm = await ip.admit(c.doctor, c.tenant, { patientId: p.id, bedId: b1, departmentId: c.dept, admittingClinicianId: c.clinicianId, reason: 'Pneumonia' });
  assert.equal(await code(ip.admit(c.doctor, c.tenant, { patientId: p.id, bedId: b2, departmentId: c.dept, admittingClinicianId: c.clinicianId, reason: 'x x x' })), 'RULE_VIOLATION', 'one active admission');
  assert.equal(await code(ip.admit(c.doctor, c.tenant, { patientId: q.id, bedId: b1, departmentId: c.dept, admittingClinicianId: c.clinicianId, reason: 'Fever' })), 'RULE_VIOLATION', 'bed occupied');
  await ip.transferBed(nurse, c.tenant, adm.admissionId, b2, 'Closer to nursing station');
  const board = await ip.bedBoard(c.reception, c.tenant);
  assert.equal(board.find((b) => b.bed_id === b2)?.admission_id, adm.admissionId);
  const now = new Date(); const hh = (d: Date) => d.toLocaleTimeString('en-GB', { timeZone: c.tenant.timezone, hour: '2-digit', minute: '2-digit' });
  const t1 = hh(new Date(+now + 30 * 60000)); const t2 = hh(new Date(+now + 8 * 3600000));
  const ord = await ip.orderMedication(c.doctor, c.tenant, adm.admissionId, { drugName: 'Amoxicillin', dose: '500 mg', route: 'oral', scheduleTimes: [t1, t2] });
  const det = await ip.admissionDetail(nurse, c.tenant, adm.admissionId);
  const due = det.doses.filter((d) => d.med_order_id === ord && d.status === 'due');
  assert.ok(due.length >= 2);
  await ip.recordDose(nurse, c.tenant, due[0].id, { outcome: 'given', patientConfirmed: true });
  assert.equal(await code(ip.recordDose(nurse, c.tenant, due[0].id, { outcome: 'given', patientConfirmed: true })), 'RULE_VIOLATION', 'no second dose');
  assert.equal(await code(ip.recordDose(nurse, c.tenant, due[1].id, { outcome: 'given', patientConfirmed: true })), 'RULE_VIOLATION', 'early dose needs a reason');
  const ord2 = await ip.orderMedication(c.doctor, c.tenant, adm.admissionId, { drugName: 'Amoxicillin', dose: '1 g', route: 'oral', scheduleTimes: [t2], replacesOrderId: ord, changeReason: 'Dose increase', startAt: new Date(+now + 3 * 3600000).toISOString() });
  const after2 = await ip.admissionDetail(nurse, c.tenant, adm.admissionId);
  assert.equal(after2.doses.find((d) => d.id === due[0].id)?.status, 'given', 'completed dose preserved');
  assert.ok(after2.doses.filter((d) => d.med_order_id === ord && d.status === 'due').length === 0);
  assert.ok(after2.doses.some((d) => d.med_order_id === ord2 && d.status === 'due'));
  assert.equal(await code(ip.discharge(c.doctor, c.tenant, adm.admissionId, { disposition: 'home' })), 'RULE_VIOLATION', 'needs summary');
  await ip.signDischargeSummary(c.doctor, c.tenant, adm.admissionId, { diagnosis: 'Community-acquired pneumonia', courseInHospital: 'IV then oral antibiotics', conditionAtDischarge: 'Stable' });
  const blocked = await ip.discharge(c.doctor, c.tenant, adm.admissionId, { disposition: 'home' }).catch((e) => e as AppError);
  assert.match((blocked as AppError).message, /active medication/);
  await ip.stopMedication(c.doctor, c.tenant, ord2, 'Course complete');
  const owed = await ip.discharge(c.doctor, c.tenant, adm.admissionId, { disposition: 'home' }).catch((e) => e as AppError);
  assert.match((owed as AppError).message, /Outstanding amount/);
  const r = await ip.discharge(c.doctor, c.tenant, adm.admissionId, { disposition: 'home', financialClearance: 'Insurance pre-auth #123, approved by Dr Admin' });
  assert.equal(r.outstandingPaise, 150000);
  const beds = await withTenant(c.tenant.id, (tx) => tx.many(`SELECT 1 FROM charge_item WHERE source_key LIKE $1`, [`bedday:${adm.admissionId}:%`]));
  assert.equal(beds.length, 1);
});

test('import: dry run flags errors and likely duplicates; commit imports; re-run skips already-imported rows', async () => {
  const c = await clinicWith({ import: true });
  await registerPatient(c.reception, c.tenant, { fullName: 'Existing Person', birthDate: '1975-07-07', phone: '9844400000' });
  const csv = 'source_id,full_name,dob,sex,phone,legacy_uhid\n' +
    'L1,Asha Rao,1990-02-03,F,9844411111,OLD-001\n' +
    'L2,"Kumar, Vinod",1966,m,,OLD-002\n' +
    'L3,,2000-01-01,f,,\n' +
    'L4,Existing Person,1975-07-07,f,9844400000,OLD-004\n';
  const r = await imp.dryRun(c.admin, c.tenant, 'patients', 'oldhms', 'pts.csv', csv);
  assert.deepEqual([r.ok, r.errors, r.review], [2, 1, 1]);
  const done = await imp.commitBatch(c.admin, c.tenant, r.batchId);
  assert.equal(done.imported, 2);
  const again = await imp.dryRun(c.admin, c.tenant, 'patients', 'oldhms', 'pts.csv', csv);
  assert.equal(again.skipped, 2);
  const found = await withTenant(c.tenant.id, (tx) => tx.many<{ full_name: string; birth_precision: string }>(`SELECT p.full_name, p.birth_precision FROM patient p JOIN patient_identifier i ON i.patient_id = p.id WHERE i.value = 'OLD-002'`));
  assert.deepEqual(found, [{ full_name: 'Kumar, Vinod', birth_precision: 'year' }]);
});
