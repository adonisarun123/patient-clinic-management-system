import { requireStaff } from '@/lib/session';
import { summary, auditLog } from '@/domain/reports';
import { can } from '@/lib/rbac';
import { fmtDateTime, label, money, today } from '@/lib/format';
import { PageHead } from '@/components/ui';

export default async function Reports({ params, searchParams }: { params: Promise<{ tenant: string }>; searchParams: Promise<{ from?: string; to?: string; audit?: string }> }) {
  const { tenant: slug } = await params;
  const sp = await searchParams;
  const { tenant, actor, session } = await requireStaff(slug, 'reports.read');
  const t = today(tenant);
  const from = sp.from ?? `${t.slice(0, 7)}-01`; const to = sp.to ?? t;
  const r = await summary(actor, tenant, from, to);
  const audit = sp.audit && can(session.role, 'audit.read') ? await auditLog(actor, tenant, { limit: 200 }) : [];
  const m = (v: number) => money(v, tenant);
  return (
    <>
      <PageHead title="Reports" sub="Revenue by business date in the clinic’s time zone. Earned = posted invoices (net of discount, before tax), excluding voided.">
        <form className="toolbar"><input type="date" name="from" defaultValue={from} /><input type="date" name="to" defaultValue={to} /><button className="btn">Apply</button></form>
      </PageHead>
      {!r.ledgerBalanced && <p className="flash err">Ledger check failed: debits and credits do not match. Contact support before closing the period.</p>}
      <div className="stats">
        <div className="stat"><b>{m(r.earnedNetPaise)}</b><span>Earned (net)</span></div>
        <div className="stat"><b>{m(r.collectedPaise)}</b><span>Collected</span></div>
        <div className="stat"><b>{m(r.refundsPaidPaise)}</b><span>Refunds paid ({r.refundsPaidCount})</span></div>
        <div className="stat"><b>{m(r.outstandingPaise)}</b><span>Outstanding now ({r.outstandingInvoices})</span></div>
        <div className="stat"><b>{m(r.advancesHeldPaise)}</b><span>Advances held</span></div>
        <div className="stat"><b>{m(r.discountPaise)}</b><span>Discounts given</span></div>
      </div>
      <div className="grid2">
        <div className="card"><h2>Activity</h2><table className="table small"><tbody>
          <tr><td>Appointments booked for period</td><td>{r.bookedTotal}</td></tr>
          {r.appointments.map((a) => <tr key={a.state}><td>· {label(a.state)}</td><td>{a.n}</td></tr>)}
          <tr><td>No-show rate</td><td>{(r.noShowRate * 100).toFixed(1)}%</td></tr>
          <tr><td>Walk-ins</td><td>{r.walkIns}</td></tr><tr><td>New patients</td><td>{r.newPatients}</td></tr><tr><td>Completed visits</td><td>{r.completedEncounters}</td></tr>
        </tbody></table></div>
        <div className="card"><h2>Collections by mode</h2><table className="table small"><tbody>
          {r.collected.map((c) => <tr key={c.method}><td>{label(c.method)}</td><td>{c.receipts} receipts</td><td>{m(c.amount_paise)}</td></tr>)}</tbody></table></div>
      </div>
      <div className="grid2">
        <div className="card"><h2>Earned by department</h2><table className="table small"><tbody>{r.earnedByDept.map((d) => <tr key={d.department}><td>{d.department}</td><td>{m(d.net_paise)}</td></tr>)}</tbody></table></div>
        <div className="card"><h2>Earned by doctor</h2><table className="table small"><tbody>{r.earnedByClinician.map((d) => <tr key={d.clinician}><td>{d.clinician}</td><td>{d.visits} invoices</td><td>{m(d.net_paise)}</td></tr>)}</tbody></table></div>
      </div>
      <details className="card"><summary><b>Trial balance (to {to})</b> {r.ledgerBalanced ? '— balanced ✓' : '— NOT balanced'}</summary>
        <table className="table small"><thead><tr><th>Account</th><th>Debit</th><th>Credit</th></tr></thead><tbody>{r.trial.map((a) => <tr key={a.code}><td>{a.code} {a.name}</td><td>{m(a.debit)}</td><td>{m(a.credit)}</td></tr>)}</tbody></table></details>
      {can(session.role, 'audit.read') && (
        <div className="card"><h2>Audit trail</h2>{!sp.audit ? <a href={`?from=${from}&to=${to}&audit=1`}>Show latest 200 events</a> : (
          <table className="table small"><thead><tr><th>When</th><th>Who</th><th>Action</th><th>Record</th><th>Reason</th></tr></thead>
            <tbody>{audit.map((a, i) => <tr key={i}><td>{fmtDateTime(a.at, tenant)}</td><td>{a.actor_name ?? a.actor_kind}{a.actor_role ? ` (${a.actor_role})` : ''}</td><td>{a.action}</td><td>{a.entity_kind}</td><td>{a.reason}</td></tr>)}</tbody></table>)}</div>)}
    </>
  );
}
