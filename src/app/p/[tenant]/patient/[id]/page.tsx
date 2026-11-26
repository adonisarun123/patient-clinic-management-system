import Link from 'next/link';
import { requirePortal } from '@/lib/portal-session';
import { portalPatientView } from '@/domain/portal';
import { fmtDateTime, label, money } from '@/lib/format';
import { Badge, Empty, Flash } from '@/components/ui';
import { cancelVisit, joinVideo, requestRecords } from '../../actions';

export default async function PortalPatient({ params, searchParams }: { params: Promise<{ tenant: string; id: string }>; searchParams: Promise<{ ok?: string; err?: string; room?: string }> }) {
  const { tenant: slug, id } = await params;
  const sp = await searchParams;
  const { tenant, s } = await requirePortal(slug);
  const v = await portalPatientView(tenant, s, id);
  const now = Date.now();
  const upcoming = v.appointments.filter((a) => +new Date(a.start_at) > now - 3600000 && ['booked', 'arrived', 'in_service'].includes(a.state));
  const past = v.appointments.filter((a) => !upcoming.includes(a));
  return (
    <>
      <p><Link href={`/p/${slug}`}>← All records</Link></p>
      <h1>{v.link.full_name}</h1>
      <p className="muted">{v.link.uhid}</p>
      <Flash ok={sp.ok} err={sp.err} />
      {sp.room && sp.room.startsWith(tenant.settings.jitsiBaseUrl) && <p className="card"><a className="btn primary" href={sp.room} target="_blank" rel="noopener noreferrer">Open the video room</a> <small className="muted">Allow camera and microphone when asked.</small></p>}
      {v.dues.length > 0 && (
        <div className="card"><h2>Payments due</h2>
          {v.dues.map((d) => <div key={d.invoice_id} className="row-between"><span>Invoice {d.number} · {money(d.due_paise, tenant)}</span>
            {tenant.settings.modules.payments && <Link className="btn primary small" href={`/p/${slug}/pay/${d.invoice_id}`}>Pay online</Link>}</div>)}</div>)}
      <div className="card"><div className="row-between"><h2>Appointments</h2>{v.link.can_schedule && <Link className="btn small" href={`/p/${slug}/book/${id}`}>Book</Link>}</div>
        {upcoming.length === 0 ? <Empty>No upcoming appointments.</Empty> : upcoming.map((a) => (
          <div key={a.id} className="note signed">
            <b>{fmtDateTime(a.start_at, tenant)}</b> · {a.service_name} · {a.clinician_name} <Badge v={a.state} /> {a.modality === 'video' && <span className="pill ok">Video</span>}
            <div className="inline-form">
              {a.modality === 'video' && tenant.settings.modules.telemedicine && (
                <form action={joinVideo.bind(null, slug, id)} className="inline-form"><input type="hidden" name="appointmentId" value={a.id} />
                  <label className="check small"><input type="checkbox" name="consent" required /> I agree to a video consultation; I understand the doctor may ask me to visit in person if needed.</label>
                  <button className="btn small primary">Join video</button></form>)}
              {a.state === 'booked' && v.link.can_schedule && (
                <form action={cancelVisit.bind(null, slug, id)}><input type="hidden" name="appointmentId" value={a.id} /><button className="btn small danger">Cancel</button></form>)}
            </div>
          </div>))}
        {past.length > 0 && <details><summary className="small">Past appointments</summary>{past.map((a) => <p key={a.id} className="small">{fmtDateTime(a.start_at, tenant)} · {a.service_name} · {label(a.state)}</p>)}</details>}
      </div>
      <div className="card"><h2>Documents</h2>
        {v.docs.length === 0 ? <Empty>The clinic has not shared any documents yet.</Empty> : (
          <ul className="list">{v.docs.map((d) => <li key={d.doc_kind + d.doc_id}><Link href={`/p/${slug}/doc/${d.doc_kind}/${d.doc_id}`}>{d.title}</Link> <small className="muted">{fmtDateTime(d.released_at, tenant)}</small></li>)}</ul>)}
      </div>
      <form action={requestRecords.bind(null, slug, id)} className="card">
        <h2>Request your records</h2>
        <label>Request<select name="requestType"><option value="copy">A copy of my records</option><option value="correction">A correction</option><option value="access_log">Who has accessed my record</option><option value="consent_withdrawal">Withdraw a consent</option><option value="other">Something else</option></select></label>
        <label>Details<textarea name="scope" rows={2} required placeholder="e.g. all prescriptions and lab reports from 2025" /></label>
        <button className="btn">Send request</button>
        <p className="small muted">You will get a case number. The clinic will respond within its published timeline.</p>
      </form>
    </>
  );
}
