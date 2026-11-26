import { cancelAppointment, checkIn, markNoShow, reschedule } from '@/domain/scheduling';
import { AppError } from '@/lib/errors';
import { body, ok, requestKey, route, staffContext } from '@/lib/http';

/** POST /appointments/{id}/cancel | reschedule | check-in | no-show */
export const POST = route<{ tenant: string; id: string; action: string }>(async (req, { tenant: slug, id, action }) => {
  const { tenant, actor } = await staffContext(req, slug);
  const b = await body<Record<string, unknown>>(req).catch(() => ({} as Record<string, unknown>));
  switch (action) {
    case 'cancel': return ok(await cancelAppointment(actor, tenant, id, String(b.reason ?? ''), { expectedVersion: b.expectedVersion as number | undefined }));
    case 'reschedule': return ok(await reschedule(actor, tenant, id, b as never, requestKey(req)));
    case 'check-in': return ok(await checkIn(actor, tenant, id, { identityConfirmed: b.identityConfirmed === true }));
    case 'no-show': await markNoShow(actor, tenant, id); return ok({ state: 'no_show' });
    default: throw new AppError('NOT_FOUND', 'Unknown action');
  }
});
