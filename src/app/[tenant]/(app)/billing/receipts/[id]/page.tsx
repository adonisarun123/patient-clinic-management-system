import Link from 'next/link';
import { requireStaff } from '@/lib/session';
import { receiptDetail } from '@/domain/billing';
import { fmtDateTime, money } from '@/lib/format';
import { Flash } from '@/components/ui';
import { PrintButton } from '@/components/PrintButton';
import { PrintLayoutStyle, HeaderLines, LayoutFooter } from '@/components/PrintLayout';
import { currentLayout } from '@/domain/records';

export default async function Receipt({ params, searchParams }: { params: Promise<{ tenant: string; id: string }>; searchParams: Promise<{ ok?: string; err?: string }> }) {
  const { tenant: slug, id } = await params;
  const { tenant, actor } = await requireStaff(slug, 'billing.read');
  const { payment: p, allocations } = await receiptDetail(actor, tenant, id);
  const b = tenant.branding;
  const pl = await currentLayout(actor, tenant, 'receipt');
  return (
    <div className="print-page narrow-print pl-rc">
      <PrintLayoutStyle layout={pl.layout} scope="pl-rc" /><div className="pp-top" />
      <div className="no-print row-between"><Link href={`/${slug}/billing`}>← Billing</Link><PrintButton /></div>
      <Flash {...await searchParams} />
      <header className="print-head"><div><h1>{tenant.legal_name ?? tenant.name}</h1><p>{b.address}</p><p>{b.phone}</p><HeaderLines layout={pl.layout} /></div></header>
      <h2>Payment receipt</h2>
      <table className="print-lines"><tbody>
        <tr><td>Receipt no.</td><td><b>{p.receipt_no}</b></td></tr>
        <tr><td>Date</td><td>{fmtDateTime(p.received_at, tenant)}</td></tr>
        <tr><td>Received from</td><td>{p.full_name} (UHID {p.uhid})</td></tr>
        <tr><td>Amount</td><td><b>{money(p.amount_paise, tenant)}</b></td></tr>
        <tr><td>Mode</td><td>{p.method.replace('_', ' ').toUpperCase()}{p.reference ? ` · Ref ${p.reference}` : ''}</td></tr>
        <tr><td>Applied to</td><td>{allocations.length ? allocations.map((a) => `${a.number}: ${a.direction === 'release' ? '−' : ''}${money(a.amount_paise, tenant)}`).join(', ') : 'Held as advance'}</td></tr>
      </tbody></table>
      {p.status === 'void' && <p className="print-flag">VOID</p>}
      <footer className="print-foot"><LayoutFooter layout={pl.layout} version={pl.version} /></footer>
    </div>
  );
}
