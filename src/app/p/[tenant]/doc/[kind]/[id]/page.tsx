import Link from 'next/link';
import { requirePortal } from '@/lib/portal-session';
import { portalDocument } from '@/domain/portal';
import { fmtDate, label, money } from '@/lib/format';
import { PrintButton } from '@/components/PrintButton';

type Snap = { rxNumber: string; issuedAt: string; facility: { name: string; address?: string }; patient: { name: string; uhid: string };
  clinician: { name: string; qualification: string | null; registrationNumber: string | null; council: string | null };
  lines: { drug: string; strength: string | null; dose: string; route: string; frequency: string; duration: string; instructions: string | null; prn: boolean; prnIndication: string | null }[];
  advice: string | null; followUpInDays: number | null };

export default async function PortalDoc({ params }: { params: Promise<{ tenant: string; kind: string; id: string }> }) {
  const { tenant: slug, kind, id } = await params;
  const { tenant, s } = await requirePortal(slug);
  const d = await portalDocument(tenant, s, kind, id);
  return (
    <div className="card print-page">
      <div className="row-between no-print"><Link href={`/p/${slug}`}>← Back</Link><PrintButton /></div>
      {'rx' in d && d.rx && (() => { const x = d.rx.snapshot as unknown as Snap; return (
        <>
          <h1>{x.facility.name}</h1><p className="small">{x.facility.address}</p>
          {d.rx.status === 'superseded' && <p className="print-flag">This prescription was replaced by a newer version.</p>}
          <p><b>{x.clinician.name}</b>{x.clinician.qualification ? `, ${x.clinician.qualification}` : ''} · Reg. {x.clinician.registrationNumber} ({x.clinician.council})</p>
          <p>{x.patient.name} · {x.patient.uhid} · {x.rxNumber} · {fmtDate(x.issuedAt, tenant)}</p>
          <ol>{x.lines.map((l, i) => <li key={i}><b>{l.drug}</b> {l.strength} — {l.dose}, {l.route}, {l.frequency}, {l.duration}{l.prn ? ` (only when needed: ${l.prnIndication})` : ''}{l.instructions ? ` · ${l.instructions}` : ''}</li>)}</ol>
          {x.advice && <p className="pre"><b>Advice:</b> {x.advice}</p>}{x.followUpInDays ? <p><b>Review after {x.followUpInDays} days.</b></p> : null}
          <p className="small muted">Electronically signed. Verification {d.rx.content_digest.slice(0, 16)}…</p>
        </>); })()}
      {'result' in d && d.result && (() => { const r = d.result as Record<string, string | null>; return (
        <><h1>{r.name}</h1><p style={{ fontSize: 20 }}><b>{r.value_num ?? r.value_text}</b> {r.unit} {r.flag && r.flag !== 'none' && <span className="pill warn">{label(r.flag)}</span>}</p>
          {r.ref_range && <p className="small">Reference range {r.ref_range}</p>}{r.report_text && <p className="pre">{r.report_text}</p>}
          {r.attachment_id && <p><a className="btn" href={`/p/${slug}/file/${r.attachment_id}`}>Download report</a></p>}
          <p className="small muted">{label(String(r.status))} · {fmtDate(String(r.verified_at), tenant)}. Please discuss results with your doctor.</p></>); })()}
      {'invoice' in d && d.invoice && (() => { const i = d.invoice as Record<string, string | number>; return (
        <><h1>Invoice {i.number}</h1><p>Total {money(i.total_paise, tenant)} · Paid {money(i.paid_paise, tenant)} · Due {money(i.due_paise, tenant)}</p></>); })()}
      {'file' in d && d.file && <p><a className="btn primary" href={`/p/${slug}/file/${id}`}>Download {d.file.filename}</a></p>}
      {'note' in d && d.note && (() => { const c = (d.note.content as { discharge?: Record<string, string> }).discharge ?? {}; return (
        <><h1>Discharge summary</h1><p><b>Diagnosis:</b> {c.diagnosis}</p><p className="pre"><b>Course:</b> {c.courseInHospital}</p><p><b>Condition:</b> {c.conditionAtDischarge}</p>
          {c.medicationsOnDischarge && <p className="pre"><b>Medicines:</b> {c.medicationsOnDischarge}</p>}{c.followUp && <p><b>Follow-up:</b> {c.followUp}</p>}{c.instructions && <p className="pre"><b>Advice:</b> {c.instructions}</p>}</>); })()}
    </div>
  );
}
