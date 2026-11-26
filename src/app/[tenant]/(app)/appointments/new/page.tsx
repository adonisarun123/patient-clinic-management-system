import Link from 'next/link';
import { requireStaff } from '@/lib/session';
import { getPatient, searchPatients } from '@/domain/patients';
import { appointmentDetail, getAvailability } from '@/domain/scheduling';
import { listCatalog } from '@/domain/catalog';
import { birthLabel } from '@/lib/identity';
import { fmtDateTime, fmtTime, money, today } from '@/lib/format';
import { Empty, Flash, PageHead, PatientBanner, RequestKey } from '@/components/ui';
import { apptAction, bookAction } from '../../actions';
import { seriesAction, waitlistAction } from '../../frontdesk-actions';
import { isoToLocalInput } from '@/lib/format';

type Sp = { q?: string; patientId?: string; serviceId?: string; clinicianId?: string; date?: string; reschedule?: string; ok?: string; err?: string };

export default async function NewAppointment({ params, searchParams }: { params: Promise<{ tenant: string }>; searchParams: Promise<Sp> }) {
  const { tenant: slug } = await params;
  const sp = await searchParams;
  const { tenant, actor } = await requireStaff(slug, 'schedule.book');
  const cat = await listCatalog(tenant.id);
  const resched = sp.reschedule ? (await appointmentDetail(actor, tenant, sp.reschedule)).appointment : null;
  const patientId = resched?.patient_id ?? sp.patientId;
  const patient = patientId ? await getPatient(actor, patientId) : null;
  const serviceId = resched?.service_id ?? sp.serviceId;
  const service = cat.services.find((s) => s.id === serviceId);
  const date = sp.date ?? today(tenant);
  const avail = service ? await getAvailability(actor, tenant, { serviceId: service.id, clinicianId: sp.clinicianId || null, from: date, days: 1 }) : null;
  const found = !patient && sp.q ? await searchPatients(actor, sp.q) : [];
  const name = (id: string) => cat.clinicians.find((c) => c.id === id)?.display_name ?? '';
  const here = `/${slug}/appointments/new`;
  const keep = (extra: Record<string, string | undefined>) => {
    const u = new URLSearchParams();
    for (const [k, v] of Object.entries({ patientId, serviceId, clinicianId: sp.clinicianId, date, reschedule: sp.reschedule, ...extra })) if (v) u.set(k, v);
    return `${here}?${u}`;
  };

  return (
    <>
      <PageHead title={resched ? `Reschedule ${resched.booking_ref}` : 'Book appointment'} sub={resched ? `Currently ${fmtDateTime(resched.start_at, tenant)} with ${name(resched.clinician_id)}` : undefined} />
      <Flash ok={sp.ok} err={sp.err} />
      {!patient ? (
        <div className="card">
          <h2>1. Find the patient</h2>
          <form className="search"><input name="q" defaultValue={sp.q} placeholder="UHID, mobile or name" autoFocus /><button className="btn primary">Search</button></form>
          {found.map((r) => (
            <p key={r.id}><Link href={keep({ patientId: r.id })}><b>{r.full_name}</b></Link> · {r.uhid} · DOB {birthLabel(r.birth_date, r.birth_precision)} · <small className="muted">{r.reason}</small></p>))}
          {sp.q && found.length === 0 && <Empty>No match.</Empty>}
          <p className="small">New patient? <Link href={`/${slug}/patients/new`}>Register first</Link>.</p>
        </div>
      ) : (
        <>
          <PatientBanner p={patient} slug={slug} />
          <form className="card toolbar wrap">
            <input type="hidden" name="patientId" value={patient.id} />
            {sp.reschedule && <input type="hidden" name="reschedule" value={sp.reschedule} />}
            <label>Service<select name="serviceId" defaultValue={serviceId ?? ''} required disabled={!!resched}>
              <option value="">Choose…</option>
              {cat.departments.map((d) => <optgroup key={d.id} label={d.name}>{cat.services.filter((s) => s.department_id === d.id && s.active).map((s) => <option key={s.id} value={s.id}>{s.name} · {s.duration_min} min · {money(s.price_paise, tenant)}</option>)}</optgroup>)}
            </select></label>
            {resched && <input type="hidden" name="serviceId" value={serviceId} />}
            <label>Doctor<select name="clinicianId" defaultValue={sp.clinicianId ?? ''}><option value="">Any eligible</option>
              {(service ? cat.clinicians.filter((c) => service.clinician_ids.includes(c.id)) : cat.clinicians).map((c) => <option key={c.id} value={c.id}>{c.display_name}</option>)}</select></label>
            <label>Date<input type="date" name="date" defaultValue={date} min={today(tenant)} /></label>
            <button className="btn primary">Show times</button>
          </form>
          {avail && (
            <div className="card">
              <h2>Available times</h2>
              {avail.slots.length === 0 ? <Empty>No free times on this day. Try another date or doctor.</Empty> : (
                resched ? (
                  <form action={apptAction.bind(null, slug, resched.id, keep({}))} className="slots-form">
                    <RequestKey /><input type="hidden" name="op" value="reschedule" /><input type="hidden" name="version" value={resched.version} />
                    <label>Reason for change<input name="reason" required minLength={3} placeholder="e.g. Patient request; doctor on leave" /></label>
                    <div className="slots">{avail.slots.map((s) => (
                      <button key={s.start + s.clinicianId} className="slot" name="slot" value={`${s.start}|${s.clinicianId}`}>{fmtTime(s.start, tenant)}<small>{name(s.clinicianId)}</small></button>))}</div>
                  </form>
                ) : (
                  <div className="slots">{avail.slots.map((s) => (
                    <form key={s.start + s.clinicianId} action={bookAction.bind(null, slug)}>
                      <RequestKey />
                      <input type="hidden" name="patientId" value={patient.id} /><input type="hidden" name="serviceId" value={service!.id} />
                      <input type="hidden" name="clinicianId" value={s.clinicianId} /><input type="hidden" name="start" value={s.start} />
                      <input type="hidden" name="back" value={keep({})} />
                      <button className="slot">{fmtTime(s.start, tenant)}<small>{name(s.clinicianId)}</small></button>
                    </form>))}</div>
                ))}
            </div>
          )}
          {service && !resched && (
            <div className="grid2">
              <form action={seriesAction.bind(null, slug)} className="card form-grid">
                <h2 className="span2">Repeat visits</h2>
                <p className="small muted span2">Books a course (e.g. physiotherapy twice a week) at the same clock time. All visits are checked against the diary.</p>
                <input type="hidden" name="patientId" value={patient.id} /><input type="hidden" name="serviceId" value={service.id} /><input type="hidden" name="back" value={keep({})} />
                <label>Doctor<select name="clinicianId" defaultValue={sp.clinicianId ?? ''} required>{cat.clinicians.filter((c) => service.clinician_ids.includes(c.id)).map((c) => <option key={c.id} value={c.id}>{c.display_name}</option>)}</select></label>
                <label>First visit<input type="datetime-local" name="firstStart" required defaultValue={avail?.slots[0] ? isoToLocalInput(avail.slots[0].start, tenant.timezone) : ''} /></label>
                <label>Repeat<select name="freq"><option value="weekly">Weekly</option><option value="daily">Daily</option></select></label>
                <label>Every<input type="number" name="everyN" min={1} max={8} defaultValue={1} /></label>
                <label>Number of visits<input type="number" name="count" min={2} max={52} defaultValue={6} required /></label>
                <label className="check"><input type="checkbox" name="skip" /> Skip dates that are not free (otherwise book nothing)</label>
                <div className="span2"><button className="btn primary">Book series</button></div>
              </form>
              <form action={waitlistAction.bind(null, slug)} className="card form-grid">
                <h2 className="span2">Add to waitlist</h2>
                <p className="small muted span2">No suitable time? The patient is flagged when a matching slot is cancelled.</p>
                <input type="hidden" name="op" value="add" /><input type="hidden" name="patientId" value={patient.id} /><input type="hidden" name="serviceId" value={service.id} /><input type="hidden" name="back" value={keep({})} />
                <label>Doctor<select name="clinicianId" defaultValue={sp.clinicianId ?? ''}><option value="">Any eligible</option>{cat.clinicians.filter((c) => service.clinician_ids.includes(c.id)).map((c) => <option key={c.id} value={c.id}>{c.display_name}</option>)}</select></label>
                <label>Time of day<select name="timePref"><option value="any">Any</option><option value="morning">Morning</option><option value="afternoon">Afternoon</option><option value="evening">Evening</option></select></label>
                <label>From<input type="date" name="earliestDate" defaultValue={date} min={today(tenant)} required /></label>
                <label>Until<input type="date" name="latestDate" required /></label>
                <label>Priority<select name="priority"><option value="0">Routine</option><option value="1">Soon</option><option value="2">Urgent</option></select></label>
                <label>Note<input name="notes" /></label>
                <div className="span2"><button className="btn">Add to waitlist</button></div>
              </form>
            </div>
          )}
        </>
      )}
    </>
  );
}
