import Link from 'next/link';
import { requireStaff } from '@/lib/session';
import { withTenant } from '@/lib/db';
import { can } from '@/lib/rbac';
import * as fin from '@/domain/finance';
import { listCatalog } from '@/domain/catalog';
import { fmtDate, fmtDateTime, money, today } from '@/lib/format';
import { Empty, Flash, PageHead } from '@/components/ui';
import { periodAction } from '../finance-actions';

const TABS = [['close', 'Month close'], ['export', 'Export to accounts'], ['mapping', 'Ledger mapping'], ['prices', 'Price changes']] as const;

export default async function Accounts({ params, searchParams }: { params: Promise<{ tenant: string }>; searchParams: Promise<{ tab?: string; month?: string; ok?: string; err?: string }> }) {
  const { tenant: slug } = await params;
  const sp = await searchParams;
  const { tenant, actor, session } = await requireStaff(slug, 'finance.close');
  const tab = TABS.some(([k]) => k === sp.tab) ? sp.tab! : 'close';
  const t = today(tenant);
  const lastMonth = new Date(new Date(`${t.slice(0, 7)}-01T00:00:00Z`).getTime() - 86400_000).toISOString().slice(0, 7);
  const month = /^\d{4}-\d{2}$/.test(sp.month ?? '') ? sp.month! : lastMonth;
  const back = `/${slug}/accounts?tab=${tab}&month=${month}`;
  return (
    <>
      <PageHead title="Accounts" sub="Month close, export to your accounting package, and scheduled price changes" />
      <Flash ok={sp.ok} err={sp.err} />
      <div className="tabs">{TABS.map(([k, l]) => <Link key={k} href={`/${slug}/accounts?tab=${k}`} className={k === tab ? 'on' : ''}>{l}</Link>)}</div>
      {tab === 'close' && <CloseTab slug={slug} actor={actor} tenant={tenant} month={month} back={back} isOwner={session.role === 'owner'} />}
      {tab === 'export' && (
        <div className="card">
          <h2>Export journals</h2>
          <p className="small muted">Every posting (invoices, receipts, advances applied, refunds, voids, drawer variances) as balanced vouchers. Import the ledger masters into Tally once, then the vouchers for each period. Try the first import on a copy of your Tally company.</p>
          <form action={`/${slug}/accounts-export`} method="get" className="inline-form wrap">
            <label>From<input type="date" name="from" defaultValue={`${lastMonth}-01`} required /></label>
            <label>To<input type="date" name="to" defaultValue={t} required /></label>
            <label>Tally company name (optional)<input name="company" /></label>
            <button className="btn primary" name="format" value="tally">Tally XML</button>
            <button className="btn" name="format" value="csv">CSV (Excel / Zoho / QuickBooks)</button>
          </form>
          <p><a className="btn small" href={`/${slug}/accounts-export?format=ledgers`}>Download ledger masters (Tally XML)</a></p>
        </div>)}
      {tab === 'mapping' && <MappingTab slug={slug} actor={actor} tenant={tenant} back={back} />}
      {tab === 'prices' && (can(session.role, 'settings.manage') ? <PricesTab slug={slug} actor={actor} tenant={tenant} back={back} /> : <Empty>Needs the settings permission.</Empty>)}
    </>
  );
}

