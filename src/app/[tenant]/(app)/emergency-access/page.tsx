import Link from 'next/link';
import { requireStaff } from '@/lib/session';
import { requireModule } from '@/domain/tenants';
import { emergencyReviewQueue } from '@/domain/access';
import { fmtDateTime, label } from '@/lib/format';
import { Empty, Flash, PageHead } from '@/components/ui';
import { reviewGrantAction } from '../module-actions';

export default async function EmergencyReview({ params, searchParams }: { params: Promise<{ tenant: string }>; searchParams: Promise<{ ok?: string; err?: string }> }) {
  const { tenant: slug } = await params;
  const sp = await searchParams;
  const { tenant, actor } = await requireStaff(slug, 'emergency.review');
  requireModule(tenant, 'emergencyAccess');
  const rows = await emergencyReviewQueue(actor, tenant);
  return (
    <>
      <PageHead title="Emergency access review" sub="Every break-glass access to a restricted record must be reviewed. Reviewing also ends any remaining access time." />
      <Flash {...sp} />
      <div className="card">{rows.length === 0 ? <Empty>Nothing to review.</Empty> : (
        <table className="table"><thead><tr><th>When</th><th>Staff</th><th>Patient</th><th>Reason given</th><th>Records opened</th><th>Review</th></tr></thead>
          <tbody>{rows.map((r) => (
            <tr key={r.id}><td>{fmtDateTime(r.granted_at, tenant)}<br /><small className="muted">until {fmtDateTime(r.expires_at, tenant)}</small></td>
              <td>{r.staff_name}<br /><small className="muted">{label(r.staff_role)}</small></td><td><Link href={`/${slug}/patients/${r.patient_id}`}>{r.full_name}</Link> · {r.uhid}</td>
              <td>{r.reason}</td><td>{r.views}</td>
              <td><form action={reviewGrantAction.bind(null, slug, r.id)} className="inline-form">
                <select name="outcome"><option value="appropriate">Appropriate</option><option value="needs_follow_up">Needs follow-up</option><option value="inappropriate">Inappropriate</option></select>
                <input name="note" placeholder="Note" /><button className="btn small">Record</button></form></td></tr>))}</tbody></table>)}</div>
      <p className="small muted">Full detail of what was opened is in Reports › Audit trail.</p>
    </>
  );
}
