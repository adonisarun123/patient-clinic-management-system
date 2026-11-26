import { z } from 'zod';
import { withTenant } from '@/lib/db';
import { invalid } from '@/lib/errors';
import { authorize, type Actor } from '@/lib/actor';
import { audit } from '@/lib/events';
import { createClinicianRow } from './staff';

// ------------------------------------------------------------------ reads
export type Department = { id: string; code: string; name: string; active: boolean };
export type Location = { id: string; code: string; name: string; kind: string; department_id: string | null; active: boolean };
export type Clinician = {
  id: string; staff_id: string | null; display_name: string; qualification: string | null; specialty: string | null;
  registration_council: string | null; registration_number: string | null; bio: string | null;
  public_profile: boolean; active: boolean; department_ids: string[];
};
export type Service = {
  id: string; department_id: string; code: string; name: string; kind: string; duration_min: number;
  buffer_before_min: number; buffer_after_min: number; price_paise: number; tax_rate_bp: number;
  follow_up_free_days: number; public_bookable: boolean; patient_instructions: string | null;
  active: boolean; version: number; clinician_ids: string[];
};

export async function listCatalog(tenantId: string, { publicOnly = false } = {}) {
  return withTenant(tenantId, async (tx) => {
    const departments = await tx.many<Department>(`SELECT id, code, name, active FROM department ORDER BY name`);
    const locations = await tx.many<Location>(`SELECT id, code, name, kind, department_id, active FROM location ORDER BY name`);
    const clinicians = await tx.many<Clinician>(
      `SELECT c.*, COALESCE(array_agg(cd.department_id) FILTER (WHERE cd.department_id IS NOT NULL), '{}') AS department_ids
         FROM clinician c LEFT JOIN clinician_department cd ON cd.clinician_id = c.id
        ${publicOnly ? 'WHERE c.active AND c.public_profile' : ''}
        GROUP BY c.id ORDER BY c.display_name`);
    const services = await tx.many<Service>(
      `SELECT s.*, COALESCE(array_agg(sc.clinician_id) FILTER (WHERE sc.clinician_id IS NOT NULL), '{}') AS clinician_ids
         FROM service s LEFT JOIN service_clinician sc ON sc.service_id = s.id
        ${publicOnly ? 'WHERE s.active AND s.public_bookable' : ''}
        GROUP BY s.id ORDER BY s.name`);
    return { departments, locations, clinicians, services };
  });
}

// ------------------------------------------------------------------ writes
const code = z.string().trim().min(1).max(20).regex(/^[A-Za-z0-9_-]+$/, 'letters, digits, - and _ only');

export async function upsertDepartment(actor: Actor, input: { id?: string; code: string; name: string; active?: boolean }) {
  authorize(actor, 'settings.manage');
  const p = z.object({ id: z.uuid().optional(), code, name: z.string().trim().min(2).max(120), active: z.boolean().default(true) }).parse(input);
  return withTenant(actor.tenantId, async (tx) => {
    const row = p.id
      ? await tx.one<{ id: string }>(`UPDATE department SET code=$2, name=$3, active=$4 WHERE id=$1 RETURNING id`, [p.id, p.code.toUpperCase(), p.name, p.active])
      : await tx.one<{ id: string }>(`INSERT INTO department (tenant_id, code, name) VALUES (app_tenant_id(), $1, $2) RETURNING id`, [p.code.toUpperCase(), p.name]);
    await audit(tx, actor, p.id ? 'department.updated' : 'department.created', 'department', row.id);
    return row.id;
  });
}

export async function upsertLocation(actor: Actor, input: { id?: string; code: string; name: string; kind?: string; departmentId?: string | null; active?: boolean }) {
  authorize(actor, 'settings.manage');
  const p = z.object({
    id: z.uuid().optional(), code, name: z.string().trim().min(1).max(120),
    kind: z.enum(['room', 'counter', 'equipment']).default('room'), departmentId: z.uuid().nullish(), active: z.boolean().default(true),
  }).parse(input);
  return withTenant(actor.tenantId, async (tx) => {
    const row = p.id
      ? await tx.one<{ id: string }>(`UPDATE location SET code=$2, name=$3, kind=$4, department_id=$5, active=$6 WHERE id=$1 RETURNING id`,
        [p.id, p.code.toUpperCase(), p.name, p.kind, p.departmentId ?? null, p.active])
      : await tx.one<{ id: string }>(`INSERT INTO location (tenant_id, code, name, kind, department_id) VALUES (app_tenant_id(), $1, $2, $3, $4) RETURNING id`,
        [p.code.toUpperCase(), p.name, p.kind, p.departmentId ?? null]);
    await audit(tx, actor, p.id ? 'location.updated' : 'location.created', 'location', row.id);
    return row.id;
  });
}

export const clinicianInput = z.object({
  id: z.uuid().optional(),
  displayName: z.string().trim().min(2).max(200),
  qualification: z.string().max(200).optional(),
  specialty: z.string().max(200).optional(),
  registrationCouncil: z.string().max(200).optional(),
  registrationNumber: z.string().max(100).optional(),
  bio: z.string().max(2000).optional(),
  publicProfile: z.boolean().default(true),
  active: z.boolean().default(true),
  departmentIds: z.array(z.uuid()).default([]),
  staffId: z.uuid().nullish(),
});

