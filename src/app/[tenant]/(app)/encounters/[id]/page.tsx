import Link from 'next/link';
import { requireStaff } from '@/lib/session';
import { getEncounter, type RxLine, type NoteContent } from '@/domain/clinical';
import { getPatient } from '@/domain/patients';
import { can } from '@/lib/rbac';
import { fmtDateTime } from '@/lib/format';
import { Badge, Flash, PatientBanner } from '@/components/ui';
import { RxEditor, type Line } from '@/components/RxEditor';
import { listTests, patientOrders } from '@/domain/labs';
import { BreakGlass } from '@/components/BreakGlass';
import { needsBreakGlass } from '@/lib/gate';
import { placeOrderAction } from '../../module-actions';
import { amendNoteAction, amendRxAction, completeEncounterAction, noteAction, rxAction, vitalsAction, allergyAction } from '../../actions';

const toLine = (l: RxLine): Line => ({ drugName: l.drug_name, strength: l.strength ?? '', form: l.form ?? '', dose: l.dose, route: l.route, frequency: l.frequency,
  duration: l.duration, quantity: l.quantity ?? '', prn: l.prn, prnIndication: l.prn_indication ?? '', instructions: l.instructions ?? '' });

export default async function Encounter({ params, searchParams }: { params: Promise<{ tenant: string; id: string }>; searchParams: Promise<{ ok?: string; err?: string }> }) {
  const { tenant: slug, id } = await params;
  const sp = await searchParams;
  const { tenant, actor, session } = await requireStaff(slug, 'clinical.read');
  let d: Awaited<ReturnType<typeof getEncounter>>;
  try { d = await getEncounter(actor, tenant, id); } catch (e) {
    if (!needsBreakGlass(e)) throw e;
    const pid = ((e as { details?: { patientId?: string } }).details?.patientId) ?? '';
    return <BreakGlass slug={slug} patientId={pid} back={`/${slug}/encounters/${id}`} minutes={tenant.settings.emergencyAccessMinutes} />;
  }
  const p = await getPatient(actor, d.encounter.patient_id);
  const e = d.encounter;
  const open = e.status === 'open';
  const canWrite = can(session.role, 'clinical.write');
  const canSign = can(session.role, 'clinical.sign') && !!session.clinicianId;
  const draftNote = d.notes.find((n) => n.status === 'draft');
  const signedNotes = d.notes.filter((n) => n.status !== 'draft');
  const draftRx = d.prescriptions.find((r) => r.status === 'draft');
  const signedRx = d.prescriptions.filter((r) => r.status !== 'draft');
  const c: NoteContent = draftNote?.content ?? {};
  const needsAllergy = p.allergy_status === 'not_reviewed';
  const labsOn = tenant.settings.modules.labs;
  const tests = labsOn ? (await listTests(tenant.id)).filter((x) => x.active) : [];
  const orders = labsOn ? await patientOrders(actor, tenant, p.id, id) : [];
  const ekind = (e as unknown as { kind: string }).kind;

  return (
    <>
      <PatientBanner p={p} slug={slug} allergies={d.allergies as { substance: string }[]} />
      <div className="row-between">
        <p className="muted">{e.service_name ?? e.department_name} · {e.clinician_name} · started {fmtDateTime(e.started_at, tenant)} <Badge v={e.status} /></p>
        {open && canWrite && <form action={completeEncounterAction.bind(null, slug, id)}><button className="btn primary">Complete visit</button></form>}
      </div>
      <Flash {...sp} />
      {e.chief_complaint && <p><b>Chief complaint:</b> {e.chief_complaint}</p>}
      {ekind === 'video' && e.appointment_id && <p><Link className="btn" href={`/${slug}/video/${e.appointment_id}`}>Video room and session record</Link></p>}

      <div className="grid2">
        <div className="card">
          <h2>Vitals</h2>
          {(d.vitals as Record<string, string | number | null>[]).map((v) => (
            <p key={String(v.id)} className="small">{fmtDateTime(String(v.measured_at), tenant)} — BP {v.systolic ? `${v.systolic}/${v.diastolic}` : '—'} · Pulse {v.pulse ?? '—'} · Temp {v.temp_c ?? '—'}°C · SpO₂ {v.spo2 ?? '—'}% · Wt {v.weight_kg ?? '—'} kg · Ht {v.height_cm ?? '—'} cm</p>))}
          {open && can(session.role, 'vitals.write') && (
            <form action={vitalsAction.bind(null, slug, id)} className="vitals">
              <label>Systolic<input name="systolic" type="number" min={40} max={300} /></label>
              <label>Diastolic<input name="diastolic" type="number" min={20} max={200} /></label>
              <label>Pulse<input name="pulse" type="number" min={20} max={250} /></label>
              <label>Resp. rate<input name="respRate" type="number" min={4} max={80} /></label>
              <label>Temp °C<input name="tempC" type="number" step="0.1" min={25} max={45} /></label>
              <label>SpO₂ %<input name="spo2" type="number" min={40} max={100} /></label>
              <label>Weight kg<input name="weightKg" type="number" step="0.01" /></label>
              <label>Height cm<input name="heightCm" type="number" step="0.1" /></label>
              <button className="btn small">Save vitals</button>
            </form>)}
        </div>
        <div className="card">
          <h2>Allergies</h2>
          {needsAllergy ? <p className="pill warn">Not reviewed</p> : p.allergy_status === 'no_known_allergies' ? <p className="pill ok">No known allergies</p>
            : <ul>{(d.allergies as { id: string; substance: string; reaction: string | null }[]).map((a) => <li key={a.id}>{a.substance}{a.reaction ? ` — ${a.reaction}` : ''}</li>)}</ul>}
          {['doctor', 'nurse', 'owner'].includes(session.role) && (
            <>
              <form action={allergyAction.bind(null, slug, p.id, `/${slug}/encounters/${id}`)} className="inline-form">
                <input name="substance" placeholder="Allergen" required /><input name="reaction" placeholder="Reaction" /><button className="btn small">Add</button></form>
              {p.allergy_status !== 'has_allergies' && <form action={allergyAction.bind(null, slug, p.id, `/${slug}/encounters/${id}`)}><input type="hidden" name="nka" value="1" /><button className="btn small">No known allergies</button></form>}
            </>)}
        </div>
      </div>

      <div className="card">
        <h2>Consultation note</h2>
        {signedNotes.map((n) => (
          <div key={n.id} className={`note ${n.status}`}>
            <small className="muted">v{n.version_no} · {n.status} by {n.signer_name} · {fmtDateTime(n.signed_at, tenant)}{n.amend_reason ? ` · amended: ${n.amend_reason}` : ''}</small>
            {n.content.subjective && <p><b>History:</b> {n.content.subjective}</p>}
            {n.content.objective && <p><b>Examination:</b> {n.content.objective}</p>}
            {n.content.diagnoses?.length ? <p><b>Diagnosis:</b> {n.content.diagnoses.map((x) => x.text).join('; ')}</p> : null}
            {n.content.assessment && <p><b>Assessment:</b> {n.content.assessment}</p>}
            {n.content.plan && <p><b>Plan:</b> {n.content.plan}</p>}
            {n.status === 'signed' && canWrite && !draftNote && (
              <form action={amendNoteAction.bind(null, slug, id, n.id)} className="inline-form"><input name="reason" placeholder="Reason for amendment" required /><button className="btn small">Amend</button></form>)}
          </div>))}
        {canWrite && (open || draftNote) && (!signedNotes.some((n) => n.status === 'signed') || draftNote) && (
          <form action={noteAction.bind(null, slug, id)} className="form-grid">
            {draftNote && <><input type="hidden" name="noteId" value={draftNote.id} /><input type="hidden" name="rowVersion" value={draftNote.row_version} /></>}
            <label className="span2">History / complaints<textarea name="subjective" rows={3} defaultValue={c.subjective} /></label>
            <label className="span2">Examination findings<textarea name="objective" rows={3} defaultValue={c.objective} /></label>
            <label>Diagnosis (one per line)<textarea name="diagnoses" rows={3} defaultValue={c.diagnoses?.map((x) => x.text).join('\n')} /></label>
            <label>Assessment<textarea name="assessment" rows={3} defaultValue={c.assessment} /></label>
            <label className="span2">Plan<textarea name="plan" rows={3} defaultValue={c.plan} /></label>
            <div className="span2">
              <button className="btn" name="intent" value="save">Save draft</button>{' '}
              {canSign && <button className="btn primary" name="intent" value="sign">Sign note</button>}
              {!canSign && <small className="muted"> Only a clinician with a profile can sign.</small>}
            </div>
          </form>)}
      </div>

      {labsOn && (
        <div className="card">
          <h2>Investigations</h2>
          {orders.length > 0 && <table className="table small"><tbody>{orders.map((o) => (
            <tr key={o.id}><td><Link href={`/${slug}/labs/${o.id}`}>{o.accession_no}</Link></td><td>{o.test_name}</td><td>{o.priority}</td>
              <td>{o.value_num ?? o.value_text ?? ''} {o.unit}</td><td><Badge v={o.status} />{o.latest_critical ? <span className="pill danger">Critical</span> : null}</td></tr>))}</tbody></table>}
          {open && can(session.role, 'orders.write') && session.clinicianId && (
            <form action={placeOrderAction.bind(null, slug, `/${slug}/encounters/${id}`)} className="form-grid">
              <input type="hidden" name="patientId" value={p.id} /><input type="hidden" name="encounterId" value={id} />
              <label className="span2">Tests<select name="testIds" multiple required size={Math.min(8, Math.max(3, tests.length))}>{tests.map((x) => <option key={x.id} value={x.id}>{x.name}{x.kind !== 'lab' ? ` (${x.kind})` : ''}</option>)}</select></label>
              <label>Priority<select name="priority"><option value="routine">Routine</option><option value="urgent">Urgent</option><option value="stat">STAT</option></select></label>
              <label>Performed at<select name="destination"><option value="internal">This clinic</option><option value="external">External lab</option></select></label>
              <label>External lab name<input name="externalLab" /></label>
              <label>Clinical information<input name="clinicalInfo" /></label>
              <div className="span2"><button className="btn">Place order</button>{tests.length === 0 && <small className="muted"> Add tests in Lab & imaging › Test catalogue first.</small>}</div>
            </form>)}
        </div>)}

      <div className="card">
        <h2>Prescription</h2>
        {signedRx.map((r) => (
          <div key={r.id} className={`note ${r.status}`}>
            <div className="row-between"><small className="muted">{r.rx_number} v{r.version_no} · {r.status}{r.amend_reason ? ` · amended: ${r.amend_reason}` : ''}</small>
              <Link href={`/${slug}/print/rx/${r.id}`} target="_blank" className="btn small">Print</Link></div>
            <ol>{r.lines.map((l) => <li key={l.id}><b>{l.drug_name}</b> {l.strength} {l.form} — {l.dose}, {l.route}, {l.frequency}, {l.duration}{l.prn ? ` (when needed: ${l.prn_indication})` : ''}{l.instructions ? ` · ${l.instructions}` : ''}</li>)}</ol>
            {r.advice && <p><b>Advice:</b> {r.advice}</p>}
            {r.status === 'signed' && canSign && !draftRx && (
              <form action={amendRxAction.bind(null, slug, id, r.id)} className="inline-form"><input name="reason" placeholder="Reason for amendment" required /><button className="btn small">Amend</button></form>)}
          </div>))}
        {canWrite && (open || draftRx) && (!signedRx.some((r) => r.status === 'signed') || draftRx) && (
          <form action={rxAction.bind(null, slug, id)}>
            {draftRx && <><input type="hidden" name="rxId" value={draftRx.id} /><input type="hidden" name="rowVersion" value={draftRx.row_version} /></>}
            <RxEditor initial={(draftRx?.lines ?? []).map(toLine)} />
            <div className="form-grid">
              <label className="span2">Advice / instructions<textarea name="advice" rows={2} defaultValue={draftRx?.advice ?? ''} /></label>
              <label>Review after (days)<input type="number" name="followUpInDays" min={0} max={3650} defaultValue={draftRx?.follow_up_in_days ?? ''} /></label>
              {needsAllergy && <label className="warnbox">Allergies not reviewed — override reason (or record allergies first)<input name="override" /></label>}
              {!needsAllergy && <label>Safety override reason (only if the system flags an allergy match)<input name="override" /></label>}
              <label className="check span2"><input type="checkbox" name="patientConfirmed" /> I have confirmed this is {p.full_name} ({p.uhid})</label>
            </div>
            <button className="btn" name="intent" value="save">Save draft</button>{' '}
            {canSign && <button className="btn primary" name="intent" value="sign">Sign prescription</button>}
          </form>)}
        <p className="muted small">Allergy checks match recorded allergen names only. They are not a drug-interaction database; clinical judgement applies.</p>
      </div>
    </>
  );
}
