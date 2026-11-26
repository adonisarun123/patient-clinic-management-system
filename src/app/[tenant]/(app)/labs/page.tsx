import Link from 'next/link';
import { requireStaff } from '@/lib/session';
import { requireModule } from '@/domain/tenants';
import { listTests, worklists, type OrderView } from '@/domain/labs';
import { can } from '@/lib/rbac';
import { fmtDateTime, label, money } from '@/lib/format';
import { Badge, Empty, Flash, PageHead } from '@/components/ui';
import { labTestAction } from '../module-actions';

function Rows({ rows, slug, tenant, extra }: { rows: OrderView[]; slug: string; tenant: Parameters<typeof fmtDateTime>[1]; extra?: (o: OrderView) => React.ReactNode }) {
  if (!rows.length) return <Empty>Nothing here.</Empty>;
  return (
    <table className="table"><thead><tr><th>Accession</th><th>Patient</th><th>Test</th><th>Priority</th><th>Ordered</th><th>Status</th><th /></tr></thead>
      <tbody>{rows.map((o) => (
        <tr key={o.id} className={o.priority === 'stat' || o.latest_critical ? 'urgent' : ''}>
          <td><Link href={`/${slug}/labs/${o.id}`}>{o.accession_no}</Link></td>
          <td>{o.full_name}<br /><small className="muted">{o.uhid}</small></td>
          <td>{o.test_name}<br /><small className="muted">{o.kind}{o.destination === 'external' ? ` · ${o.external_lab}` : ''}</small></td>
          <td>{o.priority === 'routine' ? 'Routine' : <span className="pill danger">{o.priority.toUpperCase()}</span>}</td>
          <td>{fmtDateTime(o.created_at, tenant)}<br /><small className="muted">{o.clinician_name}</small></td>
          <td><Badge v={o.status} />{o.latest_flag && o.latest_flag !== 'none' && o.latest_flag !== 'normal' ? <> <span className={`pill ${o.latest_critical ? 'danger' : 'warn'}`}>{label(o.latest_flag)}</span></> : null}</td>
          <td>{extra?.(o)}</td>
        </tr>))}</tbody></table>
  );
}

export default async function Labs({ params, searchParams }: { params: Promise<{ tenant: string }>; searchParams: Promise<{ tab?: string; edit?: string; ok?: string; err?: string }> }) {
  const { tenant: slug } = await params;
  const sp = await searchParams;
  const { tenant, actor, session } = await requireStaff(slug, 'schedule.read');
  requireModule(tenant, 'labs');
  const w = await worklists(actor, tenant);
  const tab = sp.tab ?? (session.clinicianId ? 'inbox' : 'bench');
  const tests = tab === 'catalogue' ? await listTests(tenant.id) : [];
  const edit = tests.find((t) => t.id === sp.edit);
  return (
    <>
      <PageHead title="Lab & imaging" sub="Orders are placed from the consultation screen. Results are acknowledged per version." />
      <Flash ok={sp.ok} err={sp.err} />
      {w.criticalOpen.length > 0 && (
        <div className="card warnbox"><h2>Critical results not yet acknowledged ({w.criticalOpen.length})</h2>
          <p className="small">Follow your clinic’s critical-results procedure: if the ordering doctor cannot be reached, escalate to the doctor on duty and record the call.</p>
          <ul className="list">{w.criticalOpen.map((o) => <li key={o.id}><Link href={`/${slug}/labs/${o.id}`}><b>{o.full_name}</b> — {o.test_name}</Link> · {o.clinician_name} · open {o.minutes_open} min</li>)}</ul></div>)}
      <nav className="tabs">
        {session.clinicianId && <Link href="?tab=inbox" className={tab === 'inbox' ? 'on' : ''}>My results to review ({w.inbox.length})</Link>}
        <Link href="?tab=bench" className={tab === 'bench' ? 'on' : ''}>To collect ({w.toCollect.length})</Link>
        <Link href="?tab=result" className={tab === 'result' ? 'on' : ''}>Awaiting result ({w.toResult.length})</Link>
        {can(session.role, 'settings.manage') && <Link href="?tab=catalogue" className={tab === 'catalogue' ? 'on' : ''}>Test catalogue</Link>}
      </nav>
      {tab === 'inbox' && <div className="card"><Rows rows={w.inbox} slug={slug} tenant={tenant} /></div>}
      {tab === 'bench' && <div className="card"><Rows rows={w.toCollect} slug={slug} tenant={tenant} /></div>}
      {tab === 'result' && <div className="card"><Rows rows={w.toResult} slug={slug} tenant={tenant} /></div>}
      {tab === 'catalogue' && (
        <>
          <div className="card"><table className="table small"><thead><tr><th>Code</th><th>Test</th><th>Type</th><th>Unit</th><th>Reference</th><th>Critical</th><th>Price</th><th /></tr></thead>
            <tbody>{tests.map((t) => <tr key={t.id} className={t.active ? '' : 'dim'}><td>{t.code}</td><td>{t.name}</td><td>{t.kind}</td><td>{t.unit}</td>
              <td>{t.ref_text ?? (t.ref_low != null || t.ref_high != null ? `${t.ref_low ?? ''}–${t.ref_high ?? ''}` : '')}</td>
              <td>{t.critical_low != null || t.critical_high != null ? `<${t.critical_low ?? '–'} / >${t.critical_high ?? '–'}` : ''}</td><td>{money(t.price_paise, tenant)}</td>
              <td><Link href={`?tab=catalogue&edit=${t.id}`}>Edit</Link></td></tr>)}</tbody></table></div>
          <form action={labTestAction.bind(null, slug)} className="card form-grid">
            <h2 className="span2">{edit ? `Edit ${edit.name}` : 'Add test'}</h2>
            {edit && <input type="hidden" name="id" value={edit.id} />}
            <label>Code<input name="code" defaultValue={edit?.code} required /></label>
            <label>Name<input name="name" defaultValue={edit?.name} required /></label>
            <label>Type<select name="kind" defaultValue={edit?.kind ?? 'lab'}><option value="lab">Laboratory</option><option value="imaging">Imaging</option><option value="procedure">Procedure</option></select></label>
            <label>Specimen<input name="specimen" defaultValue={edit?.specimen ?? ''} placeholder="Serum, EDTA blood…" /></label>
            <label>Unit<input name="unit" defaultValue={edit?.unit ?? ''} /></label>
            <label>Reference text (if not numeric)<input name="refText" defaultValue={edit?.ref_text ?? ''} /></label>
            <label>Reference low<input name="refLow" inputMode="decimal" defaultValue={edit?.ref_low ?? ''} /></label>
            <label>Reference high<input name="refHigh" inputMode="decimal" defaultValue={edit?.ref_high ?? ''} /></label>
            <label>Critical low<input name="criticalLow" inputMode="decimal" defaultValue={edit?.critical_low ?? ''} /></label>
            <label>Critical high<input name="criticalHigh" inputMode="decimal" defaultValue={edit?.critical_high ?? ''} /></label>
            <label>Price ({tenant.currency})<input name="price" inputMode="decimal" defaultValue={edit ? (edit.price_paise / 100).toFixed(2) : ''} /></label>
            {edit && <label>Status<select name="active" defaultValue={edit.active ? 'on' : 'off'}><option value="on">Active</option><option value="off">Retired</option></select></label>}
            <p className="span2 small muted">Reference and critical limits must come from your laboratory’s validated ranges. They drive automatic flags.</p>
            <div className="span2"><button className="btn primary">Save test</button></div>
          </form>
        </>)}
    </>
  );
}
