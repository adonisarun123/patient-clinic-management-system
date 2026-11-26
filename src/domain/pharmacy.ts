import { z } from 'zod';
import { withTenant, type Tx } from '@/lib/db';
import { AppError, invalid, notFound, rule } from '@/lib/errors';
import { authorize, staffId, type Actor } from '@/lib/actor';
import { audit, emit } from '@/lib/events';
import { requireModule, type Tenant } from './tenants';
import { assertChartAccess } from './access';

/**
 * Licensed pharmacy (CL-021–023, HS-009–013). Quantities are integer base units (tablets, ml, vials).
 * stock_balance.qty >= 0 is enforced by the database, so an over-dispense fails rather than going negative.
 * Every change is a stock_move row (append-only) written in the same transaction as the balance.
 */
const localToday = (tz: string) => new Date().toLocaleDateString('en-CA', { timeZone: tz });

async function move(tx: Tx, actor: Actor, m: { kind: string; lotId: string; locationId: string; delta: number; refKind?: string; refId?: string; reason?: string }) {
  if (m.delta === 0) return;
  if (m.delta > 0) {
    await tx.exec(`INSERT INTO stock_balance (tenant_id, lot_id, location_id, qty) VALUES (app_tenant_id(), $1, $2, $3)
                   ON CONFLICT (lot_id, location_id) DO UPDATE SET qty = stock_balance.qty + EXCLUDED.qty`, [m.lotId, m.locationId, m.delta]);
  } else {
    const n = await tx.exec(`UPDATE stock_balance SET qty = qty + $3 WHERE lot_id = $1 AND location_id = $2`, [m.lotId, m.locationId, m.delta]);
    if (!n) throw rule('No stock of this batch at this location');
  }
  await tx.exec(`INSERT INTO stock_move (tenant_id, kind, lot_id, location_id, qty_delta, ref_kind, ref_id, reason, by_staff) VALUES (app_tenant_id(), $1,$2,$3,$4,$5,$6,$7,$8)`,
    [m.kind, m.lotId, m.locationId, m.delta, m.refKind ?? null, m.refId ?? null, m.reason ?? null, staffId(actor)]);
}

// ------------------------------------------------------------------ products
export const productInput = z.object({
  id: z.uuid().optional(), code: z.string().trim().min(1).max(30), genericName: z.string().trim().min(2).max(200), brandName: z.string().max(200).optional(),
  form: z.string().trim().min(2).max(60), strength: z.string().max(60).optional(), baseUnit: z.string().trim().min(1).max(30).default('tablet'),
  schedule: z.string().max(20).default('OTC'), restricted: z.boolean().default(false), salePricePaise: z.number().int().min(0),
  taxRateBp: z.number().int().min(0).max(10000).default(0), reorderLevel: z.number().int().min(0).default(0), active: z.boolean().default(true),
});

/** CL-023: marking a product restricted, or activating one, requires pharmacy leadership (pharmacy.approve). */
export async function upsertProduct(actor: Actor, tenant: Tenant, input: z.input<typeof productInput>) {
  requireModule(tenant, 'pharmacy');
  authorize(actor, 'pharmacy.stock');
  const p = productInput.parse(input);
  if (p.restricted || ['H1', 'X'].includes(p.schedule.toUpperCase())) authorize(actor, 'pharmacy.approve');
  return withTenant(tenant.id, async (tx) => {
    const vals = [p.code.toUpperCase(), p.genericName, p.brandName ?? null, p.form, p.strength ?? null, p.baseUnit, p.schedule.toUpperCase(),
      p.restricted || ['H1', 'X'].includes(p.schedule.toUpperCase()), p.salePricePaise, p.taxRateBp, p.reorderLevel, p.active];
    const r = p.id
      ? await tx.one<{ id: string }>(`UPDATE product SET code=$2, generic_name=$3, brand_name=$4, form=$5, strength=$6, base_unit=$7, schedule=$8, restricted=$9,
          sale_price_paise=$10, tax_rate_bp=$11, reorder_level=$12, active=$13 WHERE id=$1 RETURNING id`, [p.id, ...vals])
      : await tx.one<{ id: string }>(`INSERT INTO product (tenant_id, code, generic_name, brand_name, form, strength, base_unit, schedule, restricted, sale_price_paise,
          tax_rate_bp, reorder_level, active) VALUES (app_tenant_id(), $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`, vals);
    await audit(tx, actor, p.id ? 'product.updated' : 'product.created', 'product', r.id, { data: { schedule: p.schedule, price: p.salePricePaise } });
    return r.id;
  });
}

