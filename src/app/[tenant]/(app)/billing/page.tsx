import Link from 'next/link';
import { requireStaff } from '@/lib/session';
import { patientAccount, pendingRefunds } from '@/domain/billing';
import { getPatient, searchPatients } from '@/domain/patients';
import { listCatalog } from '@/domain/catalog';
import { can } from '@/lib/rbac';
import { fmtDateTime, money, today } from '@/lib/format';
import { Badge, Empty, Flash, PageHead, PatientBanner, RequestKey } from '@/components/ui';
import { billAction, chargeAction, paymentAction, refundDecisionAction, refundRequestAction, voidChargeAction } from '../actions';

export default async function Billing({ params, searchParams }: { params: Promise<{ tenant: string }>; searchParams: Promise<{ patient?: string; q?: string; ok?: string; err?: string }> }) {
  const { tenant: slug } = await params;
  const sp = await searchParams;
  const { tenant, actor, session } = await requireStaff(slug, 'billing.read');
  const refunds = await pendingRefunds(actor, tenant);
  const found = sp.q ? await searchPatients(actor, sp.q) : [];
  const patient = sp.patient ? await getPatient(actor, sp.patient) : null;
  const acct = patient ? await patientAccount(actor, tenant, patient.id) : null;
  const cat = await listCatalog(tenant.id);
  const role = session.role;

  return (
    <>
      <PageHead title="Billing" sub="Charges → invoice → receipt. Every posting is balanced in the ledger.">
        <Link className="btn" href={`/${slug}/billing/close?date=${today(tenant)}`}>Daily cash close</Link>
      </PageHead>
      <Flash ok={sp.ok} err={sp.err} />
      <form className="search"><input name="q" defaultValue={sp.q} placeholder="Find patient: UHID, mobile or name" /><button className="btn">Find</button></form>
      {found.length > 0 && <div className="card">{found.map((r) => <p key={r.id}><Link href={`/${slug}/billing?patient=${r.id}`}>{r.full_name}</Link> · {r.uhid}</p>)}</div>}

      {refunds.length > 0 && (
        <div className="card">
          <h2>Refunds awaiting action</h2>
          <table className="table"><thead><tr><th>Patient</th><th>Receipt</th><th>Amount</th><th>Reason</th><th>Requested by</th><th>Status</th><th /></tr></thead>
            <tbody>{refunds.map((r) => (
              <tr key={r.id}><td>{r.full_name} <small className="muted">{r.uhid}</small></td><td>{r.receipt_no}</td><td>{money(r.amount_paise, tenant)} · {r.method}</td><td>{r.reason}</td>
                <td>{r.requested_by_name}</td><td><Badge v={r.status} /></td>
                <td className="row-actions">
                  {r.status === 'requested' && can(role, 'refund.approve') && (<>
                    <form action={refundDecisionAction.bind(null, slug, r.id)}><input type="hidden" name="op" value="approve" /><button className="btn small primary" disabled={r.requested_by === session.staffId && !tenant.settings.soloPractice} title={r.requested_by === session.staffId ? 'A different person must approve' : ''}>Approve</button></form>
                    <form action={refundDecisionAction.bind(null, slug, r.id)}><input type="hidden" name="op" value="reject" /><button className="btn small">Reject</button></form></>)}
                  {r.status === 'approved' && can(role, 'billing.collect') && (
                    <form action={refundDecisionAction.bind(null, slug, r.id)} className="inline-form"><input type="hidden" name="op" value="pay" />{r.method !== 'cash' && <input name="reference" placeholder="Refund txn ref" required />}<button className="btn small primary">Mark paid</button></form>)}
                </td></tr>))}</tbody></table>
        </div>)}

      {patient && acct && (
        <>
          <PatientBanner p={patient} slug={slug} />
          <div className="stats">
            <div className="stat"><b>{money(acct.duePaise, tenant)}</b><span>Balance due</span></div>
            <div className="stat"><b>{money(acct.advancePaise, tenant)}</b><span>Advance held</span></div>
            <div className="stat"><b>{acct.charges.length}</b><span>Unbilled charges</span></div>
          </div>
          <div className="grid2">
            <div className="card">
              <h2>Unbilled charges</h2>
              {acct.charges.length === 0 ? <Empty>Nothing to bill.</Empty> : (
                <form action={billAction.bind(null, slug, patient.id)}>
                  <RequestKey />
                  <table className="table small"><tbody>{acct.charges.map((c) => (
                    <tr key={c.id}><td><input type="checkbox" name="chargeId" value={c.id} defaultChecked aria-label={c.description} /></td>
                      <td>{c.description}{c.discount_reason ? <div className="muted">{c.discount_reason}</div> : null}</td><td>×{c.quantity}</td>
                      <td>{money(Number(c.unit_price_paise) * c.quantity - Number(c.discount_paise), tenant)}</td></tr>))}</tbody></table>
                  {can(role, 'billing.post') && <button className="btn primary">Create invoice</button>}
                </form>)}
              {acct.charges.length > 0 && can(role, 'billing.void') && (
                <details><summary className="small">Void a charge</summary>{acct.charges.map((c) => (
                  <form key={c.id} action={voidChargeAction.bind(null, slug, patient.id, c.id)} className="inline-form"><span className="small">{c.description}</span><input name="reason" placeholder="Reason" required /><button className="btn small">Void</button></form>))}</details>)}
              {can(role, 'billing.charge') && (
                <form action={chargeAction.bind(null, slug, patient.id)} className="form-grid tight">
                  <RequestKey />
                  <h3 className="span2">Add charge</h3>
                  <label className="span2">Service<select name="serviceId"><option value="">Other (enter description)</option>{cat.services.filter((s) => s.active).map((s) => <option key={s.id} value={s.id}>{s.name} · {money(s.price_paise, tenant)}</option>)}</select></label>
                  <label>Description<input name="description" /></label>
                  <label>Price ({tenant.currency})<input name="price" inputMode="decimal" placeholder="tariff if blank" /></label>
                  <label>Qty<input name="quantity" type="number" min={1} defaultValue={1} /></label>
                  {can(role, 'discount.apply') && <><label>Discount<input name="discount" inputMode="decimal" /></label><label className="span2">Discount reason<input name="discountReason" /></label></>}
                  <div className="span2"><button className="btn small">Add charge</button></div>
                </form>)}
            </div>
            <div className="card">
              <h2>Record payment</h2>
              {can(role, 'billing.collect') ? (
                <form action={paymentAction.bind(null, slug, patient.id)} className="form-grid tight">
                  <RequestKey />
                  <label>Amount ({tenant.currency})<input name="amount" inputMode="decimal" required defaultValue={acct.duePaise > 0 ? (acct.duePaise / 100).toFixed(2) : ''} /></label>
                  <label>Mode<select name="method"><option value="cash">Cash</option><option value="upi">UPI</option><option value="card">Card (external terminal)</option><option value="bank_transfer">Bank transfer</option><option value="cheque">Cheque</option></select></label>
                  <label className="span2">Transaction reference (required for non-cash)<input name="reference" placeholder="UPI ref / card slip no." /></label>
                  <label className="span2">Note<input name="note" /></label>
                  <p className="span2 small muted">Applied automatically to the oldest dues; any excess is kept as an advance.</p>
                  <div className="span2"><button className="btn primary">Record payment</button></div>
                </form>) : <p className="muted">You cannot collect payments.</p>}
            </div>
          </div>
          <div className="grid2">
            <div className="card">
              <h2>Invoices</h2>
              {acct.invoices.length === 0 ? <Empty>None.</Empty> : <table className="table small"><tbody>{acct.invoices.map((i) => (
                <tr key={i.invoice_id}><td><Link href={`/${slug}/billing/invoices/${i.invoice_id}`}>{i.number}</Link></td><td>{money(i.total_paise, tenant)}</td>
                  <td>{i.status === 'posted' ? (i.due_paise > 0 ? `Due ${money(i.due_paise, tenant)}` : 'Paid') : <Badge v={i.status} />}</td></tr>))}</tbody></table>}
            </div>
            <div className="card">
              <h2>Receipts</h2>
              {acct.payments.length === 0 ? <Empty>None.</Empty> : <table className="table small"><tbody>{acct.payments.map((p) => (
                <tr key={p.payment_id}><td><Link href={`/${slug}/billing/receipts/${p.payment_id}`}>{p.receipt_no}</Link><br /><small className="muted">{fmtDateTime(p.received_at, tenant)} · {p.method}</small></td>
                  <td>{money(p.amount_paise, tenant)}{p.refunded_paise > 0 ? <div className="muted">refunded {money(p.refunded_paise, tenant)}</div> : null}</td>
                  <td>{can(role, 'refund.request') && p.amount_paise - p.refunded_paise > 0 && (
                    <details><summary className="btn small">Refund</summary>
                      <form action={refundRequestAction.bind(null, slug, patient.id)} className="pop inline-form">
                        <input type="hidden" name="paymentId" value={p.payment_id} />
                        <input name="amount" inputMode="decimal" placeholder="Amount" required />
                        <select name="method"><option value="cash">Cash</option><option value="upi">UPI</option><option value="bank_transfer">Bank</option><option value="card">Card</option></select>
                        <input name="reason" placeholder="Reason" required minLength={5} /><button className="btn small">Request</button>
                      </form></details>)}</td></tr>))}</tbody></table>}
            </div>
          </div>
        </>
      )}
    </>
  );
}
