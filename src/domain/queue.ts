import { z } from 'zod';
import { withTenant } from '@/lib/db';
import { AppError, invalid, notFound, rule } from '@/lib/errors';
import { authorize, actorId, type Actor } from '@/lib/actor';
import { audit } from '@/lib/events';
import { issueTicket } from './scheduling';
import type { Tenant } from './tenants';

const localDate = (tz: string) => new Date().toLocaleDateString('en-CA', { timeZone: tz });

export const walkInInput = z.object({
  patientId: z.uuid(),
  departmentId: z.uuid(),
  clinicianId: z.uuid().nullish(),
  serviceId: z.uuid().nullish(),
  priority: z.number().int().min(0).max(3).default(0),
  priorityReason: z.string().max(300).optional(),
  identityConfirmed: z.literal(true, { message: 'Confirm two identifiers before adding to the queue' }),
});

/** OP-022: a walk-in is a distinct arrival; it stays unconfirmed until a real resource sees the patient. */
export async function addWalkIn(actor: Actor, tenant: Tenant, input: z.input<typeof walkInInput>) {
  authorize(actor, 'queue.manage');
  const p = walkInInput.parse(input);
  if (p.priority > 0) authorize(actor, 'queue.triage');
  if (p.priority > 0 && !p.priorityReason) throw invalid('Give the clinical reason for priority');
  return withTenant(tenant.id, async (tx) => {
    const pt = await tx.maybe<{ status: string }>(`SELECT status FROM patient WHERE id = $1`, [p.patientId]);
    if (!pt || pt.status === 'merged') throw notFound('Patient');
    const open = await tx.maybe(`SELECT token_no FROM queue_ticket WHERE patient_id = $1 AND service_date = $2 AND status IN ('waiting','called','in_room')`,
      [p.patientId, localDate(tenant.timezone)]);
    if (open) throw rule('This patient is already in today’s queue.');
    const t = await issueTicket(tx, {
      departmentId: p.departmentId, serviceDate: localDate(tenant.timezone), patientId: p.patientId, clinicianId: p.clinicianId,
      serviceId: p.serviceId, kind: 'walk_in', dueAt: new Date(), priority: p.priority, priorityReason: p.priorityReason,
    });
    await audit(tx, actor, 'queue.walk_in', 'queue_ticket', t.id, { patientId: p.patientId, reason: p.priorityReason });
    return t;
  });
}

export type QueueRow = {
  id: string; token_no: number; status: string; kind: string; priority: number; priority_reason: string | null;
  due_at: Date; checked_in_at: Date; called_at: Date | null; call_count: number; patient_id: string; uhid: string;
  full_name: string; clinician_id: string | null; clinician_name: string | null; department_id: string; department_name: string;
  location_name: string | null; appointment_id: string | null; encounter_id: string | null; service_name: string | null;
};

/** OP-030: priority class, then due time (booked) / check-in time (walk-in), then check-in time and stable id. */
export async function listQueue(actor: Actor, tenant: Tenant, filter: { departmentId?: string; clinicianId?: string; date?: string; includeDone?: boolean } = {}) {
  authorize(actor, 'schedule.read');
  return withTenant(tenant.id, (tx) => tx.many<QueueRow>(
    `SELECT q.*, p.uhid, p.full_name, c.display_name AS clinician_name, d.name AS department_name, l.name AS location_name,
            e.id AS encounter_id, s.name AS service_name
       FROM queue_ticket q JOIN patient p ON p.id = q.patient_id JOIN department d ON d.id = q.department_id
       LEFT JOIN clinician c ON c.id = q.clinician_id LEFT JOIN location l ON l.id = q.location_id
       LEFT JOIN service s ON s.id = q.service_id
       LEFT JOIN encounter e ON e.queue_ticket_id = q.id
      WHERE q.service_date = $1 AND ($2::uuid IS NULL OR q.department_id = $2)
        AND ($3::uuid IS NULL OR q.clinician_id = $3 OR q.clinician_id IS NULL)
        AND ($4 OR q.status IN ('waiting','called','in_room'))
      ORDER BY (q.status IN ('done','left','cancelled')), q.priority DESC, q.due_at, q.checked_in_at, q.id`,
    [filter.date ?? localDate(tenant.timezone), filter.departmentId ?? null, filter.clinicianId ?? null, !!filter.includeDone]));
}

