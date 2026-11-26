import Link from 'next/link';
import { requireStaff } from '@/lib/session';
import { can } from '@/lib/rbac';
import * as ins from '@/domain/insurance';
import { fmtDate, label, money } from '@/lib/format';
import { Empty, Flash, PageHead } from '@/components/ui';
import { insuranceAction } from '../insurance-actions';

const TABS = [['claims', 'Claims'], ['preauth', 'Pre-authorisations'], ['aging', 'Payer ageing'], ['payers', 'Insurers & TPAs']] as const;

export default async function Insurance({ params, searchParams }: { params: Promise<{ tenant: string }>; searchParams: Promise<{ tab?: string; status?: string; ok?: string; err?: string }> }) {
  const { tenant: slug } = await params;
  const sp = await searchParams;
  const { tenant, actor, session } = await requireStaff(slug, 'billing.read');
  const tab = TABS.some(([k]) => k === sp.tab) ? sp.tab! : 'claims';
  const manage = can(session.role, 'claims.manage');
  return (
    <>
      <PageHead title="Insurance & corporate billing" sub="Raise claims from an invoice (Billing › invoice). The patient then owes only their share." />
      <Flash ok={sp.ok} err={sp.err} />
      <div className="tabs">{TABS.map(([k, l]) => <Link key={k} href={`/${slug}/insurance?tab=${k}`} className={k === tab ? 'on' : ''}>{l}</Link>)}</div>
      {tab === 'claims' && <Claims slug={slug} actor={actor} tenant={tenant} status={sp.status} />}
      {tab === 'preauth' && <Preauths slug={slug} actor={actor} tenant={tenant} />}
      {tab === 'aging' && <Aging actor={actor} tenant={tenant} />}
      {tab === 'payers' && <Payers slug={slug} actor={actor} tenant={tenant} manage={manage} />}
    </>
  );
}

type A = Parameters<typeof ins.listClaims>[0]; type T = Parameters<typeof ins.listClaims>[1];

async function Claims({ slug, actor, tenant, status }: { slug: string; actor: A; tenant: T; status?: string }) {
  const rows = await ins.listClaims(actor, tenant, { status: status || undefined });
  return (
    <div className="card">
      <form className="toolbar"><input type="hidden" name="tab" value="claims" /><select name="status" defaultValue={status ?? ''}><option value="">All</option>
        {['open', 'submitted', 'query', 'settled', 'closed'].map((s) => <option key={s} value={s}>{label(s)}</option>)}</select><button className="btn small">Filter</button></form>
      {rows.length === 0 ? <Empty>No claims.</Empty> : <table className="table small"><thead><tr><th>Claim</th><th>Patient</th><th>Payer</th><th>Invoice</th><th>Claimed</th><th>Open</th><th>Status</th><th>Age</th></tr></thead>
        <tbody>{rows.map((r) => <tr key={r.id}><td><Link href={`/${slug}/insurance/claims/${r.id}`}>{r.claim_number}</Link>{r.payer_claim_ref && <><br /><small>{r.payer_claim_ref}</small></>}</td>
          <td>{r.full_name}<br /><small>{r.uhid}</small></td><td>{r.payer_name}</td><td>{r.invoice_number}</td><td>{money(r.claimed_paise, tenant)}</td>
          <td>{Number(r.open_paise) ? money(r.open_paise, tenant) : '—'}</td><td>{label(r.status)}</td><td>{r.status === 'closed' ? '' : `${r.age_days} d`}</td></tr>)}</tbody></table>}
    </div>
  );
}

