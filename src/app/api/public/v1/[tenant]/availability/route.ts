import { getAvailability } from '@/domain/scheduling';
import { ok, preflight, publicContext, route } from '@/lib/http';

export const GET = route<{ tenant: string }>(async (req, { tenant: slug }) => {
  const { tenant, actor, cors } = await publicContext(req, slug);
  const q = new URL(req.url).searchParams;
  const data = await getAvailability(actor, tenant, {
    serviceId: q.get('serviceId') ?? '', clinicianId: q.get('clinicianId') || null,
    from: q.get('from') ?? new Date().toLocaleDateString('en-CA', { timeZone: tenant.timezone }),
    days: Math.min(Number(q.get('days') ?? 7), 14),
  });
  return ok(data, 200, cors);
});
export const OPTIONS = (req: Request, ctx: { params: Promise<{ tenant: string }> }) => ctx.params.then((p) => preflight(req, p.tenant));
