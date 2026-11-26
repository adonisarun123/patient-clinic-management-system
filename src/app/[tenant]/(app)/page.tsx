import Link from 'next/link';
import { requireStaff } from '@/lib/session';
import { dayAppointments, impactedAppointments } from '@/domain/scheduling';
import { listQueue } from '@/domain/queue';
import { followUpWorklist } from '@/domain/clinical';
import { identityReviewQueue } from '@/domain/patients';
import { fmtTime, today, label } from '@/lib/format';
import { Badge, Empty, Flash, PageHead } from '@/components/ui';
import { can } from '@/lib/rbac';

export default async function Today({ params, searchParams }: { params: Promise<{ tenant: string }>; searchParams: Promise<{ ok?: string; err?: string }> }) {
  const { tenant: slug } = await params;
  const sp = await searchParams;
  const { tenant, actor, session } = await requireStaff(slug, 'schedule.read');
  const date = today(tenant);
  const mine = session.role === 'doctor' && session.clinicianId ? { clinicianId: session.clinicianId } : {};
  const [appts, queue, fus, ids, impacted] = [
    await dayAppointments(actor, tenant, date, mine), await listQueue(actor, tenant, mine),
    await followUpWorklist(actor, tenant, { horizonDays: 0 }), can(session.role, 'patient.read') ? await identityReviewQueue(actor) : [],
    await impactedAppointments(actor, tenant),
  ];
  const count = (st: string) => appts.filter((a) => a.state === st).length;
  return (
    <>
      <PageHead title={`Good ${new Date().getHours() < 12 ? 'morning' : 'day'}, ${session.name.split(' ')[0]}`} sub={new Date().toLocaleDateString(tenant.locale, { weekday: 'long', day: 'numeric', month: 'long', timeZone: tenant.timezone })}>
        <Link className="btn primary" href={`/${slug}/appointments/new`}>Book appointment</Link>
        <Link className="btn" href={`/${slug}/patients/new`}>Register patient</Link>
      </PageHead>
      <Flash {...sp} />
      <div className="stats">
        <div className="stat"><b>{appts.length - count('cancelled')}</b><span>Booked today</span></div>
        <div className="stat"><b>{count('arrived') + count('in_service')}</b><span>Arrived / in consult</span></div>
        <div className="stat"><b>{queue.filter((q) => q.status === 'waiting').length}</b><span>Waiting</span></div>
        <div className="stat"><b>{count('completed')}</b><span>Completed</span></div>
      </div>
      {(ids.length > 0 || impacted.length > 0 || fus.length > 0) && (
        <div className="card">
          <h2>Needs attention</h2>
          <ul className="list">
            {ids.length > 0 && <li><Link href={`/${slug}/patients?review=1`}>{ids.length} online/temporary registration(s) need identity confirmation</Link></li>}
            {impacted.length > 0 && <li><Link href={`/${slug}/appointments?view=impacted`}>{impacted.length} booking(s) fall on doctor leave or closure — rebook or cancel</Link></li>}
            {fus.length > 0 && <li><Link href={`/${slug}/follow-ups`}>{fus.length} follow-up(s) due or overdue</Link></li>}
          </ul>
        </div>
      )}
      <div className="card">
        <div className="row-between"><h2>{mine.clinicianId ? 'My appointments' : 'Today’s appointments'}</h2><Link href={`/${slug}/appointments`}>Day view →</Link></div>
        {appts.length === 0 ? <Empty>No appointments today.</Empty> : (
          <table className="table"><thead><tr><th>Time</th><th>Patient</th><th>Doctor</th><th>Service</th><th>Status</th></tr></thead>
            <tbody>{appts.map((a) => (
              <tr key={a.id}><td>{fmtTime(a.start_at, tenant)}</td><td><Link href={`/${slug}/patients/${a.patient_id}`}>{a.full_name}</Link> <small className="muted">{a.uhid}</small></td>
                <td>{a.clinician_name}</td><td>{a.service_name}</td><td><Badge v={a.state} />{a.token_no ? <small className="muted"> #{a.token_no}</small> : null}</td></tr>))}
            </tbody></table>)}
      </div>
      <p className="muted small">Signed in as {label(session.role)}.</p>
    </>
  );
}
