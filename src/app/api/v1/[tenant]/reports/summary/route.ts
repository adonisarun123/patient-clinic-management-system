import { summary } from '@/domain/reports';
import { ok, route, staffContext } from '@/lib/http';

export const GET = route<{ tenant: string }>(async (req, { tenant: slug }) => {
  const { tenant, actor } = await staffContext(req, slug);
  const q = new URL(req.url).searchParams;
  const today = new Date().toLocaleDateString('en-CA', { timeZone: tenant.timezone });
  return ok(await summary(actor, tenant, q.get('from') ?? today, q.get('to') ?? today));
});
