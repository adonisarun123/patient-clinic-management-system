import { z } from 'zod';
import { withTenant } from '@/lib/db';
import { AppError, invalid, notFound, rule } from '@/lib/errors';
import { authorize, actorId, type Actor } from '@/lib/actor';
import { audit } from '@/lib/events';
import { randomToken } from '@/lib/crypto';
import { requireModule, type Tenant } from './tenants';
import { portalCan, type PortalSession } from './portal';

/**
 * CL-035: a video visit records consent, identity verification, who initiated, the mode actually used and the outcome —
 * a meeting link alone is not a consultation record. Video rooms use Jitsi with an unguessable room name.
 * Production note: the public meet.jit.si service may require moderator sign-in and is not under the clinic's
 * control; configure a self-hosted Jitsi or a contracted provider (settings → jitsiBaseUrl) before go-live.
 */
const JOIN_EARLY_MIN = 15;

export async function ensureSession(tenant: Tenant, appointmentId: string) {
  requireModule(tenant, 'telemedicine');
  return withTenant(tenant.id, async (tx) => {
    const a = await tx.maybe<{ modality: string; state: string }>(`SELECT modality, state FROM appointment WHERE id = $1`, [appointmentId]);
    if (!a) throw notFound('Appointment');
    if (a.modality !== 'video') throw rule('This is not a video appointment');
    await tx.exec(`INSERT INTO tele_session (tenant_id, appointment_id, room_name) VALUES (app_tenant_id(), $1, $2) ON CONFLICT (appointment_id) DO NOTHING`,
      [appointmentId, `cc-${tenant.slug}-${randomToken(18).replace(/[^A-Za-z0-9]/g, '')}`]);
    return tx.one<TeleSession>(`SELECT * FROM tele_session WHERE appointment_id = $1`, [appointmentId]);
  });
}

export type TeleSession = { id: string; appointment_id: string; room_name: string; consent_at: Date | null; consent_method: string | null; identity_verified_by: string | null;
  identity_method: string | null; initiated_by: string | null; started_at: Date | null; ended_at: Date | null; actual_mode: string | null; technical_notes: string | null; encounter_id: string | null };

export function roomUrl(tenant: Tenant, s: Pick<TeleSession, 'room_name'>, displayName: string) {
  return `${tenant.settings.jitsiBaseUrl.replace(/\/$/, '')}/${s.room_name}#userInfo.displayName=${encodeURIComponent(JSON.stringify(displayName))}&config.prejoinPageEnabled=true`;
}

/** Patient side: consent is captured in the portal before the join link is shown, and only near the appointment time. */
export async function portalJoin(tenant: Tenant, s: PortalSession, appointmentId: string, consent: boolean) {
  requireModule(tenant, 'telemedicine');
  const a = await withTenant(tenant.id, (tx) => tx.maybe<{ patient_id: string; start_at: Date; end_at: Date; state: string }>(
    `SELECT patient_id, lower(period) AS start_at, upper(period) AS end_at, state FROM appointment WHERE id = $1`, [appointmentId]));
  if (!a) throw notFound();
  const link = portalCan(s, a.patient_id, 'can_schedule');
  if (!['booked', 'arrived', 'in_service'].includes(a.state)) throw rule('This appointment is not active');
  const now = Date.now();
  if (now < +a.start_at - JOIN_EARLY_MIN * 60_000 || now > +a.end_at + 60 * 60_000) throw rule(`You can join from ${JOIN_EARLY_MIN} minutes before the appointment time.`);
  if (!consent) throw invalid('Please agree to the video consultation terms to join');
  const sess = await ensureSession(tenant, appointmentId);
  await withTenant(tenant.id, async (tx) => {
    await tx.exec(`UPDATE tele_session SET consent_at = COALESCE(consent_at, now()), consent_method = COALESCE(consent_method, 'portal'), initiated_by = COALESCE(initiated_by, 'patient') WHERE id = $1`, [sess.id]);
    await tx.exec(`INSERT INTO audit_event (tenant_id, actor_kind, actor_id, action, entity_kind, entity_id, patient_id) VALUES (app_tenant_id(), 'public', $1, 'tele.patient_joined', 'appointment', $2, $3)`,
      [`portal:${s.accountId}`, appointmentId, a.patient_id]);
  });
  return roomUrl(tenant, sess, link.full_name);
}

