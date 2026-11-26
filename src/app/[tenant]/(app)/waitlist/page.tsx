import Link from 'next/link';
import { requireStaff } from '@/lib/session';
import { listWaitlist } from '@/domain/frontdesk';
import { listCatalog } from '@/domain/catalog';
import { fmtDate, fmtDateTime } from '@/lib/format';
import { Empty, Flash, PageHead, RequestKey } from '@/components/ui';
import { waitlistAction } from '../frontdesk-actions';

const PRI = ['Routine', 'Soon', 'Urgent'];

export default async function Waitlist({ params, searchParams }: { params: Promise<{ tenant: string }>; searchParams: Promise<{ status?: string; ok?: string; err?: string }> }) {
  const { tenant: slug } = await params;
  const sp = await searchParams;
  const { tenant, actor } = await requireStaff(slug, 'schedule.read');
  const status = (['waiting', 'booked', 'removed'].includes(sp.status ?? '') ? sp.status : 'waiting') as 'waiting';
  const rows = await listWaitlist(actor, tenant, status);
  const cat = await listCatalog(tenant.id);
  const doc = (id: string | null) => (id ? cat.clinicians.find((c) => c.id === id)?.display_name ?? '' : 'Any doctor');
  const matched = rows.filter((r) => r.match_start && +new Date(r.match_start) > Date.now());
  return (
    <>
      <PageHead title="Waitlist" sub="Patients waiting for an earlier or specific slot. When a booking is cancelled, entries it fits are highlighted here and a webhook (waitlist.slot_available) is sent." />
      <Flash ok={sp.ok} err={sp.err} />
      <div className="tabs">{['waiting', 'booked', 'removed'].map((s) => <Link key={s} href={`/${slug}/waitlist?status=${s}`} className={s === status ? 'on' : ''}>{s[0].toUpperCase() + s.slice(1)}</Link>)}</div>
      {status === 'waiting' && matched.length > 0 && <p className="flash ok">{matched.length} waiting patient(s) have a freed slot that fits. Call them and book, or clear the match if they decline.</p>}
      {rows.length === 0 ? <Empty>No entries. Add patients from the booking screen when no suitable time is free.</Empty> : (
        <div className="card"><table className="table small">
          <thead><tr><th>Patient</th><th>Service · doctor</th><th>Window</th><th>Priority</th><th>Freed slot</th><th /></tr></thead>
          <tbody>{rows.map((r) => {
            const live = r.match_start && +new Date(r.match_start) > Date.now();
            return (
              <tr key={r.id} className={live ? 'highlight' : ''}>
                <td><Link href={`/${slug}/patients/${r.patient_id}`}>{r.full_name}</Link><br /><small>{r.uhid}{r.phone ? ` · ${r.phone}` : ''}</small>{r.notes && <><br /><small className="muted">{r.notes}</small></>}</td>
                <td>{r.service_name}<br /><small>{doc(r.clinician_id)}</small></td>
                <td>{fmtDate(r.earliest_date, tenant)} – {fmtDate(r.latest_date, tenant)}<br /><small>{r.time_pref === 'any' ? 'any time' : r.time_pref}</small></td>
                <td>{PRI[r.priority]}</td>
                <td>{live ? <b>{fmtDateTime(r.match_start, tenant)}<br /><small>{doc(r.match_clinician)}</small></b> : <span className="muted">—</span>}</td>
                <td className="row-actions">{status === 'waiting' && <>
                  {live && <form action={waitlistAction.bind(null, slug)}><RequestKey /><input type="hidden" name="op" value="book" /><input type="hidden" name="id" value={r.id} />
                    <input type="hidden" name="start" value={new Date(r.match_start!).toISOString()} /><input type="hidden" name="clinicianId" value={r.match_clinician ?? ''} /><button className="btn small primary">Book this slot</button></form>}
                  {live && <form action={waitlistAction.bind(null, slug)}><input type="hidden" name="op" value="decline" /><input type="hidden" name="id" value={r.id} /><button className="btn small">Declined</button></form>}
                  <Link className="btn small" href={`/${slug}/appointments/new?patientId=${r.patient_id}&serviceId=${r.service_id}${r.clinician_id ? `&clinicianId=${r.clinician_id}` : ''}&date=${r.earliest_date}`}>Find a time</Link>
                  <form action={waitlistAction.bind(null, slug)} className="inline-form"><input type="hidden" name="op" value="remove" /><input type="hidden" name="id" value={r.id} />
                    <input name="reason" placeholder="Reason" required size={10} /><button className="btn small">Remove</button></form>
                </>}</td>
              </tr>);
          })}</tbody></table></div>
      )}
    </>
  );
}
