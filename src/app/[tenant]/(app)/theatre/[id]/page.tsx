import Link from 'next/link';
import { requireStaff } from '@/lib/session';
import { can } from '@/lib/rbac';
import * as ot from '@/domain/theatre';
import { fmtDateTime, fmtTime, isoToLocalInput, label } from '@/lib/format';
import { Empty, Flash, PageHead } from '@/components/ui';
import { theatreAction } from '../../theatre-actions';

const ANSWER: Record<string, string> = { yes: 'Yes', no: 'No', na: 'Not applicable', correct: 'Correct', incorrect: 'Incorrect', none: 'None' };

export default async function CasePage({ params, searchParams }: { params: Promise<{ tenant: string; id: string }>; searchParams: Promise<{ ok?: string; err?: string }> }) {
  const { tenant: slug, id } = await params;
  const sp = await searchParams;
  const { tenant, actor, session } = await requireStaff(slug, 'clinical.read');
  const { c, checklist, note, items } = await ot.caseDetail(actor, tenant, id);
  const here = `/${slug}/theatre/${id}`;
  const canCheck = can(session.role, 'theatre.checklist');
  const canBook = can(session.role, 'theatre.schedule');
  const stock = canCheck && ['scheduled', 'in_theatre'].includes(c.status) ? await ot.theatreStock(actor, tenant) : [];
  const done = new Set(checklist.map((k) => k.phase));
  const next = (['sign_in', 'time_out', 'sign_out'] as ot.Phase[]).find((p) => !done.has(p));
  const open = ['scheduled', 'in_theatre'].includes(c.status);
  const n = note?.content;
  const H = (k: string, v: string) => <input type="hidden" name={k} value={v} />;
  const base = <>{H('caseId', id)}{H('back', here)}</>;
  const noteEditable = c.status !== 'scheduled' && c.status !== 'cancelled' && note?.status !== 'signed' && can(session.role, 'clinical.write');
  return (
    <>
      <PageHead title={`${c.case_no} · ${c.procedure_name}${c.laterality !== 'na' ? ` (${label(c.laterality)})` : ''}`}
        sub={`${c.full_name} · ${c.uhid} · ${c.theatre_code} · ${fmtDateTime(c.planned_start, tenant)}–${fmtTime(c.planned_end, tenant)} · ${label(c.status)}`}>
        <Link className="btn" href={`/${slug}/patients/${c.patient_id}`}>Chart</Link><Link className="btn" href={`/${slug}/theatre?date=${new Date(c.planned_start).toLocaleDateString('en-CA', { timeZone: tenant.timezone })}`}>Theatre list</Link>
      </PageHead>
      <Flash ok={sp.ok} err={sp.err} />
      <div className="grid2">
        <div className="card"><h2>Case</h2>
          <p>Surgeon <b>{c.surgeon}</b>{c.anaesthetist ? <> · Anaesthetist <b>{c.anaesthetist}</b></> : null} · {label(c.anaesthesia)} · {label(c.priority)}</p>
          {c.admission_no && <p>Admission {c.admission_no}</p>}{c.service_name && <p>Fee: {c.service_name}</p>}{c.notes && <p className="small">{c.notes}</p>}
          {c.cancel_reason && <p className="warn-text">Cancelled: {c.cancel_reason}</p>}
          <table className="table small"><tbody>
            <tr><td>In theatre</td><td>{c.wheels_in_at ? fmtDateTime(c.wheels_in_at, tenant) : '—'}</td></tr>
            <tr><td>Incision</td><td>{c.incision_at ? fmtDateTime(c.incision_at, tenant) : '—'}</td></tr>
            <tr><td>Closure</td><td>{c.closure_at ? fmtDateTime(c.closure_at, tenant) : '—'}</td></tr>
            <tr><td>Out of theatre</td><td>{c.wheels_out_at ? fmtDateTime(c.wheels_out_at, tenant) : '—'}</td></tr></tbody></table>
          {canCheck && c.status === 'in_theatre' && (
            <form action={theatreAction.bind(null, slug)} className="inline-form wrap">{base}{H('op', 'time')}
              <select name="which">{!c.incision_at && <option value="incision">Incision</option>}{c.incision_at && !c.closure_at && <option value="closure">Closure</option>}{done.has('sign_out') && <option value="wheels_out">Out of theatre</option>}</select>
              <input type="datetime-local" name="at" defaultValue={isoToLocalInput(new Date(), tenant.timezone)} title="Leave as now, or correct the time" /><button className="btn small">Record time</button></form>)}
          {canCheck && c.status === 'in_theatre' && c.wheels_out_at && (
            <form action={theatreAction.bind(null, slug)}>{base}{H('op', 'complete')}<button className="btn primary">Complete case &amp; add charges</button></form>)}
          {canBook && c.status === 'scheduled' && (
            <details><summary className="small">Move or cancel</summary>
              <form action={theatreAction.bind(null, slug)} className="inline-form wrap">{base}{H('op', 'reschedule')}
                <input type="datetime-local" name="start" required defaultValue={isoToLocalInput(c.planned_start, tenant.timezone)} />
                <input type="number" name="duration" min={10} max={960} defaultValue={Math.round((new Date(c.planned_end).getTime() - new Date(c.planned_start).getTime()) / 60000)} />
                <input name="reason" required placeholder="Reason" /><button className="btn small">Move</button></form>
              <form action={theatreAction.bind(null, slug)} className="inline-form">{base}{H('op', 'cancel')}<input name="reason" required placeholder="Reason for cancelling" /><button className="btn small">Cancel case</button></form>
            </details>)}
        </div>

        <div className="card"><h2>WHO Surgical Safety Checklist</h2>
          {checklist.length === 0 && <p className="small muted">Not started.</p>}
          {checklist.map((k) => (
            <details key={k.phase} className="note signed"><summary><b>{ot.CHECKLIST[k.phase].title}</b> · {k.by} · {fmtTime(k.completed_at, tenant)}</summary>
              <ul className="small">{ot.CHECKLIST[k.phase].items.map((it) => <li key={it.key}>{it.text}: <b>{ANSWER[k.answers[it.key]] ?? k.answers[it.key]}</b></li>)}</ul>
              {k.team && <p className="small">Team: {k.team}</p>}{k.concerns && <p className="small warn-text">{k.concerns}</p>}</details>))}
          {canCheck && open && next && (next !== 'sign_out' || c.closure_at) && (
            <form action={theatreAction.bind(null, slug)} className="checklist">{base}{H('op', 'checklist')}{H('phase', next)}
              <h3>{ot.CHECKLIST[next].title} <small className="muted">— {ot.CHECKLIST[next].when}</small></h3>
              {ot.CHECKLIST[next].items.map((it) => (
                <fieldset key={it.key} className="inline-form"><legend className="small">{it.text}</legend>
                  {it.allowed.map((a) => <label key={a} className="check"><input type="radio" name={`a_${it.key}`} value={a} required /> {ANSWER[a]}</label>)}</fieldset>))}
              {next === 'time_out' && <label>Team present (names and roles)<input name="team" /></label>}
              <label>Concerns / actions{next === 'sign_out' ? ' (required if counts are incorrect or equipment needs attention)' : ''}<textarea name="concerns" rows={2} /></label>
              <button className="btn primary">Record {ot.CHECKLIST[next].title.toLowerCase()}</button>
            </form>)}
          {next === 'sign_out' && !c.closure_at && c.status === 'in_theatre' && <p className="small muted">Sign out opens after closure is recorded.</p>}
          <p className="tiny muted">Items follow the WHO Surgical Safety Checklist (2009). Any local adaptation should be agreed by the surgical and anaesthesia leads.</p>
        </div>
      </div>

      <div className="card"><h2>Consumables &amp; implants</h2>
        {items.length === 0 ? <Empty>None recorded.</Empty> : (
          <table className="table small"><tbody>{items.map((u) => (
            <tr key={u.id} className={u.status === 'returned' ? 'dim' : ''}><td>{u.name}</td><td>Batch {u.batch_no}{u.implant_serial ? ` · serial ${u.implant_serial}` : ''}</td><td>× {u.qty}</td><td>{label(u.status)}</td>
              <td>{canCheck && open && u.status === 'used' && <form action={theatreAction.bind(null, slug)} className="inline-form">{base}{H('op', 'return')}{H('itemId', u.id)}<input name="reason" required placeholder="Reason" /><button className="btn small">Return</button></form>}</td></tr>))}</tbody></table>)}
        {canCheck && open && (stock.length ? (
          <form action={theatreAction.bind(null, slug)} className="inline-form wrap">{base}{H('op', 'item')}
            <select name="stock" required>{stock.map((x) => <option key={`${x.lot_id}|${x.location_id}`} value={`${x.lot_id}|${x.location_id}`}>{x.label}</option>)}</select>
            <input type="number" name="qty" min={1} defaultValue={1} /><input name="serial" placeholder="Implant serial (if any)" /><button className="btn small">Record use</button></form>
        ) : <p className="small muted">No released, in-date stock available (Pharmacy & stock).</p>)}
      </div>

      <div className="card"><h2>Operation note {note?.status === 'signed' ? <span className="pill ok">Signed {note.signed_at ? fmtDateTime(note.signed_at, tenant) : ''}</span> : note ? <span className="pill warn">Draft</span> : null}</h2>
        {noteEditable ? (
          <form action={theatreAction.bind(null, slug)} className="form-grid">{base}{H('op', 'note')}
            <label>Pre-operative diagnosis<textarea name="preOpDiagnosis" rows={2} defaultValue={n?.preOpDiagnosis} /></label>
            <label>Post-operative diagnosis<textarea name="postOpDiagnosis" rows={2} defaultValue={n?.postOpDiagnosis} /></label>
            <label>Procedure performed<textarea name="procedurePerformed" rows={2} defaultValue={n?.procedurePerformed ?? c.procedure_name} /></label>
            <label>Assistants<input name="assistants" defaultValue={n?.assistants} /></label>
            <label className="span2">Indication<textarea name="indication" rows={2} defaultValue={n?.indication} /></label>
            <label className="span2">Findings<textarea name="findings" rows={3} defaultValue={n?.findings} /></label>
            <label className="span2">Technique<textarea name="technique" rows={6} defaultValue={n?.technique} /></label>
            <label>Estimated blood loss (ml)<input name="bloodLossMl" type="number" min={0} defaultValue={n?.bloodLossMl ?? ''} /></label>
            <label>Specimens<input name="specimens" defaultValue={n?.specimens} /></label>
            <label>Implants<input name="implants" defaultValue={n?.implants} /></label>
            <label>Drains<input name="drains" defaultValue={n?.drains} /></label>
            <label className="span2">Complications<textarea name="complications" rows={2} defaultValue={n?.complications} /></label>
            <label className="span2">Post-operative instructions<textarea name="postOpInstructions" rows={4} defaultValue={n?.postOpInstructions} /></label>
            <div className="span2"><button className="btn">Save draft</button></div>
          </form>
        ) : n ? (
          <div className="prewrap small">
            {(['preOpDiagnosis', 'postOpDiagnosis', 'procedurePerformed', 'assistants', 'indication', 'findings', 'technique', 'specimens', 'implants', 'drains', 'complications', 'postOpInstructions'] as const)
              .filter((k) => String(n[k] ?? '').trim()).map((k) => <p key={k}><b>{label(k.replace(/([A-Z])/g, '_$1').toLowerCase())}:</b> {n[k]}</p>)}
            {n.bloodLossMl != null && <p><b>Estimated blood loss:</b> {n.bloodLossMl} ml</p>}
            {note?.content_digest && <p className="tiny muted">Digest {note.content_digest.slice(0, 16)}…</p>}
          </div>
        ) : <Empty>{c.status === 'scheduled' ? 'The note opens once the patient is in theatre.' : 'No note.'}</Empty>}
        {note?.status === 'draft' && can(session.role, 'clinical.sign') && session.clinicianId === c.surgeon_id && (
          <form action={theatreAction.bind(null, slug)}>{base}{H('op', 'sign')}<button className="btn primary">Sign operation note</button></form>)}
      </div>
    </>
  );
}