// ------------------------------------------------------------------ purchasing (HS-009)
export const poInput = z.object({
  supplier: z.string().trim().min(2).max(200), locationId: z.uuid(), note: z.string().max(500).optional(),
  lines: z.array(z.object({ productId: z.uuid(), qty: z.number().int().positive(), unitCostPaise: z.number().int().min(0) })).min(1),
});

export async function createPurchaseOrder(actor: Actor, tenant: Tenant, input: z.input<typeof poInput>) {
  requireModule(tenant, 'pharmacy');
  authorize(actor, 'pharmacy.stock');
  const p = poInput.parse(input);
  return withTenant(tenant.id, async (tx) => {
    const n = await tx.one<{ v: number }>(`SELECT next_doc_number('po') AS v`);
    const po = await tx.one<{ id: string }>(`INSERT INTO purchase_order (tenant_id, po_number, supplier, location_id, created_by, note) VALUES (app_tenant_id(), $1,$2,$3,$4,$5) RETURNING id`,
      [`PO${String(n.v).padStart(6, '0')}`, p.supplier, p.locationId, staffId(actor), p.note ?? null]);
    for (const l of p.lines) await tx.exec(`INSERT INTO po_line (tenant_id, po_id, product_id, qty_ordered, unit_cost_paise) VALUES (app_tenant_id(), $1,$2,$3,$4)`, [po.id, l.productId, l.qty, l.unitCostPaise]);
    await audit(tx, actor, 'po.created', 'purchase_order', po.id);
    return po.id;
  });
}

/** Approval by someone other than the requester (dual control), unless solo practice. */
export async function approvePurchaseOrder(actor: Actor, tenant: Tenant, poId: string) {
  requireModule(tenant, 'pharmacy');
  authorize(actor, 'pharmacy.approve');
  return withTenant(tenant.id, async (tx) => {
    const po = await tx.one<{ status: string; created_by: string }>(`SELECT status, created_by FROM purchase_order WHERE id = $1 FOR UPDATE`, [poId]);
    if (po.status !== 'draft') throw rule('Only a draft order can be approved');
    if (po.created_by === staffId(actor) && !tenant.settings.soloPractice) throw rule('A different person must approve this purchase order');
    await tx.exec(`UPDATE purchase_order SET status = 'approved', approved_by = $2, approved_at = now() WHERE id = $1`, [poId, staffId(actor)]);
    await audit(tx, actor, 'po.approved', 'purchase_order', poId);
  });
}

export const receiveInput = z.object({
  locationId: z.uuid(), productId: z.uuid(), batchNo: z.string().trim().min(1).max(60), expiryDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  qty: z.number().int().positive(), unitCostPaise: z.number().int().min(0).default(0), supplier: z.string().max(200).optional(), manufacturer: z.string().max(200).optional(),
  poLineId: z.uuid().optional(), quarantine: z.boolean().default(false),
});

