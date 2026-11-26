import Link from 'next/link';
import { requireStaff } from '@/lib/session';
import { can } from '@/lib/rbac';
import * as records from '@/domain/records';
import { fmtDateTime, label } from '@/lib/format';
import { Empty, Flash, PageHead } from '@/components/ui';
import { scannerConfigured, scannerFailOpen } from '@/lib/virus-scan';
import { mergeAction, refileAction, layoutAction } from '../records-actions';

const KIND_LABEL: Record<records.PrintKind, string> = { prescription: 'Prescription', receipt: 'Payment receipt', referral: 'Referral letter' };

export default async function RecordsDesk({ params, searchParams }: { params: Promise<{ tenant: string }>; searchParams: Promise<{ tab?: string; kind?: string; ok?: string; err?: string }> }) {
  const { tenant: slug } = await params;
  const sp = await searchParams;
  const { tenant, actor, session } = await requireStaff(slug, 'patient.read');
  const tab = ['refiles', 'layouts'].includes(sp.tab ?? '') ? sp.tab! : 'merges';
  const canMerge = can(session.role, 'patient.merge');
  const canLayout = can(session.role, 'settings.manage');
  const kind = (records.PRINT_KINDS as readonly string[]).includes(sp.kind ?? '') ? sp.kind as records.PrintKind : 'prescription';
  const merges = tab === 'merges' ? await records.listMerges(actor, tenant) : [];
  const refiles = tab === 'refiles' ? await records.listRefiles(actor, tenant) : [];
  const hist = tab === 'layouts' && canLayout ? await records.layoutHistory(actor, tenant, kind) : [];
  const cur = hist[0] ? { ...records.DEFAULT_LAYOUT, ...hist[0].layout } : records.DEFAULT_LAYOUT;
  const back = `/${slug}/records?tab=${tab}${tab === 'layouts' ? `&kind=${kind}` : ''}`;
  const me = session.staffId;
  const H = (n: string, v: string) => <input type="hidden" name={n} value={v} />;
  return (
    <>
      <PageHead title="Medical records desk" sub="Chart merges, misfiled documents and print layouts. Merges and moves need a second authorised person." />
      <Flash ok={sp.ok} err={sp.err} />
      <div className="tabs">
        <Link href={`/${slug}/records`} className={tab === 'merges' ? 'on' : ''}>Chart merges</Link>
        <Link href={`/${slug}/records?tab=refiles`} className={tab === 'refiles' ? 'on' : ''}>Misfiled documents</Link>
        {canLayout && <Link href={`/${slug}/records?tab=layouts`} className={tab === 'layouts' ? 'on' : ''}>Print layouts</Link>}
      </div>

      {tab === 'merges' && (
        <div className="card">
          <p className="small muted">Start a merge from the chart you want to keep (“Merge a duplicate into this chart”). Signed notes, prescriptions and bills keep their original record and are shown through the link; open appointments, queue tickets, unbilled charges, allergies and insurance policies move. Undo returns moved items that are still open.</p>
          {merges.length === 0 ? <Empty>No merges yet.</Empty> : (
            <table className="table small"><thead><tr><th>Retire</th><th>Keep</th><th>Evidence</th><th>Status</th><th /></tr></thead>
              <tbody>{merges.map((m) => (
                <tr key={m.id}>
                  <td><Link href={`/${slug}/patients/${m.source_id}`}>{m.source_name}</Link><br /><small>{m.source_uhid}</small></td>
                  <td><Link href={`/${slug}/patients/${m.survivor_id}`}>{m.survivor_name}</Link><br /><small>{m.survivor_uhid}</small></td>
                  <td>{m.reason}<br /><small className="muted">Asked by {m.requested_by_name ?? '—'}, {fmtDateTime(m.requested_at, tenant)}</small></td>
                  <td><span className={`pill ${m.status === 'done' ? 'ok' : m.status === 'pending' ? 'warn' : ''}`}>{label(m.status)}</span>
                    {m.approved_by_name && <><br /><small>by {m.approved_by_name}</small></>}
                    {m.undo_reason && <><br /><small>Undone: {m.undo_reason}</small></>}
                    {m.undo_left && Object.keys(m.undo_left).length > 0 && <><br /><small className="warn-text">Left on kept chart: {Object.entries(m.undo_left).map(([k, v]) => `${v.length} ${label(k)}`).join(', ')}</small></>}
                    {m.decision_note && <><br /><small>{m.decision_note}</small></>}</td>
                  <td>{canMerge && m.status === 'pending' && (m.requested_by === me
                    ? <form action={mergeAction.bind(null, slug)}>{H('op', 'cancel')}{H('id', m.id)}{H('back', back)}<button className="btn small">Withdraw</button></form>
                    : <><form action={mergeAction.bind(null, slug)}>{H('op', 'approve')}{H('id', m.id)}{H('back', back)}<button className="btn small primary">Approve merge</button></form>
                      <details><summary className="small">Reject</summary><form action={mergeAction.bind(null, slug)} className="inline-form">{H('op', 'reject')}{H('id', m.id)}{H('back', back)}<input name="note" required placeholder="Why" /><button className="btn small">Reject</button></form></details></>)}
                    {canMerge && m.status === 'done' && <details><summary className="small">Undo</summary><form action={mergeAction.bind(null, slug)} className="inline-form">{H('op', 'undo')}{H('id', m.id)}{H('back', back)}<input name="reason" required minLength={5} placeholder="Why these are different people" /><button className="btn small">Undo merge</button></form></details>}</td>
                </tr>))}</tbody></table>)}
        </div>)}

      {tab === 'refiles' && (
        <div className="card">
          <p className="small muted">Start from the document on the patient chart (“Move to another chart”). Results and discharge papers are corrected at their order or admission instead.</p>
          {refiles.length === 0 ? <Empty>No re-filing requests.</Empty> : (
            <table className="table small"><thead><tr><th>Document</th><th>From</th><th>To</th><th>Reason</th><th>Status</th><th /></tr></thead>
              <tbody>{refiles.map((r) => (
                <tr key={r.id}><td>{r.title}</td>
                  <td><Link href={`/${slug}/patients/${r.from_patient_id}`}>{r.from_name}</Link><br /><small>{r.from_uhid}</small></td>
                  <td><Link href={`/${slug}/patients/${r.to_patient_id}`}>{r.to_name}</Link><br /><small>{r.to_uhid}</small></td>
                  <td>{r.reason}<br /><small className="muted">{r.requested_by_name}, {fmtDateTime(r.requested_at, tenant)}</small></td>
                  <td><span className={`pill ${r.status === 'done' ? 'ok' : r.status === 'pending' ? 'warn' : ''}`}>{label(r.status)}</span>{r.decided_by_name && <><br /><small>by {r.decided_by_name}</small></>}{r.decision_note && <><br /><small>{r.decision_note}</small></>}</td>
                  <td>{canMerge && r.status === 'pending' && (r.requested_by === me
                    ? <form action={refileAction.bind(null, slug)}>{H('op', 'cancel')}{H('id', r.id)}{H('back', back)}<button className="btn small">Withdraw</button></form>
                    : <><form action={refileAction.bind(null, slug)}>{H('op', 'approve')}{H('id', r.id)}{H('back', back)}<button className="btn small primary">Approve move</button></form>
                      <details><summary className="small">Reject</summary><form action={refileAction.bind(null, slug)} className="inline-form">{H('op', 'reject')}{H('id', r.id)}{H('back', back)}<input name="note" required placeholder="Why" /><button className="btn small">Reject</button></form></details></>)}</td></tr>))}</tbody></table>)}
          <p className="small muted">Virus scanning: {scannerConfigured() ? `on (ClamAV${scannerFailOpen() ? '; files are accepted and flagged if the scanner is down' : '; uploads are refused if the scanner is down'})` : 'off — set CLAMAV_HOST to enable'}.</p>
        </div>)}

      {tab === 'layouts' && canLayout && (
        <>
          <div className="tabs sub">{records.PRINT_KINDS.map((k) => <Link key={k} href={`/${slug}/records?tab=layouts&kind=${k}`} className={kind === k ? 'on' : ''}>{KIND_LABEL[k]}</Link>)}</div>
          <form action={layoutAction.bind(null, slug)} className="card form-grid">
            {H('kind', kind)}{H('back', back)}
            <h2 className="span2">{KIND_LABEL[kind]} layout {hist[0] ? `(current: v${hist[0].version})` : '(default)'}</h2>
            <label>Paper<select name="paper" defaultValue={cur.paper}><option>A4</option><option>A5</option></select></label>
            <label>Page margin (mm)<input name="marginMm" type="number" min={5} max={30} defaultValue={cur.marginMm} /></label>
            <label>Pre-printed letterhead: blank space at top (mm)<input name="preprintedTopMm" type="number" min={0} max={80} defaultValue={cur.preprintedTopMm} /></label>
            <label>Blank space at bottom (mm)<input name="preprintedBottomMm" type="number" min={0} max={60} defaultValue={cur.preprintedBottomMm} /></label>
            <label className="check"><input type="checkbox" name="showHeader" defaultChecked={cur.showHeader} /> Print the clinic header (turn off for pre-printed stationery)</label>
            <label className="check"><input type="checkbox" name="showLogo" defaultChecked={cur.showLogo} /> Show logo</label>
            <label>Header alignment<select name="headerAlign" defaultValue={cur.headerAlign}><option value="left">Left</option><option value="center">Centre</option></select></label>
            <label>Accent colour<input name="accent" type="color" defaultValue={cur.accent} /></label>
            <label>Text size<select name="fontScale" defaultValue={String(cur.fontScale)}><option value="0.9">Smaller</option><option value="1">Normal</option><option value="1.1">Larger</option></select></label>
            <label>Signature label (blank for none)<input name="signatureLabel" defaultValue={cur.signatureLabel} placeholder="Doctor's signature & stamp" /></label>
            <label className="span2">Extra header lines (one per line, up to 4)<textarea name="extraHeaderLines" rows={3} defaultValue={cur.extraHeaderLines.join('\n')} placeholder="Timings: Mon–Sat 9 am – 1 pm" /></label>
            <label className="span2">Footer text<textarea name="footerText" rows={2} defaultValue={cur.footerText} /></label>
            <label className="span2">Change note<input name="note" placeholder="What changed" /></label>
            <p className="span2 small muted">Each save is a new version. Prescriptions remember the layout they were signed with, so reprints match the original.</p>
            <div className="span2"><button className="btn primary">Save new version</button></div>
          </form>
          <div className="card"><h2>History</h2>{hist.length === 0 ? <Empty>Using the default layout.</Empty> : (
            <table className="table small"><tbody>{hist.map((h, i) => (
              <tr key={h.version}><td>v{h.version}{i === 0 ? <span className="pill ok">current</span> : null}</td><td>{h.note ?? ''}</td><td>{h.by ?? ''}<br /><small>{fmtDateTime(h.created_at, tenant)}</small></td>
                <td>{i > 0 && <form action={layoutAction.bind(null, slug)}>{H('op', 'restore')}{H('kind', kind)}{H('version', String(h.version))}{H('back', back)}<button className="btn small">Restore</button></form>}</td></tr>))}</tbody></table>)}</div>
        </>)}
    </>
  );
}
