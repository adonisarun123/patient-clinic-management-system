import { registerPatient, searchPatients } from '@/domain/patients';
import { body, ok, requestKey, route, staffContext } from '@/lib/http';

export const GET = route<{ tenant: string }>(async (req, { tenant: slug }) => {
  const { actor } = await staffContext(req, slug);
  return ok({ results: await searchPatients(actor, new URL(req.url).searchParams.get('q') ?? '') });
});

export const POST = route<{ tenant: string }>(async (req, { tenant: slug }) => {
  const { tenant, actor } = await staffContext(req, slug);
  return ok(await registerPatient(actor, tenant, await body(req), requestKey(req)), 201);
});
