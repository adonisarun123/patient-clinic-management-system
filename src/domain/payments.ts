import { withTenant, type Tx } from '@/lib/db';
import { AppError, invalid, notFound } from '@/lib/errors';
import { hmacSha256, safeEqual, randomToken } from '@/lib/crypto';
import { audit } from '@/lib/events';
import { recordPayment } from './billing';
import { getSecret, requireModule, type Tenant } from './tenants';
import type { Actor } from '@/lib/actor';
import { portalCan, type PortalSession } from './portal';

/**
 * Online payments (FN-018) through Razorpay hosted Checkout — no card data touches Clinic Core.
 * Flow: create a Razorpay order on the server → patient pays in Checkout → we verify the Checkout signature
 * (HMAC-SHA256 of "<our order_id>|<razorpay_payment_id>" with the key secret) AND/OR the webhook
 * (X-Razorpay-Signature = HMAC-SHA256 of the raw body with the webhook secret). Either path settles the same
 * gateway_order exactly once; the payment is recorded as a receipt with method "gateway" and auto-allocated.
 * Sandbox mode (no keys, non-production) simulates the provider so the flow can be tested end to end.
 */
/** Sandbox (simulated) payments: always on in development; on a staging server only with ALLOW_SANDBOX_PAYMENTS=1. Never set that in production. */
export const sandboxAllowed = () => process.env.NODE_ENV !== 'production' || process.env.ALLOW_SANDBOX_PAYMENTS === '1';

export type GatewayConfig = { provider: 'razorpay'; keyId: string; keySecret: string; webhookSecret: string | null } | { provider: 'sandbox' };

export async function gatewayConfig(tx: Tx): Promise<GatewayConfig | null> {
  const keyId = await getSecret(tx, 'razorpay_key_id');
  const keySecret = await getSecret(tx, 'razorpay_key_secret');
  if (keyId && keySecret) return { provider: 'razorpay', keyId, keySecret, webhookSecret: await getSecret(tx, 'razorpay_webhook_secret') };
  if (sandboxAllowed()) return { provider: 'sandbox' };
  return null;
}

/** Creates (or reuses an open) gateway order for an invoice's outstanding balance. */
export async function createInvoiceCheckout(tenant: Tenant, s: PortalSession, invoiceId: string) {
  requireModule(tenant, 'payments');
  return withTenant(tenant.id, async (tx) => {
    const inv = await tx.maybe<{ patient_id: string; due_paise: number; number: string; status: string }>(
      `SELECT patient_id, due_paise, number, status FROM invoice_balance WHERE invoice_id = $1`, [invoiceId]);
    if (!inv || inv.status !== 'posted') throw notFound('Invoice');
    const link = portalCan(s, inv.patient_id, 'can_pay');
    if (Number(inv.due_paise) <= 0) throw new AppError('RULE_VIOLATION', 'This invoice is already paid.');
    const cfg = await gatewayConfig(tx);
    if (!cfg) throw new AppError('INTERNAL', 'Online payment is not configured for this clinic.');
    const open = await tx.maybe<{ id: string; provider_order_id: string; amount_paise: number }>(
      `SELECT id, provider_order_id, amount_paise FROM gateway_order WHERE invoice_id = $1 AND status = 'created' AND amount_paise = $2 AND created_at > now() - interval '30 minutes' ORDER BY created_at DESC LIMIT 1`,
      [invoiceId, inv.due_paise]);
    let orderId = open?.provider_order_id; let gid = open?.id;
    if (!open) {
      if (cfg.provider === 'razorpay') {
        const res = await fetch('https://api.razorpay.com/v1/orders', {
          method: 'POST', signal: AbortSignal.timeout(15_000),
          headers: { 'Content-Type': 'application/json', Authorization: `Basic ${Buffer.from(`${cfg.keyId}:${cfg.keySecret}`).toString('base64')}` },
          body: JSON.stringify({ amount: Number(inv.due_paise), currency: tenant.currency, receipt: inv.number.slice(0, 40), notes: { clinic: tenant.slug, invoice: inv.number } }),
        });
        if (!res.ok) throw new AppError('INTERNAL', 'The payment provider is unavailable. Please try again shortly.');
        orderId = ((await res.json()) as { id: string }).id;
      } else {
        orderId = `sandbox_order_${randomToken(10)}`;
      }
      gid = (await tx.one<{ id: string }>(
        `INSERT INTO gateway_order (tenant_id, provider, provider_order_id, patient_id, invoice_id, amount_paise, currency, created_via)
         VALUES (app_tenant_id(), $1,$2,$3,$4,$5,$6,'portal') RETURNING id`,
        [cfg.provider, orderId, inv.patient_id, invoiceId, inv.due_paise, tenant.currency])).id;
    }
    return { gatewayOrderId: gid!, provider: cfg.provider, providerOrderId: orderId!, amountPaise: Number(inv.due_paise), currency: tenant.currency,
      keyId: cfg.provider === 'razorpay' ? cfg.keyId : null, invoiceNumber: inv.number, patientName: link.full_name };
  });
}

