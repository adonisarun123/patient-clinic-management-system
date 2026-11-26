import Link from 'next/link';
import { requirePortal } from '@/lib/portal-session';
import { portalCan } from '@/domain/portal';
import { listCatalog } from '@/domain/catalog';
import { getAvailability } from '@/domain/scheduling';
import { fmtTime, money, today } from '@/lib/format';
import { Empty, Flash } from '@/components/ui';
import { bookVisit } from '../../actions';

export default async function PortalBook({ params, searchParams }: { params: Promise<{ tenant: string; patientId: string }>; searchParams: Promise<{ serviceId?: string; date?: string; err?: string }> }) {
  const { tenant: slug, patientId } = await params;
  const sp = await searchParams;
  const { tenant, s } = await requirePortal(slug);
  const link = portalCan(s, patientId, 'can_schedule');
  const cat = await listCatalog(tenant.id, { publicOnly: true });
  const svc = cat.services.find((x) => x.id === sp.serviceId);
  const date = sp.date ?? today(tenant);
  const avail = svc ? await getAvailability({ kind: 'public', tenantId: tenant.id, journey: `portal-view-${s.accountId}` }, tenant, { serviceId: svc.id, from: date, days: 1 }) : null;
  const doc = (id: string) => cat.clinicians.find((c) => c.id === id)?.display_name ?? '';
  return (
    <>
      <p><Link href={`/p/${slug}/patient/${patientId}`}>← Back</Link></p>
      <h1>Book for {link.full_name}</h1>
      <Flash err={sp.err} />
      <form className="card toolbar wrap">
        <label>Service<select name="serviceId" defaultValue={sp.serviceId ?? ''} required><option value="">Choose…</option>{cat.services.map((x) => <option key={x.id} value={x.id}>{x.name} · {money(x.price_paise, tenant)}{x.modality === 'video' ? ' · video' : ''}</option>)}</select></label>
        <label>Date<input type="date" name="date" defaultValue={date} min={today(tenant)} /></label>
        <button className="btn">Show times</button>
      </form>
      {avail && <div className="card">{avail.slots.length === 0 ? <Empty>No times on this day.</Empty> : (
        <div className="slots">{avail.slots.map((x) => (
          <form key={x.start + x.clinicianId} action={bookVisit.bind(null, slug, patientId)}>
            <input type="hidden" name="serviceId" value={svc!.id} /><input type="hidden" name="clinicianId" value={x.clinicianId} /><input type="hidden" name="start" value={x.start} />
            <button className="slot">{fmtTime(x.start, tenant)}<small>{doc(x.clinicianId)}</small></button></form>))}</div>)}</div>}
    </>
  );
}
