import { z } from 'zod';
import { withTenant } from '@/lib/db';
import { idempotent } from '@/lib/idempotency';
import { actorId } from '@/lib/actor';
import { AppError, invalid } from '@/lib/errors';
import { registerPatient } from '@/domain/patients';
import { confirmInTx } from '@/domain/scheduling';
import { body, ok, preflight, publicContext, requestKey, route } from '@/lib/http';

const input = z.object({
  holdId: z.uuid(),
  patient: z.object({
    fullName: z.string().trim().min(2).max(200),
    phone: z.string().min(8).max(30),
    email: z.email().optional().or(z.literal('')),
    birthDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().or(z.literal('')),
    sex: z.enum(['female', 'male', 'other', 'unknown', 'declined']).default('unknown'),
  }),
  notes: z.string().max(500).optional(),
  // Explicit, purpose-specific consent to process details for this appointment (DPDP notice shown in the widget).
  consent: z.literal(true, { message: 'Consent is required to book' }),
  source: z.enum(['widget', 'api']).default('widget'),
});

/**
 * Creates a provisional registration (reception confirms identity at arrival — a web form never reveals or
 * attaches to an existing chart) and confirms the held slot, in one transaction.
 */
export const POST = route<{ tenant: string }>(async (req, { tenant: slug }) => {
  const { tenant, actor, cors } = await publicContext(req, slug);
  const parsed = input.safeParse(await body(req));
  if (!parsed.success) throw invalid('Please check your details', parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })));
  const p = parsed.data;
  if (actor.kind === 'public' && actor.journey.startsWith('anon-')) throw new AppError('VALIDATION', 'Missing booking journey');
  const result = await withTenant(tenant.id, (tx) => idempotent(tx, actorId(actor), 'public.booking', requestKey(req), p, async () => {
    const pt = await registerPatient(actor, tenant, {
      fullName: p.patient.fullName, phone: p.patient.phone, email: p.patient.email || undefined,
      birthDate: p.patient.birthDate || undefined, sex: p.patient.sex, source: p.source,
    }, null, { tx });
    await tx.exec(`INSERT INTO audit_event (tenant_id, actor_kind, action, entity_kind, entity_id, patient_id, data)
                   VALUES (app_tenant_id(), 'public', 'consent.booking', 'patient', $1, $1, $2)`,
      [pt.id, JSON.stringify({ purpose: 'appointment', notice: 'widget-v1' })]);
    const appt = await confirmInTx(tx, actor, tenant, { holdId: p.holdId, patientId: pt.id, source: p.source, notes: p.notes });
    return { bookingRef: appt.bookingRef, start: appt.start, end: appt.end, clinicianId: appt.clinicianId, service: appt.serviceName,
      pricePaise: appt.pricePaise, currency: tenant.currency };
  }));
  return ok(result, 201, cors);
});
export const OPTIONS = (req: Request, ctx: { params: Promise<{ tenant: string }> }) => ctx.params.then((p) => preflight(req, p.tenant));
