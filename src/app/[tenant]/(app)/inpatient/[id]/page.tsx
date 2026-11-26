import Link from 'next/link';
import { requireStaff } from '@/lib/session';
import { admissionDetail, bedBoard } from '@/domain/inpatient';
import { getPatient } from '@/domain/patients';
import { withTenant } from '@/lib/db';
import { can } from '@/lib/rbac';
import { fmtDateTime, fmtTime, label } from '@/lib/format';
import { Badge, Flash, PageHead, PatientBanner } from '@/components/ui';
import { BreakGlass } from '@/components/BreakGlass';
import { needsBreakGlass } from '@/lib/gate';
import { admissionAction } from '../../module-actions';

export default async function Admission({ params, searchParams }: { params: Promise<{ tenant: string; id: string }>; searchParams: Promise<{ ok?: string; err?: string }> }) {
  const { tenant: slug, id } = await params;
  const sp = await searchParams;
  const { tenant, actor, session } = await requireStaff(slug, 'clinical.read');
  let d: Awaited<ReturnType<typeof admissionDetail>>;
  try { d = await admissionDetail(actor, tenant, id); } catch (e) {
    if (!needsBreakGlass(e)) throw e;
    return <BreakGlass slug={slug} patientId={(e as { details?: { patientId?: string } }).details?.patientId ?? ''} back={`/${slug}/inpatient/${id}`} minutes={tenant.settings.emergencyAccessMinutes} />;
  }
  const a = d.admission;
  const p = await getPatient(actor, a.patient_id);
  const open = a.status === 'admitted';
  const free = open ? (await bedBoard(actor, tenant)).filter((b) => !b.admission_id && b.status === 'available') : [];
  const colleagues = await withTenant(tenant.id, (tx) => tx.many<{ id: string; full_name: string; role: string }>(`SELECT id, full_name, role FROM staff WHERE active AND role IN ('nurse','doctor','owner') ORDER BY full_name`));
  const act = admissionAction.bind(null, slug, id);
  const nursing = can(session.role, 'inpatient.nursing');
  const prescriber = can(session.role, 'clinical.sign') && !!session.clinicianId;
  const ds = d.summary?.content.discharge;
  return (
    <>
      <PatientBanner p={p} slug={slug} />
      <PageHead title={`${a.care_type === 'daycare' ? 'Day care' : 'Admission'} ${a.admission_no}`} sub={`${a.department} · ${a.clinician} · admitted ${fmtDateTime(a.admitted_at, tenant)} · ${a.reason}`}>
        <Badge v={a.status} /><Link className="btn" href={`/${slug}/encounters/${a.encounter_id}`}>Notes, vitals & orders</Link>
      </PageHead>
      <Flash {...sp} />
      {a.care_type === 'daycare' && a.status === 'admitted' && (
        <div className={`card ${a.planned_end_at && new Date(a.planned_end_at) < new Date() ? 'warnbox' : ''}`}>
          <p>Day care — expected discharge {a.planned_end_at ? fmtDateTime(a.planned_end_at, tenant) : '—'}{a.planned_end_at && new Date(a.planned_end_at) < new Date() ? ' (overdue)' : ''}.</p>
          {tenant.settings.modules.inpatient && can(session.role, 'inpatient.admit') ? (
            <form action={admissionAction.bind(null, slug, id)} className="inline-form"><input type="hidden" name="op" value="convert" />
              <input name="reason" required minLength={5} placeholder="Clinical reason for overnight stay" /><button className="btn small">Convert to inpatient</button></form>
          ) : <p className="small muted">Overnight stays need the Inpatient module; otherwise arrange transfer.</p>}
        </div>)}
      {a.converted_reason && <p className="small muted">Converted from day care: {a.converted_reason}</p>}
      <div className="grid2">
        <div className="card"><h2>Bed</h2>
          <table className="table small"><tbody>{d.stays.map((s, i) => <tr key={i}><td>{s.ward} · {s.code}</td><td>{fmtDateTime(s.start, tenant)} → {s.end ? fmtDateTime(s.end, tenant) : 'now'}</td><td>{s.reason}</td></tr>)}</tbody></table>
          {open && nursing && <form action={act} className="inline-form"><input type="hidden" name="op" value="transfer" />
            <select name="bedId" required>{free.map((b) => <option key={b.bed_id} value={b.bed_id}>{b.ward} · {b.code}</option>)}</select><input name="reason" placeholder="Reason" required /><button className="btn small">Transfer</button></form>}
        </div>
        <div className="card"><h2>Handover</h2>
          {d.handovers.map((h) => <div key={h.id} className="note"><small className="muted">{h.from_name} → {h.to_name} · {fmtDateTime(h.created_at, tenant)} · {h.accepted_at ? `accepted ${fmtTime(h.accepted_at, tenant)}` : 'not yet accepted'}</small><p>{h.summary}</p>
            {!h.accepted_at && h.to_staff === session.staffId && <form action={act}><input type="hidden" name="op" value="accept" /><input type="hidden" name="handoverId" value={h.id} /><button className="btn small primary">Accept handover</button></form>}</div>)}
          {open && nursing && <form action={act} className="form-grid tight"><input type="hidden" name="op" value="handover" />
            <label>To<select name="toStaffId">{colleagues.filter((c) => c.id !== session.staffId).map((c) => <option key={c.id} value={c.id}>{c.full_name} ({c.role})</option>)}</select></label>
            <label className="span2">Situation, background, assessment, recommendation<textarea name="summary" rows={3} required /></label>
            <div className="span2"><button className="btn small">Send handover</button></div></form>}
        </div>
      </div>

      <div className="card"><h2>Medication orders and administration record</h2>
        {d.orders.map((o) => (
          <div key={o.id} className={`note ${o.status === 'active' ? 'signed' : 'superseded'}`}>
            <div className="row-between"><b>{o.drug_name} {o.dose} {o.route} {o.prn ? `when needed — ${o.prn_indication}` : `at ${o.schedule_times.join(', ')}`}</b>
              <span><Badge v={o.status} /> {o.stop_reason && <small className="muted">{o.stop_reason}</small>}</span></div>
            {o.instructions && <p className="small">{o.instructions}</p>}
            <div className="slots" style={{ gridTemplateColumns: 'repeat(auto-fill,minmax(170px,1fr))' }}>{d.doses.filter((x) => x.med_order_id === o.id).map((x) => (
              <div key={x.id} className="slot" style={{ textAlign: 'left', borderColor: x.status === 'missed' ? 'var(--danger)' : undefined }}>
                {x.due_at ? fmtDateTime(x.due_at, tenant) : 'PRN'}<small>{label(x.status)}{x.given_at ? ` ${fmtTime(x.given_at, tenant)} · ${x.given_by_name}` : ''}{x.note ? ` · ${x.note}` : ''}</small>
                {['due', 'missed'].includes(x.status) && open && nursing && (
                  <form action={act}><input type="hidden" name="op" value="dose" /><input type="hidden" name="doseId" value={x.id} />
                    <label className="check small"><input type="checkbox" name="idok" required /> ID band checked</label>
                    <select name="outcome"><option value="given">Given</option><option value="held">Held</option><option value="refused">Refused</option></select>
                    <input name="note" placeholder="Reason if held/refused" /><button className="btn small">Record</button></form>)}
              </div>))}</div>
            {o.status === 'active' && o.prn && open && nursing && (
              <form action={act} className="inline-form"><input type="hidden" name="op" value="prn" /><input type="hidden" name="orderId" value={o.id} />
                <label className="check small"><input type="checkbox" name="idok" required /> ID band checked</label><input name="doseGiven" placeholder="Dose given" /><input name="note" placeholder="Indication / note" /><button className="btn small">Give PRN dose</button></form>)}
            {o.status === 'active' && open && prescriber && (
              <details><summary className="small">Change or stop</summary>
                <form action={act} className="inline-form"><input type="hidden" name="op" value="stop" /><input type="hidden" name="orderId" value={o.id} /><input name="reason" placeholder="Reason to stop" required /><button className="btn small danger">Stop</button></form>
                <form action={act} className="inline-form wrap"><input type="hidden" name="op" value="order" /><input type="hidden" name="replacesOrderId" value={o.id} />
                  <input name="drugName" defaultValue={o.drug_name} required /><input name="dose" placeholder="New dose" required /><input name="route" defaultValue={o.route} />
                  <input name="times" placeholder="Times e.g. 08:00 20:00" defaultValue={o.schedule_times.join(' ')} /><input type="datetime-local" name="startAt" title="Effective from" />
                  <input name="changeReason" placeholder="Reason for change" required /><button className="btn small">Sign change</button></form></details>)}
          </div>))}
        {open && prescriber && (
          <form action={act} className="inline-form wrap"><input type="hidden" name="op" value="order" />
            <b>New order:</b><input name="drugName" placeholder="Medicine" required /><input name="dose" placeholder="Dose" required /><input name="route" placeholder="Route" defaultValue="oral" />
            <input name="times" placeholder="Times e.g. 08:00 14:00 20:00" /><label className="check"><input type="checkbox" name="prn" /> When needed</label><input name="prnIndication" placeholder="When needed for" />
            <input name="instructions" placeholder="Instructions" /><button className="btn small primary">Sign order</button></form>)}
        <p className="small muted">Doses older than two hours without a record are marked missed. One record per scheduled dose; a dose change supersedes only future, unrecorded doses.</p>
      </div>

      <div className="card"><h2>Discharge</h2>
        {d.summary && ds && <div className="note signed"><small className="muted">Discharge summary v{d.summary.version_no} signed {fmtDateTime(d.summary.signed_at, tenant)}</small>
          <p><b>Diagnosis:</b> {ds.diagnosis}</p><p><b>Course:</b> {ds.courseInHospital}</p><p><b>Condition:</b> {ds.conditionAtDischarge}</p>
          {ds.medicationsOnDischarge && <p className="pre"><b>Medicines:</b> {ds.medicationsOnDischarge}</p>}{ds.followUp && <p><b>Follow-up:</b> {ds.followUp}</p>}{ds.instructions && <p className="pre"><b>Advice:</b> {ds.instructions}</p>}</div>}
        {open && can(session.role, 'inpatient.discharge') && (
          <>
            <form action={act} className="form-grid"><input type="hidden" name="op" value="summary" />
              <label className="span2">Final diagnosis<input name="diagnosis" defaultValue={ds?.diagnosis} required /></label>
              <label className="span2">Course in hospital<textarea name="course" rows={3} defaultValue={ds?.courseInHospital} required /></label>
              <label>Condition at discharge<input name="condition" defaultValue={ds?.conditionAtDischarge} required /></label>
              <label>Follow-up<input name="followUp" defaultValue={ds?.followUp} /></label>
              <label className="span2">Medicines on discharge<textarea name="meds" rows={3} defaultValue={ds?.medicationsOnDischarge} /></label>
              <label className="span2">Advice<textarea name="instructions" rows={2} defaultValue={ds?.instructions} /></label>
              <div className="span2"><button className="btn">{d.summary ? 'Sign revised summary' : 'Sign discharge summary'}</button></div></form>
            <form action={act} className="inline-form wrap"><input type="hidden" name="op" value="discharge" />
              <select name="disposition"><option value="home">Home</option><option value="referred">Referred</option><option value="transferred_out">Transferred out</option><option value="lama">Left against medical advice</option><option value="absconded">Absconded</option><option value="death">Death</option></select>
              <input name="clearance" placeholder="If bills are open: who authorised credit, and why" size={45} />
              <button className="btn primary">Discharge</button></form>
            <p className="small muted">Discharge needs a signed summary (except LAMA, absconded, death), all medication orders stopped, and bills settled or credit authorised. Bed-day charges are added automatically.</p>
          </>)}
        {!open && <p>Discharged {fmtDateTime(a.discharged_at, tenant)} · {label(a.disposition ?? '')} · {a.financial_clearance}</p>}
      </div>
    </>
  );
}
