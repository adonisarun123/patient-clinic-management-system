import Link from 'next/link';
import { requireStaff } from '@/lib/session';
import { can } from '@/lib/rbac';
import * as ot from '@/domain/theatre';
import { requireModule } from '@/domain/tenants';
import { getPatient, searchPatients } from '@/domain/patients';
import { listCatalog } from '@/domain/catalog';
import { withTenant } from '@/lib/db';
import { fmtTime, label, money } from '@/lib/format';
import { Empty, Flash, PageHead, PatientBanner } from '@/components/ui';
import { theatreAction } from '../theatre-actions';

export default async function TheatreList({ params, searchParams }: { params: Promise<{ tenant: string }>; searchParams: Promise<{ date?: string; book?: string; q?: string; tab?: string; ok?: string; err?: string }> }) {
  const { tenant: slug } = await params;
  const sp = await searchParams;
  const { tenant, actor, session } = await requireStaff(slug, 'clinical.read');
  requireModule(tenant, 'theatre');
  const today = new Date().toLocaleDateString('en-CA', { timeZone: tenant.timezone });
  const day = /^\d{4}-\d{2}-\d{2}$/.test(sp.date ?? '') ? sp.date! : today;
  const [list, rooms] = await Promise.all([ot.theatreList(actor, tenant, day), ot.listTheatres(actor, tenant)]);
  const canBook = can(session.role, 'theatre.schedule');
  const bookPatient = canBook && sp.book ? await getPatient(actor, sp.book) : null;
  const found = canBook && sp.q ? await searchPatients(actor, sp.q) : [];
  const cat = bookPatient ? await listCatalog(tenant.id) : null;
  const adm = bookPatient ? await withTenant(tenant.id, (tx) => tx.maybe<{ id: string; admission_no: string }>(`SELECT id, admission_no FROM admission WHERE patient_id = $1 AND status = 'admitted'`, [bookPatient.id])) : null;
  const active = rooms.filter((r) => r.active);
  const back = `/${slug}/theatre?date=${day}`;
  const phaseLabel = (ph: string[]) => ['sign_in', 'time_out', 'sign_out'].map((p) => (ph.includes(p) ? '●' : '○')).join('');
  return (
    <>
      <PageHead title="Operating theatre" sub={`${list.length} case(s) on ${day}`}>
        <form className="toolbar"><input type="date" name="date" defaultValue={day} /><button className="btn">Show</button></form>
        {can(session.role, 'settings.manage') && <Link className="btn" href="?tab=rooms">Theatres</Link>}
      </PageHead>
      <Flash ok={sp.ok} err={sp.err} />
      {sp.tab === 'rooms' && can(session.role, 'settings.manage') && (
        <div className="card">
          <table className="table small"><thead><tr><th>Code</th><th>Name</th><th>Rate / hour</th><th>Turnover</th><th /></tr></thead>
            <tbody>{rooms.map((r) => <tr key={r.id} className={r.active ? '' : 'dim'}><td>{r.code}</td><td>{r.name}</td><td>{money(r.hourly_rate_paise, tenant)}</td><td>{r.turnover_minutes} min</td><td>{r.active ? 'In use' : 'Closed'}</td></tr>)}</tbody></table>
          <form action={theatreAction.bind(null, slug)} className="inline-form wrap"><input type="hidden" name="op" value="room" /><input type="hidden" name="back" value={`${back}&tab=rooms`} />
            <input name="code" placeholder="Code (OT1)" required /><input name="name" placeholder="Name" required /><input name="rate" inputMode="decimal" placeholder={`Rate per hour (${tenant.currency})`} />
            <input name="turnover" type="number" min={0} max={240} defaultValue={30} title="Cleaning/turnover minutes after each case" /><button className="btn small primary">Add theatre</button></form>
        </div>)}
      <div className="card">
        {list.length === 0 ? <Empty>No operations listed.</Empty> : (
          <table className="table"><thead><tr><th>Time</th><th>Theatre</th><th>Patient</th><th>Procedure</th><th>Team</th><th>Checklist</th><th>Status</th></tr></thead>
            <tbody>{list.map((c) => (
              <tr key={c.id} className={c.status === 'cancelled' ? 'dim' : c.status === 'in_theatre' ? 'highlight' : ''}>
                <td>{fmtTime(c.start_at, tenant)}–{fmtTime(c.end_at, tenant)}</td><td>{c.theatre_code}</td>
                <td><Link href={`/${slug}/theatre/${c.id}`}><b>{c.full_name}</b></Link><br /><small>{c.uhid} · {c.case_no}</small></td>
                <td>{c.procedure_name}{c.laterality !== 'na' ? <span className="pill">{label(c.laterality)}</span> : null}{c.priority !== 'elective' ? <span className="pill danger">{label(c.priority)}</span> : null}</td>
                <td><small>{c.surgeon}{c.anaesthetist ? ` · ${c.anaesthetist}` : ''}<br />{label(c.anaesthesia)}</small></td>
                <td title="Sign in · Time out · Sign out">{phaseLabel(c.phases)}</td><td>{label(c.status)}</td></tr>))}</tbody></table>)}
      </div>
      {canBook && (
        <div className="card">
          <h2>Schedule an operation</h2>
          {!active.length ? <p className="small muted">Add a theatre first (Theatres).</p> : !bookPatient ? (
            <><form className="search"><input type="hidden" name="date" value={day} /><input name="q" defaultValue={sp.q} placeholder="Find patient" /><button className="btn">Find</button></form>
              {found.map((r) => <p key={r.id}><Link href={`?date=${day}&book=${r.id}`}>{r.full_name}</Link> · {r.uhid}</p>)}</>
          ) : (
            <><PatientBanner p={bookPatient} slug={slug} />
              <form action={theatreAction.bind(null, slug)} className="form-grid">
                <input type="hidden" name="op" value="schedule" /><input type="hidden" name="patientId" value={bookPatient.id} /><input type="hidden" name="back" value={`${back}&book=${bookPatient.id}`} />
                <label className="span2">Procedure<input name="procedureName" required minLength={3} /></label>
                <label>Side<select name="laterality" defaultValue="na"><option value="na">Not applicable</option><option value="left">Left</option><option value="right">Right</option><option value="bilateral">Bilateral</option></select></label>
                <label>Priority<select name="priority"><option value="elective">Elective</option><option value="urgent">Urgent</option><option value="emergency">Emergency</option></select></label>
                <label>Theatre<select name="theatreId">{active.map((r) => <option key={r.id} value={r.id}>{r.code} · {r.name}</option>)}</select></label>
                <label>Start<input type="datetime-local" name="start" required defaultValue={`${day}T09:00`} /></label>
                <label>Expected duration (min)<input type="number" name="duration" min={10} max={960} defaultValue={60} /></label>
                <label>Surgeon<select name="surgeonId" defaultValue={session.clinicianId ?? ''}>{cat!.clinicians.filter((c) => c.active).map((c) => <option key={c.id} value={c.id}>{c.display_name}</option>)}</select></label>
                <label>Anaesthesia<select name="anaesthesia">{['general', 'spinal', 'epidural', 'regional_block', 'local', 'sedation', 'none'].map((a) => <option key={a} value={a}>{label(a)}</option>)}</select></label>
                <label>Anaesthetist<select name="anaesthetistId"><option value="">—</option>{cat!.clinicians.filter((c) => c.active).map((c) => <option key={c.id} value={c.id}>{c.display_name}</option>)}</select></label>
                <label>Procedure fee (service)<select name="serviceId"><option value="">— none —</option>{cat!.services.filter((x) => x.active).map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</select></label>
                {adm && <label className="check"><input type="checkbox" name="admissionId" value={adm.id} defaultChecked /> Link to admission {adm.admission_no}</label>}
                <label className="span2">Notes (equipment, implants, blood)<input name="notes" /></label>
                <div className="span2"><button className="btn primary">Schedule</button> <Link href={back}>Cancel</Link></div>
              </form></>)}
        </div>)}
    </>
  );
}
