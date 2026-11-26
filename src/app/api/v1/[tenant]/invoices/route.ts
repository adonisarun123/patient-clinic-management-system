import { billCharges } from '@/domain/billing';
import { body, ok, requestKey, route, staffContext } from '@/lib/http';

/** Body: { patientId, chargeIds[] } → posted invoice with number and balanced journal. */
export const POST = route<{ tenant: string }>(async (req, { tenant: slug }) => {
  const { tenant, actor } = await staffContext(req, slug);
  const b = await body<{ patientId: string; chargeIds: string[] }>(req);
  return ok(await billCharges(actor, tenant, b.patientId, b.chargeIds ?? [], requestKey(req)), 201);
});
