'use client';
import { useState } from 'react';

type Confirm = (gatewayOrderId: string, paymentId: string, signature?: string) => Promise<{ ok: true; outcome: string } | { ok: false; error: string }>;
declare global { interface Window { Razorpay?: new (o: Record<string, unknown>) => { open: () => void; on: (e: string, f: (r: unknown) => void) => void } } }

function loadScript(src: string) {
  return new Promise<void>((resolve, reject) => {
    if (document.querySelector(`script[src="${src}"]`)) return resolve();
    const s = document.createElement('script'); s.src = src; s.onload = () => resolve(); s.onerror = () => reject(new Error('Could not load the payment page'));
    document.body.appendChild(s);
  });
}

/** Opens Razorpay Checkout (or a sandbox confirmation). The server verifies the signature before recording any money. */
export function CheckoutButton(p: { provider: string; keyId: string | null; orderId: string; amount: number; currency: string; name: string; gatewayOrderId: string; confirm: Confirm; doneHref: string }) {
  const [state, setState] = useState<'idle' | 'busy' | 'done' | 'error'>('idle');
  const [message, setMessage] = useState('');
  const finish = async (paymentId: string, signature?: string) => {
    setState('busy');
    const r = await p.confirm(p.gatewayOrderId, paymentId, signature);
    if (r.ok) { setState('done'); setMessage('Payment received. A receipt has been issued.'); } else { setState('error'); setMessage(r.error); }
  };
  const start = async () => {
    setState('busy'); setMessage('');
    try {
      if (p.provider === 'sandbox') return finish(`sandbox_pay_${crypto.randomUUID().slice(0, 12)}`);
      await loadScript('https://checkout.razorpay.com/v1/checkout.js');
      const rz = new window.Razorpay!({ key: p.keyId, amount: p.amount, currency: p.currency, name: p.name, order_id: p.orderId,
        handler: (r: { razorpay_payment_id: string; razorpay_signature: string }) => finish(r.razorpay_payment_id, r.razorpay_signature),
        modal: { ondismiss: () => setState('idle') } });
      rz.on('payment.failed', () => { setState('error'); setMessage('The payment did not go through. No money was taken, or it will be refunded by your bank.'); });
      rz.open();
    } catch (e) { setState('error'); setMessage((e as Error).message); }
  };
  if (state === 'done') return <><p className="flash ok">{message}</p><a className="btn" href={p.doneHref}>Done</a></>;
  return (
    <>
      {message && <p className="flash err">{message}</p>}
      <button className="btn primary wide" onClick={start} disabled={state === 'busy'}>{state === 'busy' ? 'Please wait…' : p.provider === 'sandbox' ? 'Simulate payment (test mode)' : 'Pay now'}</button>
    </>
  );
}
