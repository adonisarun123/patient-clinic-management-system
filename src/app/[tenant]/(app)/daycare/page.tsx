import Link from 'next/link';
import { requireStaff } from '@/lib/session';
import { can } from '@/lib/rbac';
import { dayCareBoard, bedBoard } from '@/domain/inpatient';
import { getPatient, searchPatients } from '@/domain/patients';
import { listCatalog } from '@/domain/catalog';
import { requireModule } from '@/domain/tenants';
import { fmtTime, money } from '@/lib/format';
import { Empty, Flash, PageHead, PatientBanner } from '@/components/ui';
import { admitAction } from '../module-actions';

export default async function DayCare({ params, searchParams }: { params: Promise<{ tenant: string }>; searchParams: Promise<{ admit?: string; q?: string; ok?: string; err?: string }> }) {
  const { tenant: slug } = await params;
  const sp = await searchParams;
  const { tenant, actor, session } = await requireStaff(slug, 'clinical.read');
  requireModule(tenant, 'daycare');
  const rows = await dayCareBoard(actor, tenant);
  const beds = (await bedBoard(actor, tenant)).filter((b) => !b.admission_id && b.status === 'available');
  const dayBeds = [...beds].sort((a, b) => Number(b.category === 'daycare') - Number(a.category === 'daycare'));
  const cat = can(session.role, 'inpatient.admit') ? await listCatalog(tenant.id) : null;
  const admitPatient = sp.admit ? await getPatient(actor, sp.admit) : null;
  const found = sp.q ? await searchPatients(actor, sp.q) : [];
  const active = rows.filter((r) => r.status === 'admitted');
  return (
    <>
      <PageHead title="Day care" sub={`${active.length} in · ${active.filter((r) => r.overdue).length} past expected discharge · ${rows.length - active.length} discharged today`}>
        {can(session.role, 'settings.manage') && <Link className="btn" href={`/${slug}/inpatient?tab=beds`}>Beds</Link>}
      </PageHead>
      <Flash ok={sp.ok} err={sp.err} />
      <div className="card">
        {rows.length === 0 ? <Empty>No day-care patients today.</Empty> : (
          <table className="table"><thead><tr><th>Patient</th><th>Bed</th><th>Reason</th><th>In</th><th>Expected out</th><th>Status</th></tr></thead>
            <tbody>{rows.map((r) => (
              <tr key={r.id} className={r.overdue ? 'highlight' : r.status !== 'admitted' ? 'dim' : ''}>
                <td><Link href={`/${slug}/inpatient/${r.id}`}><b>{r.full_name}</b></Link><br /><small>{r.uhid} · {r.admission_no}</small></td>
                <td>{r.bed ?? '—'}</td><td>{r.reason}</td><td>{fmtTime(r.admitted_at, tenant)}</td>
                <td>{r.planned_end_at ? fmtTime(r.planned_end_at, tenant) : '—'}{r.overdue && <div className="warn-text small">Overdue — discharge or convert</div>}</td>
                <td>{r.status === 'admitted' ? (r.summary_signed ? 'Summary signed' : 'In care') : `Discharged ${r.discharged_at ? fmtTime(r.discharged_at, tenant) : ''}`}</td></tr>))}</tbody></table>)}
      </div>
      {cat && (
        <div className="card">
          <h2>Admit for day care</h2>
          {!admitPatient ? (
            <><form className="search"><input name="q" defaultValue={sp.q} placeholder="Find patient" /><button className="btn">Find</button></form>
              {found.map((r) => <p key={r.id}><Link href={`?admit=${r.id}`}>{r.full_name}</Link> · {r.uhid}</p>)}</>
          ) : (
            <><PatientBanner p={admitPatient} slug={slug} />
              <form action={admitAction.bind(null, slug)} className="form-grid">
                <input type="hidden" name="patientId" value={admitPatient.id} /><input type="hidden" name="careType" value="daycare" />
                <label>Bed / chair<select name="bedId" required>{dayBeds.map((b) => <option key={b.bed_id} value={b.bed_id}>{b.ward} · {b.code} ({b.category}, {money(b.daily_rate_paise, tenant)})</option>)}</select></label>
                <label>Department<select name="departmentId">{cat.departments.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}</select></label>
                <label>Doctor<select name="clinicianId" defaultValue={session.clinicianId ?? ''}>{cat.clinicians.filter((c) => c.active).map((c) => <option key={c.id} value={c.id}>{c.display_name}</option>)}</select></label>
                <label>Expected discharge time (today)<input type="time" name="plannedEndTime" required /></label>
                <label className="span2">Reason (e.g. chemotherapy cycle 3, iron infusion, cataract surgery)<input name="reason" required /></label>
                <div className="span2"><button className="btn primary" disabled={!dayBeds.length}>Admit for day care</button> <Link href={`/${slug}/daycare`}>Cancel</Link>
                  {!dayBeds.length && <span className="small muted"> No free beds. Add day-care beds under Beds (category “daycare”).</span>}</div>
              </form></>)}
        </div>)}
      <p className="small muted">The bed’s daily rate is charged once for a same-day stay. Discharge needs a signed discharge summary, as for inpatients.</p>
    </>
  );
}
