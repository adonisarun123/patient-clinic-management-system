import Link from 'next/link';
import { requireStaff } from '@/lib/session';
import { listRecordsRequests } from '@/domain/portal';
import { searchPatients } from '@/domain/patients';
import { fmtDateTime, label } from '@/lib/format';
import { Badge, Empty, Flash, PageHead } from '@/components/ui';
import { recordsRequestAction } from '../module-actions';

export default async function RecordsRequests({ params, searchParams }: { params: Promise<{ tenant: string }>; searchParams: Promise<{ q?: string; ok?: string; err?: string }> }) {
  const { tenant: slug } = await params;
  const sp = await searchParams;
  const { tenant, actor } = await requireStaff(slug, 'records.requests');
  const rows = await listRecordsRequests(actor, tenant);
  const found = sp.q ? await searchPatients(actor, sp.q) : [];
  return (
    <>
      <PageHead title="Records requests" sub={`Copies, corrections, access logs and other requests. Each gets a case number and a response clock (${tenant.settings.recordsRequestDays} days — set in Settings › Modules; confirm the legal timeline that applies).`} />
      <Flash ok={sp.ok} err={sp.err} />
      <div className="card">{rows.length === 0 ? <Empty>No requests.</Empty> : (
        <table className="table"><thead><tr><th>Case</th><th>Requester</th><th>Patient</th><th>Request</th><th>Due</th><th>Status</th><th /></tr></thead>
          <tbody>{rows.map((r) => (
            <tr key={r.id} className={r.overdue ? 'urgent' : ''}><td>{r.case_no}<br /><small className="muted">{r.source} · {fmtDateTime(r.received_at, tenant)}</small></td>
              <td>{r.requester_name}<br /><small className="muted">{label(r.requester_kind)}{r.authority_note ? ` · ${r.authority_note}` : ''}</small></td>
              <td>{r.patient_id ? <Link href={`/${slug}/patients/${r.patient_id}`}>{r.full_name}</Link> : '—'}</td>
              <td>{label(r.request_type)}: {r.scope}<br /><small className="muted">delivery: {r.delivery}</small></td>
              <td>{fmtDateTime(r.due_at, tenant)}{r.overdue ? <span className="pill danger">Overdue</span> : null}</td><td><Badge v={r.status} />{r.outcome ? <div className="small">{r.outcome}</div> : null}</td>
              <td>{['received', 'in_review'].includes(r.status) && (
                <form action={recordsRequestAction.bind(null, slug)} className="inline-form"><input type="hidden" name="id" value={r.id} />
                  <select name="status"><option value="in_review">In review</option><option value="fulfilled">Fulfilled</option><option value="rejected">Rejected</option><option value="withdrawn">Withdrawn</option></select>
                  <input name="outcome" placeholder="What was provided / reason" /><button className="btn small">Update</button></form>)}</td></tr>))}</tbody></table>)}</div>
      <form action={recordsRequestAction.bind(null, slug)} className="card form-grid">
        <h2 className="span2">Log a request received at the desk, by email or post</h2>
        <label>Patient (search below, then pick)<select name="patientId"><option value="">— not yet identified —</option>{found.map((f) => <option key={f.id} value={f.id}>{f.full_name} · {f.uhid}</option>)}</select></label>
        <label>Requester is<select name="requesterKind"><option value="patient">The patient</option><option value="representative">Representative</option><option value="third_party">Third party (insurer, court, employer…)</option></select></label>
        <label>Requester name<input name="requesterName" required /></label><label>Contact<input name="requesterContact" /></label>
        <label className="span2">Authority / identity evidence<input name="authorityNote" placeholder="e.g. ID checked; consent letter dated …" /></label>
        <label>Type<select name="requestType"><option value="copy">Copy of records</option><option value="correction">Correction</option><option value="access_log">Who accessed my record</option><option value="erasure">Erasure</option><option value="consent_withdrawal">Withdraw consent</option><option value="other">Other</option></select></label>
        <label>Delivery<select name="delivery"><option value="print">Printed copy</option><option value="portal">Portal</option><option value="email">Email</option><option value="in_person">In person</option></select></label>
        <label>From<input type="date" name="dateFrom" /></label><label>To<input type="date" name="dateTo" /></label>
        <label className="span2">What is requested<textarea name="scope" rows={2} required /></label>
        <div className="span2"><button className="btn primary">Log request</button></div>
      </form>
      <form className="search card"><input name="q" defaultValue={sp.q} placeholder="Find the patient for a new request" /><button className="btn">Find</button></form>
    </>
  );
}
