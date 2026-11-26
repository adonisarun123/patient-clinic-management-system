import { recordPayment } from '@/domain/billing';
import { body, ok, requestKey, route, staffContext } from '@/lib/http';

export const POST = route<{ tenant: string }>(async (req, { tenant: slug }) => {
  const { tenant, actor } = await staffContext(req, slug);
  return ok(await recordPayment(actor, tenant, await body(req), requestKey(req)), 201);
});
