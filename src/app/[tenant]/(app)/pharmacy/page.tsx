import Link from 'next/link';
import { requireStaff } from '@/lib/session';
import { requireModule } from '@/domain/tenants';
import { dispenseQueue, stockOverview } from '@/domain/pharmacy';
import { listCatalog } from '@/domain/catalog';
import { can } from '@/lib/rbac';
import { fmtDate, fmtDateTime, money } from '@/lib/format';
import { Badge, Empty, Flash, PageHead } from '@/components/ui';
import { countAction, poAction, productAction, recallAction, receiveAction } from '../module-actions';

export default async function Pharmacy({ params, searchParams }: { params: Promise<{ tenant: string }>; searchParams: Promise<{ tab?: string; edit?: string; ok?: string; err?: string }> }) {
  const { tenant: slug } = await params;
  const sp = await searchParams;
  const { tenant, actor, session } = await requireStaff(slug, 'pharmacy.dispense');
  requireModule(tenant, 'pharmacy');
  const tab = sp.tab ?? 'queue';
  const stockRole = can(session.role, 'pharmacy.stock');
  const queue = tab === 'queue' ? await dispenseQueue(actor, tenant) : [];
  const ov = tab !== 'queue' && stockRole ? await stockOverview(actor, tenant) : null;
  const stores = (await listCatalog(tenant.id)).locations.filter((l) => l.kind === 'store' && l.active);
  const pname = (id: string) => ov?.products.find((p) => p.id === id)?.generic_name ?? '';
  const edit = ov?.products.find((p) => p.id === sp.edit);
  return (
    <>
      <PageHead title="Pharmacy" sub="Dispensing against signed prescriptions, batch and expiry stock, purchasing, recalls and counts." />
      <Flash ok={sp.ok} err={sp.err} />
      {!stores.length && <p className="flash warn">Create a store location first: Settings › Structure › Rooms and counters, type “store”.</p>}
      <nav className="tabs">{['queue', 'stock', 'purchasing', 'counts'].filter((t) => t === 'queue' || stockRole).map((t) => (
        <Link key={t} href={`?tab=${t}`} className={t === tab ? 'on' : ''}>{t === 'queue' ? 'To dispense' : t[0].toUpperCase() + t.slice(1)}</Link>))}</nav>

      {tab === 'queue' && <div className="card">{queue.length === 0 ? <Empty>No signed prescriptions waiting.</Empty> : (
        <table className="table"><thead><tr><th>Prescription</th><th>Patient</th><th>Doctor</th><th>Signed</th><th>Open lines</th><th /></tr></thead>
          <tbody>{queue.map((r) => <tr key={r.id}><td>{r.rx_number}</td><td>{r.full_name}<br /><small className="muted">{r.uhid}</small></td><td>{r.clinician}</td>
            <td>{fmtDateTime(r.signed_at, tenant)}</td><td>{r.open_lines}</td><td><Link className="btn small primary" href={`/${slug}/pharmacy/dispense/${r.id}`}>Dispense</Link></td></tr>)}</tbody></table>)}</div>}

      {tab === 'stock' && ov && (
        <>
          <div className="card"><h2>Products</h2>
            <table className="table small"><thead><tr><th>Code</th><th>Medicine</th><th>Schedule</th><th>Price / unit</th><th>Usable</th><th>On hand</th><th /></tr></thead>
              <tbody>{ov.products.map((p) => <tr key={p.id} className={p.usable <= p.reorder_level ? 'urgent' : p.active ? '' : 'dim'}><td>{p.code}</td>
                <td><b>{p.generic_name}</b> {p.strength} {p.form}{p.brand_name ? <div className="small muted">{p.brand_name}</div> : null}</td>
                <td>{p.schedule}{p.restricted ? <span className="pill danger">Restricted</span> : null}</td><td>{money(p.sale_price_paise, tenant)}</td>
                <td>{p.usable} {p.base_unit}{p.usable <= p.reorder_level ? <span className="pill warn">Reorder</span> : null}</td><td>{p.on_hand}</td><td><Link href={`?tab=stock&edit=${p.id}`}>Edit</Link></td></tr>)}</tbody></table></div>
          <div className="grid2">
            <form action={receiveAction.bind(null, slug)} className="card form-grid tight">
              <h2 className="span2">Receive stock</h2>
              <label>Product<select name="productId" required>{ov.products.filter((p) => p.active).map((p) => <option key={p.id} value={p.id}>{p.generic_name} {p.strength}</option>)}</select></label>
              <label>Store<select name="locationId" required>{stores.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}</select></label>
              <label>Batch no.<input name="batchNo" required /></label><label>Expiry<input type="date" name="expiryDate" required /></label>
              <label>Quantity (base units)<input type="number" name="qty" min={1} required /></label><label>Unit cost<input name="unitCost" inputMode="decimal" /></label>
              <label>Supplier<input name="supplier" /></label>
              <label>Against PO line<select name="poLineId"><option value="">—</option>{ov.pos.filter((o) => o.status !== 'draft').flatMap((o) => o.lines.filter((l) => l.qty_received < l.qty_ordered).map((l) => <option key={l.id} value={l.id}>{o.po_number}: {pname(l.product_id)} ({l.qty_received}/{l.qty_ordered})</option>))}</select></label>
              <label className="check span2"><input type="checkbox" name="quarantine" /> Hold in quarantine (pending inspection)</label>
              <div className="span2"><button className="btn primary">Receive</button></div>
            </form>
            <form action={productAction.bind(null, slug)} className="card form-grid tight">
              <h2 className="span2">{edit ? `Edit ${edit.generic_name}` : 'Add product'}</h2>
              {edit && <input type="hidden" name="id" value={edit.id} />}
              <label>Code<input name="code" defaultValue={edit?.code} required /></label><label>Generic name<input name="genericName" defaultValue={edit?.generic_name} required /></label>
              <label>Brand<input name="brandName" defaultValue={edit?.brand_name ?? ''} /></label><label>Form<input name="form" defaultValue={edit?.form ?? 'Tablet'} required /></label>
              <label>Strength<input name="strength" defaultValue={edit?.strength ?? ''} /></label><label>Base unit<input name="baseUnit" defaultValue={edit?.base_unit ?? 'tablet'} /></label>
              <label>Schedule<select name="schedule" defaultValue={edit?.schedule ?? 'H'}><option value="OTC">OTC (no prescription)</option><option value="G">G</option><option value="H">H</option><option value="H1">H1 (restricted)</option><option value="X">X (restricted)</option></select></label>
              <label>Price per unit<input name="price" inputMode="decimal" defaultValue={edit ? (edit.sale_price_paise / 100).toFixed(2) : ''} required /></label>
              <label>GST %<input name="taxRate" inputMode="decimal" defaultValue={edit ? edit.tax_rate_bp / 100 : 0} /></label>
              <label>Reorder level<input type="number" name="reorderLevel" min={0} defaultValue={edit?.reorder_level ?? 0} /></label>
              <label className="check"><input type="checkbox" name="restricted" defaultChecked={edit?.restricted} /> Restricted (pharmacist only)</label>
              <p className="span2 small muted">Confirm schedule classification and GST rate against current regulations. Restricted products need pharmacy leadership approval.</p>
              <div className="span2"><button className="btn">Save product</button></div>
            </form>
          </div>
          <div className="card"><h2>Batches on hand</h2>
            <table className="table small"><thead><tr><th>Medicine</th><th>Batch</th><th>Expiry</th><th>Store</th><th>Qty</th><th>Status</th><th /></tr></thead>
              <tbody>{ov.lots.map((l) => <tr key={l.id + l.location_id} className={l.days_left <= 90 ? 'urgent' : ''}><td>{pname(l.product_id)}</td><td>{l.batch_no}</td>
                <td>{fmtDate(l.expiry_date, tenant)}{l.days_left <= 0 ? <span className="pill danger">Expired</span> : l.days_left <= 90 ? <span className="pill warn">{l.days_left} days</span> : null}</td>
                <td>{l.location}</td><td>{l.qty}</td><td><Badge v={l.status} /></td>
                <td>{l.status !== 'recalled' && can(session.role, 'pharmacy.approve') && <details><summary className="small">Recall</summary><form action={recallAction.bind(null, slug)} className="inline-form"><input type="hidden" name="lotId" value={l.id} /><input name="reference" placeholder="Recall reference" required /><button className="btn small danger">Recall batch</button></form></details>}</td></tr>)}</tbody></table></div>
        </>)}

      {tab === 'purchasing' && ov && (
        <>
          <div className="card"><h2>Open purchase orders</h2>{ov.pos.length === 0 ? <Empty>None.</Empty> : (
            <table className="table small"><tbody>{ov.pos.map((o) => <tr key={o.id}><td>{o.po_number}</td><td>{o.supplier}</td><td><Badge v={o.status} /></td>
              <td>{o.lines.map((l) => `${pname(l.product_id)} ${l.qty_received}/${l.qty_ordered}`).join('; ')}</td>
              <td>{o.status === 'draft' && can(session.role, 'pharmacy.approve') && <form action={poAction.bind(null, slug)}><input type="hidden" name="op" value="approve" /><input type="hidden" name="poId" value={o.id} /><button className="btn small" disabled={o.created_by === session.staffId && !tenant.settings.soloPractice}>Approve</button></form>}</td></tr>)}</tbody></table>)}</div>
          <form action={poAction.bind(null, slug)} className="card form-grid tight">
            <h2 className="span2">New purchase order</h2>
            <label>Supplier<input name="supplier" required /></label>
            <label>Deliver to<select name="locationId">{stores.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}</select></label>
            {[0, 1, 2, 3, 4].map((i) => (
              <div key={i} className="span2 inline"><select name="productId"><option value="">— product —</option>{ov.products.filter((p) => p.active).map((p) => <option key={p.id} value={p.id}>{p.generic_name} {p.strength} (usable {p.usable})</option>)}</select>
                <input type="number" name="qty" min={0} placeholder="Qty" /><input name="unitCost" inputMode="decimal" placeholder="Unit cost" /></div>))}
            <label className="span2">Note<input name="note" /></label>
            <div className="span2"><button className="btn primary">Create PO</button> <small className="muted">A different person approves it before goods can be received against it.</small></div>
          </form>
        </>)}

      {tab === 'counts' && ov && (
        <div className="card"><h2>Stock counts</h2>
          <table className="table small"><tbody>{ov.counts.map((c) => <tr key={c.id}><td>{fmtDateTime(c.created_at, tenant)}</td><td>{stores.find((s) => s.id === c.location_id)?.name}</td><td><Badge v={c.status} /></td><td><Link href={`/${slug}/pharmacy/counts/${c.id}`}>Open</Link></td></tr>)}</tbody></table>
          <form action={countAction.bind(null, slug)} className="inline-form"><input type="hidden" name="op" value="open" /><select name="locationId">{stores.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}</select><button className="btn">Start blind count</button></form>
        </div>)}
    </>
  );
}