/** Settles a paid gateway order once; called from the Checkout callback and the webhook. Safe to call repeatedly. */
async function settle(tx: Tx, tenant: Tenant, providerOrderId: string, providerPaymentId: string, amountPaise: number | null, via: string) {
  const g = await tx.maybe<{ id: string; status: string; patient_id: string; invoice_id: string | null; amount_paise: number; payment_id: string | null; provider: string }>(
    `SELECT * FROM gateway_order WHERE provider_order_id = $1 FOR UPDATE`, [providerOrderId]);
  if (!g) return { outcome: 'unknown_order' as const };
  if (g.status === 'paid') return { outcome: 'already_settled' as const, paymentId: g.payment_id };
  if (amountPaise != null && amountPaise !== Number(g.amount_paise)) return { outcome: 'amount_mismatch' as const };
  // Money arrived: record it even if the invoice was paid meanwhile — the excess stays as an advance for refund review (OP-020).
  const sys: Actor = { kind: 'system', tenantId: tenant.id };
  const r = await recordPayment(sys, tenant, { patientId: g.patient_id, method: 'gateway', amountPaise: Number(g.amount_paise), reference: providerPaymentId,
    note: `Online (${g.provider}) via ${via}`, allocations: g.invoice_id ? [{ invoiceId: g.invoice_id, amountPaise: Number(g.amount_paise) }] : [], autoAllocate: true }, `gw:${providerPaymentId}`, tx);
  await tx.exec(`UPDATE gateway_order SET status = 'paid', provider_payment_id = $2, payment_id = $3, paid_at = now() WHERE id = $1`, [g.id, providerPaymentId, r.paymentId]);
  await audit(tx, sys, 'gateway.settled', 'gateway_order', g.id, { patientId: g.patient_id, data: { via, receiptNo: r.receiptNo } });
  return { outcome: 'settled' as const, paymentId: r.paymentId, receiptNo: r.receiptNo };
}

/** Checkout success handler: verify the signature with our own order id (never the client-supplied one). */
export async function verifyCheckout(tenant: Tenant, s: PortalSession, gatewayOrderId: string, p: { razorpay_payment_id: string; razorpay_signature?: string }) {
  requireModule(tenant, 'payments');
  return withTenant(tenant.id, async (tx) => {
    const g = await tx.maybe<{ provider: string; provider_order_id: string; patient_id: string }>(`SELECT provider, provider_order_id, patient_id FROM gateway_order WHERE id = $1`, [gatewayOrderId]);
    if (!g) throw notFound();
    portalCan(s, g.patient_id, 'can_pay');
    const cfg = await gatewayConfig(tx);
    if (!cfg) throw new AppError('INTERNAL', 'Online payment is not configured');
    if (!/^[\w-]{6,80}$/.test(p.razorpay_payment_id ?? '')) throw invalid('Missing payment id');
    if (g.provider === 'razorpay') {
      if (cfg.provider !== 'razorpay' || !p.razorpay_signature) throw new AppError('FORBIDDEN', 'Payment could not be verified');
      const expected = hmacSha256(cfg.keySecret, `${g.provider_order_id}|${p.razorpay_payment_id}`);
      if (!safeEqual(expected, p.razorpay_signature)) throw new AppError('FORBIDDEN', 'Payment could not be verified');
    } else if (!sandboxAllowed()) {
      throw new AppError('FORBIDDEN', 'Sandbox payments are disabled in production');
    }
    return settle(tx, tenant, g.provider_order_id, p.razorpay_payment_id, null, 'checkout');
  });
}

/** Razorpay webhook: every delivery is logged; only signature-verified payment.captured events settle money. */
export async function handleRazorpayWebhook(tenant: Tenant, rawBody: string, signature: string | null) {
  return withTenant(tenant.id, async (tx) => {
    const cfg = await gatewayConfig(tx);
    const secret = cfg && cfg.provider === 'razorpay' ? cfg.webhookSecret : null;
    const ok = !!(secret && signature && safeEqual(hmacSha256(secret, rawBody), signature));
    let body: { event?: string; payload?: { payment?: { entity?: { id?: string; order_id?: string; amount?: number; status?: string } } } } = {};
    try { body = JSON.parse(rawBody); } catch { /* logged below */ }
    const pay = body.payload?.payment?.entity;
    let outcome = ok ? 'ignored' : 'bad_signature';
    if (ok && body.event === 'payment.captured' && pay?.id && pay.order_id) {
      outcome = (await settle(tx, tenant, pay.order_id, pay.id, typeof pay.amount === 'number' ? pay.amount : null, 'webhook')).outcome;
    }
    await tx.exec(`INSERT INTO gateway_event (tenant_id, provider, event_type, signature_ok, provider_payment_id, outcome, payload) VALUES (app_tenant_id(), 'razorpay', $1, $2, $3, $4, $5)`,
      [body.event ?? null, ok, pay?.id ?? null, outcome, ok ? rawBody : JSON.stringify({ rejected: true })]);
    return { ok, outcome };
  });
}

export async function gatewayActivity(tenantId: string) {
  return withTenant(tenantId, async (tx) => ({
    orders: await tx.many<{ id: string; provider: string; provider_order_id: string; amount_paise: number; status: string; created_at: Date; paid_at: Date | null; provider_payment_id: string | null; full_name: string }>(
      `SELECT g.*, p.full_name FROM gateway_order g JOIN patient p ON p.id = g.patient_id ORDER BY g.created_at DESC LIMIT 100`),
    events: await tx.many<{ received_at: Date; event_type: string | null; signature_ok: boolean; outcome: string | null; provider_payment_id: string | null }>(
      `SELECT received_at, event_type, signature_ok, outcome, provider_payment_id FROM gateway_event ORDER BY received_at DESC LIMIT 50`),
  }));
}
