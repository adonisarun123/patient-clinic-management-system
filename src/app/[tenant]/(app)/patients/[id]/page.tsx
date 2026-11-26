import Link from 'next/link';
import { requireStaff } from '@/lib/session';
import { getPatient, patientHistory, searchPatients } from '@/domain/patients';
import { patientTimeline } from '@/domain/clinical';
import { listCatalog } from '@/domain/catalog';
import { can } from '@/lib/rbac';
import { birthLabel } from '@/lib/identity';
import { fmtDate, fmtDateTime, label } from '@/lib/format';
import { Badge, Empty, Flash, PatientBanner } from '@/components/ui';
import { listPatientDocuments } from '@/domain/attachments';
import { patientPortalLinks, releasedIds } from '@/domain/portal';
import { patientOrders } from '@/domain/labs';
import { patientDispenses } from '@/domain/pharmacy';
import { BreakGlass } from '@/components/BreakGlass';
import { FileField } from '@/components/FileField';
import { objectStorageEnabled } from '@/lib/blob';
import { needsBreakGlass } from '@/lib/gate';
import { listReferrals, listReferrers } from '@/domain/frontdesk';
import { referralAction } from '../../frontdesk-actions';
import { listPayers, patientPolicies, listPreauths } from '@/domain/insurance';
import { insuranceAction } from '../../insurance-actions';
import { money } from '@/lib/format';
import { uploadDocAction, docErrorAction, portalLinkAction, restrictAction, releaseAction, returnAction } from '../../module-actions';
import { mergeAction, refileAction } from '../../records-actions';
import { listMerges } from '@/domain/records';
import { patientAbha, formatAbhaNumber, maskAbhaNumber } from '@/domain/abha';
import { abhaAction } from '../../abdm-actions';
import { allergyAction, allergyStatusAction, confirmIdentityAction, linkPatientAction, updatePatientAction, walkInAction, followUpAction } from '../../actions';

type Sp = { showAbha?: string; dup?: string; ok?: string; err?: string; edit?: string; link?: string };

