import { provisionTenant, getTenantBySlug, invalidateTenantCache, type Tenant } from '../src/domain/tenants';
import { createStaff } from '../src/domain/staff';
import { upsertDepartment, upsertLocation, upsertService, addScheduleTemplate } from '../src/domain/catalog';
import { withPlatform } from '../src/lib/db';
import type { Actor } from '../src/lib/actor';

if (!process.env.DATABASE_URL) process.env.DATABASE_URL = 'postgres://clinic_app:clinic@localhost:5433/clinic_test';

export type Fixture = Awaited<ReturnType<typeof makeClinic>>;

export function tomorrowAt(tz: string, hhmm: string, plusDays = 1): string {
  const d = new Date(Date.now() + plusDays * 86400000).toLocaleDateString('en-CA', { timeZone: tz });
  // Asia/Kolkata has a fixed +05:30 offset, which keeps fixtures deterministic.
  return new Date(`${d}T${hhmm}:00+05:30`).toISOString();
}

export async function makeClinic(opts: { solo?: boolean } = {}) {
  const slug = `t-${Math.random().toString(36).slice(2, 10)}`;
  const t = await provisionTenant({ slug, name: `Test ${slug}`, ownerEmail: `owner@${slug}.test`, ownerName: 'Owner', soloPractice: !!opts.solo });
  if (opts.solo) {
    await withPlatform((tx) => tx.exec(`UPDATE tenant SET settings = settings || '{"soloPractice":true}' WHERE id = $1`, [t.tenantId]));
    invalidateTenantCache(slug);
  }
  const tenant: Tenant = await getTenantBySlug(slug);
  const sys: Actor = { kind: 'system', tenantId: tenant.id };
  const dept = await upsertDepartment(sys, { code: 'GM', name: 'General Medicine' });
  const room = await upsertLocation(sys, { code: 'R1', name: 'Room 1', departmentId: dept });
  const doc = await createStaff(sys, { email: `doc@${slug}.test`, fullName: 'Dr Test', role: 'doctor',
    clinician: { registrationNumber: 'KMC-1', registrationCouncil: 'KMC', departmentIds: [dept] } });
  const rec = await createStaff(sys, { email: `rec@${slug}.test`, fullName: 'Reception', role: 'reception' });
  const cashier = await createStaff(sys, { email: `cash@${slug}.test`, fullName: 'Cashier', role: 'cashier' });
  const ownerStaff = await createStaff(sys, { email: `admin@${slug}.test`, fullName: 'Admin', role: 'admin' });
  const service = await upsertService(sys, { departmentId: dept, code: 'CONS', name: 'Consultation', durationMin: 30, bufferAfterMin: 0,
    pricePaise: 50000, clinicianIds: [doc.clinicianId!] });
  await addScheduleTemplate(sys, { clinicianId: doc.clinicianId!, locationId: room, weekdays: [0, 1, 2, 3, 4, 5, 6], startTime: '08:00', endTime: '20:00', slotStepMin: 10 });
  const staff = (id: string, role: 'doctor' | 'reception' | 'cashier' | 'admin', clinicianId: string | null = null): Actor =>
    ({ kind: 'staff', tenantId: tenant.id, staffId: id, role, clinicianId, name: role });
  return {
    tenant, slug, dept, room, service, publishableKey: t.publishableKey,
    doctor: staff(doc.staffId, 'doctor', doc.clinicianId), clinicianId: doc.clinicianId!,
    reception: staff(rec.staffId, 'reception'), cashier: staff(cashier.staffId, 'cashier'), admin: staff(ownerStaff.staffId, 'admin'), sys,
  };
}