async function CloseTab({ slug, actor, tenant, month, back, isOwner }: { slug: string; actor: Parameters<typeof fin.listPeriods>[0]; tenant: Parameters<typeof fin.listPeriods>[1]; month: string; back: string; isOwner: boolean }) {
  const periods = await fin.listPeriods(actor, tenant);
  const sum = await withTenant(tenant.id, (tx) => fin.periodSummary(tx, `${month}-01`));
  const state = periods.find((p) => p.period_start.startsWith(month));
  const tb = sum.trialBalance.filter((r) => Number(r.debit) || Number(r.credit));
  return (
    <>
      <form className="card toolbar"><input type="hidden" name="tab" value="close" /><label>Month<input type="month" name="month" defaultValue={month} /></label><button className="btn">Show</button></form>
      <div className="stats">
        <div className="stat"><b>{sum.invoices.n}</b><span>Invoices posted</span></div>
        <div className="stat"><b>{money(sum.invoices.total, tenant)}</b><span>Invoiced (incl. tax)</span></div>
        <div className="stat"><b>{money(sum.invoices.tax, tenant)}</b><span>Tax on invoices</span></div>
        <div className="stat"><b>{money(sum.refunds.amount, tenant)}</b><span>Refunds paid ({sum.refunds.n})</span></div>
      </div>
      <div className="grid2">
        <div className="card"><h2>Tax by rate</h2>{sum.taxByRate.length === 0 ? <Empty>No invoices.</Empty> : <table className="table small"><thead><tr><th>Rate</th><th>Taxable value</th><th>Tax</th></tr></thead>
          <tbody>{sum.taxByRate.map((r) => <tr key={r.rate_bp}><td>{(r.rate_bp / 100).toFixed(2)}%</td><td>{money(r.taxable, tenant)}</td><td>{money(r.tax, tenant)}</td></tr>)}</tbody></table>}
          <p className="small muted">Healthcare services are generally GST-exempt; taxable lines (e.g. some pharmacy sales) appear here. Confirm treatment with your accountant.</p></div>
        <div className="card"><h2>Receipts by mode</h2>{sum.receiptsByTender.length === 0 ? <Empty>None.</Empty> : <table className="table small"><tbody>{sum.receiptsByTender.map((r) => <tr key={r.method}><td>{r.method}</td><td>{r.n}</td><td>{money(r.amount, tenant)}</td></tr>)}</tbody></table>}</div>
      </div>
      <div className="card"><h2>Trial balance — movements in {month}</h2>
        <table className="table small"><thead><tr><th>Code</th><th>Account</th><th>Debit</th><th>Credit</th></tr></thead>
          <tbody>{tb.map((r) => <tr key={r.code}><td>{r.code}</td><td>{r.name}</td><td>{money(r.debit, tenant)}</td><td>{money(r.credit, tenant)}</td></tr>)}</tbody>
          <tfoot><tr><th /><th>Total</th><th>{money(tb.reduce((s, r) => s + Number(r.debit), 0), tenant)}</th><th>{money(tb.reduce((s, r) => s + Number(r.credit), 0), tenant)}</th></tr></tfoot></table></div>
      <div className="card">
        <h2>Status: {state?.status === 'closed' ? `Closed ${fmtDateTime(state.closed_at, tenant)} by ${state.closer}` : state?.status === 'reopened' ? `Reopened (${state.reopen_reason})` : 'Open'}</h2>
        {sum.openDrawers > 0 && <p className="flash warn">{sum.openDrawers} cash drawer(s) from this month are still open or awaiting approval.</p>}
        {state?.status !== 'closed' ? (
          <form action={periodAction.bind(null, slug)}><input type="hidden" name="op" value="close" /><input type="hidden" name="month" value={month} /><input type="hidden" name="back" value={back} />
            <p className="small">Closing freezes this month: no posting can be dated inside it and its invoices can no longer be voided. The figures above are stored with the close as tax evidence.</p>
            <button className="btn primary">Close {month}</button></form>
        ) : isOwner ? (
          <form action={periodAction.bind(null, slug)} className="inline-form"><input type="hidden" name="op" value="reopen" /><input type="hidden" name="month" value={month} /><input type="hidden" name="back" value={back} />
            <input name="reason" placeholder="Why reopen? (min 10 characters, audited)" required minLength={10} size={40} /><button className="btn danger">Reopen month</button></form>
        ) : <p className="small muted">Only the clinic owner can reopen a closed month.</p>}
      </div>
      {periods.length > 0 && <div className="card"><h2>History</h2><table className="table small"><tbody>{periods.map((p) => <tr key={p.period_start}><td>{p.period_start.slice(0, 7)}</td><td>{p.status}</td><td>{fmtDate(p.closed_at, tenant)}</td><td>{p.closer}</td><td>{p.reopen_reason}</td></tr>)}</tbody></table></div>}
    </>
  );
}