export async function upsertClinician(actor: Actor, input: z.input<typeof clinicianInput>) {
  authorize(actor, 'settings.manage');
  const p = clinicianInput.parse(input);
  return withTenant(actor.tenantId, async (tx) => {
    let id = p.id;
    if (!id) {
      id = await createClinicianRow(tx, p);
      if (p.bio || !p.publicProfile) await tx.exec(`UPDATE clinician SET bio=$2, public_profile=$3 WHERE id=$1`, [id, p.bio ?? null, p.publicProfile]);
    } else {
      await tx.exec(
        `UPDATE clinician SET display_name=$2, qualification=$3, specialty=$4, registration_council=$5, registration_number=$6,
                bio=$7, public_profile=$8, active=$9 WHERE id=$1`,
        [id, p.displayName, p.qualification ?? null, p.specialty ?? null, p.registrationCouncil ?? null, p.registrationNumber ?? null,
          p.bio ?? null, p.publicProfile, p.active]);
      await tx.exec(`DELETE FROM clinician_department WHERE clinician_id = $1`, [id]);
      for (const d of p.departmentIds) {
        await tx.exec(`INSERT INTO clinician_department (tenant_id, clinician_id, department_id) VALUES (app_tenant_id(), $1, $2)`, [id, d]);
      }
    }
    await audit(tx, actor, p.id ? 'clinician.updated' : 'clinician.created', 'clinician', id);
    return id;
  });
}

export const serviceInput = z.object({
  id: z.uuid().optional(),
  departmentId: z.uuid(),
  code,
  name: z.string().trim().min(2).max(200),
  kind: z.enum(['consultation', 'review', 'procedure', 'investigation', 'other']).default('consultation'),
  durationMin: z.number().int().min(5).max(480),
  bufferBeforeMin: z.number().int().min(0).max(120).default(0),
  bufferAfterMin: z.number().int().min(0).max(120).default(0),
  pricePaise: z.number().int().min(0),
  taxRateBp: z.number().int().min(0).max(10000).default(0),
  followUpFreeDays: z.number().int().min(0).max(365).default(0),
  publicBookable: z.boolean().default(true),
  patientInstructions: z.string().max(2000).optional(),
  active: z.boolean().default(true),
  clinicianIds: z.array(z.uuid()).min(1, 'Choose at least one eligible doctor'),
});

/** CFG-003/008: a change bumps the service version; booked appointments keep the version they were booked on. */
export async function upsertService(actor: Actor, input: z.input<typeof serviceInput>) {
  authorize(actor, 'settings.manage');
  const r = serviceInput.safeParse(input);
  if (!r.success) throw invalid('Invalid service', r.error.issues);
  const p = r.data;
  return withTenant(actor.tenantId, async (tx) => {
    const vals = [p.departmentId, p.code.toUpperCase(), p.name, p.kind, p.durationMin, p.bufferBeforeMin, p.bufferAfterMin,
      p.pricePaise, p.taxRateBp, p.followUpFreeDays, p.publicBookable, p.patientInstructions ?? null, p.active];
    const row = p.id
      ? await tx.one<{ id: string }>(
        `UPDATE service SET department_id=$2, code=$3, name=$4, kind=$5, duration_min=$6, buffer_before_min=$7, buffer_after_min=$8,
                price_paise=$9, tax_rate_bp=$10, follow_up_free_days=$11, public_bookable=$12, patient_instructions=$13, active=$14,
                version = version + 1 WHERE id=$1 RETURNING id`, [p.id, ...vals])
      : await tx.one<{ id: string }>(
        `INSERT INTO service (tenant_id, department_id, code, name, kind, duration_min, buffer_before_min, buffer_after_min,
                price_paise, tax_rate_bp, follow_up_free_days, public_bookable, patient_instructions, active)
         VALUES (app_tenant_id(), $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING id`, vals);
    await tx.exec(`DELETE FROM service_clinician WHERE service_id = $1`, [row.id]);
    for (const c of p.clinicianIds) {
      await tx.exec(`INSERT INTO service_clinician (tenant_id, service_id, clinician_id) VALUES (app_tenant_id(), $1, $2)`, [row.id, c]);
    }
    await audit(tx, actor, p.id ? 'service.updated' : 'service.created', 'service', row.id, { data: { pricePaise: p.pricePaise } });
    return row.id;
  });
}

// ------------------------------------------------------------------ schedules
export const templateInput = z.object({
  clinicianId: z.uuid(),
  locationId: z.uuid(),
  weekdays: z.array(z.number().int().min(0).max(6)).min(1),
  startTime: z.string().regex(/^\d{2}:\d{2}$/),
  endTime: z.string().regex(/^\d{2}:\d{2}$/),
  slotStepMin: z.number().int().min(5).max(120).default(10),
  validFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  validTo: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
});