/** Goods receipt: creates or tops up a lot. Expired stock is refused at the door. */
export async function receiveStock(actor: Actor, tenant: Tenant, input: z.input<typeof receiveInput>) {
  requireModule(tenant, 'pharmacy');
  authorize(actor, 'pharmacy.stock');
  const p = receiveInput.parse(input);
  if (p.expiryDate <= localToday(tenant.timezone)) throw rule('This batch is already expired; it cannot be received into usable stock.');
  return withTenant(tenant.id, async (tx) => {
    const lot = await tx.one<{ id: string; expiry_date: string; status: string }>(
      `INSERT INTO lot (tenant_id, product_id, batch_no, expiry_date, supplier, manufacturer, unit_cost_paise, status)
       VALUES (app_tenant_id(), $1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (tenant_id, product_id, batch_no) DO UPDATE SET supplier = COALESCE(EXCLUDED.supplier, lot.supplier) RETURNING id, expiry_date, status`,
      [p.productId, p.batchNo.toUpperCase(), p.expiryDate, p.supplier ?? null, p.manufacturer ?? null, p.unitCostPaise, p.quarantine ? 'quarantine' : 'released']);
    if (lot.expiry_date !== p.expiryDate) throw rule(`Batch ${p.batchNo} is already recorded with expiry ${lot.expiry_date}. Check the label.`);
    if (lot.status === 'recalled') throw rule('This batch is under recall');
    if (p.poLineId) {
      const n = await tx.exec(`UPDATE po_line l SET qty_received = qty_received + $2 FROM purchase_order o
                               WHERE l.id = $1 AND o.id = l.po_id AND o.status IN ('approved','partly_received') AND l.product_id = $3`, [p.poLineId, p.qty, p.productId]);
      if (!n) throw rule('That purchase order line is not approved for receipt, or the product does not match');
      await tx.exec(`UPDATE purchase_order o SET status = CASE WHEN NOT EXISTS (SELECT 1 FROM po_line WHERE po_id = o.id AND qty_received < qty_ordered) THEN 'received' ELSE 'partly_received' END
                     WHERE id = (SELECT po_id FROM po_line WHERE id = $1)`, [p.poLineId]);
    }
    await move(tx, actor, { kind: 'receipt', lotId: lot.id, locationId: p.locationId, delta: p.qty, refKind: p.poLineId ? 'po_line' : undefined, refId: p.poLineId });
    await audit(tx, actor, 'stock.received', 'lot', lot.id, { data: { qty: p.qty, batch: p.batchNo } });
    return lot.id;
  });
}

// ------------------------------------------------------------------ dispensing (CL-021/022)
export const dispenseInput = z.object({
  prescriptionId: z.uuid().nullish(), patientId: z.uuid(), locationId: z.uuid(), counselled: z.boolean().default(false),
  lines: z.array(z.object({ rxLineId: z.uuid().nullish(), productId: z.uuid(), qty: z.number().int().positive(), substitutionReason: z.string().max(300).optional() })).min(1),
});

/**
 * Dispense against the current signed prescription. For each line: allocate from released, unexpired lots in
 * first-expiry-first-out order, never beyond the prescribed quantity, then charge once per line.
 * Restricted products require a pharmacist. Lots are locked in a stable order so concurrent dispenses cannot oversell.
 */