async function MappingTab({ slug, actor, tenant, back }: { slug: string; actor: Parameters<typeof fin.accountMap>[0]; tenant: Parameters<typeof fin.accountMap>[1]; back: string }) {
  const rows = await fin.accountMap(actor, tenant);
  return (
    <>
      <form action={periodAction.bind(null, slug)} className="card"><input type="hidden" name="op" value="mapping" /><input type="hidden" name="back" value={back} />
        <h2>How each account appears in Tally</h2>
        <p className="small muted">Leave blank to use Clinic Core’s name. Group is the Tally parent group used when you import the ledger masters (e.g. Cash-in-Hand, Bank Accounts, Sundry Debtors, Duties &amp; Taxes, Direct Incomes).</p>
        <table className="table small"><thead><tr><th>Code</th><th>Clinic Core account</th><th>Tally ledger name</th><th>Tally group</th></tr></thead>
          <tbody>{rows.map((r) => <tr key={r.id}><td>{r.code}<input type="hidden" name="id" value={r.id} /></td><td>{r.name}</td>
            <td><input name={`name_${r.id}`} defaultValue={r.external_name ?? ''} placeholder={r.name} /></td>
            <td><input name={`group_${r.id}`} defaultValue={r.external_group ?? ''} placeholder={fin.DEFAULT_GROUP[r.type]} /></td></tr>)}</tbody></table>
        <button className="btn primary">Save mapping</button>
      </form>
      <form action={periodAction.bind(null, slug)} className="card inline-form"><input type="hidden" name="op" value="threshold" /><input type="hidden" name="back" value={back} />
        <label>Cash drawer variance needing a second person’s approval (₹)<input name="threshold" defaultValue={(tenant.settings.drawerVarianceApprovalPaise / 100).toFixed(2)} /></label>
        <button className="btn">Save</button></form>
    </>
  );
}

async function PricesTab({ slug, actor, tenant, back }: { slug: string; actor: Parameters<typeof fin.priceSchedule>[0]; tenant: Parameters<typeof fin.priceSchedule>[1]; back: string }) {
  const rows = await fin.priceSchedule(actor, tenant);
  const cat = await listCatalog(tenant.id);
  return (
    <>
      <div className="card"><h2>Scheduled and current price periods</h2>
        <p className="small muted">A scheduled price applies to visits dated inside its period; outside any period the service’s base price (Settings › Services) applies. Bookings made earlier keep the price quoted for their visit date.</p>
        {rows.length === 0 ? <Empty>No price changes scheduled.</Empty> : <table className="table small"><thead><tr><th>Service</th><th>Price</th><th>From</th><th>Until</th><th>Reason</th><th /></tr></thead>
          <tbody>{rows.map((r) => <tr key={r.id}><td>{r.service_name}</td><td>{money(r.price_paise, tenant)}{r.current ? <span className="pill ok">Now</span> : null}</td><td>{r.from}</td><td>{r.to ?? 'open-ended'}</td><td>{r.reason}</td>
            <td>{r.from > today(tenant) && <form action={periodAction.bind(null, slug)}><input type="hidden" name="op" value="unprice" /><input type="hidden" name="id" value={r.id} /><input type="hidden" name="back" value={back} /><button className="btn small">Remove</button></form>}</td></tr>)}</tbody></table>}
      </div>
      <form action={periodAction.bind(null, slug)} className="card form-grid"><input type="hidden" name="op" value="price" /><input type="hidden" name="back" value={back} />
        <h2 className="span2">Schedule a price change</h2>
        <label>Service<select name="serviceId" required>{cat.services.filter((s) => s.active).map((s) => <option key={s.id} value={s.id}>{s.name} (base {money(s.price_paise, tenant)})</option>)}</select></label>
        <label>New price (₹)<input name="price" required inputMode="decimal" /></label>
        <label>From<input type="date" name="from" min={today(tenant)} required /></label>
        <label>Until (optional)<input type="date" name="to" /></label>
        <label className="span2">Reason<input name="reason" required minLength={3} placeholder="e.g. Annual revision April 2027" /></label>
        <div className="span2"><button className="btn primary">Schedule</button></div>
      </form>
    </>
  );
}
