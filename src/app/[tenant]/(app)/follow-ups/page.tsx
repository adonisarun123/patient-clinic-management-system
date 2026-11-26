import Link from 'next/link';
import { requireStaff } from '@/lib/session';
import { followUpWorklist } from '@/domain/clinical';
import { fmtDate } from '@/lib/format';
import { Empty, Flash, PageHead } from '@/components/ui';
import { followUpAction } from '../actions';

export default async function FollowUps({ params, searchParams }: { params: Promise<{ tenant: string }>; searchParams: Promise<{ mine?: string; days?: string; ok?: string; err?: string }> }) {
  const { tenant: slug } = await params;
  const sp = await searchParams;
  const { tenant, actor, session } = await requireStaff(slug, 'schedule.read');
  const rows = await followUpWorklist(actor, tenant, { ownerId: sp.mine ? session.staffId : undefined, horizonDays: Number(sp.days ?? 14) });
  const back = `/${slug}/follow-ups`;
  return (
    <>
      <PageHead title="Follow-ups and recalls" sub="Every follow-up has an owner and a due date. Record each outcome." />
      <Flash ok={sp.ok} err={sp.err} />
      <form className="toolbar"><label className="check"><input type="checkbox" name="mine" value="1" defaultChecked={!!sp.mine} /> Mine only</label>
        <select name="days" defaultValue={sp.days ?? '14'}><option value="0">Due today / overdue</option><option value="7">Next 7 days</option><option value="14">Next 14 days</option><option value="60">Next 60 days</option></select><button className="btn">Filter</button></form>
      <div className="card">{rows.length === 0 ? <Empty>No open follow-ups in this window.</Empty> : (
        <table className="table"><thead><tr><th>Due</th><th>Patient</th><th>Reason</th><th>Doctor / owner</th><th>Outcome</th></tr></thead>
          <tbody>{rows.map((f) => (
            <tr key={f.id} className={f.overdue ? 'urgent' : ''}>
              <td>{fmtDate(f.due_date, tenant)}{f.overdue && <div className="pill danger">Overdue</div>}</td>
              <td><Link href={`/${slug}/patients/${f.patient_id}`}>{f.full_name}</Link><br /><small className="muted">{f.uhid} · {f.phone_e164 ?? 'no phone'}</small></td>
              <td>{f.reason}</td><td>{f.clinician_name ?? '—'}<br /><small className="muted">{f.owner_name ?? 'Unassigned'}</small></td>
              <td>
                <Link className="btn small" href={`/${slug}/appointments/new?patientId=${f.patient_id}`}>Book</Link>
                <form action={followUpAction.bind(null, slug, back)} className="inline-form">
                  <input type="hidden" name="followUpId" value={f.id} />
                  <select name="status"><option value="completed">Done / contacted</option><option value="booked">Booked</option><option value="cancelled">Not needed</option></select>
                  <input name="outcome" placeholder="Outcome (e.g. called, booked 12 Dec)" required /><button className="btn small">Save</button>
                </form>
              </td></tr>))}</tbody></table>)}</div>
    </>
  );
}
