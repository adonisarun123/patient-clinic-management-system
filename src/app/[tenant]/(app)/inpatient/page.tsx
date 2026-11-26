import Link from 'next/link';
import { requireStaff } from '@/lib/session';
import { requireModule } from '@/domain/tenants';
import { bedBoard } from '@/domain/inpatient';
import { getPatient, searchPatients } from '@/domain/patients';
import { listCatalog } from '@/domain/catalog';
import { can } from '@/lib/rbac';
import { fmtDateTime, money } from '@/lib/format';
import { Empty, Flash, PageHead, PatientBanner } from '@/components/ui';
import { admitAction, bedAction } from '../module-actions';

export default async function Inpatient({ params, searchParams }: { params: Promise<{ tenant: string }>; searchParams: Promise<{ tab?: string; admit?: string; q?: string; ok?: string; err?: string }> }) {
  const { tenant: slug } = await params;
  const sp = await searchParams;
  const { tenant, actor, session } = await requireStaff(slug, 'schedule.read');
  if (!tenant.settings.modules.daycare) requireModule(tenant, 'inpatient');
  const board = await bedBoard(actor, tenant);
  const cat = await listCatalog(tenant.id);
  const wards = cat.locations.filter((l) => l.kind === 'ward' && l.active);
  const admitPatient = sp.admit ? await getPatient(actor, sp.admit) : null;
  const found = sp.q ? await searchPatients(actor, sp.q) : [];
  const free = board.filter((b) => !b.admission_id && b.status === 'available');
  const byWard = wards.map((w) => ({ w, beds: board.filter((b) => b.ward_id === w.id) }));
  return (
    <>
      <PageHead title="Inpatient" sub={`${board.filter((b) => b.admission_id).length} occupied · ${free.length} available · ${board.length} beds`}>
        {can(session.role, 'settings.manage') && <Link className="btn" href="?tab=beds">Beds</Link>}
      </PageHead>
      <Flash ok={sp.ok} err={sp.err} />
      {sp.tab === 'beds' && can(session.role, 'settings.manage') ? (
        <form action={bedAction.bind(null, slug)} className="card inline-form wrap">
          <b>Add bed</b>
          <select name="wardId" required>{wards.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}</select>
          <input name="code" placeholder="Bed code e.g. W1-05" required /><input name="category" placeholder="Category (general, private, ICU)" />
          <input name="rate" inputMode="decimal" placeholder={`Daily rate (${tenant.currency})`} /><button className="btn small primary">Add</button>
          {!wards.length && <p className="small muted">Create a ward first: Settings › Structure, type “ward”.</p>}
        </form>) : null}
      {can(session.role, 'inpatient.admit') && (
        <div className="card">
          <h2>Admit a patient</h2>
          {!admitPatient ? (
            <>
              <form className="search"><input name="q" defaultValue={sp.q} placeholder="Find patient" /><button className="btn">Find</button></form>
              {found.map((r) => <p key={r.id}><Link href={`?admit=${r.id}`}>{r.full_name}</Link> · {r.uhid}</p>)}
            </>
          ) : (
            <>
              <PatientBanner p={admitPatient} slug={slug} />
              <form action={admitAction.bind(null, slug)} className="form-grid">
                <input type="hidden" name="patientId" value={admitPatient.id} />
                <label>Bed<select name="bedId" required>{free.map((b) => <option key={b.bed_id} value={b.bed_id}>{b.ward} · {b.code} ({b.category}, {money(b.daily_rate_paise, tenant)}/day)</option>)}</select></label>
                <label>Department<select name="departmentId">{cat.departments.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}</select></label>
                <label>Admitting doctor<select name="clinicianId" defaultValue={session.clinicianId ?? ''}>{cat.clinicians.filter((c) => c.active).map((c) => <option key={c.id} value={c.id}>{c.display_name}</option>)}</select></label>
                <label>Expected discharge<input type="date" name="expectedDischarge" /></label>
                <label className="span2">Reason for admission<input name="reason" required /></label>
                <div className="span2"><button className="btn primary" disabled={!free.length}>Admit</button> <Link href={`/${slug}/inpatient`}>Cancel</Link></div>
              </form>
            </>)}
        </div>)}
      {byWard.length === 0 ? <Empty>No wards configured.</Empty> : byWard.map(({ w, beds }) => (
        <div key={w.id} className="card"><h2>{w.name}</h2>
          <div className="slots">{beds.map((b) => b.admission_id ? (
            <Link key={b.bed_id} href={`/${slug}/inpatient/${b.admission_id}`} className="slot" style={{ borderColor: 'var(--brand)', textAlign: 'left' }}>
              {b.code}<small><b>{b.full_name}</b></small><small>{b.uhid} · {b.admission_no}</small><small>since {fmtDateTime(b.admitted_at, tenant)}</small></Link>
          ) : (
            <div key={b.bed_id} className="slot" style={{ opacity: b.status === 'available' ? 1 : 0.6 }}>{b.code}<small>{b.status}</small>
              {b.status !== 'available' && can(session.role, 'inpatient.nursing') && <form action={bedAction.bind(null, slug)}><input type="hidden" name="op" value="status" /><input type="hidden" name="bedId" value={b.bed_id} /><input type="hidden" name="status" value="available" /><button className="link small">Mark ready</button></form>}</div>))}</div>
        </div>))}
    </>
  );
}
