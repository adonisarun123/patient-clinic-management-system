import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { makeClinic, tomorrowAt } from './helpers';
import { pool, withTenant } from '../src/lib/db';
import { AppError, toAppError } from '../src/lib/errors';
import { registerPatient, recordAllergyReview } from '../src/domain/patients';
import { bookDirect, checkIn } from '../src/domain/scheduling';
import { startEncounter, saveRxDraft, signPrescription, recordVitals } from '../src/domain/clinical';
import * as safety from '../src/domain/safety';

after(async () => { await pool().end(); });
const err = async (p: Promise<unknown>) => { try { await p; return null; } catch (e) { return toAppError(e) as AppError; } };

test('dose and frequency parsing', () => {
  assert.equal(safety.timesPerDay('TDS'), 3); assert.equal(safety.timesPerDay('1-0-1'), 2); assert.equal(safety.timesPerDay('1-1-1-1'), 4);
  assert.equal(safety.timesPerDay('every 6 hours'), 4); assert.equal(safety.timesPerDay('q8h'), 3); assert.equal(safety.timesPerDay('as directed'), null);
  assert.equal(safety.doseAmount('500 mg', null, 'mg'), 500); assert.equal(safety.doseAmount('0.5 g', null, 'mg'), 500);
  assert.equal(safety.doseAmount('2 tabs', '250 mg', 'mg'), 500); assert.equal(safety.doseAmount('½ tab', '500 mg', 'mg'), 250);
  assert.equal(safety.doseAmount('5 ml', null, 'mg'), null); assert.equal(safety.doseAmount('one spoon', '250 mg', 'mg'), null);
});

// Fictional drugs and limits — test fixtures only, not clinical reference data.
async function visit(c: Awaited<ReturnType<typeof makeClinic>>, birthDate: string, hhmm: string) {
  const p = await registerPatient(c.reception, c.tenant, { fullName: `Safety ${hhmm}`, birthDate, phone: `98${hhmm.replace(':', '')}12345`.slice(0, 10) });
  const a = await bookDirect(c.reception, c.tenant, { serviceId: c.service, clinicianId: c.clinicianId, start: tomorrowAt(c.tenant.timezone, hhmm), patientId: p.id });
  const t = await checkIn(c.reception, c.tenant, a.appointmentId, { identityConfirmed: true });
  const { encounterId } = await startEncounter(c.doctor, c.tenant, t.ticketId);
  return { p, encounterId };
}