export async function dispense(actor: Actor, tenant: Tenant, input: z.input<typeof dispenseInput>) {
  requireModule(tenant, 'pharmacy');
  authorize(actor, 'pharmacy.dispense');
  const p = dispenseInput.parse(input);
  return withTenant(tenant.id, async (tx) => {
    await assertChartAccess(tx, actor, tenant, p.patientId);
    let rxLines: { id: string; drug_name: string; quantity: string | null }[] = [];
    if (p.prescriptionId) {
      const rx = await tx.maybe<{ status: string; patient_id: string }>(`SELECT status, patient_id FROM prescription WHERE id = $1`, [p.prescriptionId]);
      if (!rx || rx.patient_id !== p.patientId) throw notFound('Prescription');
      if (rx.status !== 'signed') throw rule(rx.status === 'superseded' ? 'This prescription was replaced by a newer version. Dispense from the current one.' : 'Only a signed prescription can be dispensed');
      rxLines = await tx.many(`SELECT id, drug_name, quantity FROM rx_line WHERE prescription_id = $1`, [p.prescriptionId]);
    }
    const n = await tx.one<{ v: number }>(`SELECT next_doc_number('dispense') AS v`);
    const d = await tx.one<{ id: string; dispense_no: string }>(
      `INSERT INTO dispense (tenant_id, dispense_no, patient_id, prescription_id, location_id, dispensed_by, counselled) VALUES (app_tenant_id(), $1,$2,$3,$4,$5,$6) RETURNING id, dispense_no`,
      [`DSP${String(n.v).padStart(7, '0')}`, p.patientId, p.prescriptionId ?? null, p.locationId, staffId(actor), p.counselled]);
    const today = localToday(tenant.timezone);
    const out: { product: string; qty: number; lots: string[] }[] = [];
    for (const line of p.lines) {
      const prod = await tx.maybe<{ generic_name: string; strength: string | null; restricted: boolean; active: boolean; sale_price_paise: number; tax_rate_bp: number }>(
        `SELECT generic_name, strength, restricted, active, sale_price_paise, tax_rate_bp FROM product WHERE id = $1`, [line.productId]);
      if (!prod?.active) throw notFound('Product');
      if (prod.restricted && !(actor.kind === 'staff' && actor.role === 'pharmacist')) throw new AppError('FORBIDDEN', `${prod.generic_name} is a restricted medicine; a pharmacist must dispense it.`);
      if (p.prescriptionId) {
        if (!line.rxLineId) throw invalid('Map each item to a prescription line');
        const rl = rxLines.find((r) => r.id === line.rxLineId);
        if (!rl) throw invalid('Prescription line does not belong to this prescription');
        if (!rl.drug_name.toLowerCase().includes(prod.generic_name.toLowerCase().split(' ')[0]) && !line.substitutionReason) {
          throw rule(`"${prod.generic_name}" does not match the prescribed "${rl.drug_name}". Record a substitution reason or pick the matching product.`);
        }
        const prescribed = rl.quantity && /^\d+$/.test(rl.quantity.trim()) ? Number(rl.quantity) : null;
        if (prescribed != null) {
          const already = await tx.one<{ q: number }>(`SELECT COALESCE(sum(qty - qty_returned), 0)::int AS q FROM dispense_line WHERE rx_line_id = $1`, [rl.id]);
          if (already.q + line.qty > prescribed) throw rule(`Only ${prescribed - already.q} of ${rl.drug_name} remain on this prescription.`);
        }
      } else {
        // Without a prescription, only non-prescription (OTC) products may be supplied.
        const sched = await tx.one<{ schedule: string }>(`SELECT schedule FROM product WHERE id = $1`, [line.productId]);
        if (sched.schedule !== 'OTC') throw rule(`${prod.generic_name} needs a prescription.`);
      }
      // FEFO: lock candidate balances in expiry, then id order.
      const lots = await tx.many<{ lot_id: string; qty: number; batch_no: string }>(
        `SELECT b.lot_id, b.qty, l.batch_no FROM stock_balance b JOIN lot l ON l.id = b.lot_id
          WHERE l.product_id = $1 AND b.location_id = $2 AND l.status = 'released' AND l.expiry_date > $3 AND b.qty > 0
          ORDER BY l.expiry_date, l.id FOR UPDATE OF b`, [line.productId, p.locationId, today]);
      let need = line.qty; const used: string[] = [];
      for (const l of lots) {
        if (need <= 0) break;
        const take = Math.min(need, l.qty);
        const dl = await tx.one<{ id: string }>(
          `INSERT INTO dispense_line (tenant_id, dispense_id, rx_line_id, product_id, lot_id, qty, substitution_reason) VALUES (app_tenant_id(), $1,$2,$3,$4,$5,$6) RETURNING id`,
          [d.id, line.rxLineId ?? null, line.productId, l.lot_id, take, line.substitutionReason ?? null]);
        await move(tx, actor, { kind: 'dispense', lotId: l.lot_id, locationId: p.locationId, delta: -take, refKind: 'dispense_line', refId: dl.id });
        const ch = await tx.one<{ id: string }>(
          `INSERT INTO charge_item (tenant_id, patient_id, description, quantity, unit_price_paise, tax_rate_bp, source_key, created_by)
           VALUES (app_tenant_id(), $1,$2,$3,$4,$5,$6,$7) RETURNING id`,
          [p.patientId, `${prod.generic_name}${prod.strength ? ` ${prod.strength}` : ''} (batch ${l.batch_no})`, take, prod.sale_price_paise, prod.tax_rate_bp, `dispense_line:${dl.id}`, staffId(actor)]);
        await tx.exec(`UPDATE dispense_line SET charge_item_id = $2 WHERE id = $1`, [dl.id, ch.id]);
        used.push(l.batch_no); need -= take;
      }
      if (need > 0) throw rule(`Not enough usable stock of ${prod.generic_name}: short by ${need}.`);
      out.push({ product: prod.generic_name, qty: line.qty, lots: used });
    }
    await audit(tx, actor, 'dispense.completed', 'dispense', d.id, { patientId: p.patientId, data: { lines: out.length } });
    await emit(tx, 'dispense.completed', 'dispense', d.id, { dispenseNo: d.dispense_no });
    return { dispenseId: d.id, dispenseNo: d.dispense_no, lines: out };
  });
}

