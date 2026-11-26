import { getAvailability } from '@/domain/scheduling';
import { ok, route, staffContext } from '@/lib/http';

export const GET = route<{ tenant: string }>(async (req, { tenant: slug }) => {
  const { tenant, actor } = await staffContext(req, slug);
  const q = new URL(req.url).searchParams;
  return ok(await getAvailability(actor, tenant, {
    serviceId: q.get('serviceId') ?? '', clinicianId: q.get('clinicianId') || null,
    from: q.get('from') ?? new Date().toLocaleDateString('en-CA', { timeZone: tenant.timezone }), days: Number(q.get('days') ?? 7),
  }));
});
