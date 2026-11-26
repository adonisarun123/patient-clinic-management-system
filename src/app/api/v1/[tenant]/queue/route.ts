import { listQueue } from '@/domain/queue';
import { ok, route, staffContext } from '@/lib/http';

export const GET = route<{ tenant: string }>(async (req, { tenant: slug }) => {
  const { tenant, actor } = await staffContext(req, slug);
  const q = new URL(req.url).searchParams;
  return ok({ queue: await listQueue(actor, tenant, { departmentId: q.get('departmentId') ?? undefined, clinicianId: q.get('clinicianId') ?? undefined }) });
});