async function Preauths({ slug, actor, tenant }: { slug: string; actor: A; tenant: T }) {
  const rows = await ins.listPreauths(actor, tenant);
  return (
    <div className="card"><p className="small muted">Start a pre-authorisation from the patient’s chart (Insurance card).</p>
      {rows.length === 0 ? <Empty>None.</Empty> : <table className="table small"><thead><tr><th>Ref</th><th>Patient</th><th>Payer</th><th>Treatment</th><th>Estimate</th><th>Approved</th><th>Status</th><th>Date</th></tr></thead>
        <tbody>{rows.map((r) => <tr key={r.id}><td><Link href={`/${slug}/insurance/preauth/${r.id}`}>{r.ref_number}</Link>{r.payer_ref && <><br /><small>{r.payer_ref}</small></>}</td>
          <td>{r.full_name}<br /><small>{r.uhid}</small></td><td>{r.payer_name}</td><td>{r.treatment.slice(0, 60)}</td><td>{money(r.estimated_paise, tenant)}</td>
          <td>{r.approved_paise != null ? money(r.approved_paise, tenant) : '—'}</td><td>{label(r.status)}</td><td>{fmtDate(r.created_at, tenant)}</td></tr>)}</tbody></table>}
    </div>
  );
}

async function Aging({ actor, tenant }: { actor: A; tenant: T }) {
  const rows = await ins.payerAging(actor, tenant);
  return (
    <div className="card"><h2>Outstanding from payers</h2><p className="small muted">Days since submission (or since raised, if not yet submitted). Overdue = beyond the payer’s credit days.</p>
      {rows.length === 0 ? <Empty>Nothing outstanding.</Empty> : <table className="table small"><thead><tr><th>Payer</th><th>0–30</th><th>31–60</th><th>61–90</th><th>90+</th><th>Total</th><th>Overdue</th></tr></thead>
        <tbody>{rows.map((r) => <tr key={r.payer_id}><td>{r.payer_name}<br /><small>{r.credit_days} credit days</small></td><td>{money(r.b0, tenant)}</td><td>{money(r.b30, tenant)}</td><td>{money(r.b60, tenant)}</td>
          <td>{money(r.b90, tenant)}</td><td><b>{money(r.total, tenant)}</b></td><td className={Number(r.overdue) ? 'warn-text' : ''}>{money(r.overdue, tenant)}</td></tr>)}</tbody></table>}
    </div>
  );
}

async function Payers({ slug, actor, tenant, manage }: { slug: string; actor: A; tenant: T; manage: boolean }) {
  const rows = await ins.listPayers(actor, tenant);
  const back = `/${slug}/insurance?tab=payers`;
  return (
    <>
      <div className="card"><table className="table small"><thead><tr><th>Name</th><th>Type</th><th>Credit days</th><th>Usual TDS</th><th>Outstanding</th><th>Contact</th></tr></thead>
        <tbody>{rows.map((r) => <tr key={r.id} className={r.active ? '' : 'dim'}><td>{r.name}{r.code ? ` (${r.code})` : ''}</td><td>{label(r.kind)}</td><td>{r.credit_days}</td><td>{(r.tds_rate_bp / 100).toFixed(2)}%</td>
          <td>{money(r.outstanding, tenant)}</td><td>{[r.email, r.phone].filter(Boolean).join(' · ')}</td></tr>)}</tbody></table></div>
      {manage && <form action={insuranceAction.bind(null, slug)} className="card form-grid"><input type="hidden" name="op" value="payer" /><input type="hidden" name="back" value={back} />
        <h2 className="span2">Add insurer, TPA or corporate</h2>
        <label>Name<input name="name" required /></label>
        <label>Type<select name="kind"><option value="insurer">Insurer</option><option value="tpa">TPA</option><option value="corporate">Corporate / employer</option><option value="government">Government scheme</option></select></label>
        <label>Code<input name="code" /></label><label>Credit days<input type="number" name="creditDays" defaultValue={30} min={0} max={365} /></label>
        <label>Usual TDS deducted (%)<input name="tdsRate" defaultValue="0" inputMode="decimal" /></label><label>Email<input type="email" name="email" /></label>
        <label>Phone<input name="phone" /></label>
        <div className="span2"><button className="btn primary">Save</button> <small className="muted">The TDS rate only pre-fills settlements; confirm the applicable rate with your accountant.</small></div>
      </form>}
    </>
  );
}
