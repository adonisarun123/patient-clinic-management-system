import Link from 'next/link';
import { requirePortal } from '@/lib/portal-session';
import { createInvoiceCheckout } from '@/domain/payments';
import { money } from '@/lib/format';
import { AppError } from '@/lib/errors';
import { CheckoutButton } from '@/components/CheckoutButton';
import { confirmPayment } from '../../actions';

export default async function Pay({ params }: { params: Promise<{ tenant: string; invoiceId: string }> }) {
  const { tenant: slug, invoiceId } = await params;
  const { tenant, s } = await requirePortal(slug);
  let co: Awaited<ReturnType<typeof createInvoiceCheckout>>;
  try { co = await createInvoiceCheckout(tenant, s, invoiceId); } catch (e) {
    return <div className="card narrow"><p className="flash err">{e instanceof AppError ? e.message : 'Online payment is not available right now.'}</p><Link href={`/p/${slug}`}>Back</Link></div>;
  }
  return (
    <div className="card narrow">
      <h1>Pay invoice {co.invoiceNumber}</h1>
      <p style={{ fontSize: 22 }}><b>{money(co.amountPaise, tenant)}</b></p>
      <p className="muted">For {co.patientName}. You will pay on {co.provider === 'razorpay' ? 'Razorpay’s secure page' : 'a test page (no real money)'}; card and UPI details never reach the clinic.</p>
      <CheckoutButton provider={co.provider} keyId={co.keyId} orderId={co.providerOrderId} amount={co.amountPaise} currency={co.currency} name={tenant.name}
        gatewayOrderId={co.gatewayOrderId} confirm={confirmPayment.bind(null, slug)} doneHref={`/p/${slug}`} />
    </div>
  );
}
