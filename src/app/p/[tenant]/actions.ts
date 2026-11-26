'use server';
import { cookies, headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { AppError, toAppError } from '@/lib/errors';
import { rateLimit } from '@/lib/http';
import { portalCookie, pendingCookie, portalTenant, requirePortal } from '@/lib/portal-session';
import { kickOutbox } from '@/lib/outbox';
import * as portal from '@/domain/portal';
import * as pay from '@/domain/payments';
import * as tele from '@/domain/telemedicine';
import { createHold, confirmAppointment } from '@/domain/scheduling';
import { sha256 } from '@/lib/crypto';

const str = (f: FormData, k: string) => String(f.get(k) ?? '').trim();
const msg = (e: unknown) => { const x = toAppError(e); return x instanceof AppError ? x.message : 'Something went wrong. Please try again.'; };
const ipOf = async () => (await headers()).get('x-forwarded-for')?.split(',')[0] ?? 'local';

export async function requestCode(slug: string, f: FormData) {
  const tenant = await portalTenant(slug);
  let dev: string | undefined;
  try {
    rateLimit(`portal-otp:${slug}:${await ipOf()}`, 6);
    const r = await portal.requestOtp(tenant, str(f, 'phone'), await ipOf());
    dev = r.devCode;
  } catch (e) { redirect(`/p/${slug}?err=${encodeURIComponent(msg(e))}`); }
  (await cookies()).set(pendingCookie(slug), str(f, 'phone'), { httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production', path: `/p/${slug}`, maxAge: 600 });
  redirect(`/p/${slug}?step=code${dev ? `&dev=${dev}` : ''}`);
}

export async function verifyCode(slug: string, f: FormData) {
  const tenant = await portalTenant(slug);
  const jar = await cookies();
  const phone = jar.get(pendingCookie(slug))?.value ?? '';
  let token: { token: string; maxAge: number };
  try {
    rateLimit(`portal-verify:${slug}:${await ipOf()}`, 20);
    token = await portal.verifyOtp(tenant, phone, str(f, 'code'), await ipOf());
  } catch (e) { redirect(`/p/${slug}?step=code&err=${encodeURIComponent(msg(e))}`); }
  jar.delete(pendingCookie(slug));
  jar.set(portalCookie(slug), token.token, { httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production', path: `/p/${slug}`, maxAge: token.maxAge });
  redirect(`/p/${slug}`);
}

export async function signOut(slug: string) {
  const tenant = await portalTenant(slug);
  const jar = await cookies();
  const t = jar.get(portalCookie(slug))?.value;
  if (t) await portal.portalLogout(tenant, t);
  jar.delete(portalCookie(slug));
  redirect(`/p/${slug}`);
}

export async function cancelVisit(slug: string, patientId: string, f: FormData) {
  const { tenant, s } = await requirePortal(slug);
  let r = `/p/${slug}/patient/${patientId}?ok=Appointment+cancelled`;
  try { await portal.portalCancel(tenant, s, str(f, 'appointmentId')); } catch (e) { r = `/p/${slug}/patient/${patientId}?err=${encodeURIComponent(msg(e))}`; }
  kickOutbox((await portalTenant(slug)).id, slug);
  redirect(r);
}

export async function joinVideo(slug: string, patientId: string, f: FormData) {
  const { tenant, s } = await requirePortal(slug);
  let url: string;
  try { url = await tele.portalJoin(tenant, s, str(f, 'appointmentId'), f.get('consent') === 'on'); } catch (e) { redirect(`/p/${slug}/patient/${patientId}?err=${encodeURIComponent(msg(e))}`); }
  // The page shows a link to the room (a form cannot redirect off-site under the portal's form-action CSP).
  redirect(`/p/${slug}/patient/${patientId}?room=${encodeURIComponent(url)}`);
}

export async function requestRecords(slug: string, patientId: string, f: FormData) {
  const { tenant, s } = await requirePortal(slug);
  const link = portal.portalCan(s, patientId, 'can_view_documents');
  let r: string;
  try {
    const c = await portal.createRecordsRequest(null, tenant, { patientId, requesterKind: link.relation === 'self' ? 'patient' : 'representative',
      requesterName: link.relation === 'self' ? link.full_name : `${link.relation} of ${link.full_name}`, requesterContact: s.phone,
      authorityNote: `Portal account linked as ${link.relation}`, requestType: (str(f, 'requestType') || 'copy') as 'copy', scope: str(f, 'scope'), delivery: 'portal' }, 'portal');
    r = `/p/${slug}/patient/${patientId}?ok=${encodeURIComponent(`Request ${c.caseNo} received`)}`;
  } catch (e) { r = `/p/${slug}/patient/${patientId}?err=${encodeURIComponent(msg(e))}`; }
  kickOutbox((await portalTenant(slug)).id, slug);
  redirect(r);
}

/** Portal booking: holds are scoped to this portal account (journey secret derived from the account). */
export async function bookVisit(slug: string, patientId: string, f: FormData) {
  const { tenant, s } = await requirePortal(slug);
  portal.portalCan(s, patientId, 'can_schedule');
  const actor = { kind: 'public' as const, tenantId: tenant.id, journey: `portal-${sha256(s.accountId)}` };
  let r: string;
  try {
    const h = await createHold(actor, tenant, { serviceId: str(f, 'serviceId'), clinicianId: str(f, 'clinicianId'), start: str(f, 'start') });
    const a = await confirmAppointment(actor, tenant, { holdId: h.holdId, patientId, source: 'portal' }, `portal-${h.holdId}`);
    r = `/p/${slug}/patient/${patientId}?ok=${encodeURIComponent(`Booked ${a.bookingRef}`)}`;
  } catch (e) { r = `/p/${slug}/book/${patientId}?err=${encodeURIComponent(msg(e))}`; }
  kickOutbox((await portalTenant(slug)).id, slug);
  redirect(r);
}

/** Called by the payment page after Checkout returns. */
export async function confirmPayment(slug: string, gatewayOrderId: string, paymentId: string, signature?: string) {
  const { tenant, s } = await requirePortal(slug);
  try {
    const r = await pay.verifyCheckout(tenant, s, gatewayOrderId, { razorpay_payment_id: paymentId, razorpay_signature: signature });
    return { ok: true as const, outcome: r.outcome };
  } catch (e) { return { ok: false as const, error: msg(e) }; }
}
