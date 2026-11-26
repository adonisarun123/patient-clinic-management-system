import { getTenantBySlug } from '@/domain/tenants';
import { handleRazorpayWebhook } from '@/domain/payments';

/** Razorpay → Clinic Core. Signature is checked over the raw body; respond 200 quickly so Razorpay does not retry needlessly. */
export async function POST(req: Request, ctx: { params: Promise<{ tenant: string }> }) {
  const { tenant: slug } = await ctx.params;
  const tenant = await getTenantBySlug(slug).catch(() => null);
  if (!tenant || !tenant.settings.modules.payments) return new Response('not found', { status: 404 });
  const raw = await req.text();
  if (raw.length > 512 * 1024) return new Response('too large', { status: 413 });
  try {
    const r = await handleRazorpayWebhook(tenant, raw, req.headers.get('x-razorpay-signature'));
    return Response.json({ received: true }, { status: r.ok ? 200 : 400 });
  } catch (e) {
    console.error('[razorpay webhook]', (e as Error).message);
    return new Response('error', { status: 500 });
  }
}
