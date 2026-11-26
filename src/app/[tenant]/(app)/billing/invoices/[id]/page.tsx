import Link from 'next/link';
import { requireStaff } from '@/lib/session';
import { invoiceDetail } from '@/domain/billing';
import { can } from '@/lib/rbac';
import { fmtDate, money } from '@/lib/format';
import { Flash } from '@/components/ui';
import { PrintButton } from '@/components/PrintButton';
import { voidInvoiceAction } from '../../../actions';
import { listClaims, patientPolicies, listPreauths } from '@/domain/insurance';
import { insuranceAction } from '../../../insurance-actions';

export default async function Invoice({ params, searchParams }: { params: Promise<{ tenant: string; id: string }>; searchParams: Promise<{ ok?: string; err?: string }> }) {
  const { tenant: slug, id } = await params;
  const { tenant, actor, session } = await requireStaff(slug, 'billing.read');
  const { invoice: i, lines, balance, allocations } = await invoiceDetail(actor, tenant, id);
  const b = tenant.branding;
  const claims = (await listClaims(actor, tenant, { patientId: i.patient_id })).filter((c) => c.invoice_number === i.number);
  const policies = can(session.role, 'claims.manage') && i.status === 'posted' && Number(balance.due_paise) > 0 ? (await patientPolicies(actor, tenant, i.patient_id)).filter((p) => p.status === 'active') : [];
  const approvedPA = policies.length ? (await listPreauths(actor, tenant, { patientId: i.patient_id })).filter((x) => ['approved', 'partially_approved'].includes(x.status)) : [];
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
          {Number(balance.payer_paise) > 0 && <tr><td colSpan={5}>Claimed from insurer / payer</td><td>{money(balance.payer_paise, tenant)}</td></tr>}
          <tr className="total"><td colSpan={5}>Balance due{Number(balance.payer_paise) > 0 ? ' from patient' : ''}</td><td>{money(balance.due_paise, tenant)}</td></tr>
        </tfoot></table>
      {allocations.length > 0 && <p className="small">Payments: {(allocations as { receipt_no: string; amount_paise: number; direction: string }[]).map((a) => `${a.receipt_no} ${a.direction === 'release' ? '−' : ''}${money(a.amount_paise, tenant)}`).join(', ')}</p>}
      {claims.length > 0 && <p className="small no-print">Claims: {claims.map((c) => <Link key={c.id} href={`/${slug}/insurance/claims/${c.id}`}>{c.claim_number} · {c.payer_name} · {c.status} </Link>)}</p>}
      {policies.length > 0 && (
        <form action={insuranceAction.bind(null, slug)} className="no-print card inline-form wrap"><input type="hidden" name="op" value="claim" /><input type="hidden" name="invoiceId" value={id} /><input type="hidden" name="back" value={`/${slug}/billing/invoices/${id}`} />
          <b>Claim from insurer:</b>
          <select name="policyId">{policies.map((p) => <option key={p.id} value={p.id}>{p.payer_name}{p.tpa_name ? ` via ${p.tpa_name}` : ''} · {p.policy_number}{p.copay_bp ? ` (co-pay ${p.copay_bp / 100}%)` : ''}</option>)}</select>
          <label>Amount ₹<input name="amount" required inputMode="decimal" size={9} defaultValue={((Number(balance.due_paise) * (10000 - policies[0].copay_bp)) / 10000 / 100).toFixed(2)} /></label>
          {approvedPA.length > 0 && <select name="preauthId"><option value="">No pre-auth</option>{approvedPA.map((x) => <option key={x.id} value={x.id}>{x.ref_number} · approved {money(x.approved_paise, tenant)}</option>)}</select>}
          <button className="btn primary small">Raise claim</button>
          <small className="muted">The claimed amount moves off the patient’s balance. Default is the due amount less the policy’s co-pay; reduce it for non-payable items.</small></form>)}
      {i.status === 'posted' && can(session.role, 'billing.void') && (
        <form action={voidInvoiceAction.bind(null, slug, id)} className="no-print card inline-form"><b>Void invoice:</b><input name="reason" placeholder="Reason (required)" required /><button className="btn danger small">Void</button>
          <small className="muted">Payments move back to the patient’s advance; charges return to unbilled for re-billing. The number is never reused.</small></form>)}
    </div>
  );
}