export default async function PatientChart({ params, searchParams }: { params: Promise<{ tenant: string; id: string }>; searchParams: Promise<Sp> }) {
  const { tenant: slug, id } = await params;
  const sp = await searchParams;
  const { tenant, actor, session } = await requireStaff(slug, 'patient.read');
  const p = await getPatient(actor, id);
  const canClinical = can(session.role, 'clinical.read');
  let t: Awaited<ReturnType<typeof patientTimeline>> | null = null;
  let locked = false;
  if (canClinical) {
    try { t = await patientTimeline(actor, tenant, id); } catch (e) { if (needsBreakGlass(e)) locked = true; else throw e; }
  }
  const m = tenant.settings.modules;
  const docs = t ? await listPatientDocuments(actor, tenant, id) : [];
  const links = m.portal && can(session.role, 'portal.manage') ? await patientPortalLinks(actor, tenant, id) : [];
  const released = m.portal && t ? await releasedIds(tenant, id) : [];
  const isReleased = (kind: string, docId: string) => released.some((r) => r.doc_kind === kind && r.doc_id === docId);
  const orders = t ? await patientOrders(actor, tenant, id) : [];
  const dispenses = m.pharmacy && t && can(session.role, 'pharmacy.dispense') ? await patientDispenses(tenant.id, id) : [];
  const history = sp.edit ? await patientHistory(actor, id) : [];
  const cat = await listCatalog(tenant.id);
  const dupResults = sp.dup && can(session.role, 'patient.merge') ? (await searchPatients(actor, sp.dup)).filter((r) => r.id !== id && r.status !== 'merged') : [];
  const abha = p.status !== 'merged' ? await patientAbha(actor, tenant, id) : null;
  const mergeLog = can(session.role, 'patient.merge') ? await listMerges(actor, tenant, { patientId: id }) : [];
  const linkResults = sp.link ? (await searchPatients(actor, sp.link)).filter((r) => r.id !== id && r.status !== 'merged') : [];
  const activeAllergies = (t?.allergies ?? []).filter((a) => (a as { status: string }).status === 'active') as { id: string; substance: string; reaction: string | null; severity: string | null }[];
  const back = `/${slug}/patients/${id}`;
  const referrals = await listReferrals(actor, tenant, { patientId: id });
  const canIns = can(session.role, 'billing.read');
  const policies = canIns ? await patientPolicies(actor, tenant, id) : [];
  const payers = can(session.role, 'claims.manage') ? (await listPayers(actor, tenant)).filter((p) => p.active) : [];
  const preauths = canIns ? await listPreauths(actor, tenant, { patientId: id }) : [];
  const referrers = can(session.role, 'patient.write') || can(session.role, 'clinical.write') ? (await listReferrers(actor, tenant)).filter((r) => r.active) : [];

  if (p.status === 'merged' && p.merged_into_id) {
    return <div className="card"><p>This record ({p.uhid}) was linked into another chart.</p><Link className="btn primary" href={`/${slug}/patients/${p.merged_into_id}`}>Open surviving chart</Link></div>;
  }

  return (
    <>
      <PatientBanner p={p} slug={slug} allergies={activeAllergies} />
      <Flash ok={sp.ok} err={sp.err} />
      {locked && <BreakGlass slug={slug} patientId={id} back={back} minutes={tenant.settings.emergencyAccessMinutes} />}
      {(p as { restricted?: boolean }).restricted && !locked && <p className="pill danger">Restricted record — every access is logged</p>}
      <div className="actions-row">
        {can(session.role, 'schedule.book') && <Link className="btn primary" href={`/${slug}/appointments/new?patientId=${id}`}>Book appointment</Link>}
        {can(session.role, 'billing.read') && <Link className="btn" href={`/${slug}/billing?patient=${id}`}>Account & billing</Link>}
        {can(session.role, 'patient.write') && <Link className="btn" href={`${back}?edit=1`}>Edit details</Link>}
        {m.inpatient && can(session.role, 'inpatient.admit') && <Link className="btn" href={`/${slug}/inpatient?admit=${id}`}>Admit</Link>}
      </div>

      {(p.status === 'provisional' || p.status === 'temporary') && can(session.role, 'patient.write') && (
        <div className="card warnbox">
          <h2>Confirm identity</h2>
          <p>This record came from {p.status === 'temporary' ? 'an unidentified arrival' : `an online booking (${label(p.registration_source)})`}. Ask the patient for two identifiers.</p>
          <div className="grid2">
            <form action={confirmIdentityAction.bind(null, slug, id)}><p className="small muted">New patient — no existing chart:</p><button className="btn">Confirm as new patient</button></form>
            <div>
              <p className="small muted">Already registered here? Find their chart and link this record into it{can(session.role, 'patient.merge') ? '' : ' (medical records staff only)'}:</p>
              <form className="search"><input name="link" defaultValue={sp.link} placeholder="Search existing chart" /><button className="btn">Find</button></form>
              {linkResults.map((r) => (
                <form key={r.id} action={linkPatientAction.bind(null, slug, id)} className="link-row">
                  <input type="hidden" name="survivorId" value={r.id} />
                  <span><b>{r.full_name}</b> · {r.uhid} · DOB {birthLabel(r.birth_date, r.birth_precision)} · <small>{r.reason}</small></span>
                  <input name="reason" required placeholder="Evidence (e.g. name + DOB + phone confirmed)" />
                  <button className="btn" disabled={!can(session.role, 'patient.merge')}>Link</button>
                </form>
              ))}
            </div>
          </div>
        </div>
      )}

      {sp.edit && can(session.role, 'patient.write') ? (
        <form action={updatePatientAction.bind(null, slug, id)} className="card form-grid">
          <h2 className="span2">Edit details</h2>
          <input type="hidden" name="version" value={p.version} />
          <label className="span2">Full name<input name="fullName" defaultValue={p.full_name} required /></label>
          <label>Preferred name<input name="preferredName" defaultValue={p.preferred_name ?? ''} /></label>
          <label>Sex<select name="sex" defaultValue={p.sex}>{['female', 'male', 'other', 'unknown', 'declined'].map((s) => <option key={s} value={s}>{label(s)}</option>)}</select></label>
          <label>Date of birth (YYYY, YYYY-MM or YYYY-MM-DD)<input name="birthDate" placeholder={birthLabel(p.birth_date, p.birth_precision)} pattern="\d{4}(-\d{2}(-\d{2})?)?" /></label>
          <label>Mobile<input name="phone" defaultValue={p.phone_e164 ?? ''} /></label>
          <label>Email<input name="email" defaultValue={p.email ?? ''} /></label>
          <label>Language<input name="language" defaultValue={p.preferred_language ?? ''} /></label>
          <label className="span2">Address<input name="line1" defaultValue={p.address?.line1 ?? ''} /></label>
          <label>City<input name="city" defaultValue={p.address?.city ?? ''} /></label>
          <label>State<input name="state" defaultValue={p.address?.state ?? ''} /></label>
          <label>PIN<input name="pincode" defaultValue={p.address?.pincode ?? ''} /></label>
          <label>Type of change<select name="kind"><option value="update">New information (e.g. new phone)</option><option value="correction">Correction of an error</option></select></label>
          <label className="span2">Reason (recorded in history)<input name="reason" required minLength={3} /></label>
          <div className="span2"><button className="btn primary">Save changes</button> <Link href={back}>Cancel</Link></div>
          {history.length > 0 && (
            <div className="span2"><h3>Change history</h3>
              <table className="table small"><thead><tr><th>When</th><th>Field</th><th>From</th><th>To</th><th>Type</th><th>By</th><th>Reason</th></tr></thead>
                <tbody>{history.map((h) => { const r = h as Record<string, string>; return (
                  <tr key={r.id}><td>{fmtDateTime(r.at, tenant)}</td><td>{r.field}</td><td>{r.old_value}</td><td>{r.new_value}</td><td>{r.kind}</td><td>{r.actor_name}</td><td>{r.reason}</td></tr>); })}</tbody></table>
            </div>)}
        </form>
      ) : (
        <div className="grid2">
          <div className="card">
            <h2>Details</h2>
            <dl className="dl">
              <dt>UHID</dt><dd>{p.uhid}</dd>
              {p.preferred_name && <><dt>Preferred name</dt><dd>{p.preferred_name}</dd></>}
              <dt>Mobile</dt><dd>{p.phone_e164 ?? label(p.phone_status)} {p.phone_e164 && <small className="muted">({p.phone_status})</small>}</dd>
              <dt>Email</dt><dd>{p.email ?? '—'}</dd>
              <dt>Language</dt><dd>{p.preferred_language ?? '—'}</dd>
              <dt>Address</dt><dd>{[p.address?.line1, p.address?.city, p.address?.state, p.address?.pincode].filter(Boolean).join(', ') || '—'}</dd>
              <dt>Emergency contact</dt><dd>{p.emergency_contact ? `${p.emergency_contact.name} (${p.emergency_contact.relation ?? 'contact'}) ${p.emergency_contact.phone}` : '—'}</dd>
              <dt>Registered</dt><dd>{fmtDate(p.created_at, tenant)} · {label(p.registration_source)}</dd>
            </dl>
          </div>
          <div className="card">
            <h2>Allergies</h2>
            {p.allergy_status === 'not_reviewed' && <p className="pill warn">Not reviewed — a blank list does not mean “no known allergies”.</p>}
            {p.allergy_status === 'no_known_allergies' && <p className="pill ok">No known allergies (reviewed)</p>}
            {activeAllergies.length > 0 && <ul className="list">{activeAllergies.map((a) => (
              <li key={a.id}><b>{a.substance}</b> {a.reaction && `— ${a.reaction}`} {a.severity && <Badge v={a.severity} />}
                {can(session.role, 'clinical.write') && <form action={allergyStatusAction.bind(null, slug, a.id, back)} className="inline-form">
                  <select name="status"><option value="resolved">Resolved</option><option value="entered_in_error">Entered in error</option></select><button className="btn small">Update</button></form>}
              </li>))}</ul>}
            {['doctor', 'nurse', 'owner'].includes(session.role) && (
              <>
                <form action={allergyAction.bind(null, slug, id, back)} className="inline-form">
                  <input name="substance" placeholder="Allergen / substance" required /><input name="reaction" placeholder="Reaction" />
                  <select name="severity"><option value="unknown">Severity?</option><option value="mild">Mild</option><option value="moderate">Moderate</option><option value="severe">Severe</option></select>
                  <button className="btn small">Add</button>
                </form>
                {activeAllergies.length === 0 && <form action={allergyAction.bind(null, slug, id, back)}><input type="hidden" name="nka" value="1" /><button className="btn small">Patient reports no known allergies</button></form>}
              </>
            )}
          </div>
        </div>
      )}

      {can(session.role, 'queue.manage') && (
        <form action={walkInAction.bind(null, slug)} className="card inline-form">
          <input type="hidden" name="patientId" value={id} /><input type="hidden" name="back" value={back} />
          <b>Walk-in:</b>
          <select name="departmentId" required>{cat.departments.filter((d) => d.active).map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}</select>
          <select name="clinicianId"><option value="">Any doctor</option>{cat.clinicians.filter((c) => c.active).map((c) => <option key={c.id} value={c.id}>{c.display_name}</option>)}</select>
          <select name="serviceId"><option value="">Service…</option>{cat.services.filter((s) => s.active).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select>
          {can(session.role, 'queue.triage') && <><select name="priority" defaultValue="0"><option value="0">Routine</option><option value="1">Soon</option><option value="2">Urgent</option><option value="3">Emergency</option></select><input name="priorityReason" placeholder="Clinical reason if not routine" /></>}
          <label className="check"><input type="checkbox" name="idok" required /> Two identifiers confirmed</label>
          <button className="btn">Add to queue</button>
        </form>
      )}

      {t && (
        <>
          <div className="card">
            <h2>Visits</h2>
            {t.encounters.length === 0 ? <Empty>No visits yet.</Empty> : t.encounters.map((e) => {
              const notes = t.notes.filter((n) => n.encounter_id === e.id);
              const rxs = t.prescriptions.filter((r) => r.encounter_id === e.id);
              return (
                <div key={e.id} className="visit">
                  <div className="row-between"><b>{fmtDateTime(e.started_at, tenant)} · {e.service_name ?? e.department_name} · {e.clinician_name}</b>
                    <span><Badge v={e.status} /> <Link href={`/${slug}/encounters/${e.id}`}>Open</Link></span></div>
                  {e.chief_complaint && <p className="small">Complaint: {e.chief_complaint}</p>}
                  {notes.map((n) => (
                    <div key={n.id} className={`note ${n.status}`}>
                      <small className="muted">Note v{n.version_no} · {n.status}{n.signed_at ? ` · ${fmtDateTime(n.signed_at, tenant)}` : ''}</small>
                      {n.content.diagnoses?.length ? <p><b>Dx:</b> {n.content.diagnoses.map((d) => d.text).join('; ')}</p> : null}
                      {n.content.assessment && <p><b>Assessment:</b> {n.content.assessment}</p>}
                      {n.content.plan && <p><b>Plan:</b> {n.content.plan}</p>}
                    </div>))}
                  {rxs.map((r) => (
                    <div key={r.id} className={`note ${r.status}`}>
                      <small className="muted">{r.rx_number} v{r.version_no} · {r.status} · <Link href={`/${slug}/print/rx/${r.id}`} target="_blank">Print</Link></small>
                      <ul className="small">{r.snapshot.lines.map((l, i) => <li key={i}>{l.drug} — {l.dose}, {l.frequency}, {l.duration}</li>)}</ul>
                    </div>))}
                </div>);
            })}
          </div>
          <div className="grid2">
            <div className="card">
              <h2>Appointments</h2>
              {t.appointments.length === 0 ? <Empty>None.</Empty> : <table className="table small"><tbody>{t.appointments.map((a) => (
                <tr key={a.id}><td>{fmtDateTime(a.start_at, tenant)}</td><td>{a.service_name}</td><td>{a.clinician_name}</td><td><Badge v={a.state} /></td></tr>))}</tbody></table>}
            </div>
            <div className="card">
              <h2>Follow-ups</h2>
              {(t.followUps as { id: string; due_date: string; reason: string; status: string }[]).map((f) => (
                <p key={f.id} className="small">{fmtDate(f.due_date, tenant)} — {f.reason} <Badge v={f.status} /></p>))}
              <form action={followUpAction.bind(null, slug, back)} className="inline-form">
                <input type="hidden" name="patientId" value={id} />
                <input type="date" name="dueDate" required /><input name="reason" placeholder="Reason" required /><button className="btn small">Add follow-up</button>
              </form>
            </div>
          </div>
          {(t.vitals as Record<string, string | number | null>[]).length > 0 && (
            <div className="card"><h2>Recent vitals</h2>
              <table className="table small"><thead><tr><th>When</th><th>BP</th><th>Pulse</th><th>Temp °C</th><th>SpO₂</th><th>Weight kg</th></tr></thead>
                <tbody>{(t.vitals as Record<string, string | number | null>[]).map((v) => (
                  <tr key={String(v.id)}><td>{fmtDateTime(String(v.measured_at), tenant)}</td><td>{v.systolic ? `${v.systolic}/${v.diastolic}` : '—'}</td><td>{v.pulse ?? '—'}</td><td>{v.temp_c ?? '—'}</td><td>{v.spo2 ?? '—'}</td><td>{v.weight_kg ?? '—'}</td></tr>))}</tbody></table>
            </div>)}
        </>
      )}

      {t && orders.length > 0 && (
        <div className="card"><h2>Lab & imaging</h2>
          <table className="table small"><tbody>{orders.map((o) => (
            <tr key={o.id}><td><Link href={`/${slug}/labs/${o.id}`}>{o.accession_no}</Link></td><td>{o.test_name}</td><td>{fmtDateTime(o.created_at, tenant)}</td>
              <td>{o.value_num ?? o.value_text ?? ''} {o.unit}</td><td><Badge v={o.status} />{o.latest_critical ? <span className="pill danger">Critical</span> : null}</td></tr>))}</tbody></table></div>)}

      {t && m.portal && t.prescriptions.some((r) => r.status === 'signed') && can(session.role, 'clinical.read') && (
        <div className="card"><h2>Portal documents</h2>
          <table className="table small"><tbody>{t.prescriptions.filter((r) => r.status === 'signed').map((r) => (
            <tr key={r.id}><td>Prescription {r.rx_number}</td><td>{fmtDateTime(r.signed_at, tenant)}</td>
              <td><form action={releaseAction.bind(null, slug, back)} className="inline-form"><input type="hidden" name="patientId" value={id} /><input type="hidden" name="kind" value="prescription" /><input type="hidden" name="docId" value={r.id} />
                {isReleased('prescription', r.id) ? <><input type="hidden" name="op" value="revoke" /><span className="pill ok">In portal</span><button className="btn small">Remove</button></> : <button className="btn small">Release to portal</button>}</form></td></tr>))}</tbody></table></div>)}

      {canIns && (
        <div className="card"><h2>Insurance</h2>
          {policies.length === 0 ? <Empty>No policies on file.</Empty> : <table className="table small"><tbody>{policies.map((pp) => (
            <tr key={pp.id} className={pp.status === 'active' ? '' : 'dim'}><td><b>{pp.payer_name}</b>{pp.tpa_name ? ` via ${pp.tpa_name}` : ''}<br /><small>{pp.policy_number}{pp.member_id ? ` · member ${pp.member_id}` : ''}</small></td>
              <td>{pp.valid_from || pp.valid_to ? `${pp.valid_from ?? '…'} → ${pp.valid_to ?? '…'}` : ''}</td>
              <td>{pp.sum_insured_paise != null ? `${money(pp.used_paise, tenant)} of ${money(pp.sum_insured_paise, tenant)} used` : ''}{pp.copay_bp ? ` · co-pay ${pp.copay_bp / 100}%` : ''}</td>
              <td>{payers.length > 0 && <form action={insuranceAction.bind(null, slug)}><input type="hidden" name="op" value="policyStatus" /><input type="hidden" name="id" value={pp.id} /><input type="hidden" name="active" value={pp.status === 'active' ? '0' : '1'} /><input type="hidden" name="back" value={back} />
                <button className="btn small">{pp.status === 'active' ? 'Deactivate' : 'Activate'}</button></form>}</td></tr>))}</tbody></table>}
          {preauths.length > 0 && <p className="small">Pre-authorisations: {preauths.map((x) => <Link key={x.id} href={`/${slug}/insurance/preauth/${x.id}`}>{x.ref_number} ({label(x.status)}) </Link>)}</p>}
          {payers.length > 0 ? (
            <div className="grid2">
              <form action={insuranceAction.bind(null, slug)} className="form-grid"><input type="hidden" name="op" value="policy" /><input type="hidden" name="patientId" value={id} /><input type="hidden" name="back" value={back} />
                <h3 className="span2">Add policy / corporate cover</h3>
                <label>Insurer / employer<select name="payerId" required>{payers.filter((x) => x.kind !== 'tpa').map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</select></label>
                <label>Through TPA<select name="tpaId"><option value="">— none —</option>{payers.filter((x) => x.kind === 'tpa').map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</select></label>
                <label>Policy / card no.<input name="policyNumber" required /></label><label>Member ID<input name="memberId" /></label>
                <label>Valid from<input type="date" name="validFrom" /></label><label>Valid to<input type="date" name="validTo" /></label>
                <label>Sum insured (₹)<input name="sumInsured" inputMode="decimal" /></label><label>Co-pay (%)<input name="copay" defaultValue="0" inputMode="decimal" /></label>
                <div className="span2"><button className="btn small">Add policy</button></div>
              </form>
              {policies.some((x) => x.status === 'active') && <form action={insuranceAction.bind(null, slug)} className="form-grid"><input type="hidden" name="op" value="preauth" /><input type="hidden" name="patientId" value={id} /><input type="hidden" name="back" value={back} />
                <h3 className="span2">Request pre-authorisation</h3>
                <label>Policy<select name="policyId">{policies.filter((x) => x.status === 'active').map((x) => <option key={x.id} value={x.id}>{x.payer_name} · {x.policy_number}</option>)}</select></label>
                <label>Estimated cost (₹)<input name="estimate" required inputMode="decimal" /></label>
                <label className="span2">Treatment / procedure<input name="treatment" required minLength={3} /></label>
                <div className="span2"><button className="btn small">Draft request</button></div>
              </form>}
            </div>) : can(session.role, 'claims.manage') ? <p className="small muted">Add insurers and TPAs under <Link href={`/${slug}/insurance?tab=payers`}>Insurance › Insurers &amp; TPAs</Link> first.</p> : null}
        </div>)}

      <div className="card"><h2>Referrals</h2>
        {referrals.length === 0 ? <Empty>No referrals.</Empty> : <table className="table small"><tbody>{referrals.map((r) => (
          <tr key={r.id}><td><Link href={`/${slug}/referrals/${r.id}`}>{r.ref_number}</Link></td><td>{r.direction === 'inbound' ? `From ${r.referrer_name ?? '—'}` : `To ${r.referrer_name ?? r.to_specialty ?? '—'}`}</td>
            <td>{r.reason.slice(0, 70)}</td><td>{label(r.status)}</td><td>{fmtDate(r.created_at, tenant)}</td></tr>))}</tbody></table>}
        <div className="grid2">
          {can(session.role, 'patient.write') && (referrers.length ? (
            <form action={referralAction.bind(null, slug)} className="form-grid"><input type="hidden" name="op" value="inbound" /><input type="hidden" name="patientId" value={id} /><input type="hidden" name="back" value={back} />
              <h3 className="span2">Record a referral we received</h3>
              <label>Referred by<select name="referrerId" required>{referrers.map((r) => <option key={r.id} value={r.id}>{r.name}{r.organisation ? ` · ${r.organisation}` : ''}</option>)}</select></label>
              <label>Urgency<select name="urgency"><option value="routine">Routine</option><option value="soon">Soon</option><option value="urgent">Urgent</option></select></label>
              <label className="span2">Reason<input name="reason" required minLength={3} /></label>
              <div className="span2"><button className="btn small">Record</button></div>
            </form>) : <p className="small muted">Add referring doctors under <Link href={`/${slug}/referrals?tab=referrers`}>Referrals › Referring doctors</Link> to record inbound referrals.</p>)}
          {can(session.role, 'clinical.write') && (
            <form action={referralAction.bind(null, slug)} className="form-grid"><input type="hidden" name="op" value="draft" /><input type="hidden" name="patientId" value={id} /><input type="hidden" name="back" value={back} />
              <h3 className="span2">Refer this patient out</h3>
              <label>To<select name="referrerId"><option value="">(specialty only)</option>{referrers.map((r) => <option key={r.id} value={r.id}>{r.name}{r.specialty ? ` · ${r.specialty}` : ''}</option>)}</select></label>
              <label>Specialty<input name="toSpecialty" /></label>
              <label className="span2">Reason<input name="reason" required minLength={5} /></label>
              <div className="span2"><button className="btn small">Draft letter</button></div>
            </form>)}
        </div>
      </div>

      {t && (
        <div className="card"><h2>Documents</h2>
          {docs.length === 0 ? <Empty>No documents filed.</Empty> : <table className="table small"><tbody>{docs.map((d) => (
            <tr key={d.id} className={d.status === 'active' ? '' : 'dim'}><td><a href={`/${slug}/files/${d.id}`}>{d.title}</a><br /><small className="muted">{d.category} · {d.filename} · {Math.ceil(d.size_bytes / 1024)} KB</small></td>
              <td>{d.document_date ? fmtDate(d.document_date, tenant) : fmtDate(d.created_at, tenant)}{d.source ? <div className="small muted">{d.source}</div> : null}</td>
              <td>{m.portal && d.status === 'active' && (
                <form action={releaseAction.bind(null, slug, back)} className="inline-form"><input type="hidden" name="patientId" value={id} /><input type="hidden" name="kind" value="attachment" /><input type="hidden" name="docId" value={d.id} />
                  {isReleased('attachment', d.id) ? <><input type="hidden" name="op" value="revoke" /><span className="pill ok">In portal</span><button className="btn small">Remove</button></> : <button className="btn small">Release</button>}</form>)}
                {d.scan_status === 'error_accepted' && <div className="scan-flag">Not virus-scanned ({d.scan_detail})</div>}
                {d.status === 'active' && can(session.role, 'patient.merge') && ['patient_document', 'import'].includes(d.entity_kind) && <details><summary className="small">Move to another chart</summary><form action={refileAction.bind(null, slug)} className="inline-form wrap"><input type="hidden" name="op" value="request" /><input type="hidden" name="attachmentId" value={d.id} /><input type="hidden" name="back" value={back} /><input name="toUhid" required placeholder="Correct patient's UHID" /><input name="reason" required minLength={5} placeholder="How you know" /><button className="btn small">Request move</button></form></details>}
                {d.status === 'active' && can(session.role, 'patient.merge') && <details><summary className="small">Entered in error</summary><form action={docErrorAction.bind(null, slug, id, d.id)} className="inline-form"><input name="reason" required placeholder="Reason" /><button className="btn small">Mark</button></form></details>}</td></tr>))}</tbody></table>}
          {can(session.role, 'patient.write') && (
            <form action={uploadDocAction.bind(null, slug, id)} className="inline-form wrap" encType="multipart/form-data">
              <FileField name="file" slug={slug} tenantId={tenant.id} objectStorage={objectStorageEnabled()} accept="application/pdf,image/jpeg,image/png" required label="Document file" />
              <input name="title" placeholder="Title (e.g. MRI knee report)" required />
              <select name="category"><option value="outside_report">Outside report</option><option value="discharge_summary">Old discharge summary</option><option value="imaging">Imaging</option><option value="referral">Referral letter</option><option value="consent">Signed consent</option><option value="id_document">ID document</option><option value="other">Other</option></select>
              <input type="date" name="documentDate" title="Date on the document" /><input name="source" placeholder="Source (hospital / lab)" />
              <button className="btn small">Upload</button></form>)}
        </div>)}

      <div className="card"><h2>ABHA (Ayushman Bharat Health Account)</h2>
        {abha ? (
          <>
            <p>{abha.abha_number && <><b>{sp.showAbha === '1' && can(session.role, 'patient.write') ? formatAbhaNumber(abha.abha_number) : maskAbhaNumber(abha.abha_number)}</b>{can(session.role, 'patient.write') && sp.showAbha !== '1' && <> <Link className="small" href={`${back}?showAbha=1`}>show</Link></>}</>}
              {abha.abha_address && <> · {abha.abha_address}</>} <span className={`pill ${abha.verification === 'abdm_verified' ? 'ok' : ''}`}>{label(abha.verification)}</span></p>
            <p className="small muted">Recorded {fmtDate(abha.recorded_at, tenant)} with the patient’s consent{abha.consent_note ? ` (${abha.consent_note})` : ''}.</p>
            {can(session.role, 'patient.write') && <details><summary className="small">Remove</summary><form action={abhaAction.bind(null, slug, id)} className="inline-form"><input type="hidden" name="op" value="remove" /><input name="reason" required placeholder="Reason (e.g. consent withdrawn)" /><button className="btn small">Remove</button></form></details>}
          </>) : <p className="small muted">Not recorded.</p>}
        {can(session.role, 'patient.write') && (
          <details open={!abha}><summary className="small">{abha ? 'Replace' : 'Record ABHA'}</summary>
            <form action={abhaAction.bind(null, slug, id)} className="inline-form wrap"><input type="hidden" name="op" value="record" />
              <input name="abhaNumber" placeholder="ABHA number (14 digits)" inputMode="numeric" /><input name="abhaAddress" placeholder="ABHA address (name@abdm)" />
              <select name="verification"><option value="card_seen">ABHA card / app seen</option><option value="self_declared">Told by patient</option></select>
              <label className="check"><input type="checkbox" name="consent" required /> Patient agreed to the clinic storing and using their ABHA</label>
              <input name="consentNote" placeholder="Consent note (optional)" /><button className="btn small">Save</button></form>
            <p className="tiny muted">Verification with ABDM is available once the clinic’s ABDM integration is approved.</p>
          </details>)}
      </div>

      {can(session.role, 'patient.merge') && p.status !== 'merged' && (
        <div className="card"><h2>Duplicate charts</h2>
          <p className="small muted">If this person has a second chart, merge it into this one. A second authorised person approves, and the merge can be undone from the records desk.</p>
          <form className="search"><input name="dup" defaultValue={sp.dup} placeholder="Search the duplicate by name, phone or UHID" /><button className="btn">Find</button></form>
          {dupResults.map((r) => (
            <form key={r.id} action={mergeAction.bind(null, slug)} className="link-row">
              <input type="hidden" name="op" value="request" /><input type="hidden" name="sourceId" value={r.id} /><input type="hidden" name="survivorId" value={id} /><input type="hidden" name="back" value={back} />
              <span><b>{r.full_name}</b> · {r.uhid} · DOB {birthLabel(r.birth_date, r.birth_precision)}</span>
              <input name="reason" required minLength={5} placeholder="Evidence (e.g. name, DOB and phone confirmed with the patient)" />
              <button className="btn">Merge into this chart</button>
            </form>))}
          {mergeLog.length > 0 && <p className="small">History: {mergeLog.map((x) => `${x.source_uhid} → ${x.survivor_uhid} (${label(x.status)})`).join(' · ')} — <Link href={`/${slug}/records`}>records desk</Link></p>}
        </div>)}

      {m.portal && can(session.role, 'portal.manage') && (
        <div className="card"><h2>Patient portal access</h2>
          <p className="small muted">A verified phone number alone never shows a chart. Link each phone only after checking the person’s identity and, for a representative, their authority.</p>
          {links.length > 0 && <table className="table small"><tbody>{links.map((l) => (
            <tr key={l.id}><td>{l.phone_e164}</td><td>{label(l.relation)}</td><td>{[l.can_schedule && 'appointments', l.can_view_documents && 'documents', l.can_pay && 'payments'].filter(Boolean).join(', ')}</td>
              <td className="small">{l.evidence} — {l.verifier}{l.valid_until ? ` · until ${l.valid_until}` : ''}</td>
              <td><form action={portalLinkAction.bind(null, slug, id)} className="inline-form"><input type="hidden" name="op" value="revoke" /><input type="hidden" name="linkId" value={l.id} /><input name="reason" placeholder="Reason" required /><button className="btn small danger">Revoke</button></form></td></tr>))}</tbody></table>}
          <form action={portalLinkAction.bind(null, slug, id)} className="inline-form wrap">
            <input name="phone" placeholder="Mobile number" defaultValue={p.phone_e164 ?? ''} required />
            <select name="relation"><option value="self">Self</option><option value="parent">Parent</option><option value="guardian">Guardian</option><option value="spouse">Spouse</option><option value="child">Adult child</option><option value="representative">Authorised representative</option></select>
            <label className="check"><input type="checkbox" name="canSchedule" defaultChecked /> Appointments</label>
            <label className="check"><input type="checkbox" name="canViewDocuments" defaultChecked /> Documents</label>
            <label className="check"><input type="checkbox" name="canPay" defaultChecked /> Payments</label>
            <input type="date" name="validUntil" title="Valid until (e.g. child turns 18)" />
            <input name="evidence" placeholder="How identity/authority was verified" required minLength={5} />
            <button className="btn small primary">Grant access</button></form>
        </div>)}

      {dispenses.length > 0 && (
        <div className="card"><h2>Medicines dispensed</h2>
          <table className="table small"><tbody>{dispenses.map((d) => (
            <tr key={d.line_id}><td>{d.dispense_no}</td><td>{fmtDateTime(d.at, tenant)}</td><td>{d.generic_name} · batch {d.batch_no}</td><td>×{d.qty}{d.qty_returned ? ` (returned ${d.qty_returned})` : ''}</td>
              <td>{d.qty > d.qty_returned && <details><summary className="small">Return</summary><form action={returnAction.bind(null, slug, back)} className="inline-form">
                <input type="hidden" name="lineId" value={d.line_id} /><input name="qty" type="number" min={1} max={d.qty - d.qty_returned} defaultValue={1} />
                <label className="check"><input type="checkbox" name="restock" /> Sealed, restock</label><input name="reason" placeholder="Reason" required /><button className="btn small">Return</button></form></details>}</td></tr>))}</tbody></table></div>)}

      {m.emergencyAccess && can(session.role, 'emergency.review') && (
        <form action={restrictAction.bind(null, slug, id)} className="card inline-form">
          <input type="hidden" name="restricted" value={(p as { restricted?: boolean }).restricted ? '0' : '1'} />
          <b>{(p as { restricted?: boolean }).restricted ? 'Remove restriction' : 'Restrict this record'}</b>
          <input name="reason" placeholder="Reason (e.g. staff member, public figure, sensitive care)" required />
          <button className="btn small">{(p as { restricted?: boolean }).restricted ? 'Unrestrict' : 'Restrict'}</button></form>)}
    </>
  );
}
