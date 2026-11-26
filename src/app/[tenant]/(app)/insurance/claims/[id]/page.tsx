import Link from 'next/link';
import { requireStaff } from '@/lib/session';
import { can } from '@/lib/rbac';
import { claimDetail } from '@/domain/insurance';
import { fmtDateTime, label, money } from '@/lib/format';
import { Flash, PageHead } from '@/components/ui';
import { insuranceAction } from '../../../insurance-actions';

export default async function Claim({ params, searchParams }: { params: Promise<{ tenant: string; id: string }>; searchParams: Promise<{ ok?: string; err?: string }> }) {
  const { tenant: slug, id } = await params;
  const sp = await searchParams;
  const { tenant, actor, session } = await requireStaff(slug, 'billing.read');
  const { claim: c, events } = await claimDetail(actor, tenant, id);
  const v = (k: string) => c[k] as never;
  const manage = can(session.role, 'claims.manage');
  const here = `/${slug}/insurance/claims/${id}`;
  const open = Number(v('open_paise'));
  const H = ({ op }: { op: string }) => <><input type="hidden" name="op" value={op} /><input type="hidden" name="id" value={id} /><input type="hidden" name="back" value={here} /></>;
  const tdsGuess = ((open * Number(v('tds_rate_bp'))) / 10000 / 100).toFixed(2);
  return (
    <>
      <PageHead title={`Claim ${c.claim_number}`} sub={`${v('payer_name')} · ${label(c.status)}`} />
      <Flash ok={sp.ok} err={sp.err} />
      <div className="grid2">
        <div className="card"><h2>Claim</h2>
          <table className="table small"><tbody>
            <tr><td>Patient</td><td><Link href={`/${slug}/patients/${c.patient_id}`}>{v('full_name')}</Link> · {v('uhid')}</td></tr>
            <tr><td>Policy</td><td>{v('policy_number')}{v('member_id') ? ` · member ${v('member_id')}` : ''}</td></tr>
            <tr><td>Invoice</td><td><Link href={`/${slug}/billing/invoices/${c.invoice_id}`}>{v('invoice_number')}</Link> ({money(v('invoice_total'), tenant)})</td></tr>
            {v('preauth_ref') && <tr><td>Pre-auth</td><td>{v('preauth_ref')}</td></tr>}
            <tr><td>Payer reference</td><td>{v('payer_claim_ref') ?? '—'}</td></tr>
          </tbody></table></div>
        <div className="card"><h2>Money</h2>
          <table className="table small"><tbody>
            <tr><td>Claimed</td><td>{money(c.claimed_paise, tenant)}</td></tr>
            <tr><td>Received</td><td>{money(v('settled_paise'), tenant)}</td></tr>
            <tr><td>TDS deducted</td><td>{money(v('tds_paise'), tenant)}</td></tr>
            <tr><td>Disallowed → patient</td><td>{money(v('returned_paise'), tenant)}</td></tr>
            <tr><td>Written off</td><td>{money(v('written_off_paise'), tenant)}</td></tr>
            <tr className="total"><td>Still open</td><td>{money(open, tenant)}</td></tr>
          </tbody></table></div>
      </div>

      {manage && c.status !== 'closed' && (
        <div className="card">
          {['open', 'query'].includes(c.status) && <form action={insuranceAction.bind(null, slug)} className="inline-form"><H op="submit" />
            <b>{c.status === 'query' ? 'Resubmit after answering the query' : 'Submitted on the payer’s portal?'}</b><input name="payerRef" placeholder="Payer claim reference" defaultValue={v('payer_claim_ref') ?? ''} required /><button className="btn primary">Mark submitted</button></form>}
          {c.status === 'open' && <form action={insuranceAction.bind(null, slug)} className="inline-form"><H op="withdraw" /><input name="note" placeholder="Why withdraw?" required /><button className="btn small">Withdraw claim</button></form>}
          {c.status === 'submitted' && <form action={insuranceAction.bind(null, slug)} className="inline-form"><H op="query" /><input name="note" placeholder="What the payer asked for" required size={40} /><button className="btn">Record query</button></form>}
          {['submitted', 'query', 'settled'].includes(c.status) && (
            <form action={insuranceAction.bind(null, slug)} className="form-grid"><H op="settle" />
              <h3 className="span2">Record settlement advice</h3>
              <label>Amount received (₹)<input name="received" inputMode="decimal" defaultValue="" placeholder="0.00" /></label>
              <label>Bank / UTR reference<input name="reference" /></label>
              <label>TDS deducted (₹)<input name="tds" inputMode="decimal" placeholder={tdsGuess} /></label>
              <label>Disallowed (₹)<input name="disallowed" inputMode="decimal" placeholder="0.00" /></label>
              <label>Disallowed amount<select name="disallowedTo"><option value="patient">Collect from patient</option>{can(session.role, 'finance.close') && <option value="write_off">Write off</option>}</select></label>
              <label>Reason / note<input name="note" /></label>
              <div className="span2"><button className="btn primary">Record</button> <small className="muted">Received + TDS + disallowed can’t exceed the open amount. Partial settlements are fine.</small></div>
            </form>)}
          {['submitted', 'query'].includes(c.status) && <form action={insuranceAction.bind(null, slug)} className="inline-form"><H op="reject" />
            <b>Rejected?</b><input name="note" placeholder="Rejection reason" required /><select name="to"><option value="patient">Collect from patient</option>{can(session.role, 'finance.close') && <option value="write_off">Write off</option>}</select><button className="btn danger small">Record rejection</button></form>}
        </div>)}

      <div className="card"><h2>History</h2><table className="table small"><tbody>{events.map((e, k) => <tr key={k}><td>{fmtDateTime(e.at, tenant)}</td><td>{label(e.action)}</td>
        <td>{e.amount_paise != null ? money(e.amount_paise, tenant) : ''}</td><td>{e.reference}</td><td>{e.note}</td><td>{e.actor}</td></tr>)}</tbody></table></div>
    </>
  );
}
