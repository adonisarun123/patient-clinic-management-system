import { requireStaff } from '@/lib/session';
import { requireModule } from '@/domain/tenants';
import { batches, batchRows } from '@/domain/importer';
import { fmtDateTime } from '@/lib/format';
import { Badge, Empty, Flash, PageHead } from '@/components/ui';
import { importAction } from '../module-actions';

export default async function Import({ params, searchParams }: { params: Promise<{ tenant: string }>; searchParams: Promise<{ batch?: string; ok?: string; err?: string }> }) {
  const { tenant: slug } = await params;
  const sp = await searchParams;
  const { tenant, actor } = await requireStaff(slug, 'import.run');
  requireModule(tenant, 'import');
  const list = await batches(actor, tenant);
  const current = sp.batch ? list.find((b) => b.id === sp.batch) : null;
  const rows = current ? await batchRows(actor, tenant, current.id) : [];
  return (
    <>
      <PageHead title="Data import" sub="Upload a CSV, check it, review likely duplicates, then commit. Re-running the same file skips rows already imported." />
      <Flash ok={sp.ok} err={sp.err} />
      <form action={importAction.bind(null, slug)} className="card form-grid" encType="multipart/form-data">
        <label>What<select name="kind"><option value="patients">Patients</option><option value="appointments">Future appointments</option></select></label>
        <label>Source system name<input name="sourceSystem" placeholder="e.g. old-hms" required /></label>
        <label className="span2">CSV file<input type="file" name="file" accept=".csv,text/csv" required /></label>
        <div className="span2 small muted">
          <p><b>Patients columns:</b> source_id, full_name, dob (YYYY-MM-DD, YYYY-MM or YYYY), age, sex, phone, email, address, city, pincode, legacy_uhid</p>
          <p><b>Appointments columns:</b> source_id, patient_source_id or uhid, doctor_registration_no or doctor_name, service_code, start (YYYY-MM-DD HH:MM clinic time), notes</p>
          <p>Nothing is saved to patient records until you commit. Import patients before appointments.</p>
        </div>
        <div className="span2"><button className="btn primary">Check file</button></div>
      </form>
      {current && (
        <div className="card">
          <h2>{current.filename} — {current.kind}</h2>
          <p>{current.row_count} rows · {current.ok_count} ready · {current.review_count} to review · {current.error_count} errors · <Badge v={current.status} /></p>
          {current.status === 'validated' ? (
            <form action={importAction.bind(null, slug)}>
              <input type="hidden" name="op" value="commit" /><input type="hidden" name="batchId" value={current.id} />
              {rows.length > 0 && <table className="table small"><thead><tr><th>Row</th><th>Source id</th><th>Status</th><th>Issues</th><th>Import anyway?</th></tr></thead>
                <tbody>{rows.map((r) => <tr key={r.row_no} className={r.status === 'error' ? 'urgent' : ''}><td>{r.row_no}</td><td>{r.source_id}</td><td><Badge v={r.status} /></td><td>{r.messages.join('; ')}</td>
                  <td>{r.status === 'review' && <label className="check"><input type="checkbox" name="approveRow" value={r.row_no} /> Different person — import</label>}</td></tr>)}</tbody></table>}
              <button className="btn primary">Commit {current.ok_count} ready row(s)</button> <small className="muted">Rows with errors are skipped; fix them and upload again.</small>
            </form>
          ) : rows.length ? <table className="table small"><tbody>{rows.map((r) => <tr key={r.row_no}><td>{r.row_no}</td><td>{r.source_id}</td><td><Badge v={r.status} /></td><td>{r.messages.join('; ')}</td></tr>)}</tbody></table> : null}
        </div>)}
      <div className="card"><h2>Previous batches</h2>{list.length === 0 ? <Empty>None.</Empty> : (
        <table className="table small"><tbody>{list.map((b) => <tr key={b.id}><td><a href={`?batch=${b.id}`}>{b.filename}</a></td><td>{b.kind}</td><td>{b.source_system}</td><td>{fmtDateTime(b.created_at, tenant)}</td><td>{b.row_count} rows</td><td><Badge v={b.status} /></td></tr>)}</tbody></table>)}</div>
    </>
  );
}
