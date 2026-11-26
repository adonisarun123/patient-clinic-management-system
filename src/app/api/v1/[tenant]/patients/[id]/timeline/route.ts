import { patientTimeline } from '@/domain/clinical';
import { ok, route, staffContext } from '@/lib/http';

export const GET = route<{ tenant: string; id: string }>(async (req, { tenant: slug, id }) => {
  const { tenant, actor } = await staffContext(req, slug);
  return ok(await patientTimeline(actor, tenant, id));
});
