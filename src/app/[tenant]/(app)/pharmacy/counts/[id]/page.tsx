import { requireStaff } from '@/lib/session';
import { withTenant } from '@/lib/db';
import { requireModule } from '@/domain/tenants';
import { can } from '@/lib/rbac';
import { fmtDate } from '@/lib/format';
import { Badge, Flash, PageHead } from '@/components/ui';
import { countAction } from '../../../module-actions';

/** Blind count: the counter does not see system quantities until the count is submitted. */
export default async function Count({ params, searchParams }: { params: Promise<{ tenant: string; id: string }>; searchParams: Promise<{ ok?: string; err?: string }> }) {
  const { tenant: slug, id } = await params;
  const sp = await searchParams;
  const { tenant, session } = await requireStaff(slug, 'pharmacy.stock');
  requireModule(tenant, 'pharmacy');
  const { count, lines } = await withTenant(tenant.id, async (tx) => ({
    count: await tx.one<{ status: string; counted_by: string }>(`SELECT status, counted_by FROM stock_count WHERE id = $1`, [id]),
    lines: await tx.many<{ lot_id: string; system_qty: number; counted_qty: number | null; batch_no: string; expiry_date: string; generic_name: string; strength: string | null }>(
      `SELECT c.lot_id, c.system_qty, c.counted_qty, l.batch_no, l.expiry_date, p.generic_name, p.strength FROM stock_count_line c JOIN lot l ON l.id = c.lot_id JOIN product p ON p.id = l.product_id
        WHERE c.count_id = $1 ORDER BY p.generic_name, l.expiry_date`, [id]),
  }));
  const reveal = count.status !== 'open';
  return (
    <>
      <PageHead title="Stock count" sub={<Badge v={count.status} />} />
      <Flash {...sp} />
      <form action={countAction.bind(null, slug)} className="card">
        <input type="hidden" name="countId" value={id} /><input type="hidden" name="op" value="enter" />
        <table className="table"><thead><tr><th>Medicine</th><th>Batch</th><th>Expiry</th><th>Counted</th>{reveal && <><th>System</th><th>Difference</th></>}</tr></thead>
          <tbody>{lines.map((l) => (
            <tr key={l.lot_id} className={reveal && l.counted_qty !== l.system_qty ? 'urgent' : ''}><td>{l.generic_name} {l.strength}</td><td>{l.batch_no}</td><td>{fmtDate(l.expiry_date, tenant)}</td>
              <td><input type="hidden" name="lotId" value={l.lot_id} /><input type="number" name="qty" min={0} required defaultValue={l.counted_qty ?? ''} disabled={count.status !== 'open'} style={{ width: 100 }} /></td>
              {reveal && <><td>{l.system_qty}</td><td>{(l.counted_qty ?? 0) - l.system_qty}</td></>}</tr>))}</tbody></table>
        {count.status === 'open' && <button className="btn primary">Save counts</button>}
      </form>
      {count.status === 'submitted' && can(session.role, 'pharmacy.approve') && (
        <form action={countAction.bind(null, slug)} className="card inline-form"><input type="hidden" name="countId" value={id} /><input type="hidden" name="op" value="post" />
          <input name="reason" placeholder="Reason for adjustments" required /><button className="btn primary" disabled={count.counted_by === session.staffId && !tenant.settings.soloPractice}>Post adjustments</button>
          {count.counted_by === session.staffId && !tenant.settings.soloPractice && <small className="muted">A different person must post this count.</small>}</form>)}
    </>
  );
}
