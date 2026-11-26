import Link from 'next/link';
import { requireStaff } from '@/lib/session';
import { requireModule } from '@/domain/tenants';
import { appointmentDetail } from '@/domain/scheduling';
import { getPatient } from '@/domain/patients';
import { ensureSession, roomUrl } from '@/domain/telemedicine';
import { can } from '@/lib/rbac';
import { fmtDateTime, label } from '@/lib/format';
import { Flash, PageHead, PatientBanner } from '@/components/ui';
import { videoAction } from '../../module-actions';

export default async function Video({ params, searchParams }: { params: Promise<{ tenant: string; id: string }>; searchParams: Promise<{ ok?: string; err?: string }> }) {
  const { tenant: slug, id } = await params;
  const sp = await searchParams;
  const { tenant, actor, session } = await requireStaff(slug, 'schedule.read');
  requireModule(tenant, 'telemedicine');
  const { appointment: a } = await appointmentDetail(actor, tenant, id);
  const p = await getPatient(actor, a.patient_id);
  const s = await ensureSession(tenant, id);
  const conduct = can(session.role, 'telemedicine.conduct') && !!session.clinicianId;
  return (
    <>
      <PatientBanner p={p} slug={slug} />
      <PageHead title="Video consultation" sub={`${a.booking_ref} · ${fmtDateTime(a.start_at, tenant)}`} />
      <Flash {...sp} />
      <div className="grid2">
        <div className="card">
          <h2>Session record</h2>
          <dl className="dl">
            <dt>Patient consent</dt><dd>{s.consent_at ? `${label(s.consent_method ?? '')} · ${fmtDateTime(s.consent_at, tenant)}` : 'Not yet recorded'}</dd>
            <dt>Identity check</dt><dd>{s.identity_method ?? 'Not yet recorded'}</dd>
            <dt>Started</dt><dd>{fmtDateTime(s.started_at, tenant)}</dd>
            <dt>Ended</dt><dd>{s.ended_at ? `${fmtDateTime(s.ended_at, tenant)} · ${label(s.actual_mode ?? '')}` : '—'}</dd>
          </dl>
          {s.encounter_id && <p><Link className="btn" href={`/${slug}/encounters/${s.encounter_id}`}>Open encounter (notes, prescription)</Link></p>}
        </div>
        <div className="card">
          {!s.started_at && conduct && (
            <form action={videoAction.bind(null, slug, id)}>
              <h2>Start consultation</h2>
              <label>How did you verify the patient on video?<input name="identityMethod" required minLength={3} placeholder="Name and date of birth stated; ID shown on camera" /></label>
              <label>Consent<select name="consentMethod" defaultValue={s.consent_at ? 'portal' : 'verbal_recorded'}><option value="portal">Given in portal</option><option value="verbal_recorded">Verbal, recorded now</option><option value="written">Written</option></select></label>
              <button className="btn primary">Start and open room</button>
            </form>)}
          {s.started_at && (
            <>
              <h2>Room</h2>
              <p><a className="btn primary" href={roomUrl(tenant, s, session.name)} target="_blank" rel="noopener noreferrer">Join video room</a></p>
              <p className="small muted">The patient joins from the portal. If video fails, you may continue by phone and record the actual mode below.</p>
              {!s.ended_at && conduct && (
                <form action={videoAction.bind(null, slug, id)} className="inline-form"><input type="hidden" name="op" value="end" />
                  <select name="mode"><option value="video">Completed by video</option><option value="audio">Switched to audio</option><option value="text">Text only</option><option value="converted_in_person">Asked to visit in person</option><option value="not_held">Not held</option></select>
                  <input name="notes" placeholder="Technical notes" /><button className="btn">Close session</button></form>)}
            </>)}
          {!conduct && !s.started_at && <p className="muted">Waiting for the clinician to start.</p>}
        </div>
      </div>
    </>
  );
}
