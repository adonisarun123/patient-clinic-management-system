import Link from 'next/link';
import { requireStaff } from '@/lib/session';
import { invoiceDetail } from '@/domain/billing';
import { can } from '@/lib/rbac';
import { fmtDate, money } from '@/lib/format';
import { Flash } from '@/components/ui';
import { PrintButton } from '@/components/PrintButton';
import { voidInvoiceAction } from '../../../actions';

export default async function Invoice({ params, searchParams }: { params: Promise<{ tenant: string; id: string }>; searchParams: Promise<{ ok?: string; err?: string }> }) {
  const { tenant: slug, id } = await params;
  const { tenant, actor, session } = await requireStaff(slug, 'billing.read');
  const { invoice: i, lines, balance, allocations } = await invoiceDetail(actor, tenant, id);
  const b = tenant.branding;
  return (
    <div className="print-page">
      <div className="no-print row-between"><Link href={`/${slug}/billing?patient=${i.patient_id}`}>← Back to account</Link><PrintButton /></div>
      <Flash {...await searchParams} />
      <header className="print-head"><div><h1>{tenant.legal_name ?? tenant.name}</h1><p>{b.address}</p><p>{[b.phone, b.email].filter(Boolean).join(' · ')}</p>{b.registrationText && <p className="small">{b.registrationText}</p>}</div></header>
      <div className="print-doc"><div><h2>{i.status === 'void' ? 'VOID — ' : ''}Invoice</h2><p>{i.number} · {fmtDate(i.business_date, tenant)}</p></div>
        <div className="right"><b>{i.full_name}</b><br />UHID {i.uhid}</div></div>
      {i.status === 'void' && <p className="print-flag">This invoice was voided: {i.void_reason}</p>}
      <table className="print-lines"><thead><tr><th>Description</th><th>Qty</th><th>Rate</th><th>Discount</th><th>Tax</th><th>Amount</th></tr></thead>
        <tbody>{lines.map((l, k) => <tr key={k}><td>{l.description}</td><td>{l.quantity}</td><td>{money(l.unit_price_paise, tenant)}</td><td>{l.discount_paise ? money(l.discount_paise, tenant) : '—'}</td>
          <td>{l.tax_paise ? `${money(l.tax_paise, tenant)} (${l.tax_rate_bp / 100}%)` : '—'}</td><td>{money(l.line_total_paise, tenant)}</td></tr>)}</tbody>
        <tfoot>
          <tr><td colSpan={5}>Subtotal</td><td>{money(i.subtotal_paise, tenant)}</td></tr>
          {i.discount_paise > 0 && <tr><td colSpan={5}>Discount</td><td>−{money(i.discount_paise, tenant)}</td></tr>}
          {i.tax_paise > 0 && <tr><td colSpan={5}>Tax</td><td>{money(i.tax_paise, tenant)}</td></tr>}
          <tr className="total"><td colSpan={5}>Total</td><td>{money(i.total_paise, tenant)}</td></tr>
          <tr><td colSpan={5}>Paid</td><td>{money(balance.paid_paise, tenant)}</td></tr>
          <tr className="total"><td colSpan={5}>Balance due</td><td>{money(balance.due_paise, tenant)}</td></tr>
        </tfoot></table>
      {allocations.length > 0 && <p className="small">Payments: {(allocations as { receipt_no: string; amount_paise: number; direction: string }[]).map((a) => `${a.receipt_no} ${a.direction === 'release' ? '−' : ''}${money(a.amount_paise, tenant)}`).join(', ')}</p>}
      {i.status === 'posted' && can(session.role, 'billing.void') && (
        <form action={voidInvoiceAction.bind(null, slug, id)} className="no-print card inline-form"><b>Void invoice:</b><input name="reason" placeholder="Reason (required)" required /><button className="btn danger small">Void</button>
          <small className="muted">Payments move back to the patient’s advance; charges return to unbilled for re-billing. The number is never reused.</small></form>)}
    </div>
  );
}