test('formulary limits, weight-based dosing for children, class allergy, interaction rules, override recorded', async () => {
  const c = await makeClinic();
  const ownerish = c.admin;
  await safety.upsertFormularyItem(ownerish, c.tenant, { genericName: 'Testamol', brandNames: ['Testa'], classes: ['analgesic-x'], strength: '250 mg', doseUnit: 'mg',
    perKgMin: 10, perKgMax: 15, maxSingleDose: 1000, maxDailyDose: 3000, weightRequiredUnderYears: 12, source: 'Test fixture' });
  await safety.upsertFormularyItem(ownerish, c.tenant, { genericName: 'Pencilloxin', classes: ['penicillin-x'], strength: '500 mg', doseUnit: 'mg', source: 'Test fixture' });
  await safety.upsertFormularyItem(ownerish, c.tenant, { genericName: 'Warfaroid', classes: ['anticoagulant-x'], doseUnit: 'mg', source: 'Test fixture' });
  assert.equal((await err(safety.upsertFormularyItem(c.reception, c.tenant, { genericName: 'X', source: 'abc' })))?.code, 'FORBIDDEN');
  const imp = await safety.importInteractionCsv(ownerish, c.tenant, 'a,b,severity,effect,management,source\nclass:analgesic-x,Warfaroid,major,"Bleeding risk (fixture)",Avoid,Test fixture\n');
  assert.equal(imp.imported, 1);
  assert.equal((await err(safety.importInteractionCsv(ownerish, c.tenant, 'a,b,severity,effect,source\nx,y,severe,bad,src\n')))?.code, 'RULE_VIOLATION', 'invalid severity rejects the file');

  // Child, 8 years: weight required; 20 kg → max 300 mg per dose.
  const kid = await visit(c, `${new Date().getFullYear() - 8}-01-01`, '09:00');
  await recordAllergyReview(c.doctor, kid.p.id, { noKnownAllergies: true });
  const rx1 = await saveRxDraft(c.doctor, c.tenant, kid.encounterId, { lines: [{ drugName: 'Testamol', strength: '250 mg', dose: '2 tabs', frequency: 'TDS', duration: '3 days' }] });
  let e = await err(signPrescription(c.doctor, c.tenant, rx1.prescriptionId, { patientConfirmed: true }));
  assert.match(e!.message, /record a current weight/);
  await recordVitals(c.doctor, c.tenant, kid.encounterId, { weightKg: 20 });
  e = await err(signPrescription(c.doctor, c.tenant, rx1.prescriptionId, { patientConfirmed: true }));
  assert.match(e!.message, /25 mg\/kg .* above the 15 mg\/kg maximum/);
  const findings = await safety.checkDraft(c.doctor, c.tenant, rx1.prescriptionId);
  assert.ok(findings.some((f) => f.kind === 'per_kg_high' && f.source === 'Test fixture'));
  const rx1b = await saveRxDraft(c.doctor, c.tenant, kid.encounterId, { lines: [{ drugName: 'Testamol', strength: '250 mg', dose: '250 mg', frequency: 'TDS', duration: '3 days' }] }, rx1.prescriptionId);
  await signPrescription(c.doctor, c.tenant, rx1b.prescriptionId, { patientConfirmed: true });

  // Adult: daily maximum, class allergy, interaction with a recently prescribed drug.
  const adult = await visit(c, '1980-01-01', '10:00');
  await recordAllergyReview(c.doctor, adult.p.id, { substance: 'penicillin-x', reaction: 'Hives', severity: 'severe' });
  const rx2 = await saveRxDraft(c.doctor, c.tenant, adult.encounterId, { lines: [
    { drugName: 'Testa', strength: '250 mg', dose: '1000 mg', frequency: '1-1-1-1', duration: '2 days' },
    { drugName: 'Pencilloxin', strength: '500 mg', dose: '500 mg', frequency: 'BD', duration: '5 days' },
    { drugName: 'Warfaroid', dose: '5 mg', frequency: 'OD', duration: '30 days' },
    { drugName: 'Unlisted Syrup', dose: '5 ml', frequency: 'TDS', duration: '3 days' },
  ] });
  const f2 = await safety.checkDraft(c.doctor, c.tenant, rx2.prescriptionId);
  const kinds = f2.map((f) => f.kind);
  assert.ok(kinds.includes('max_daily'), 'brand name maps to the formulary item; 4000 mg/day > 3000');
  assert.ok(kinds.includes('allergy'), 'class allergy');
  assert.ok(kinds.includes('interaction_major'), 'class-based interaction');
  assert.ok(kinds.includes('off_formulary'));
  assert.equal(f2.find((f) => f.kind === 'off_formulary')?.severity, 'warn', 'default policy only warns');
  e = await err(signPrescription(c.doctor, c.tenant, rx2.prescriptionId, { patientConfirmed: true }));
  assert.equal(e?.code, 'RULE_VIOLATION');
  await signPrescription(c.doctor, c.tenant, rx2.prescriptionId, { patientConfirmed: true, safetyOverrideReason: 'Specialist advice documented' });
  const stored = await withTenant(c.tenant.id, (tx) => tx.one<{ safety_findings: { kind: string }[]; snapshot: { safetyFindings: unknown[] } }>(`SELECT safety_findings, snapshot FROM prescription WHERE id = $1`, [rx2.prescriptionId]));
  assert.ok(stored.safety_findings.some((f) => f.kind === 'interaction_major'));
  assert.ok(stored.snapshot.safetyFindings.length >= 3, 'findings frozen into the signed record');
});
