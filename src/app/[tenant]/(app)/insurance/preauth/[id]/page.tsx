import Link from 'next/link';
import { requireStaff } from '@/lib/session';
import { can } from '@/lib/rbac';
import { listPreauths, preauthEvents } from '@/domain/insurance';
import { withTenant } from '@/lib/db';
import { fmtDate, fmtDateTime, label, money } from '@/lib/format';
import { Flash, PageHead } from '@/components/ui';
import { insuranceAction } from '../../../insurance-actions';

export default async function Preauth({ params, searchParams }: { params: Promise<{ tenant: string; id: string }>; searchParams: Promise<{ ok?: string; err?: string }> }) {
  const { tenant: slug, id } = await params;
  const sp = await searchParams;
  const { tenant, actor, session } = await requireStaff(slug, 'billing.read');
  const pid = await withTenant(tenant.id, async (tx) => (await tx.one<{ patient_id: string }>(`SELECT patient_id FROM preauth WHERE id = $1`, [id])).patient_id);
  const pa = (await listPreauths(actor, tenant, { patientId: pid })).find((x) => x.id === id)!;
  const events = await preauthEvents(tenant, id);
  const here = `/${slug}/insurance/preauth/${id}`;
  const manage = can(session.role, 'claims.manage');
  const F = ({ to, children }: { to: string; children: React.ReactNode }) => (
    <form action={insuranceAction.bind(null, slug)} className="inline-form"><input type="hidden" name="op" value="preauthStatus" /><input type="hidden" name="id" value={id} /><input type="hidden" name="to" value={to} /><input type="hidden" name="back" value={here} />{children}</form>);
  return (
    <>
      <PageHead title={`Pre-authorisation ${pa.ref_number}`} sub={`${pa.payer_name} · ${label(pa.status)}`} />
      <Flash ok={sp.ok} err={sp.err} />
      <div className="card"><table className="table small"><tbody>
        <tr><td>Patient</td><td><Link href={`/${slug}/patients/${pa.patient_id}`}>{pa.full_name}</Link> · {pa.uhid}</td></tr>
        <tr><td>Treatment</td><td>{pa.treatment}</td></tr><tr><td>Estimate</td><td>{money(pa.estimated_paise, tenant)}</td></tr>
        <tr><td>Approved</td><td>{pa.approved_paise != null ? money(pa.approved_paise, tenant) : '—'}{pa.valid_until ? ` · valid until ${fmtDate(pa.valid_until, tenant)}` : ''}</td></tr>
        <tr><td>Payer reference</td><td>{pa.payer_ref ?? '—'}</td></tr></tbody></table></div>
      {manage && !['cancelled', 'approved'].includes(pa.status) && (
        <div className="card">
          {['draft', 'query', 'partially_approved', 'denied'].includes(pa.status) && <F to="submitted"><b>{pa.status === 'draft' ? 'Sent to the payer?' : 'Resubmit'}</b><input name="payerRef" placeholder="Payer reference" defaultValue={pa.payer_ref ?? ''} required={pa.status === 'draft'} /><button className="btn primary">Mark submitted</button></F>}
          {pa.status === 'submitted' && <>
            <F to="approved"><b>Approved</b><input name="approved" placeholder="Approved amount ₹" required inputMode="decimal" /><input type="date" name="validUntil" /><button className="btn primary">Record approval</button></F>
            <F to="query"><input name="note" placeholder="Query from payer" required size={36} /><button className="btn">Record query</button></F>
            <F to="denied"><input name="note" placeholder="Denial reason" required /><button className="btn danger small">Record denial</button></F>
          </>}
          <F to="cancelled"><input name="note" placeholder="Why cancel?" required /><button className="btn small">Cancel request</button></F>
        </div>)}
      <div className="card"><h2>History</h2><table className="table small"><tbody>{events.map((e, k) => <tr key={k}><td>{fmtDateTime(e.at, tenant)}</td><td>{label(e.action)}</td>
        <td>{e.amount_paise != null ? money(e.amount_paise, tenant) : ''}</td><td>{e.reference}</td><td>{e.note}</td><td>{e.actor}</td></tr>)}</tbody></table></div>
    </>
  );
}