/** HS-011: a return goes back to stock only if the batch is still usable and the pack is intact; otherwise quarantine. */
export async function returnDispensed(actor: Actor, tenant: Tenant, dispenseLineId: string, qty: number, opts: { restock: boolean; reason: string }) {
  requireModule(tenant, 'pharmacy');
  authorize(actor, 'pharmacy.dispense');
  if (!opts.reason?.trim()) throw invalid('Give the reason for return');
  return withTenant(tenant.id, async (tx) => {
    const dl = await tx.maybe<{ qty: number; qty_returned: number; lot_id: string; charge_item_id: string | null; dispense_id: string }>(
      `SELECT qty, qty_returned, lot_id, charge_item_id, dispense_id FROM dispense_line WHERE id = $1 FOR UPDATE`, [dispenseLineId]);
    if (!dl) throw notFound('Dispensed item');
    if (qty <= 0 || qty > dl.qty - dl.qty_returned) throw invalid(`You can return at most ${dl.qty - dl.qty_returned}`);
    const d = await tx.one<{ location_id: string; patient_id: string }>(`SELECT location_id, patient_id FROM dispense WHERE id = $1`, [dl.dispense_id]);
    const charge = dl.charge_item_id ? await tx.one<{ status: string; quantity: number; unit_price_paise: number; description: string; tax_rate_bp: number }>(
      `SELECT status, quantity, unit_price_paise, description, tax_rate_bp FROM charge_item WHERE id = $1 FOR UPDATE`, [dl.charge_item_id]) : null;
    if (charge && charge.status === 'billed') throw rule('This item is already invoiced. Void the invoice in Billing, then process the return.');
    const lot = await tx.one<{ status: string; expiry: boolean }>(`SELECT status, expiry_date <= $2::date AS expiry FROM lot WHERE id = $1`, [dl.lot_id, localToday(tenant.timezone)]);
    await tx.exec(`UPDATE dispense_line SET qty_returned = qty_returned + $2 WHERE id = $1`, [dispenseLineId, qty]);
    const usable = opts.restock && lot.status === 'released' && !lot.expiry;
    if (usable) await move(tx, actor, { kind: 'return', lotId: dl.lot_id, locationId: d.location_id, delta: qty, refKind: 'dispense_line', refId: dispenseLineId, reason: opts.reason });
    else await tx.exec(`INSERT INTO stock_move (tenant_id, kind, lot_id, location_id, qty_delta, ref_kind, ref_id, reason, by_staff)
                        VALUES (app_tenant_id(), 'return', $1, $2, $3, 'dispense_line', $4, $5, $6)`,
      [dl.lot_id, d.location_id, qty, dispenseLineId, `Not restocked (destroy/quarantine): ${opts.reason}`, staffId(actor)]);
    // Reprice the unbilled charge: void it and recreate for the quantity kept.
    if (dl.charge_item_id && charge && charge.status === 'unbilled') {
      await tx.exec(`UPDATE charge_item SET status = 'voided', discount_reason = $2 WHERE id = $1`, [dl.charge_item_id, `Return of ${qty}`]);
      const keep = charge.quantity - qty;
      if (keep > 0) {
        const nc = await tx.one<{ id: string }>(`INSERT INTO charge_item (tenant_id, patient_id, description, quantity, unit_price_paise, tax_rate_bp, source_key, created_by)
          VALUES (app_tenant_id(), $1,$2,$3,$4,$5,$6,$7) RETURNING id`,
          [d.patient_id, charge.description, keep, charge.unit_price_paise, charge.tax_rate_bp, `dispense_line:${dispenseLineId}:after_return:${Date.now()}`, staffId(actor)]);
        await tx.exec(`UPDATE dispense_line SET charge_item_id = $2 WHERE id = $1`, [dispenseLineId, nc.id]);
      }
    }
    await audit(tx, actor, 'dispense.returned', 'dispense_line', dispenseLineId, { patientId: d.patient_id, reason: opts.reason, data: { qty, restocked: usable } });
    return { restocked: usable };
  });
}

