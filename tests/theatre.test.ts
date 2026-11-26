import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { makeClinic, tomorrowAt } from './helpers';
import { pool, withTenant } from '../src/lib/db';
import { AppError, toAppError } from '../src/lib/errors';
import type { Actor } from '../src/lib/actor';
import { setModules, getTenantBySlug, invalidateTenantCache, type Tenant } from '../src/domain/tenants';
import { createStaff } from '../src/domain/staff';
import { upsertLocation } from '../src/domain/catalog';
import { registerPatient } from '../src/domain/patients';
import * as ip from '../src/domain/inpatient';
import * as rx from '../src/domain/pharmacy';
import * as ot from '../src/domain/theatre';

after(async () => { await pool().end(); });
const err = async (p: Promise<unknown>) => { try { await p; return null; } catch (e) { return toAppError(e) as AppError; } };

async function clinic(mods: Record<string, boolean>) {
  const c = await makeClinic();
  await setModules(c.tenant, mods as never);
  invalidateTenantCache(c.slug);
  const tenant: Tenant = await getTenantBySlug(c.slug);
  const mk = async (role: 'nurse' | 'doctor' | 'pharmacist', clin = false) => {
    const s = await createStaff(c.sys, { email: `${role}${Math.random().toString(36).slice(2, 6)}@${c.slug}.test`, fullName: `${role} x`, role,
      clinician: clin ? { registrationNumber: `KMC-${Math.random().toString(36).slice(2, 6)}`, departmentIds: [c.dept] } : undefined });
    return { kind: 'staff', tenantId: tenant.id, staffId: s.staffId, role, clinicianId: s.clinicianId, name: role } as Extract<Actor, { kind: 'staff' }>;
  };
  return { ...c, tenant, mk };
}

test('day care: same-day admission only, overdue on the board, one bed-day charge, conversion needs inpatient module', async () => {
  const c = await clinic({ daycare: true });
  const ward = await upsertLocation(c.sys, { code: 'DC', name: 'Day Care', kind: 'ward' });
  const bed = await ip.upsertBed(c.admin, c.tenant, { wardId: ward, code: 'DC-01', category: 'daycare', dailyRatePaise: 80000 });
  const p = await registerPatient(c.reception, c.tenant, { fullName: 'Day Patient', birthDate: '1970-01-01' });
  const base = { patientId: p.id, bedId: bed, departmentId: c.dept, admittingClinicianId: c.clinicianId, reason: 'Iron infusion' };
  assert.equal((await err(ip.admit(c.reception, c.tenant, { ...base, careType: 'inpatient' })))?.code, 'FORBIDDEN', 'inpatient module is off');
  assert.equal((await err(ip.admit(c.reception, c.tenant, { ...base, careType: 'daycare', plannedEndAt: tomorrowAt(c.tenant.timezone, '12:00') })))?.code, 'VALIDATION', 'overnight is not day care');
  const soon = new Date(Date.now() + 60_000);
  const dayEnd = soon.toLocaleDateString('en-CA', { timeZone: c.tenant.timezone }) === new Date().toLocaleDateString('en-CA', { timeZone: c.tenant.timezone });
  if (!dayEnd) return; // test run straddles local midnight
  const adm = await ip.admit(c.reception, c.tenant, { ...base, careType: 'daycare', plannedEndAt: soon.toISOString() });
  assert.match(adm.admissionNo, /^DC\d{6}$/);
  await withTenant(c.tenant.id, (tx) => tx.exec(`UPDATE admission SET planned_end_at = now() - interval '1 minute' WHERE id = $1`, [adm.admissionId]));
  const board = await ip.dayCareBoard(c.doctor, c.tenant);
  assert.equal(board[0].overdue, true);
  assert.equal((await err(ip.convertToInpatient(c.reception, c.tenant, adm.admissionId, 'Needs overnight observation')))?.code, 'FORBIDDEN');
  await ip.signDischargeSummary(c.doctor, c.tenant, adm.admissionId, { diagnosis: 'Iron deficiency anaemia', courseInHospital: 'IV iron given', conditionAtDischarge: 'Stable' });
  const d = await ip.discharge(c.doctor, c.tenant, adm.admissionId, { disposition: 'home', financialClearance: 'Bill at desk' });
  assert.equal(d.outstandingPaise, 80000, 'one day-care charge');
});

