import { requireStaff } from '@/lib/session';
import { dailyClose } from '@/domain/reports';
import { fmtTime, money, today } from '@/lib/format';
import { Empty, PageHead } from '@/components/ui';
import { PrintButton } from '@/components/PrintButton';
import { can } from '@/lib/rbac';
import { DENOMINATIONS, drawerSessions, myDrawer } from '@/domain/finance';
import { drawerAction } from '../../finance-actions';
import { Flash } from '@/components/ui';

export default async function Close({ params, searchParams }: { params: Promise<{ tenant: string }>; searchParams: Promise<{ date?: string; ok?: string; err?: string }> }) {
  const { tenant: slug } = await params;
  const { tenant, actor, session } = await requireStaff(slug, 'billing.read');
  const sp = await searchParams;
  const date = sp.date ?? today(tenant);
  const mine = can(session.role, 'billing.collect') ? await myDrawer(actor, tenant) : null;
  const sessions = await drawerSessions(actor, tenant, date);
  const back = `/${slug}/billing/close?date=${date}`;
  const d = await dailyClose(actor, tenant, date);
  const by = new Map<string, number>();
  for (const r of d.receipts) by.set(r.method, (by.get(r.method) ?? 0) + Number(r.amount_paise));
  for (const r of d.refunds) by.set(r.method, (by.get(r.method) ?? 0) - Number(r.amount_paise));
  return (
    <div className="print-page">
      <PageHead title="Daily cash close" sub={date}><form className="no-print toolbar"><input type="date" name="date" defaultValue={date} /><button className="btn">Show</button></form><PrintButton /></PageHead>
      <Flash ok={sp.ok} err={sp.err} />
      {can(session.role, 'billing.collect') && (mine ? (
        <form action={drawerAction.bind(null, slug)} className="card no-print"><input type="hidden" name="op" value="close" /><input type="hidden" name="back" value={back} />
          <h2>Close my cash drawer</h2>
          <p className="small muted">Opened {fmtTime(mine.opened_at, tenant)} with a float of {money(mine.opening_float_paise, tenant)}. Count the notes and coins; the system compares your count with the cash you received and refunded.</p>
          <div className="denoms">{DENOMINATIONS.map((d) => <label key={d}>₹{d}<input type="number" name={`d${d}`} min={0} defaultValue={0} /></label>)}</div>
          <label>Reason if the count doesn’t match<input name="reason" placeholder="e.g. ₹10 change given without receipt" /></label>
          <button className="btn primary">Close drawer</button>
        </form>
      ) : (
        <form action={drawerAction.bind(null, slug)} className="card inline-form no-print"><input type="hidden" name="op" value="open" /><input type="hidden" name="back" value={back} />
          <b>Cash drawer</b><label>Opening float (₹)<input name="float" defaultValue="0" inputMode="decimal" size={8} /></label><button className="btn">Open my drawer</button></form>
      ))}
      {sessions.length > 0 && <div className="card"><h2>Cash drawers</h2>
        <table className="table small"><thead><tr><th>Cashier</th><th>Opened</th><th>Closed</th><th>Float</th><th>Expected</th><th>Counted</th><th>Variance</th><th>Status</th><th /></tr></thead>
          <tbody>{sessions.map((d) => <tr key={d.id}><td>{d.full_name}</td><td>{fmtTime(d.opened_at, tenant)}</td><td>{d.closed_at ? fmtTime(d.closed_at, tenant) : '—'}</td>
            <td>{money(d.opening_float_paise, tenant)}</td><td>{d.expected_paise != null ? money(d.expected_paise, tenant) : '—'}</td><td>{d.counted_paise != null ? money(d.counted_paise, tenant) : '—'}</td>
            <td className={Number(d.variance_paise) ? 'warn-text' : ''}>{d.variance_paise != null ? money(d.variance_paise, tenant) : '—'}{d.variance_reason ? <><br /><small>{d.variance_reason}</small></> : null}</td>
            <td>{d.status.replace('_', ' ')}{d.approver ? <><br /><small>by {d.approver}</small></> : null}</td>
            <td>{d.status === 'pending_approval' && can(session.role, 'finance.close') && <form action={drawerAction.bind(null, slug)} className="no-print"><input type="hidden" name="op" value="approve" /><input type="hidden" name="id" value={d.id} /><input type="hidden" name="back" value={back} /><button className="btn small">Approve</button></form>}</td></tr>)}</tbody></table></div>}
      <div className="stats">{[...by.entries()].map(([m, v]) => <div key={m} className="stat"><b>{money(v, tenant)}</b><span>Net {m.replace('_', ' ')}</span></div>)}</div>
      <p className="small muted">Count the drawer against “Net cash”. Reconcile UPI/card totals to the bank or terminal settlement before closing the day.</p>
      <div className="card"><h2>Receipts</h2>{d.receipts.length === 0 ? <Empty>None.</Empty> : (
        <table className="table small"><thead><tr><th>Time</th><th>Receipt</th><th>Patient</th><th>Mode</th><th>Ref</th><th>Amount</th><th>By</th></tr></thead>
          <tbody>{d.receipts.map((r) => <tr key={r.receipt_no}><td>{fmtTime(r.received_at, tenant)}</td><td>{r.receipt_no}</td><td>{r.full_name}</td><td>{r.method}</td><td>{r.reference}</td><td>{money(r.amount_paise, tenant)}</td><td>{r.received_by}</td></tr>)}</tbody></table>)}</div>
      {d.refunds.length > 0 && <div className="card"><h2>Refunds paid</h2><table className="table small"><tbody>{d.refunds.map((r, i) => <tr key={i}><td>{r.full_name}</td><td>{r.method}</td><td>{r.paid_reference}</td><td>−{money(r.amount_paise, tenant)}</td></tr>)}</tbody></table></div>}
    </div>
  );
}