// ------------------------------------------------------------------ recalls (HS-012)
export async function recallLot(actor: Actor, tenant: Tenant, lotId: string, reference: string) {
  requireModule(tenant, 'pharmacy');
  authorize(actor, 'pharmacy.approve');
  if (!reference?.trim()) throw invalid('Enter the supplier or regulator recall reference');
  return withTenant(tenant.id, async (tx) => {
    await tx.exec(`UPDATE lot SET status = 'recalled', recall_ref = $2 WHERE id = $1`, [lotId, reference]);
    const affected = await tx.many<{ patient_id: string; full_name: string; uhid: string; phone_e164: string | null; qty: number; at: Date; dispense_no: string }>(
      `SELECT p.id AS patient_id, p.full_name, p.uhid, p.phone_e164, dl.qty - dl.qty_returned AS qty, d.at, d.dispense_no
         FROM dispense_line dl JOIN dispense d ON d.id = dl.dispense_id JOIN patient p ON p.id = d.patient_id
        WHERE dl.lot_id = $1 AND dl.qty > dl.qty_returned ORDER BY d.at DESC`, [lotId]);
    await audit(tx, actor, 'lot.recalled', 'lot', lotId, { reason: reference, data: { patientsAffected: affected.length } });
    await emit(tx, 'lot.recalled', 'lot', lotId, { reference, patientsAffected: affected.length });
    return affected;
  });
}

// ------------------------------------------------------------------ stock counts (HS-013) — blind count, then post
export async function openCount(actor: Actor, tenant: Tenant, locationId: string) {
  requireModule(tenant, 'pharmacy');
  authorize(actor, 'pharmacy.stock');
  return withTenant(tenant.id, async (tx) => {
    const c = await tx.one<{ id: string }>(`INSERT INTO stock_count (tenant_id, location_id, counted_by) VALUES (app_tenant_id(), $1, $2) RETURNING id`, [locationId, staffId(actor)]);
    await tx.exec(`INSERT INTO stock_count_line (tenant_id, count_id, lot_id, system_qty) SELECT app_tenant_id(), $1, lot_id, qty FROM stock_balance WHERE location_id = $2`, [c.id, locationId]);
    await audit(tx, actor, 'count.opened', 'stock_count', c.id);
    return c.id;
  });
}

export async function enterCount(actor: Actor, tenant: Tenant, countId: string, counts: { lotId: string; qty: number }[]) {
  authorize(actor, 'pharmacy.stock');
  return withTenant(tenant.id, async (tx) => {
    const c = await tx.one<{ status: string }>(`SELECT status FROM stock_count WHERE id = $1 FOR UPDATE`, [countId]);
    if (c.status !== 'open') throw rule('This count is closed');
    for (const x of counts) {
      if (!Number.isInteger(x.qty) || x.qty < 0) throw invalid('Counts must be whole numbers ≥ 0');
      await tx.exec(`UPDATE stock_count_line SET counted_qty = $3 WHERE count_id = $1 AND lot_id = $2`, [countId, x.lotId, x.qty]);
    }
    await tx.exec(`UPDATE stock_count SET status = 'submitted' WHERE id = $1 AND NOT EXISTS (SELECT 1 FROM stock_count_line WHERE count_id = $1 AND counted_qty IS NULL)`, [countId]);
  });
}

