import { createHold, releaseHold } from '@/domain/scheduling';
import { body, ok, preflight, publicContext, route } from '@/lib/http';

/** Reserve a slot for a few minutes while the visitor enters their details. Requires an X-Journey secret. */
export const POST = route<{ tenant: string }>(async (req, { tenant: slug }) => {
  const { tenant, actor, cors } = await publicContext(req, slug);
  const b = await body<{ serviceId: string; clinicianId: string; start: string }>(req);
  const hold = await createHold(actor, tenant, b);
  return ok({ holdId: hold.holdId, expiresAt: hold.expiresAt, start: hold.start, end: hold.end, clinicianId: hold.clinicianId }, 201, cors);
});

export const DELETE = route<{ tenant: string }>(async (req, { tenant: slug }) => {
  const { tenant, actor, cors } = await publicContext(req, slug);
  const holdId = new URL(req.url).searchParams.get('holdId');
  if (holdId) await releaseHold(actor, tenant, holdId);
  return ok({ released: true }, 200, cors);
});
export const OPTIONS = (req: Request, ctx: { params: Promise<{ tenant: string }> }) => ctx.params.then((p) => preflight(req, p.tenant));