export async function addScheduleTemplate(actor: Actor, input: z.input<typeof templateInput>) {
  authorize(actor, 'schedule.configure');
  const p = templateInput.parse(input);
  if (p.endTime <= p.startTime) throw invalid('End time must be after start time');
  return withTenant(actor.tenantId, async (tx) => {
    for (const wd of p.weekdays) {
      // Reject overlapping sessions for the same doctor and weekday (CFG-008).
      const clash = await tx.maybe(
        `SELECT 1 FROM schedule_template WHERE clinician_id=$1 AND weekday=$2
            AND start_time < $4::time AND end_time > $3::time
            AND daterange(valid_from, valid_to, '[]') && daterange(COALESCE($5::date, current_date), $6::date, '[]')`,
        [p.clinicianId, wd, p.startTime, p.endTime, p.validFrom ?? null, p.validTo ?? null]);
      if (clash) throw invalid('This session overlaps an existing session for the same doctor and day');
      await tx.exec(
        `INSERT INTO schedule_template (tenant_id, clinician_id, location_id, weekday, start_time, end_time, slot_step_min, valid_from, valid_to)
         VALUES (app_tenant_id(), $1, $2, $3, $4, $5, $6, COALESCE($7::date, current_date), $8)`,
        [p.clinicianId, p.locationId, wd, p.startTime, p.endTime, p.slotStepMin, p.validFrom ?? null, p.validTo ?? null]);
    }
    await audit(tx, actor, 'schedule.template_added', 'clinician', p.clinicianId, { data: { weekdays: p.weekdays, start: p.startTime, end: p.endTime } });
  });
}

export async function removeScheduleTemplate(actor: Actor, id: string) {
  authorize(actor, 'schedule.configure');
  await withTenant(actor.tenantId, async (tx) => {
    // End the session rather than delete it, keeping the predecessor readable (OP-014).
    await tx.exec(`UPDATE schedule_template SET valid_to = GREATEST(valid_from, current_date - 1) WHERE id = $1`, [id]);
    await audit(tx, actor, 'schedule.template_ended', 'schedule_template', id);
  });
}

export async function listSchedules(tenantId: string) {
  return withTenant(tenantId, async (tx) => ({
    templates: await tx.many<{ id: string; clinician_id: string; location_id: string; weekday: number; start_time: string; end_time: string; slot_step_min: number; valid_from: string; valid_to: string | null }>(
      `SELECT * FROM schedule_template WHERE valid_to IS NULL OR valid_to >= current_date ORDER BY clinician_id, weekday, start_time`),
    exceptions: await tx.many<{ id: string; clinician_id: string | null; location_id: string | null; kind: string; starts_at: Date; ends_at: Date; reason: string | null }>(
      `SELECT id, clinician_id, location_id, kind, lower(period) AS starts_at, upper(period) AS ends_at, reason
         FROM schedule_exception WHERE upper(period) > now() ORDER BY lower(period)`),
  }));
}

export const exceptionInput = z.object({
  kind: z.enum(['leave', 'closure', 'extra']),
  clinicianId: z.uuid().nullish(),
  locationId: z.uuid().nullish(),
  startsAt: z.string(), // local "YYYY-MM-DDTHH:MM" in the tenant zone
  endsAt: z.string(),
  slotStepMin: z.number().int().min(5).max(120).default(10),
  reason: z.string().max(500).optional(),
});

/** OP-026: publishing leave blocks new bookings immediately and returns the affected bookings worklist. */
export async function addScheduleException(actor: Actor, timezone: string, input: z.input<typeof exceptionInput>) {
  authorize(actor, 'schedule.configure');
  const p = exceptionInput.parse(input);
  return withTenant(actor.tenantId, async (tx) => {
    const row = await tx.one<{ id: string }>(
      `INSERT INTO schedule_exception (tenant_id, clinician_id, location_id, kind, period, slot_step_min, reason, created_by)
       VALUES (app_tenant_id(), $1, $2, $3,
               tstzrange(($4::timestamp AT TIME ZONE $6), ($5::timestamp AT TIME ZONE $6), '[)'), $7, $8, $9) RETURNING id`,
      [p.clinicianId ?? null, p.locationId ?? null, p.kind, p.startsAt, p.endsAt, timezone, p.slotStepMin, p.reason ?? null,
        actor.kind === 'staff' ? actor.staffId : null]);
    await audit(tx, actor, `schedule.${p.kind}_published`, 'schedule_exception', row.id, { reason: p.reason });
    const affected = p.kind === 'extra' ? [] : await tx.many<{ id: string; booking_ref: string }>(
      `SELECT a.id, a.booking_ref FROM appointment a, schedule_exception e
        WHERE e.id = $1 AND a.state = 'booked' AND a.period && e.period
          AND (e.clinician_id IS NULL OR a.clinician_id = e.clinician_id)`, [row.id]);
    return { id: row.id, affected };
  });
}

export async function removeScheduleException(actor: Actor, id: string) {
  authorize(actor, 'schedule.configure');
  await withTenant(actor.tenantId, async (tx) => {
    await tx.exec(`DELETE FROM schedule_exception WHERE id = $1`, [id]);
    await audit(tx, actor, 'schedule.exception_lifted', 'schedule_exception', id);
  });
}
