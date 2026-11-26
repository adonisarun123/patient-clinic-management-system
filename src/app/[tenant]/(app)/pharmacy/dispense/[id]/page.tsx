import { requireStaff } from '@/lib/session';
import { prescriptionForDispense, dispensableProducts } from '@/domain/pharmacy';
import { listCatalog } from '@/domain/catalog';
import { Flash, PageHead } from '@/components/ui';
import { dispenseAction } from '../../../module-actions';

export default async function Dispense({ params, searchParams }: { params: Promise<{ tenant: string; id: string }>; searchParams: Promise<{ ok?: string; err?: string }> }) {
  const { tenant: slug, id } = await params;
  const sp = await searchParams;
  const { tenant, actor } = await requireStaff(slug, 'pharmacy.dispense');
  const { rx, lines, allergies } = await prescriptionForDispense(actor, tenant, id);
  const products = await dispensableProducts(actor, tenant);
  const stores = (await listCatalog(tenant.id)).locations.filter((l) => l.kind === 'store' && l.active);
  const guess = (drug: string) => products.find((p) => drug.toLowerCase().includes(p.generic_name.toLowerCase().split(' ')[0]))?.id ?? '';
  return (
    <>
      <PageHead title={`Dispense ${rx.rx_number}`} sub={`${rx.full_name} · ${rx.uhid}`} />
      <Flash {...sp} />
      <p>{rx.allergy_status === 'no_known_allergies' ? <span className="pill ok">No known allergies</span> : allergies.length ? <span className="pill danger">Allergies: {allergies.map((a) => a.substance).join(', ')}</span> : <span className="pill warn">Allergies not reviewed</span>}</p>
      {rx.status !== 'signed' ? <p className="flash err">This prescription is {rx.status}. Dispense only from the current signed version.</p> : (
        <form action={dispenseAction.bind(null, slug, id)} className="card">
          <input type="hidden" name="patientId" value={rx.patient_id} />
          <label style={{ maxWidth: 300 }}>From store<select name="locationId" required>{stores.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}</select></label>
          <table className="table"><thead><tr><th>Prescribed</th><th>Dispensed</th><th>Product</th><th>Qty now</th><th>Substitution reason</th></tr></thead>
            <tbody>{lines.map((l) => (
              <tr key={l.id}><td><b>{l.drug_name}</b> {l.strength}<div className="small muted">{l.dose}, {l.frequency}, {l.duration}{l.quantity ? ` · qty ${l.quantity}` : ''}</div></td>
                <td>{l.dispensed}</td>
                <td><input type="hidden" name="rxLineId" value={l.id} /><select name="productId" defaultValue={guess(l.drug_name)}><option value="">— skip —</option>{products.map((p) => <option key={p.id} value={p.id}>{p.generic_name} {p.strength} {p.form} (usable {p.usable})</option>)}</select></td>
                <td><input type="number" name="qty" min={0} defaultValue={l.quantity && /^\d+$/.test(l.quantity.trim()) ? Math.max(0, Number(l.quantity) - l.dispensed) : ''} style={{ width: 90 }} /></td>
                <td><input name="subReason" placeholder="Only if different product" /></td></tr>))}</tbody></table>
          <label className="check"><input type="checkbox" name="counselled" /> Patient counselled on use, dose and storage</label>
          <p className="small muted">Batches are picked automatically, earliest expiry first. Expired, quarantined and recalled stock is never used.</p>
          <button className="btn primary">Dispense and charge</button>
        </form>)}
    </>
  );
}
