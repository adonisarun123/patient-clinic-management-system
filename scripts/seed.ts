// Creates a demo clinic with departments, rooms, doctors, services and weekly sessions.
// Usage: npm run db:seed -- [slug]   (default slug: demo-clinic)
import { provisionTenant, getTenantBySlug } from '../src/domain/tenants';
import { createStaff } from '../src/domain/staff';
import { upsertDepartment, upsertLocation, upsertService, addScheduleTemplate } from '../src/domain/catalog';
import { registerPatient } from '../src/domain/patients';
import { withTenant, pool } from '../src/lib/db';
import { setModules, invalidateTenantCache, MODULES } from '../src/domain/tenants';
import { upsertTest } from '../src/domain/labs';
import { upsertProduct, receiveStock } from '../src/domain/pharmacy';
import { upsertBed } from '../src/domain/inpatient';
import type { Actor } from '../src/lib/actor';

async function main() {
  const slug = process.argv[2] ?? 'demo-clinic';
  const t = await provisionTenant({
    slug, name: 'Demo Multispeciality Clinic', ownerEmail: `owner@${slug}.test`, ownerName: 'Clinic Owner',
    uhidPrefix: 'DMC', allowedOrigins: ['http://localhost:3000'],
  });
  const tenant = await getTenantBySlug(slug);
  const sys: Actor = { kind: 'system', tenantId: t.tenantId };
  await withTenant(t.tenantId, (tx) => tx.exec(`UPDATE tenant SET branding = $1 WHERE id = $2`, [JSON.stringify({
    primaryColor: '#0f766e', accentColor: '#f59e0b', address: '12 MG Road, Bengaluru 560001', phone: '+91 80 0000 0000',
    email: 'care@demo-clinic.test', registrationText: 'Clinic registration: DEMO/0001',
  }), t.tenantId]).catch(() => undefined));
  const gm = await upsertDepartment(sys, { code: 'GM', name: 'General Medicine' });
  const ped = await upsertDepartment(sys, { code: 'PED', name: 'Paediatrics' });
  const r1 = await upsertLocation(sys, { code: 'R1', name: 'Consult Room 1', departmentId: gm });
  const r2 = await upsertLocation(sys, { code: 'R2', name: 'Consult Room 2', departmentId: ped });
  const d1 = await createStaff(sys, { email: `dr.rao@${slug}.test`, fullName: 'Dr. Meera Rao', role: 'doctor',
    clinician: { qualification: 'MBBS, MD (Internal Medicine)', specialty: 'General Physician', registrationCouncil: 'Karnataka Medical Council', registrationNumber: 'KMC-12345', departmentIds: [gm] } });
  const d2 = await createStaff(sys, { email: `dr.iyer@${slug}.test`, fullName: 'Dr. Arjun Iyer', role: 'doctor',
    clinician: { qualification: 'MBBS, DCH', specialty: 'Paediatrician', registrationCouncil: 'Karnataka Medical Council', registrationNumber: 'KMC-67890', departmentIds: [ped] } });
  const rec = await createStaff(sys, { email: `front@${slug}.test`, fullName: 'Front Desk', role: 'reception' });
  const cash = await createStaff(sys, { email: `cashier@${slug}.test`, fullName: 'Cashier', role: 'cashier' });
  await upsertService(sys, { departmentId: gm, code: 'GM-NEW', name: 'General consultation (new)', durationMin: 15, pricePaise: 60000, followUpFreeDays: 7, clinicianIds: [d1.clinicianId!] });
  await upsertService(sys, { departmentId: gm, code: 'GM-REV', name: 'Review consultation', kind: 'review', durationMin: 10, pricePaise: 30000, clinicianIds: [d1.clinicianId!] });
  await upsertService(sys, { departmentId: ped, code: 'PED-NEW', name: 'Paediatric consultation', durationMin: 20, bufferAfterMin: 5, pricePaise: 70000, clinicianIds: [d2.clinicianId!] });
  await upsertService(sys, { departmentId: ped, code: 'PED-VAX', name: 'Vaccination visit', kind: 'procedure', durationMin: 10, pricePaise: 20000, publicBookable: false, clinicianIds: [d2.clinicianId!] });
  await addScheduleTemplate(sys, { clinicianId: d1.clinicianId!, locationId: r1, weekdays: [1, 2, 3, 4, 5, 6], startTime: '09:00', endTime: '13:00', slotStepMin: 15 });
  await addScheduleTemplate(sys, { clinicianId: d1.clinicianId!, locationId: r1, weekdays: [1, 3, 5], startTime: '17:00', endTime: '20:00', slotStepMin: 15 });
  await addScheduleTemplate(sys, { clinicianId: d2.clinicianId!, locationId: r2, weekdays: [1, 2, 3, 4, 5, 6], startTime: '10:00', endTime: '14:00', slotStepMin: 10 });
  // Conditional modules: switched on for the demo so every screen can be tried.
  await setModules(tenant, Object.fromEntries(MODULES.map((m) => [m, true])), { autoReleasePrescriptions: true });
  invalidateTenantCache(slug);
  const full = await getTenantBySlug(slug);
  await upsertService(sys, { departmentId: gm, code: 'GM-VID', name: 'Video consultation', durationMin: 15, pricePaise: 50000, modality: 'video', clinicianIds: [d1.clinicianId!] });
  for (const tst of [
    { code: 'CBC', name: 'Complete blood count', specimen: 'EDTA blood', pricePaise: 35000, refText: 'See report' },
    { code: 'K', name: 'Serum potassium', specimen: 'Serum', unit: 'mmol/L', refLow: 3.5, refHigh: 5.1, criticalLow: 2.8, criticalHigh: 6.2, pricePaise: 25000 },
    { code: 'GLU-F', name: 'Fasting blood glucose', specimen: 'Fluoride plasma', unit: 'mg/dL', refLow: 70, refHigh: 99, criticalLow: 40, criticalHigh: 400, pricePaise: 12000 },
    { code: 'XR-CHEST', name: 'X-ray chest PA', kind: 'imaging' as const, pricePaise: 50000 },
  ]) await upsertTest(sys, full, tst);
  const store = await upsertLocation(sys, { code: 'PH', name: 'Main pharmacy', kind: 'store' });
  const ward = await upsertLocation(sys, { code: 'W1', name: 'General ward', kind: 'ward' });
  for (const [code, cat, rate] of [['W1-01', 'general', 150000], ['W1-02', 'general', 150000], ['W1-03', 'general', 150000], ['P-01', 'private', 400000]] as const) {
    await upsertBed(sys, full, { wardId: ward, code, category: cat, dailyRatePaise: rate });
  }
  const pharmacist = await createStaff(sys, { email: `pharmacy@${slug}.test`, fullName: 'Pharmacist', role: 'pharmacist' });
  const nurse = await createStaff(sys, { email: `nurse@${slug}.test`, fullName: 'Staff Nurse', role: 'nurse' });
  const ph: Actor = { kind: 'staff', tenantId: t.tenantId, staffId: pharmacist.staffId, role: 'pharmacist', clinicianId: null, name: 'Pharmacist' };
  const exp = (days: number) => new Date(Date.now() + days * 86400000).toISOString().slice(0, 10);
  for (const [code, name, strength, form, unit, sched, price] of [
    ['PCM650', 'Paracetamol', '650 mg', 'Tablet', 'tablet', 'H', 200], ['AMOX500', 'Amoxicillin', '500 mg', 'Capsule', 'capsule', 'H', 600],
    ['CET10', 'Cetirizine', '10 mg', 'Tablet', 'tablet', 'H', 150], ['ORS', 'Oral rehydration salts', '21 g', 'Sachet', 'sachet', 'OTC', 2000],
  ] as const) {
    const pid = await upsertProduct(ph, full, { code, genericName: name, strength, form, baseUnit: unit, schedule: sched, salePricePaise: price, reorderLevel: 20 });
    await receiveStock(ph, full, { locationId: store, productId: pid, batchNo: `${code}-A1`, expiryDate: exp(60), qty: 30, unitCostPaise: Math.round(price * 0.6), supplier: 'Demo Distributors' });
    await receiveStock(ph, full, { locationId: store, productId: pid, batchNo: `${code}-B2`, expiryDate: exp(500), qty: 200, unitCostPaise: Math.round(price * 0.6), supplier: 'Demo Distributors' });
  }
  const staffActor: Actor = { kind: 'staff', tenantId: t.tenantId, staffId: rec.staffId, role: 'reception', clinicianId: null, name: 'Front Desk' };
  await registerPatient(staffActor, tenant, { fullName: 'Lakshmi Narayan', birthDate: '1978-04-12', sex: 'female', phone: '9876543210' });
  await registerPatient(staffActor, tenant, { fullName: 'Rohan Kumar', estimatedAgeYears: 34, sex: 'male', phone: '9876500001' });

  console.log(`
Demo clinic ready → http://localhost:3000/${slug}
  owner      owner@${slug}.test       ${t.tempPassword}
  doctor     dr.rao@${slug}.test      ${d1.tempPassword}
  doctor     dr.iyer@${slug}.test     ${d2.tempPassword}
  reception  front@${slug}.test       ${rec.tempPassword}
  cashier    cashier@${slug}.test     ${cash.tempPassword}
  pharmacist pharmacy@${slug}.test    ${pharmacist.tempPassword}
  nurse      nurse@${slug}.test       ${nurse.tempPassword}
Patient portal: http://localhost:3000/p/${slug}  (staff link a phone to a chart first; OTP shows on screen in test mode)
Website key (publishable): ${t.publishableKey}
Embed: <script src="http://localhost:3000/embed.js" data-clinic="${slug}" data-key="${t.publishableKey}" async></script>`);
  await pool().end();
}
main().catch((e) => { console.error(e); process.exit(1); });
