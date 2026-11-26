import Link from 'next/link';
import { requireStaff } from '@/lib/session';
import { orderDetail } from '@/domain/labs';
import { releasedIds } from '@/domain/portal';
import { can } from '@/lib/rbac';
import { fmtDateTime, label } from '@/lib/format';
import { Badge, Flash, PageHead } from '@/components/ui';
import { orderAction } from '../../module-actions';
import { FileField } from '@/components/FileField';
import { objectStorageEnabled } from '@/lib/blob';

export default async function LabOrder({ params, searchParams }: { params: Promise<{ tenant: string; id: string }>; searchParams: Promise<{ ok?: string; err?: string }> }) {
  const { tenant: slug, id } = await params;
  const sp = await searchParams;
  const { tenant, actor, session } = await requireStaff(slug, 'schedule.read');
  const { order: o, test: t, versions } = await orderDetail(actor, tenant, id);
  const latest = versions[0];
  const released = tenant.settings.modules.portal ? (await releasedIds(tenant, o.patient_id)).some((r) => r.doc_kind === 'result' && r.doc_id === id) : false;
  const act = orderAction.bind(null, slug, id);
  return (
    <>
      <PageHead title={`${t.name} · ${o.accession_no}`} sub={<><Link href={`/${slug}/patients/${o.patient_id}`}>{o.full_name}</Link> · {o.uhid} · ordered by {o.clinician_name} {fmtDateTime(o.created_at, tenant)}</>}>
        <Badge v={o.status} />{o.priority !== 'routine' && <span className="pill danger">{o.priority.toUpperCase()}</span>}
      </PageHead>
      <Flash {...sp} />
      {o.clinical_info && <p><b>Clinical information:</b> {o.clinical_info}</p>}
      {o.status === 'requested' && can(session.role, 'results.enter') && (
        <form action={act} className="card inline-form"><input type="hidden" name="op" value="collect" />
          <label className="check"><input type="checkbox" name="idok" required /> Two identifiers checked and specimen labelled{t.specimen ? ` (${t.specimen})` : ''}</label>
          <button className="btn primary">Mark collected</button></form>)}
      {['requested', 'collected'].includes(o.status) && can(session.role, 'orders.write') && (
        <details className="card"><summary>Cancel order</summary><form action={act} className="inline-form"><input type="hidden" name="op" value="cancel" /><input name="reason" placeholder="Reason" required /><button className="btn small danger">Cancel order</button></form></details>)}

      {versions.map((v, i) => (
        <div key={v.id} className={`card note ${i === 0 ? 'signed' : 'superseded'}`}>
          <div className="row-between"><b>Version {v.version_no} · {label(v.status)}{i > 0 ? ' (superseded)' : ''}</b>
            <small className="muted">verified by {v.verifier} · {fmtDateTime(v.verified_at, tenant)}{v.performing_lab ? ` · ${v.performing_lab}` : ''}</small></div>
          {v.amend_reason && <p className="small">Amended: {v.amend_reason}</p>}
          {(v.value_num != null || v.value_text) && <p style={{ fontSize: 18 }}><b>{v.value_num ?? v.value_text}</b> {v.unit} {v.flag !== 'none' && <span className={`pill ${v.is_critical ? 'danger' : v.flag === 'normal' ? 'ok' : 'warn'}`}>{label(v.flag)}</span>} {v.ref_range && <small className="muted">ref {v.ref_range}</small>}</p>}
          {v.report_text && <p className="pre">{v.report_text}</p>}
          {v.attachment_id && <p><a href={`/${slug}/files/${v.attachment_id}`} className="btn small">Download report</a></p>}
          {v.ack_action ? <p className="pill ok">{label(v.ack_action)} by {v.ack_by} · {fmtDateTime(v.ack_at, tenant)}{v.ack_note ? ` — ${v.ack_note}` : ''}</p>
            : i === 0 && can(session.role, 'results.ack') && (
              <form action={act} className="inline-form"><input type="hidden" name="op" value="ack" /><input type="hidden" name="versionId" value={v.id} />
                <select name="action"><option value="acknowledged">Reviewed</option><option value="patient_informed">Patient informed</option><option value="follow_up_created">Create follow-up</option><option value="no_action_needed">No action needed</option></select>
                <input type="date" name="followUpDueDate" title="Follow-up date" /><input name="note" placeholder={v.is_critical ? 'Action taken (required for critical)' : 'Note'} />
                <button className="btn small primary">Acknowledge</button></form>)}
        </div>))}

      {o.status !== 'cancelled' && o.status !== 'requested' && can(session.role, 'results.enter') && (
        <form action={act} className="card form-grid" encType="multipart/form-data">
          <input type="hidden" name="op" value="result" />
          <h2 className="span2">{latest ? 'Issue amended result' : 'Enter result'}</h2>
          {t.unit || t.ref_low != null ? <label>Value ({t.unit ?? ''})<input name="valueNum" inputMode="decimal" /></label> : <label>Result<input name="valueText" /></label>}
          <label>Status<select name="status"><option value="final">Final</option><option value="preliminary">Preliminary</option></select></label>
          <label className="span2">Report / impression<textarea name="reportText" rows={4} /></label>
          <label>Performing laboratory<input name="performingLab" defaultValue={o.destination === 'external' ? o.external_lab ?? '' : tenant.name} /></label>
          <label>Report file (PDF/JPEG/PNG, ≤10 MB)<FileField name="file" slug={slug} tenantId={tenant.id} objectStorage={objectStorageEnabled()} accept="application/pdf,image/jpeg,image/png" /></label>
          <label className="check"><input type="checkbox" name="abnormal" /> Abnormal</label>
          <label className="check"><input type="checkbox" name="critical" /> Critical — needs immediate clinician acknowledgement</label>
          {latest && <label className="span2">Reason for amendment (required)<input name="amendReason" required /></label>}
          <div className="span2"><button className="btn primary">Save result</button></div>
        </form>)}
      {latest && tenant.settings.modules.portal && (latest.status === 'final' || latest.status === 'amended') && !released && can(session.role, 'clinical.read') && (
        <form action={act} className="card inline-form"><input type="hidden" name="op" value="release" /><input type="hidden" name="patientId" value={o.patient_id} />
          <span>Released results appear in the patient portal.</span><button className="btn small">Release to patient</button></form>)}
      {released && <p className="pill ok">Released to the patient portal</p>}
    </>
  );
}