test('theatre: clash prevention incl. turnover, WHO checklist order and stop rules, consumables, op note, charges', async () => {
  const c = await clinic({ theatre: true, pharmacy: true });
  const nurse = await c.mk('nurse');
  const anaes = await c.mk('doctor', true);
  const pharm = await c.mk('pharmacist');
  const surgeon = c.doctor;
  const ot1 = await ot.upsertTheatre(c.admin, c.tenant, { code: 'OT1', name: 'Main theatre', hourlyRatePaise: 600000, turnoverMinutes: 30 });
  const p = await registerPatient(c.reception, c.tenant, { fullName: 'Surgical One', birthDate: '1965-01-01' });
  const q = await registerPatient(c.reception, c.tenant, { fullName: 'Surgical Two', birthDate: '1966-01-01' });
  const nine = tomorrowAt(c.tenant.timezone, '09:00');
  const base = { theatreId: ot1, surgeonId: c.clinicianId, anaesthetistId: anaes.clinicianId!, procedureName: 'Laparoscopic cholecystectomy', laterality: 'na' as const, durationMin: 60 };
  assert.equal((await err(ot.scheduleCase(c.reception, c.tenant, { ...base, patientId: p.id, start: nine, anaesthetistId: null })))?.code, 'VALIDATION', 'GA needs an anaesthetist');
  const k = await ot.scheduleCase(c.reception, c.tenant, { ...base, patientId: p.id, start: nine, serviceId: c.service });
  // 10:15 overlaps the 30-minute turnover after a 09:00–10:00 case.
  const t1015 = tomorrowAt(c.tenant.timezone, '10:15');
  const e1 = await err(ot.scheduleCase(c.reception, c.tenant, { ...base, patientId: q.id, start: t1015, surgeonId: anaes.clinicianId!, anaesthetistId: null, anaesthesia: 'local' }));
  assert.match(e1!.message, /theatre is already booked/);
  const ot2 = await ot.upsertTheatre(c.admin, c.tenant, { code: 'OT2', name: 'Minor theatre', hourlyRatePaise: 0, turnoverMinutes: 15 });
  const e2 = await err(ot.scheduleCase(c.reception, c.tenant, { ...base, theatreId: ot2, patientId: q.id, start: tomorrowAt(c.tenant.timezone, '09:30') }));
  assert.match(e2!.message, /surgeon is already operating/);
  await ot.scheduleCase(c.reception, c.tenant, { ...base, patientId: q.id, start: tomorrowAt(c.tenant.timezone, '10:30') });

  const signIn = { identity_site_procedure_consent: 'yes', site_marked: 'na', anaesthesia_check: 'yes', pulse_oximeter: 'yes', known_allergy: 'no', difficult_airway: 'yes', airway_equipment: 'no', blood_loss_risk: 'no', iv_access_fluids: 'na' };
  assert.equal((await err(ot.recordChecklist(nurse, c.tenant, k.caseId, 'time_out', {})))?.code, 'RULE_VIOLATION');
  assert.match((await err(ot.recordChecklist(nurse, c.tenant, k.caseId, 'sign_in', signIn)))!.message, /equipment and assistance/);
  assert.match((await err(ot.recordChecklist(nurse, c.tenant, k.caseId, 'sign_in', { ...signIn, airway_equipment: 'yes', pulse_oximeter: 'no' })))!.message, /Pulse oximeter/);
  assert.equal((await err(ot.recordChecklist(c.reception, c.tenant, k.caseId, 'sign_in', { ...signIn, airway_equipment: 'yes' })))?.code, 'FORBIDDEN');
  await ot.recordChecklist(nurse, c.tenant, k.caseId, 'sign_in', { ...signIn, airway_equipment: 'yes' });
  assert.match((await err(ot.markTime(nurse, c.tenant, k.caseId, 'incision')))!.message, /Time out before incision/);
  await ot.recordChecklist(nurse, c.tenant, k.caseId, 'time_out', { team_introduced: 'yes', confirmed_patient_site_procedure: 'yes', antibiotic_prophylaxis: 'yes',
    surgeon_critical_steps: 'yes', anaesthesia_concerns: 'yes', sterility_equipment: 'yes', imaging_displayed: 'na' }, { team: 'Dr Test (surgeon), anaesthetist, nurse' });
  assert.equal((await err(ot.recordChecklist(nurse, c.tenant, k.caseId, 'time_out', {})))?.code, 'RULE_VIOLATION');
  await ot.markTime(nurse, c.tenant, k.caseId, 'incision');

  // Consumables from stock, with an implant serial; one returned.
  const store = await upsertLocation(c.sys, { code: 'OTS', name: 'OT store', kind: 'store' });
  const prod = await rx.upsertProduct(pharm, c.tenant, { code: 'CLIP', genericName: 'Ligating clip cartridge', form: 'Device', baseUnit: 'unit', schedule: 'OTC', salePricePaise: 150000 });
  const late = new Date(Date.now() + 400 * 86400000).toISOString().slice(0, 10);
  const lotRes = await rx.receiveStock(pharm, c.tenant, { locationId: store, productId: prod, batchNo: 'CL-1', expiryDate: late, qty: 3 });
  const lotId = (await withTenant(c.tenant.id, (tx) => tx.one<{ id: string }>(`SELECT id FROM lot WHERE batch_no = 'CL-1'`))).id; void lotRes;
  assert.match((await err(ot.recordConsumable(nurse, c.tenant, k.caseId, { lotId, locationId: store, qty: 5 })))!.message, /Not enough stock/);
  await ot.recordConsumable(nurse, c.tenant, k.caseId, { lotId, locationId: store, qty: 2, implantSerial: 'SN-001' });
  const extra = await ot.recordConsumable(nurse, c.tenant, k.caseId, { lotId, locationId: store, qty: 1 });
  await ot.returnConsumable(nurse, c.tenant, extra, 'Opened in error, sealed');
  const bal = await withTenant(c.tenant.id, (tx) => tx.one<{ qty: number }>(`SELECT qty FROM stock_balance WHERE lot_id = $1`, [lotId]));
  assert.equal(bal.qty, 1);

  await ot.saveOpNote(surgeon, c.tenant, k.caseId, { postOpDiagnosis: 'Calculous cholecystitis', procedurePerformed: 'Lap chole', findings: 'Distended GB', technique: 'Four-port', postOpInstructions: 'Oral fluids at 6 h' });
  assert.match((await err(ot.signOpNote(surgeon, c.tenant, k.caseId)))!.message, /incision and closure/);
  assert.match((await err(ot.recordChecklist(nurse, c.tenant, k.caseId, 'sign_out', {})))!.message, /Answer/);
  await ot.markTime(nurse, c.tenant, k.caseId, 'closure');
  const so = { procedure_recorded: 'yes', counts: 'incorrect', specimen_labelled: 'yes', equipment_problems: 'none', recovery_concerns: 'yes' };
  assert.match((await err(ot.recordChecklist(nurse, c.tenant, k.caseId, 'sign_out', so)))!.message, /Counts are incorrect/);
  assert.match((await err(ot.markTime(nurse, c.tenant, k.caseId, 'wheels_out')))!.message, /Sign out/);
  await ot.recordChecklist(nurse, c.tenant, k.caseId, 'sign_out', so, { concerns: 'Swab count short by one; recount found it in bin, verified by scrub nurse' });
  assert.match((await err(ot.signOpNote(anaes, c.tenant, k.caseId)))!.message, /operating surgeon/);
  await ot.signOpNote(surgeon, c.tenant, k.caseId);
  assert.equal((await err(ot.saveOpNote(surgeon, c.tenant, k.caseId, { findings: 'changed' })))?.code, 'RULE_VIOLATION');
  assert.equal((await err(withTenant(c.tenant.id, (tx) => tx.exec(`UPDATE surgery_checklist SET concerns = 'x' WHERE case_id = $1`, [k.caseId]))))?.code, 'RULE_VIOLATION');
  await withTenant(c.tenant.id, (tx) => tx.exec(`UPDATE surgery_case SET wheels_in_at = now() - interval '70 minutes' WHERE id = $1`, [k.caseId]));
  await ot.markTime(nurse, c.tenant, k.caseId, 'wheels_out');
  const done = await ot.completeCase(nurse, c.tenant, k.caseId);
  assert.ok(done.minutes >= 70);
  const charges = await withTenant(c.tenant.id, (tx) => tx.many<{ source_key: string; quantity: number; unit_price_paise: string; status: string }>(
    `SELECT source_key, quantity, unit_price_paise, status FROM charge_item WHERE patient_id = $1 ORDER BY source_key`, [p.id]));
  const by = (pfx: string) => charges.filter((x) => x.source_key.startsWith(pfx));
  assert.equal(by('ottime:')[0].quantity, 3, '70+ min → 3 half-hours'); assert.equal(Number(by('ottime:')[0].unit_price_paise), 300000);
  assert.equal(by('otfee:').length, 1);
  assert.deepEqual(by('otitem:').map((x) => x.status).sort(), ['unbilled', 'voided']);
  const ev = await withTenant(c.tenant.id, (tx) => tx.one<{ n: number }>(`SELECT count(*)::int AS n FROM outbox_event WHERE type = 'surgery.count_discrepancy'`));
  assert.ok(ev.n >= 1);
});
