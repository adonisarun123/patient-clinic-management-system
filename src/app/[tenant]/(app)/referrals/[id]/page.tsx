import Link from 'next/link';
import { requireStaff } from '@/lib/session';
import { referralDetail, listReferrers } from '@/domain/frontdesk';
import { getPatient } from '@/domain/patients';
import { withTenant } from '@/lib/db';
import { can } from '@/lib/rbac';
import { fmtDate, fmtDateTime, label } from '@/lib/format';
import { birthLabel } from '@/lib/identity';
import { Flash, PageHead } from '@/components/ui';
import { PrintButton } from '@/components/PrintButton';
import { PrintLayoutStyle, HeaderLines, LayoutFooter } from '@/components/PrintLayout';
import { currentLayout } from '@/domain/records';
import { referralAction } from '../../frontdesk-actions';

export default async function ReferralPage({ params, searchParams }: { params: Promise<{ tenant: string; id: string }>; searchParams: Promise<{ ok?: string; err?: string }> }) {
  const { tenant: slug, id } = await params;
  const sp = await searchParams;
  const { tenant, actor, session } = await requireStaff(slug, 'patient.read');
  const r = await referralDetail(actor, tenant, id);
  const p = await getPatient(actor, r.patient_id);
  const refs = r.status === 'draft' ? await listReferrers(actor, tenant) : [];
  const appts = r.direction === 'inbound' && ['received', 'booked'].includes(r.status)
    ? await withTenant(tenant.id, (tx) => tx.many<{ id: string; booking_ref: string; start_at: Date }>(
      `SELECT id, booking_ref, lower(period) AS start_at FROM appointment WHERE patient_id = $1 AND state IN ('booked','arrived','in_service','completed') ORDER BY lower(period) DESC LIMIT 10`, [r.patient_id]))
    : [];
  const here = `/${slug}/referrals/${id}`;
  const pl = await currentLayout(actor, tenant, 'referral');
  const canSign = can(session.role, 'clinical.sign') && !!session.clinicianId;
  const closed = ['completed', 'declined', 'cancelled'].includes(r.status);
  return (
    <>
      <PageHead title={`${r.direction === 'outbound' ? 'Referral letter' : 'Inbound referral'} ${r.ref_number}`} sub={`${label(r.status)} · ${label(r.urgency)}`}>
        {r.direction === 'outbound' && r.signed_at && <PrintButton />}
      </PageHead>
      <Flash ok={sp.ok} err={sp.err} />

      {r.direction === 'outbound' && r.status === 'draft' ? (
        <form action={referralAction.bind(null, slug)} className="card form-grid no-print">
          <input type="hidden" name="op" value="edit" /><input type="hidden" name="id" value={id} /><input type="hidden" name="back" value={here} /><input type="hidden" name="patientId" value={r.patient_id} />
          <label>Refer to<select name="referrerId" defaultValue={r.referrer_id ?? ''}><option value="">(not a specific doctor)</option>{refs.filter((x) => x.active).map((x) => <option key={x.id} value={x.id}>{x.name}{x.specialty ? ` · ${x.specialty}` : ''}</option>)}</select></label>
          <label>Specialty<input name="toSpecialty" defaultValue={r.to_specialty ?? ''} /></label>
          <label>Urgency<select name="urgency" defaultValue={r.urgency}><option value="routine">Routine</option><option value="soon">Soon</option><option value="urgent">Urgent</option></select></label>
          <label className="span2">Reason for referral<textarea name="reason" defaultValue={r.reason} required rows={3} /></label>
          <label className="span2">Clinical summary (history, findings, investigations, current medicines)<textarea name="clinicalSummary" defaultValue={r.clinical_summary ?? ''} rows={8} /></label>
          <div className="span2"><button className="btn">Save draft</button></div>
        </form>
      ) : null}

      <article className="card letter pl-rf">
        <PrintLayoutStyle layout={pl.layout} scope="pl-rf" /><div className="pp-top" />
        <header className="letter-head print-head"><div><h2>{tenant.name}</h2><HeaderLines layout={pl.layout} /></div></header><header className="letter-head"><p className="small">{r.direction === 'outbound' ? 'Referral letter' : 'Referral received'} · {r.ref_number} · {fmtDate(r.signed_at ?? r.created_at, tenant)}</p></header>
        <p><b>{r.direction === 'outbound' ? 'To' : 'From'}:</b> {r.referrer_name ? `${r.referrer_name}${r.referrer_specialty ? `, ${r.referrer_specialty}` : ''}${r.referrer_org ? `, ${r.referrer_org}` : ''}` : r.to_specialty ? `Consultant, ${r.to_specialty}` : '—'}</p>
        <p><b>Patient:</b> {p.full_name} · {p.uhid} · {p.sex ?? ''} · DOB {birthLabel(p.birth_date, p.birth_precision)}</p>
        <p><b>Urgency:</b> {label(r.urgency)}</p>
        <h3>Reason for referral</h3><p className="prewrap">{r.reason}</p>
        {r.clinical_summary && <><h3>Clinical summary</h3><p className="prewrap">{r.clinical_summary}</p></>}
        {r.direction === 'outbound' && (r.signed_at
          ? <footer className="signature"><p>{r.clinician_name}{r.qualification ? `, ${r.qualification}` : ''}</p><p className="small">Reg. {r.registration_number}{r.registration_council ? ` (${r.registration_council})` : ''} · Signed electronically {fmtDateTime(r.signed_at, tenant)}</p></footer>
          : <p className="flash warn no-print">Draft — not signed.</p>)}
        {r.outcome_notes && <p className="small muted prewrap no-print">{r.outcome_notes}</p>}
        <footer className="print-foot"><LayoutFooter layout={pl.layout} version={pl.version} /></footer>
      </article>

      <div className="card no-print row-actions">
        {r.direction === 'outbound' && r.status === 'draft' && (canSign
          ? <form action={referralAction.bind(null, slug)}><input type="hidden" name="op" value="sign" /><input type="hidden" name="id" value={id} /><input type="hidden" name="back" value={here} /><button className="btn primary">Sign letter</button></form>
          : <p className="small muted">A doctor must sign this letter.</p>)}
        {r.status === 'signed' && <form action={referralAction.bind(null, slug)} className="inline-form"><input type="hidden" name="op" value="sent" /><input type="hidden" name="id" value={id} /><input type="hidden" name="back" value={here} />
          <select name="how"><option>handed to patient</option><option>emailed</option><option>sent by post</option><option>sent via WhatsApp</option></select><button className="btn">Mark sent</button></form>}
        {appts.length > 0 && <form action={referralAction.bind(null, slug)} className="inline-form"><input type="hidden" name="op" value="link" /><input type="hidden" name="id" value={id} /><input type="hidden" name="back" value={here} />
          <select name="appointmentId">{appts.map((a) => <option key={a.id} value={a.id}>{a.booking_ref} · {fmtDateTime(a.start_at, tenant)}</option>)}</select><button className="btn">Link visit</button></form>}
        {r.direction === 'inbound' && r.status === 'received' && <Link className="btn" href={`/${slug}/appointments/new?patientId=${r.patient_id}`}>Book a visit</Link>}
        {!closed && r.status !== 'draft' && <form action={referralAction.bind(null, slug)} className="inline-form"><input type="hidden" name="op" value="close" /><input type="hidden" name="id" value={id} /><input type="hidden" name="back" value={here} />
          <select name="status"><option value="completed">Completed</option><option value="declined">Declined</option><option value="cancelled">Cancelled</option></select><input name="notes" placeholder="Outcome / note" required /><button className="btn">Close</button></form>}
        <Link className="btn" href={`/${slug}/patients/${r.patient_id}`}>Patient chart</Link>
      </div>
    </>
  );
}
