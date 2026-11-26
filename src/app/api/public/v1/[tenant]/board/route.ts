import { publicBoard } from '@/domain/queue';
import { ok, publicContext, route } from '@/lib/http';

/** Waiting-room screen feed: tokens and rooms only. */
export const GET = route<{ tenant: string }>(async (req, { tenant: slug }) => {
  const { tenant, cors } = await publicContext(req, slug);
  const dept = new URL(req.url).searchParams.get('departmentId') ?? undefined;
  return ok({ updatedAt: new Date().toISOString(), tickets: await publicBoard(tenant, dept) }, 200, cors);
});