/** Posting adjusts balances to the counted figures, net of movements since the cut-off; needs a second person unless solo. */
export async function postCount(actor: Actor, tenant: Tenant, countId: string, reason: string) {
  requireModule(tenant, 'pharmacy');
  authorize(actor, 'pharmacy.approve');
  return withTenant(tenant.id, async (tx) => {
    const c = await tx.one<{ status: string; counted_by: string; location_id: string; cutoff_at: Date }>(`SELECT * FROM stock_count WHERE id = $1 FOR UPDATE`, [countId]);
    if (c.status !== 'submitted') throw rule('Enter every count before posting');
    if (c.counted_by === staffId(actor) && !tenant.settings.soloPractice) throw rule('A different person must post this count');
    const lines = await tx.many<{ lot_id: string; system_qty: number; counted_qty: number }>(`SELECT lot_id, system_qty, counted_qty FROM stock_count_line WHERE count_id = $1 ORDER BY lot_id`, [countId]);
    let adjusted = 0;
    for (const l of lines) {
      const diff = l.counted_qty - l.system_qty;
      if (diff !== 0) { await move(tx, actor, { kind: 'count', lotId: l.lot_id, locationId: c.location_id, delta: diff, refKind: 'stock_count', refId: countId, reason }); adjusted++; }
    }
    await tx.exec(`UPDATE stock_count SET status = 'posted', posted_by = $2, posted_at = now() WHERE id = $1`, [countId, staffId(actor)]);
    await audit(tx, actor, 'count.posted', 'stock_count', countId, { reason, data: { adjusted } });
    return { adjusted };
  });
}

// ------------------------------------------------------------------ reads
export async function stockOverview(actor: Actor, tenant: Tenant) {
  requireModule(tenant, 'pharmacy');
  authorize(actor, 'pharmacy.stock');
  return withTenant(tenant.id, async (tx) => {
    const today = localToday(tenant.timezone);
    const products = await tx.many<{ id: string; code: string; generic_name: string; brand_name: string | null; form: string; strength: string | null; base_unit: string; schedule: string;
      restricted: boolean; sale_price_paise: number; reorder_level: number; active: boolean; on_hand: number; usable: number; tax_rate_bp: number }>(
      `SELECT p.*, COALESCE(sum(b.qty), 0)::int AS on_hand,
              COALESCE(sum(b.qty) FILTER (WHERE l.status = 'released' AND l.expiry_date > $1), 0)::int AS usable
         FROM product p LEFT JOIN lot l ON l.product_id = p.id LEFT JOIN stock_balance b ON b.lot_id = l.id
        GROUP BY p.id ORDER BY p.generic_name`, [today]);
    const lots = await tx.many<{ id: string; product_id: string; batch_no: string; expiry_date: string; status: string; location_id: string; location: string; qty: number; days_left: number }>(
      `SELECT l.id, l.product_id, l.batch_no, l.expiry_date, l.status, b.location_id, loc.name AS location, b.qty, (l.expiry_date - $1::date) AS days_left
         FROM lot l JOIN stock_balance b ON b.lot_id = l.id JOIN location loc ON loc.id = b.location_id WHERE b.qty > 0 ORDER BY l.expiry_date`, [today]);
    const pos = await tx.many<{ id: string; po_number: string; supplier: string; status: string; created_at: Date; created_by: string; lines: { id: string; product_id: string; qty_ordered: number; qty_received: number }[] }>(
      `SELECT o.*, COALESCE(json_agg(json_build_object('id', l.id, 'product_id', l.product_id, 'qty_ordered', l.qty_ordered, 'qty_received', l.qty_received)) FILTER (WHERE l.id IS NOT NULL), '[]') AS lines
         FROM purchase_order o LEFT JOIN po_line l ON l.po_id = o.id WHERE o.status IN ('draft','approved','partly_received') GROUP BY o.id ORDER BY o.created_at DESC`);
    const counts = await tx.many<{ id: string; status: string; location_id: string; created_at: Date; counted_by: string }>(`SELECT * FROM stock_count WHERE status IN ('open','submitted') ORDER BY created_at DESC`);
    return { products, lots, pos, counts };
  });
}

