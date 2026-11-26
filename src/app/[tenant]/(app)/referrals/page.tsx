import Link from 'next/link';
import { requireStaff } from '@/lib/session';
import { listReferrals, listReferrers } from '@/domain/frontdesk';
import { fmtDate, label } from '@/lib/format';
import { Badge, Empty, Flash, PageHead } from '@/components/ui';
import { referralAction } from '../frontdesk-actions';

export default async function Referrals({ params, searchParams }: { params: Promise<{ tenant: string }>; searchParams: Promise<{ tab?: string; ok?: string; err?: string }> }) {
  const { tenant: slug } = await params;
  const sp = await searchParams;
  const { tenant, actor } = await requireStaff(slug, 'patient.read');
  const tab = ['inbound', 'outbound', 'referrers'].includes(sp.tab ?? '') ? sp.tab! : 'inbound';
  const rows = tab === 'referrers' ? [] : await listReferrals(actor, tenant, { direction: tab as 'inbound' });
  const refs = tab === 'referrers' ? await listReferrers(actor, tenant) : [];
  return (
    <>
      <PageHead title="Referrals" sub="Patients referred to you by outside doctors, and letters your doctors send out. Record inbound referrals and write letters from the patient’s chart." />
      <Flash ok={sp.ok} err={sp.err} />
      <div className="tabs">{[['inbound', 'Referred to us'], ['outbound', 'Referred out'], ['referrers', 'Referring doctors']].map(([k, l]) => <Link key={k} href={`/${slug}/referrals?tab=${k}`} className={k === tab ? 'on' : ''}>{l}</Link>)}</div>
      {tab !== 'referrers' ? (rows.length === 0 ? <Empty>None yet.</Empty> : (
        <div className="card"><table className="table small"><thead><tr><th>No.</th><th>Patient</th><th>{tab === 'inbound' ? 'From' : 'To'}</th><th>Reason</th><th>Urgency</th><th>Status</th><th>Date</th></tr></thead>
          <tbody>{rows.map((r) => <tr key={r.id}><td><Link href={`/${slug}/referrals/${r.id}`}>{r.ref_number}</Link></td><td><Link href={`/${slug}/patients/${r.patient_id}`}>{r.full_name}</Link><br /><small>{r.uhid}</small></td>
            <td>{r.referrer_name ?? r.to_specialty ?? '—'}</td><td>{r.reason.slice(0, 80)}</td><td>{r.urgency === 'routine' ? 'Routine' : <Badge v={r.urgency} />}</td><td>{label(r.status)}</td><td>{fmtDate(r.created_at, tenant)}</td></tr>)}</tbody></table></div>
      )) : (
        <>
          <div className="card"><h2>Referring doctors</h2><p className="small muted">Ranked by referrals in the last 90 days — useful for relationship and marketing follow-up.</p>
            <table className="table small"><thead><tr><th>Name</th><th>Specialty · organisation</th><th>Contact</th><th>Sent us (90 d)</th><th>Sent us (all)</th><th>We referred</th></tr></thead>
              <tbody>{refs.map((r) => <tr key={r.id} className={r.active ? '' : 'dim'}><td>{r.name}{r.registration_no ? <><br /><small>Reg. {r.registration_no}</small></> : null}</td>
                <td>{[r.specialty, r.organisation].filter(Boolean).join(' · ')}</td><td>{[r.phone, r.email].filter(Boolean).join(' · ')}</td><td>{r.inbound_90d}</td><td>{r.inbound_total}</td><td>{r.outbound_total}</td></tr>)}</tbody></table></div>
          <form action={referralAction.bind(null, slug)} className="card form-grid"><input type="hidden" name="op" value="referrer" /><input type="hidden" name="back" value={`/${slug}/referrals?tab=referrers`} />
            <h2 className="span2">Add a referring / receiving doctor</h2>
            <label>Name<input name="name" required /></label><label>Specialty<input name="specialty" /></label>
            <label>Hospital / clinic<input name="organisation" /></label><label>Registration no.<input name="registrationNo" /></label>
            <label>Phone<input name="phone" /></label><label>Email<input type="email" name="email" /></label>
            <div className="span2"><button className="btn primary">Save</button></div>
          </form>
        </>
      )}
    </>
  );
}
