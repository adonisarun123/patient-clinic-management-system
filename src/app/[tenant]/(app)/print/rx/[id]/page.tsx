import { requireStaff } from '@/lib/session';
import { getPrescriptionForPrint } from '@/domain/clinical';
import { ageLabel, birthLabel } from '@/lib/identity';
import { PrintButton } from '@/components/PrintButton';
import { PrintLayoutStyle, HeaderLines, LayoutFooter } from '@/components/PrintLayout';
import { currentLayout, type PrintLayout } from '@/domain/records';

type Snap = {
  rxNumber: string; version: number; issuedAt: string; timezone: string;
  facility: { name: string; address?: string; phone?: string; email?: string; logoUrl?: string; registrationText?: string; footerNote?: string };
  patient: { uhid: string; name: string; sex: string; birthDate: string | null; birthPrecision: string; estimatedAgeYears: number | null; ageAsOf: string | null };
  allergies: string | { substance: string; reaction: string | null }[];
  clinician: { name: string; qualification: string | null; council: string | null; registrationNumber: string | null };
  encounter: { date: string; department: string };
  lines: { drug: string; strength: string | null; form: string | null; dose: string; route: string; frequency: string; duration: string; quantity: string | null; prn: boolean; prnIndication: string | null; instructions: string | null }[];
  advice: string | null; followUpInDays: number | null; supersedes: { reason: string } | null;
  printLayout?: { version: number; layout: PrintLayout };
};

/** Renders the frozen snapshot — exactly what was signed — never live chart data. */
export default async function PrintRx({ params }: { params: Promise<{ tenant: string; id: string }> }) {
  const { tenant: slug, id } = await params;
  const { tenant, actor } = await requireStaff(slug, 'clinical.read');
  const rx = await getPrescriptionForPrint(actor, tenant, id);
  const s = rx.snapshot as unknown as Snap;
  // The layout frozen at signing is used, so a reprint looks like the original; older prescriptions use the current one.
  const pl = s.printLayout ?? await currentLayout(actor, tenant, 'prescription');
  const issued = new Date(s.issuedAt).toLocaleString(tenant.locale, { timeZone: s.timezone, dateStyle: 'medium', timeStyle: 'short' });
  return (
    <div className="print-page pl-rx">
      <PrintLayoutStyle layout={pl.layout} scope="pl-rx" />
      <PrintButton />
      <div className="pp-top" />
      <header className="print-head">
        {s.facility.logoUrl ? <img src={s.facility.logoUrl} alt="" /> : null}
        <div><h1>{s.facility.name}</h1><p>{s.facility.address}</p><p>{[s.facility.phone, s.facility.email].filter(Boolean).join(' · ')}</p>
          {s.facility.registrationText && <p className="small">{s.facility.registrationText}</p>}<HeaderLines layout={pl.layout} /></div>
      </header>
      <div className="print-doc">
        <p><b>{s.clinician.name}</b>{s.clinician.qualification ? `, ${s.clinician.qualification}` : ''}<br /><small>Reg. No. {s.clinician.registrationNumber} ({s.clinician.council})</small></p>
        <p className="right"><b>{s.rxNumber}</b>{s.version > 1 ? ` (revision ${s.version})` : ''}<br /><small>{issued}</small></p>
      </div>
      {rx.status === 'superseded' && <p className="print-flag">SUPERSEDED — a later revision of this prescription exists.</p>}
      {s.supersedes && <p className="print-flag">Revised prescription. Reason: {s.supersedes.reason}</p>}
      <table className="print-patient"><tbody><tr>
        <td><b>{s.patient.name}</b></td><td>UHID {s.patient.uhid}</td>
        <td>{ageLabel({ birth_date: s.patient.birthDate, birth_precision: s.patient.birthPrecision, estimated_age_years: s.patient.estimatedAgeYears, age_as_of: s.patient.ageAsOf })} / {s.patient.sex}</td>
        <td>DOB {birthLabel(s.patient.birthDate, s.patient.birthPrecision)}</td></tr>
        <tr><td colSpan={4}>Allergies: {typeof s.allergies === 'string' ? s.allergies : s.allergies.map((a) => `${a.substance}${a.reaction ? ` (${a.reaction})` : ''}`).join(', ')}</td></tr></tbody></table>
      <h2 className="rx-symbol">℞</h2>
      <table className="print-lines"><thead><tr><th>#</th><th>Medicine</th><th>Dose</th><th>Frequency</th><th>Duration</th><th>Qty</th></tr></thead>
        <tbody>{s.lines.map((l, i) => (
          <tr key={i}><td>{i + 1}</td><td><b>{l.drug}</b> {l.strength} {l.form}<br /><small>{l.route}{l.prn ? ` · only when needed for ${l.prnIndication}` : ''}{l.instructions ? ` · ${l.instructions}` : ''}</small></td>
            <td>{l.dose}</td><td>{l.frequency}</td><td>{l.duration}</td><td>{l.quantity ?? ''}</td></tr>))}</tbody></table>
      {s.advice && <><h3>Advice</h3><p className="pre">{s.advice}</p></>}
      {s.followUpInDays ? <p><b>Review after {s.followUpInDays} days.</b></p> : null}
      {pl.layout.signatureLabel && <p className="sig-line">{pl.layout.signatureLabel}</p>}
      <footer className="print-foot">
        <p>Electronically signed by {s.clinician.name} on {issued}. Verification digest {String(rx.content_digest).slice(0, 16)}…</p>
        {s.facility.footerNote && <p>{s.facility.footerNote}</p>}
        <LayoutFooter layout={{ ...pl.layout, signatureLabel: '' }} version={pl.version} />
      </footer>
    </div>
  );
}