/** Prescriptions signed in the last 14 days with lines not yet fully dispensed. */
export async function dispenseQueue(actor: Actor, tenant: Tenant) {
  requireModule(tenant, 'pharmacy');
  authorize(actor, 'pharmacy.dispense');
  return withTenant(tenant.id, (tx) => tx.many<{ id: string; rx_number: string; signed_at: Date; patient_id: string; full_name: string; uhid: string; clinician: string; open_lines: number }>(
    `SELECT rx.id, rx.rx_number, rx.signed_at, p.id AS patient_id, p.full_name, p.uhid, c.display_name AS clinician,
            (SELECT count(*)::int FROM rx_line l WHERE l.prescription_id = rx.id
               AND COALESCE((SELECT sum(qty - qty_returned) FROM dispense_line dl WHERE dl.rx_line_id = l.id), 0)
                   < CASE WHEN l.quantity ~ '^\\s*\\d+\\s*$' THEN trim(l.quantity)::int ELSE 1 END) AS open_lines
       FROM prescription rx JOIN patient p ON p.id = rx.patient_id JOIN clinician c ON c.id = rx.clinician_id
      WHERE rx.status = 'signed' AND rx.signed_at > now() - interval '14 days' ORDER BY rx.signed_at DESC`)).then((r) => r.filter((x) => x.open_lines > 0));
}

export async function prescriptionForDispense(actor: Actor, tenant: Tenant, rxId: string) {
  requireModule(tenant, 'pharmacy');
  authorize(actor, 'pharmacy.dispense');
  return withTenant(tenant.id, async (tx) => {
    const rx = await tx.maybe<{ id: string; rx_number: string; status: string; patient_id: string; full_name: string; uhid: string; allergy_status: string }>(
      `SELECT rx.id, rx.rx_number, rx.status, rx.patient_id, p.full_name, p.uhid, p.allergy_status FROM prescription rx JOIN patient p ON p.id = rx.patient_id WHERE rx.id = $1`, [rxId]);
    if (!rx) throw notFound('Prescription');
    await assertChartAccess(tx, actor, tenant, rx.patient_id);
    const lines = await tx.many<{ id: string; drug_name: string; strength: string | null; dose: string; frequency: string; duration: string; quantity: string | null; dispensed: number }>(
      `SELECT l.*, COALESCE((SELECT sum(qty - qty_returned) FROM dispense_line dl WHERE dl.rx_line_id = l.id), 0)::int AS dispensed FROM rx_line l WHERE l.prescription_id = $1 ORDER BY sort_order`, [rxId]);
    const allergies = await tx.many<{ substance: string }>(`SELECT substance FROM allergy WHERE patient_id = $1 AND status = 'active'`, [rx.patient_id]);
    return { rx, lines, allergies };
  });
}

export async function patientDispenses(tenantId: string, patientId: string) {
  return withTenant(tenantId, (tx) => tx.many<{ line_id: string; dispense_no: string; at: Date; generic_name: string; batch_no: string; qty: number; qty_returned: number }>(
    `SELECT dl.id AS line_id, d.dispense_no, d.at, p.generic_name, l.batch_no, dl.qty, dl.qty_returned
       FROM dispense_line dl JOIN dispense d ON d.id = dl.dispense_id JOIN product p ON p.id = dl.product_id JOIN lot l ON l.id = dl.lot_id
      WHERE d.patient_id = $1 ORDER BY d.at DESC LIMIT 100`, [patientId]));
}

/** Products with usable stock, for the dispensing screen (caller must hold pharmacy.dispense). */
export async function dispensableProducts(actor: Actor, tenant: Tenant) {
  requireModule(tenant, 'pharmacy');
  authorize(actor, 'pharmacy.dispense');
  return withTenant(tenant.id, (tx) => tx.many<{ id: string; generic_name: string; strength: string | null; form: string; usable: number }>(
    `SELECT p.id, p.generic_name, p.strength, p.form,
            COALESCE(sum(b.qty) FILTER (WHERE l.status = 'released' AND l.expiry_date > $1), 0)::int AS usable
       FROM product p LEFT JOIN lot l ON l.product_id = p.id LEFT JOIN stock_balance b ON b.lot_id = l.id
      WHERE p.active GROUP BY p.id ORDER BY p.generic_name`, [localToday(tenant.timezone)]));
}