export const startInput = z.object({
  identityMethod: z.string().trim().min(3, 'Record how you verified the patient on video (e.g. name + DOB stated, ID shown)'),
  consentMethod: z.enum(['portal', 'verbal_recorded', 'written']),
});

/** Clinician starts the consult: records identity check and consent, opens the encounter (kind 'video') and moves the booking to in-service. */
export async function startVideoVisit(actor: Actor, tenant: Tenant, appointmentId: string, input: z.input<typeof startInput>) {
  requireModule(tenant, 'telemedicine');
  authorize(actor, 'telemedicine.conduct');
  if (actor.kind !== 'staff' || !actor.clinicianId) throw new AppError('FORBIDDEN', 'Only a credentialled clinician can conduct a video consultation');
  const p = startInput.parse(input);
  const sess = await ensureSession(tenant, appointmentId);
  return withTenant(tenant.id, async (tx) => {
    const a = await tx.one<{ patient_id: string; state: string; department_id: string; service_id: string; clinician_id: string; version: number }>(
      `SELECT patient_id, state, department_id, service_id, clinician_id, version FROM appointment WHERE id = $1 FOR UPDATE`, [appointmentId]);
    const c = await tx.one<{ registration_number: string | null }>(`SELECT registration_number FROM clinician WHERE id = $1`, [actor.clinicianId]);
    if (!c.registration_number) throw rule('Your clinician profile needs a council registration number before conducting video consultations.');
    let encounterId = sess.encounter_id;
    if (!encounterId) {
      if (!['booked', 'arrived'].includes(a.state)) throw rule(`Appointment is ${a.state}`);
      encounterId = (await tx.one<{ id: string }>(
        `INSERT INTO encounter (tenant_id, patient_id, appointment_id, department_id, lead_clinician_id, service_id, kind, created_by)
         VALUES (app_tenant_id(), $1,$2,$3,$4,$5,'video',$6) RETURNING id`,
        [a.patient_id, appointmentId, a.department_id, actor.clinicianId, a.service_id, actor.staffId])).id;
      await tx.exec(`UPDATE appointment SET state = 'in_service', version = version + 1, updated_at = now() WHERE id = $1`, [appointmentId]);
      await tx.exec(`INSERT INTO appointment_event (tenant_id, appointment_id, action, from_state, to_state, actor_kind, actor_id, data)
                     VALUES (app_tenant_id(), $1, 'video_started', $2, 'in_service', 'staff', $3, '{}')`, [appointmentId, a.state, actorId(actor)]);
    }
    await tx.exec(`UPDATE tele_session SET identity_verified_by = $2, identity_method = $3, consent_at = COALESCE(consent_at, now()), consent_method = COALESCE(consent_method, $4),
                     initiated_by = COALESCE(initiated_by, 'clinician'), started_at = COALESCE(started_at, now()), encounter_id = $5 WHERE id = $1`,
      [sess.id, actor.staffId, p.identityMethod, p.consentMethod, encounterId]);
    await audit(tx, actor, 'tele.started', 'appointment', appointmentId, { patientId: a.patient_id });
    return { encounterId, joinUrl: roomUrl(tenant, sess, actor.name) };
  });
}

export async function endVideoVisit(actor: Actor, tenant: Tenant, appointmentId: string, actualMode: 'video' | 'audio' | 'text' | 'converted_in_person' | 'not_held', notes?: string) {
  requireModule(tenant, 'telemedicine');
  authorize(actor, 'telemedicine.conduct');
  return withTenant(tenant.id, async (tx) => {
    const s = await tx.maybe<{ id: string }>(`SELECT id FROM tele_session WHERE appointment_id = $1`, [appointmentId]);
    if (!s) throw notFound('Video session');
    await tx.exec(`UPDATE tele_session SET ended_at = now(), actual_mode = $2, technical_notes = $3 WHERE id = $1`, [s.id, actualMode, notes ?? null]);
    await audit(tx, actor, 'tele.ended', 'appointment', appointmentId, { data: { actualMode } });
  });
}

export async function sessionFor(tenant: Tenant, appointmentId: string) {
  return withTenant(tenant.id, (tx) => tx.maybe<TeleSession>(`SELECT * FROM tele_session WHERE appointment_id = $1`, [appointmentId]));
}
