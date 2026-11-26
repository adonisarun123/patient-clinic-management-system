import { bookDirect, dayAppointments } from '@/domain/scheduling';
import { body, ok, requestKey, route, staffContext } from '@/lib/http';

export const GET = route<{ tenant: string }>(async (req, { tenant: slug }) => {
  const { tenant, actor } = await staffContext(req, slug);
  const q = new URL(req.url).searchParams;
  const date = q.get('date') ?? new Date().toLocaleDateString('en-CA', { timeZone: tenant.timezone });
  return ok({ date, appointments: await dayAppointments(actor, tenant, date, { clinicianId: q.get('clinicianId') ?? undefined, departmentId: q.get('departmentId') ?? undefined }) });
});

/** Body: { serviceId, clinicianId, start (ISO with offset), patientId, notes? } — send Idempotency-Key. */
export const POST = route<{ tenant: string }>(async (req, { tenant: slug }) => {
  const { tenant, actor } = await staffContext(req, slug);
  return ok(await bookDirect(actor, tenant, await body(req), requestKey(req)), 201);
});
