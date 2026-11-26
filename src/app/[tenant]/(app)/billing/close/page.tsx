import { requireStaff } from '@/lib/session';
import { dailyClose } from '@/domain/reports';
import { fmtTime, money, today } from '@/lib/format';
import { Empty, PageHead } from '@/components/ui';
import { PrintButton } from '@/components/PrintButton';

export default async function Close({ params, searchParams }: { params: Promise<{ tenant: string }>; searchParams: Promise<{ date?: string }> }) {
  const { tenant: slug } = await params;
  const { tenant, actor } = await requireStaff(slug, 'billing.read');
  const date = (await searchParams).date ?? today(tenant);
  const d = await dailyClose(actor, tenant, date);
  const by = new Map<string, number>();
  for (const r of d.receipts) by.set(r.method, (by.get(r.method) ?? 0) + Number(r.amount_paise));
  for (const r of d.refunds) by.set(r.method, (by.get(r.method) ?? 0) - Number(r.amount_paise));
  return (
    <div className="print-page">
      <PageHead title="Daily cash close" sub={date}><form className="no-print toolbar"><input type="date" name="date" defaultValue={date} /><button className="btn">Show</button></form><PrintButton /></PageHead>
      <div className="stats">{[...by.entries()].map(([m, v]) => <div key={m} className="stat"><b>{money(v, tenant)}</b><span>Net {m.replace('_', ' ')}</span></div>)}</div>
      <p className="small muted">Count the drawer against “Net cash”. Reconcile UPI/card totals to the bank or terminal settlement before closing the day.</p>
      <div className="card"><h2>Receipts</h2>{d.receipts.length === 0 ? <Empty>None.</Empty> : (
        <table className="table small"><thead><tr><th>Time</th><th>Receipt</th><th>Patient</th><th>Mode</th><th>Ref</th><th>Amount</th><th>By</th></tr></thead>
          <tbody>{d.receipts.map((r) => <tr key={r.receipt_no}><td>{fmtTime(r.received_at, tenant)}</td><td>{r.receipt_no}</td><td>{r.full_name}</td><td>{r.method}</td><td>{r.reference}</td><td>{money(r.amount_paise, tenant)}</td><td>{r.received_by}</td></tr>)}</tbody></table>)}</div>
      {d.refunds.length > 0 && <div className="card"><h2>Refunds paid</h2><table className="table small"><tbody>{d.refunds.map((r, i) => <tr key={i}><td>{r.full_name}</td><td>{r.method}</td><td>{r.paid_reference}</td><td>−{money(r.amount_paise, tenant)}</td></tr>)}</tbody></table></div>}
    </div>
  );
}
