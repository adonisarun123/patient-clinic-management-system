import Link from 'next/link';
import { requireStaff } from '@/lib/session';
import { dayAppointments, impactedAppointments } from '@/domain/scheduling';
import { listCatalog } from '@/domain/catalog';
import { can } from '@/lib/rbac';
import { maskPhone } from '@/lib/identity';
import { fmtDateTime, fmtTime, today } from '@/lib/format';
import { Badge, Empty, Flash, PageHead } from '@/components/ui';
import { apptAction } from '../actions';

function shift(date: string, n: number) { const d = new Date(`${date}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }

export default async function Appointments({ params, searchParams }: { params: Promise<{ tenant: string }>; searchParams: Promise<{ date?: string; clinicianId?: string; view?: string; ok?: string; err?: string }> }) {
  const { tenant: slug } = await params;
  const sp = await searchParams;
  const { tenant, actor, session } = await requireStaff(slug, 'schedule.read');
  const date = sp.date && /^\d{4}-\d{2}-\d{2}$/.test(sp.date) ? sp.date : today(tenant);
  const cat = await listCatalog(tenant.id);
  const base = `/${slug}/appointments`;
  const qs = (d: string) => `${base}?date=${d}${sp.clinicianId ? `&clinicianId=${sp.clinicianId}` : ''}`;
  const backHere = qs(date);

  if (sp.view === 'impacted') {
    const rows = await impactedAppointments(actor, tenant);
    return (
      <>
        <PageHead title="Bookings affected by leave or closure" sub="Contact each patient, then reschedule or cancel. Each change is logged." />
        <Flash ok={sp.ok} err={sp.err} />
        <div className="card">{rows.length === 0 ? <Empty>Nothing pending.</Empty> : (
          <table className="table"><thead><tr><th>When</th><th>Patient</th><th>Phone</th><th>Doctor</th><th>Reason</th><th /></tr></thead>
            <tbody>{rows.map((r) => (
              <tr key={r.id}><td>{fmtDateTime(r.start_at, tenant)}</td><td>{r.full_name}</td><td>{r.phone_e164 ?? '—'}</td><td>{r.clinician_name}</td><td>{r.reason}</td>
                <td><Link className="btn small" href={`${base}/new?reschedule=${r.id}`}>Reschedule</Link></td></tr>))}</tbody></table>)}</div>
      </>
    );
  }

  const rows = await dayAppointments(actor, tenant, date, { clinicianId: sp.clinicianId });
  const canBook = can(session.role, 'schedule.book');
  return (
    <>
      <PageHead title="Appointments" sub={new Date(`${date}T12:00:00Z`).toLocaleDateString(tenant.locale, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' })}>
        {canBook && <Link className="btn primary" href={`${base}/new`}>Book appointment</Link>}
        <Link className="btn" href={`${base}?view=impacted`}>Impacted by leave</Link>
      </PageHead>
      <Flash ok={sp.ok} err={sp.err} />
      <form className="toolbar">
        <Link className="btn" href={qs(shift(date, -1))} aria-label="Previous day">←</Link>
        <input type="date" name="date" defaultValue={date} />
        <Link className="btn" href={qs(shift(date, 1))} aria-label="Next day">→</Link>
        <select name="clinicianId" defaultValue={sp.clinicianId ?? ''}><option value="">All doctors</option>{cat.clinicians.map((c) => <option key={c.id} value={c.id}>{c.display_name}</option>)}</select>
        <button className="btn">Show</button>
        <Link href={qs(today(tenant))}>Today</Link>
      </form>
      <div className="card">
        {rows.length === 0 ? <Empty>No appointments on this day.</Empty> : (
          <table className="table">
            <thead><tr><th>Time</th><th>Patient</th><th>Doctor · room</th><th>Service</th><th>Status</th><th>Actions</th></tr></thead>
            <tbody>{rows.map((a) => (
              <tr key={a.id} className={a.state === 'cancelled' ? 'dim' : ''}>
                <td>{fmtTime(a.start_at, tenant)}<br /><small className="muted">{a.booking_ref}</small></td>
                <td><Link href={`/${slug}/patients/${a.patient_id}`}><b>{a.full_name}</b></Link><br /><small className="muted">{a.uhid} · {maskPhone(a.phone_e164)}</small>
                  {a.patient_status === 'provisional' && <><br /><span className="pill warn">Online booking — confirm identity</span></>}</td>
                <td>{a.clinician_name}<br /><small className="muted">{a.location_name}</small></td>
                <td>{a.service_name}<br /><small className="muted">{a.source}{a.notes ? ` · ${a.notes}` : ''}</small></td>
                <td><Badge v={a.state} />{a.token_no ? <div className="muted small">Token {a.token_no}</div> : null}</td>
                <td className="row-actions">
                  {a.state === 'booked' && can(session.role, 'queue.manage') && (
                    <form action={apptAction.bind(null, slug, a.id, backHere)} className="inline-form">
                      <input type="hidden" name="op" value="checkin" />
                      <label className="check small"><input type="checkbox" name="idok" required /> 2 IDs checked</label>
                      <button className="btn small primary">Check in</button>
                    </form>)}
                  {a.state === 'booked' && canBook && (
                    <details><summary className="btn small">More</summary>
                      <div className="pop">
                        <Link className="btn small" href={`${base}/new?reschedule=${a.id}`}>Reschedule</Link>
                        <form action={apptAction.bind(null, slug, a.id, backHere)} className="inline-form">
                          <input type="hidden" name="op" value="cancel" /><input type="hidden" name="version" value={a.version} />
                          <input name="reason" placeholder="Cancellation reason" required /><button className="btn small danger">Cancel</button>
                        </form>
                        <form action={apptAction.bind(null, slug, a.id, backHere)}><input type="hidden" name="op" value="noshow" /><button className="btn small">Mark no-show</button></form>
                      </div>
                    </details>)}
                  {['no_show', 'cancelled'].includes(a.state) && can(session.role, 'schedule.override') && (
                    <details><summary className="btn small">Correct</summary>
                      <form action={apptAction.bind(null, slug, a.id, backHere)} className="pop inline-form">
                        <input type="hidden" name="op" value="reinstate" /><input name="reason" placeholder="Why reinstate?" required /><button className="btn small">Reinstate</button>
                      </form></details>)}
                </td>
              </tr>))}
            </tbody>
          </table>)}
      </div>
    </>
  );
}
