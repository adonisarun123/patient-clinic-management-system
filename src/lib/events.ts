import type { Tx } from './db';
import type { Actor } from './actor';
import { actorId } from './actor';

/** DM-008: audit access and changes without copying clinical narrative. */
export async function audit(tx: Tx, actor: Actor, action: string, entityKind: string, entityId: string | null,
  opts: { patientId?: string | null; reason?: string | null; data?: Record<string, unknown> } = {}): Promise<void> {
  await tx.exec(
    `INSERT INTO audit_event (tenant_id, actor_kind, actor_id, actor_role, action, entity_kind, entity_id, patient_id, reason, data, ip)
     VALUES (app_tenant_id(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [actor.kind, actorId(actor), actor.kind === 'staff' ? actor.role : null, action, entityKind, entityId,
      opts.patientId ?? null, opts.reason ?? null, JSON.stringify(opts.data ?? {}), 'ip' in actor ? actor.ip ?? null : null],
  );
}

/** API-004: versioned event envelope written in the same transaction as the change. */
export async function emit(tx: Tx, type: string, aggregateKind: string, aggregateId: string,
  payload: Record<string, unknown>, aggregateVersion?: number): Promise<void> {
  await tx.exec(
    `INSERT INTO outbox_event (tenant_id, type, aggregate_kind, aggregate_id, aggregate_version, payload)
     VALUES (app_tenant_id(), $1, $2, $3, $4, $5)`,
    [type, aggregateKind, aggregateId, aggregateVersion ?? null, JSON.stringify(payload)],
  );
}

export const EVENT_TYPES = [
  'waitlist.slot_available', 'referral.received', 'referral.sent', 'claim.submitted', 'claim.settled', 'preauth.decided',
  'patient.registered', 'appointment.booked', 'appointment.rescheduled', 'appointment.cancelled',
  'appointment.checked_in', 'appointment.no_show', 'appointment.completed', 'prescription.signed',
  'invoice.posted', 'invoice.voided', 'payment.received', 'refund.paid', 'follow_up.created',
  'result.critical', 'result.final', 'document.released', 'records_request.received', 'patient.admitted', 'patient.discharged',
  'dispense.completed', 'lot.recalled', 'emergency_access.granted',
] as const;
