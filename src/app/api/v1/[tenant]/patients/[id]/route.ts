import { getPatient } from '@/domain/patients';
import { ok, route, staffContext } from '@/lib/http';

export const GET = route<{ tenant: string; id: string }>(async (req, { tenant: slug, id }) => {
  const { actor } = await staffContext(req, slug);
  return ok(await getPatient(actor, id));
});
