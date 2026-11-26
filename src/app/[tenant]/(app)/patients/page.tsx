import Link from 'next/link';
import { requireStaff } from '@/lib/session';
import { identityReviewQueue, searchPatients } from '@/domain/patients';
import { ageLabel, birthLabel, maskPhone } from '@/lib/identity';
import { Badge, Empty, Flash, PageHead } from '@/components/ui';
import { fmtDateTime } from '@/lib/format';

export default async function Patients({ params, searchParams }: { params: Promise<{ tenant: string }>; searchParams: Promise<{ q?: string; review?: string; ok?: string; err?: string }> }) {
  const { tenant: slug } = await params;
  const sp = await searchParams;
  const { tenant, actor } = await requireStaff(slug, 'patient.read');
  const results = sp.q ? await searchPatients(actor, sp.q) : [];
  const review = sp.review ? await identityReviewQueue(actor) : [];
  return (
    <>
      <PageHead title="Patients" sub="Search by UHID, mobile number or name">
        <Link className="btn primary" href={`/${slug}/patients/new`}>Register patient</Link>
        <Link className="btn" href={`/${slug}/patients?review=1`}>Identity review</Link>
      </PageHead>
      <Flash {...sp} />
      <form className="search" role="search">
        <input name="q" defaultValue={sp.q} placeholder="UHID, 10-digit mobile, or name" autoFocus aria-label="Search patients" />
        <button className="btn primary">Search</button>
      </form>
      {sp.q && (
        <div className="card">
          {results.length === 0 ? <Empty>No match. Check spelling, try the mobile number, or <Link href={`/${slug}/patients/new`}>register a new patient</Link>.</Empty> : (
            <>
              <p className="muted small">A shared phone may belong to a family. Confirm two identifiers (name and date of birth) before selecting.</p>
              <table className="table"><thead><tr><th>Patient</th><th>UHID</th><th>Age / DOB</th><th>Phone</th><th>Match</th></tr></thead>
                <tbody>{results.map((r) => (
                  <tr key={r.id}><td><Link href={`/${slug}/patients/${r.id}`}><b>{r.full_name}</b></Link> {r.status !== 'active' && <Badge v={r.status} />}</td>
                    <td>{r.uhid}</td><td>{ageLabel({ ...r, estimated_age_years: null, age_as_of: null })} · {birthLabel(r.birth_date, r.birth_precision)}</td>
                    <td>{maskPhone(r.phone_e164)}</td><td><small>{r.reason}</small></td></tr>))}
                </tbody></table>
            </>)}
        </div>
      )}
      {sp.review && (
        <div className="card">
          <h2>Registrations awaiting identity confirmation</h2>
          <p className="muted small">Online bookings and temporary registrations. At the desk, confirm two identifiers, then either confirm the record or link it to the existing chart.</p>
          {review.length === 0 ? <Empty>Nothing to review.</Empty> : (
            <table className="table"><thead><tr><th>Patient</th><th>UHID</th><th>Source</th><th>Phone</th><th>Created</th></tr></thead>
              <tbody>{review.map((r) => (
                <tr key={r.id}><td><Link href={`/${slug}/patients/${r.id}`}>{r.full_name}</Link></td><td>{r.uhid}</td><td><Badge v={r.registration_source} /></td>
                  <td>{maskPhone(r.phone_e164)}</td><td>{fmtDateTime(r.created_at, tenant)}</td></tr>))}
              </tbody></table>)}
        </div>
      )}
    </>
  );
}
