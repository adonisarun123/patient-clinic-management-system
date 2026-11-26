import Link from 'next/link';
import { requireStaff } from '@/lib/session';
import { listQueue } from '@/domain/queue';
import { listCatalog } from '@/domain/catalog';
import { can } from '@/lib/rbac';
import { fmtTime } from '@/lib/format';
import { Badge, Empty, Flash, PageHead } from '@/components/ui';
import { queueAction } from '../actions';

const PRIORITY = ['Routine', 'Soon', 'Urgent', 'Emergency'];

export default async function Queue({ params, searchParams }: { params: Promise<{ tenant: string }>; searchParams: Promise<{ departmentId?: string; mine?: string; done?: string; ok?: string; err?: string }> }) {
  const { tenant: slug } = await params;
  const sp = await searchParams;
  const { tenant, actor, session } = await requireStaff(slug, 'schedule.read');
  const cat = await listCatalog(tenant.id);
  const mine = sp.mine === '1' && session.clinicianId ? session.clinicianId : undefined;
  const rows = await listQueue(actor, tenant, { departmentId: sp.departmentId, clinicianId: mine, includeDone: sp.done === '1' });
  const clinical = can(session.role, 'clinical.write');
  return (
    <>
      <PageHead title="Queue" sub="Ordered by clinical priority, then scheduled time (booked) or arrival time (walk-in).">
        <Link className="btn" href={`/${slug}/board`} target="_blank">Waiting-room screen</Link>
        <Link className="btn" href={`/${slug}/patients`}>Add walk-in</Link>
      </PageHead>
      <Flash ok={sp.ok} err={sp.err} />
      <form className="toolbar">
        <select name="departmentId" defaultValue={sp.departmentId ?? ''}><option value="">All departments</option>{cat.departments.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}</select>
        {session.clinicianId && <label className="check"><input type="checkbox" name="mine" value="1" defaultChecked={sp.mine === '1'} /> My patients</label>}
        <label className="check"><input type="checkbox" name="done" value="1" defaultChecked={sp.done === '1'} /> Include seen</label>
        <button className="btn">Filter</button>
      </form>
      <div className="card">
        {rows.length === 0 ? <Empty>Nobody is waiting.</Empty> : (
          <table className="table">
            <thead><tr><th>Token</th><th>Patient</th><th>Due / arrived</th><th>Doctor</th><th>Priority</th><th>Status</th><th>Actions</th></tr></thead>
            <tbody>{rows.map((q) => (
              <tr key={q.id} className={q.priority >= 2 ? 'urgent' : ''}>
                <td className="token">{q.token_no}</td>
                <td><Link href={`/${slug}/patients/${q.patient_id}`}><b>{q.full_name}</b></Link><br /><small className="muted">{q.uhid} · {q.kind === 'walk_in' ? 'Walk-in' : 'Booked'}{q.service_name ? ` · ${q.service_name}` : ''}</small></td>
                <td>{q.kind === 'booked' ? `Due ${fmtTime(q.due_at, tenant)}` : '—'}<br /><small className="muted">Arrived {fmtTime(q.checked_in_at, tenant)}</small></td>
                <td>{q.clinician_name ?? <span className="muted">Unassigned</span>}<br /><small className="muted">{q.location_name ?? q.department_name}</small></td>
                <td>{PRIORITY[q.priority]}{q.priority_reason ? <div className="small muted">{q.priority_reason}</div> : null}</td>
                <td><Badge v={q.status} />{q.call_count > 0 && q.status === 'called' ? <small className="muted"> ×{q.call_count}</small> : null}</td>
                <td className="row-actions">
                  {q.encounter_id ? <Link className="btn small primary" href={`/${slug}/encounters/${q.encounter_id}`}>Open visit</Link> : (
                    <>
                      {['waiting', 'called'].includes(q.status) && <form action={queueAction.bind(null, slug, q.id)}><input type="hidden" name="op" value="call" /><button className="btn small">Call</button></form>}
                      {clinical && ['waiting', 'called'].includes(q.status) && <form action={queueAction.bind(null, slug, q.id)}><input type="hidden" name="op" value="start" /><button className="btn small primary">Start consult</button></form>}
                      {['waiting', 'called'].includes(q.status) && (
                        <details><summary className="btn small">More</summary><div className="pop">
                          {can(session.role, 'queue.triage') && <form action={queueAction.bind(null, slug, q.id)} className="inline-form"><input type="hidden" name="op" value="priority" />
                            <select name="priority" defaultValue={q.priority}>{PRIORITY.map((p, i) => <option key={p} value={i}>{p}</option>)}</select><input name="reason" placeholder="Clinical reason" required /><button className="btn small">Set</button></form>}
                          <form action={queueAction.bind(null, slug, q.id)} className="inline-form"><input type="hidden" name="op" value="left" /><input name="reason" placeholder="Reason" /><button className="btn small danger">Left before seen</button></form>
                        </div></details>)}
                    </>)}
                </td>
              </tr>))}</tbody>
          </table>)}
      </div>
    </>
  );
}