export async function callTicket(actor: Actor, tenant: Tenant, ticketId: string, locationId?: string | null) {
  authorize(actor, 'queue.manage');
  return withTenant(tenant.id, async (tx) => {
    const t = await tx.maybe<{ status: string; patient_id: string }>(`SELECT status, patient_id FROM queue_ticket WHERE id = $1 FOR UPDATE`, [ticketId]);
    if (!t) throw notFound('Queue ticket');
    if (!['waiting', 'called'].includes(t.status)) throw rule('This patient has already been seen or left.');
    await tx.exec(`UPDATE queue_ticket SET status = 'called', called_at = now(), call_count = call_count + 1,
                    called_by = $2, location_id = COALESCE($3, location_id), updated_at = now() WHERE id = $1`,
      [ticketId, actor.kind === 'staff' ? actor.staffId : null, locationId ?? null]);
    await audit(tx, actor, 'queue.called', 'queue_ticket', ticketId, { patientId: t.patient_id });
  });
}

/** OP-031: a receptionist cannot override a clinical priority decision. */
export async function setPriority(actor: Actor, tenant: Tenant, ticketId: string, priority: number, reason: string) {
  authorize(actor, 'queue.triage');
  if (!reason?.trim()) throw invalid('A clinical reason is required to change priority');
  if (priority < 0 || priority > 3) throw invalid('Priority must be 0–3');
  return withTenant(tenant.id, async (tx) => {
    const t = await tx.one<{ priority: number; patient_id: string }>(`SELECT priority, patient_id FROM queue_ticket WHERE id = $1 FOR UPDATE`, [ticketId]);
    await tx.exec(`UPDATE queue_ticket SET priority = $2, priority_reason = $3, updated_at = now() WHERE id = $1`, [ticketId, priority, reason]);
    await audit(tx, actor, 'queue.priority_changed', 'queue_ticket', ticketId, { patientId: t.patient_id, reason, data: { from: t.priority, to: priority } });
  });
}

export async function markLeft(actor: Actor, tenant: Tenant, ticketId: string, reason: string) {
  authorize(actor, 'queue.manage');
  return withTenant(tenant.id, async (tx) => {
    const t = await tx.one<{ status: string; appointment_id: string | null; patient_id: string }>(
      `SELECT status, appointment_id, patient_id FROM queue_ticket WHERE id = $1 FOR UPDATE`, [ticketId]);
    if (!['waiting', 'called'].includes(t.status)) throw rule('Only a waiting patient can be marked as left.');
    await tx.exec(`UPDATE queue_ticket SET status = 'left', updated_at = now() WHERE id = $1`, [ticketId]);
    if (t.appointment_id) {
      const a = await tx.one<{ state: string }>(`SELECT state FROM appointment WHERE id = $1 FOR UPDATE`, [t.appointment_id]);
      if (a.state === 'arrived') {
        await tx.exec(`UPDATE appointment SET state = 'left_before_seen', cancel_reason = $2, version = version + 1, updated_at = now() WHERE id = $1`, [t.appointment_id, reason]);
        await tx.exec(`UPDATE resource_claim SET status = 'released', released_at = now() WHERE appointment_id = $1 AND status = 'booked'`, [t.appointment_id]);
        await tx.exec(`INSERT INTO appointment_event (tenant_id, appointment_id, action, from_state, to_state, reason, actor_kind, actor_id)
                       VALUES (app_tenant_id(), $1, 'left_before_seen', 'arrived', 'left_before_seen', $2, $3, $4)`,
          [t.appointment_id, reason, actor.kind, actorId(actor)]);
      }
    }
    await audit(tx, actor, 'queue.left', 'queue_ticket', ticketId, { patientId: t.patient_id, reason });
  });
}

/** Waiting-room display: token, destination and call status only — never names or clinical detail. */
export async function publicBoard(tenant: Tenant, departmentId?: string) {
  return withTenant(tenant.id, (tx) => tx.many<{ token_no: number; status: string; department: string; room: string | null; called_at: Date | null }>(
    `SELECT q.token_no, q.status, d.name AS department, l.name AS room, q.called_at
       FROM queue_ticket q JOIN department d ON d.id = q.department_id LEFT JOIN location l ON l.id = q.location_id
      WHERE q.service_date = $1 AND q.status IN ('waiting','called') AND ($2::uuid IS NULL OR q.department_id = $2)
      ORDER BY (q.status = 'called') DESC, q.called_at DESC NULLS LAST, q.priority DESC, q.due_at LIMIT 40`,
    [localDate(tenant.timezone), departmentId ?? null]));
}

export { AppError };
