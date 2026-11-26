import { z } from 'zod';
import { withTenant, type Tx } from '@/lib/db';
import { AppError, invalid, notFound, rule } from '@/lib/errors';
import { authorize, actorId, staffId, type Actor } from '@/lib/actor';
import { can } from '@/lib/rbac';
import { audit, emit } from '@/lib/events';
import { idempotent } from '@/lib/idempotency';
import { financialYear, lineTax } from '@/lib/money';
import { chartIds } from './patients';
import type { Tenant } from './tenants';

const businessDate = (tz: string) => new Date().toLocaleDateString('en-CA', { timeZone: tz });
const CASH_METHODS = new Set(['cash']);

async function accounts(tx: Tx) {
  const rows = await tx.many<{ id: string; code: string }>(`SELECT id, code FROM ledger_account`);
  const m = new Map(rows.map((r) => [r.code, r.id]));
  const get = (c: string) => { const id = m.get(c); if (!id) throw new AppError('INTERNAL', `Ledger account ${c} missing`); return id; };
  return { cash: get('1000'), clearing: get('1010'), receivable: get('1100'), advances: get('2100'), tax: get('2200'), revenue: get('4000') };
}

type Leg = { account: string; debit?: number; credit?: number };

/** Writes one balanced journal. The deferred trigger re-checks the balance at commit. */
async function postJournal(tx: Tx, tenant: Tenant, actor: Actor, src: { kind: string; id: string; key: string; date: string; memo: string; patientId?: string; reverses?: string }, legs: Leg[]) {
  const lines = legs.filter((l) => (l.debit ?? 0) > 0 || (l.credit ?? 0) > 0);
  const d = lines.reduce((s, l) => s + (l.debit ?? 0), 0);
  const c = lines.reduce((s, l) => s + (l.credit ?? 0), 0);
  if (d !== c) throw new AppError('INTERNAL', `Unbalanced journal ${src.key}: ${d} vs ${c}`);
  if (lines.length < 2) return null;
  const j = await tx.one<{ id: string }>(
    `INSERT INTO journal (tenant_id, source_kind, source_id, source_key, business_date, memo, reverses_id, posted_by)
     VALUES (app_tenant_id(), $1,$2,$3,$4,$5,$6,$7) RETURNING id`,
    [src.kind, src.id, src.key, src.date, src.memo, src.reverses ?? null, staffId(actor)]);
  for (const l of lines) {
    await tx.exec(`INSERT INTO journal_line (tenant_id, journal_id, account_id, currency, debit_paise, credit_paise, patient_id)
                   VALUES (app_tenant_id(), $1,$2,$3,$4,$5,$6)`, [j.id, l.account, tenant.currency, l.debit ?? 0, l.credit ?? 0, src.patientId ?? null]);
  }
  return j.id;
}

// ------------------------------------------------------------------ charges
export const chargeInput = z.object({
  patientId: z.uuid(), encounterId: z.uuid().nullish(), serviceId: z.uuid().nullish(),
  description: z.string().trim().min(2).max(300).optional(), quantity: z.number().int().min(1).max(1000).default(1),
  unitPricePaise: z.number().int().min(0).optional(), discountPaise: z.number().int().min(0).default(0),
  discountReason: z.string().max(300).optional(),
});

export async function addCharge(actor: Actor, tenant: Tenant, input: z.input<typeof chargeInput>, requestKey?: string | null) {
  authorize(actor, 'billing.charge');
  const p = chargeInput.parse(input);
  if (p.discountPaise > 0) {
    authorize(actor, 'discount.apply');
    if (!p.discountReason?.trim()) throw invalid('Give a reason for the discount');
  }
  return withTenant(tenant.id, (tx) => idempotent(tx, actorId(actor), 'charge.add', requestKey, p, async () => {
    let desc = p.description; let price = p.unitPricePaise; let tax = 0; let dept: string | null = null;
    if (p.serviceId) {
      const s = await tx.one<{ name: string; price_paise: number; tax_rate_bp: number; department_id: string }>(
        `SELECT name, price_paise, tax_rate_bp, department_id FROM service WHERE id = $1`, [p.serviceId]);
      desc ??= s.name; price ??= Number(s.price_paise); tax = s.tax_rate_bp; dept = s.department_id;
      // Overriding a published tariff needs discount authority, just like a discount.
      if (p.unitPricePaise != null && p.unitPricePaise !== Number(s.price_paise)) authorize(actor, 'discount.apply');
    }
    if (!desc || price == null) throw invalid('Choose a service or enter a description and price');
    if (p.discountPaise > price * p.quantity) throw invalid('Discount cannot exceed the line amount');
    const r = await tx.one<{ id: string }>(
      `INSERT INTO charge_item (tenant_id, patient_id, encounter_id, service_id, department_id, description, quantity, unit_price_paise,
         discount_paise, tax_rate_bp, source_key, discount_reason, created_by)
       VALUES (app_tenant_id(), $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`,
      [p.patientId, p.encounterId ?? null, p.serviceId ?? null, dept, desc, p.quantity, price, p.discountPaise, tax,
        `manual:${crypto.randomUUID()}`, p.discountReason ?? null, staffId(actor)]);
    await audit(tx, actor, 'charge.added', 'charge_item', r.id, { patientId: p.patientId, reason: p.discountReason, data: { price, discount: p.discountPaise } });
    return { chargeId: r.id };
  }));
}

export async function voidCharge(actor: Actor, tenant: Tenant, chargeId: string, reason: string) {
  authorize(actor, 'billing.void');
  if (!reason?.trim()) throw invalid('A reason is required');
  return withTenant(tenant.id, async (tx) => {
    const c = await tx.one<{ status: string; patient_id: string }>(`SELECT status, patient_id FROM charge_item WHERE id = $1 FOR UPDATE`, [chargeId]);
    if (c.status !== 'unbilled') throw rule('Only an unbilled charge can be voided. Void the invoice first.');
    await tx.exec(`UPDATE charge_item SET status = 'voided' WHERE id = $1`, [chargeId]);
    await audit(tx, actor, 'charge.voided', 'charge_item', chargeId, { patientId: c.patient_id, reason });
  });
}

// ------------------------------------------------------------------ invoices
/** POST /v1/invoices: builds lines from unbilled charges and posts with a number and balanced journal, or rolls back entirely. */
export async function billCharges(actor: Actor, tenant: Tenant, patientId: string, chargeIds: string[], requestKey?: string | null) {
  authorize(actor, 'billing.post');
  if (!chargeIds.length) throw invalid('Select at least one charge');
  return withTenant(tenant.id, (tx) => idempotent(tx, actorId(actor), 'invoice.post', requestKey, { patientId, chargeIds: [...chargeIds].sort() }, async () => {
    const ids = await chartIds(tx, patientId);
    const charges = await tx.many<{ id: string; description: string; quantity: number; unit_price_paise: number; discount_paise: number;
      tax_rate_bp: number; status: string; patient_id: string; encounter_id: string | null; clinician_id: string | null; department_id: string | null; service_id: string | null }>(
      `SELECT * FROM charge_item WHERE id = ANY($1) ORDER BY created_at, id FOR UPDATE`, [chargeIds]);
    if (charges.length !== chargeIds.length) throw notFound('Charge');
    for (const c of charges) {
      if (!ids.includes(c.patient_id)) throw rule('All charges must belong to this patient');
      if (c.status !== 'unbilled') throw rule('A selected charge is already billed or voided. Refresh and try again.');
    }
    const lines = charges.map((c) => {
      const gross = Number(c.unit_price_paise) * c.quantity;
      const net = gross - Number(c.discount_paise);
      const tax = lineTax(net, c.tax_rate_bp);
      return { c, gross, discount: Number(c.discount_paise), tax, total: net + tax };
    });
    const subtotal = lines.reduce((s, l) => s + l.gross, 0);
    const discount = lines.reduce((s, l) => s + l.discount, 0);
    const tax = lines.reduce((s, l) => s + l.tax, 0);
    const total = subtotal - discount + tax;
    const date = businessDate(tenant.timezone);
    const fy = financialYear(date);
    const n = await tx.one<{ v: number }>(`SELECT next_doc_number($1) AS v`, [`invoice:${fy}`]);
    const number = `INV/${fy}/${String(n.v).padStart(6, '0')}`;
    const encounterIds = [...new Set(charges.map((c) => c.encounter_id).filter(Boolean))];
    const inv = await tx.one<{ id: string }>(
      `INSERT INTO invoice (tenant_id, patient_id, encounter_id, number, status, subtotal_paise, discount_paise, tax_paise, total_paise,
          business_date, posted_at, posted_by, created_by)
       VALUES (app_tenant_id(), $1,$2,$3,'posted',$4,$5,$6,$7,$8, now(), $9, $9) RETURNING id`,
      [patientId, encounterIds.length === 1 ? encounterIds[0] : null, number, subtotal, discount, tax, total, date, staffId(actor)]);
    for (const l of lines) {
      await tx.exec(
        `INSERT INTO invoice_line (tenant_id, invoice_id, charge_item_id, description, quantity, unit_price_paise, discount_paise, tax_rate_bp,
           tax_paise, line_total_paise, clinician_id, department_id, service_id)
         VALUES (app_tenant_id(), $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        [inv.id, l.c.id, l.c.description, l.c.quantity, l.c.unit_price_paise, l.discount, l.c.tax_rate_bp, l.tax, l.total,
          l.c.clinician_id, l.c.department_id, l.c.service_id]);
    }
    await tx.exec(`UPDATE charge_item SET status = 'billed', invoice_id = $2 WHERE id = ANY($1)`, [chargeIds, inv.id]);
    const a = await accounts(tx);
    await postJournal(tx, tenant, actor, { kind: 'invoice', id: inv.id, key: `invoice:${inv.id}`, date, memo: number, patientId }, [
      { account: a.receivable, debit: total }, { account: a.revenue, credit: subtotal - discount }, { account: a.tax, credit: tax },
    ]);
    await audit(tx, actor, 'invoice.posted', 'invoice', inv.id, { patientId, data: { number, total } });
    await emit(tx, 'invoice.posted', 'invoice', inv.id, { number, totalPaise: total });
    // Apply any unallocated advance automatically (oldest first).
    await autoApplyAdvances(tx, tenant, actor, patientId, inv.id, total, date);
    return { invoiceId: inv.id, number, totalPaise: total };
  }));
}

async function autoApplyAdvances(tx: Tx, tenant: Tenant, actor: Actor, patientId: string, invoiceId: string, due: number, date: string) {
  if (due <= 0) return;
  const ids = await chartIds(tx, patientId);
  const advances = await tx.many<{ payment_id: string; free: number }>(
    `SELECT payment_id, (amount_paise - allocated_paise - refunded_paise) AS free FROM payment_balance
      WHERE patient_id = ANY($1) AND status = 'confirmed' AND amount_paise - allocated_paise - refunded_paise > 0 ORDER BY payment_id`, [ids]);
  for (const adv of advances) {
    if (due <= 0) break;
    const amt = Math.min(Number(adv.free), due);
    await applyAllocation(tx, tenant, actor, adv.payment_id, invoiceId, amt, date, patientId);
    due -= amt;
  }
}

async function applyAllocation(tx: Tx, tenant: Tenant, actor: Actor, paymentId: string, invoiceId: string, amount: number, date: string, patientId: string) {
  const al = await tx.one<{ id: string }>(
    `INSERT INTO allocation (tenant_id, payment_id, invoice_id, amount_paise, direction, created_by) VALUES (app_tenant_id(), $1,$2,$3,'apply',$4) RETURNING id`,
    [paymentId, invoiceId, amount, staffId(actor)]);
  const a = await accounts(tx);
  await postJournal(tx, tenant, actor, { kind: 'allocation', id: al.id, key: `allocation:${al.id}`, date, memo: 'Advance applied', patientId },
    [{ account: a.advances, debit: amount }, { account: a.receivable, credit: amount }]);
}

/** Void: release allocations back to advance, reverse the journal and return charges to unbilled. Number is never reused. */
export async function voidInvoice(actor: Actor, tenant: Tenant, invoiceId: string, reason: string) {
  authorize(actor, 'billing.void');
  if (!reason?.trim()) throw invalid('A reason is required');
  return withTenant(tenant.id, async (tx) => {
    const inv = await tx.maybe<{ id: string; status: string; number: string; patient_id: string; total_paise: number; subtotal_paise: number; discount_paise: number; tax_paise: number }>(
      `SELECT * FROM invoice WHERE id = $1 FOR UPDATE`, [invoiceId]);
    if (!inv) throw notFound('Invoice');
    if (inv.status !== 'posted') throw rule('Only a posted invoice can be voided');
    const date = businessDate(tenant.timezone);
    const a = await accounts(tx);
    const perPayment = await tx.many<{ payment_id: string; net: number }>(
      `SELECT payment_id, sum(CASE direction WHEN 'apply' THEN amount_paise ELSE -amount_paise END)::bigint AS net
         FROM allocation WHERE invoice_id = $1 GROUP BY payment_id HAVING sum(CASE direction WHEN 'apply' THEN amount_paise ELSE -amount_paise END) > 0`, [invoiceId]);
    for (const p of perPayment) {
      const al = await tx.one<{ id: string }>(
        `INSERT INTO allocation (tenant_id, payment_id, invoice_id, amount_paise, direction, reason, created_by) VALUES (app_tenant_id(), $1,$2,$3,'release',$4,$5) RETURNING id`,
        [p.payment_id, invoiceId, p.net, `Invoice void: ${reason}`, staffId(actor)]);
      await postJournal(tx, tenant, actor, { kind: 'allocation', id: al.id, key: `allocation:${al.id}`, date, memo: `Release from ${inv.number}`, patientId: inv.patient_id },
        [{ account: a.receivable, debit: Number(p.net) }, { account: a.advances, credit: Number(p.net) }]);
    }
    const orig = await tx.maybe<{ id: string }>(`SELECT id FROM journal WHERE source_key = $1`, [`invoice:${invoiceId}`]);
    await postJournal(tx, tenant, actor, { kind: 'invoice_void', id: invoiceId, key: `invoice_void:${invoiceId}`, date, memo: `Void ${inv.number}`, patientId: inv.patient_id, reverses: orig?.id }, [
      { account: a.revenue, debit: Number(inv.subtotal_paise) - Number(inv.discount_paise) }, { account: a.tax, debit: Number(inv.tax_paise) },
      { account: a.receivable, credit: Number(inv.total_paise) },
    ]);
    await tx.exec(`UPDATE invoice SET status = 'void', void_reason = $2, voided_at = now(), voided_by = $3, version = version + 1 WHERE id = $1`, [invoiceId, reason, staffId(actor)]);
    await tx.exec(`UPDATE charge_item SET status = 'unbilled', invoice_id = NULL WHERE invoice_id = $1`, [invoiceId]);
    await audit(tx, actor, 'invoice.voided', 'invoice', invoiceId, { patientId: inv.patient_id, reason });
    await emit(tx, 'invoice.voided', 'invoice', invoiceId, { number: inv.number });
  });
}

// ------------------------------------------------------------------ payments
export const paymentInput = z.object({
  patientId: z.uuid(),
  method: z.enum(['cash', 'upi', 'card', 'bank_transfer', 'cheque', 'other', 'gateway']),
  amountPaise: z.number().int().positive(),
  reference: z.string().trim().max(120).optional(),
  note: z.string().max(300).optional(),
  allocations: z.array(z.object({ invoiceId: z.uuid(), amountPaise: z.number().int().positive() })).default([]),
  autoAllocate: z.boolean().default(true),
});

/** POST /v1/payments: externally confirmed tender only (no card data). Receipt number, allocation and journal are atomic. */
export async function recordPayment(actor: Actor, tenant: Tenant, input: z.input<typeof paymentInput>, requestKey?: string | null, txIn?: Tx) {
  authorize(actor, 'billing.collect');
  const p = paymentInput.parse(input);
  if (!CASH_METHODS.has(p.method) && !p.reference) throw invalid('Enter the transaction reference shown on the UPI/card/bank confirmation');
  const run = (fn: (tx: Tx) => Promise<{ paymentId: string; receiptNo: string; unallocatedPaise: number }>) => (txIn ? fn(txIn) : withTenant(tenant.id, fn));
  return run((tx) => idempotent(tx, actorId(actor), 'payment.record', requestKey, p, async () => {
    const date = businessDate(tenant.timezone);
    const fy = financialYear(date);
    const n = await tx.one<{ v: number }>(`SELECT next_doc_number($1) AS v`, [`receipt:${fy}`]);
    const receiptNo = `RCT/${fy}/${String(n.v).padStart(6, '0')}`;
    const pay = await tx.one<{ id: string }>(
      `INSERT INTO payment (tenant_id, patient_id, receipt_no, method, amount_paise, reference, business_date, received_by, note)
       VALUES (app_tenant_id(), $1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
      [p.patientId, receiptNo, p.method, p.amountPaise, p.reference || null, date, staffId(actor), p.note ?? null]);
    const a = await accounts(tx);
    const tender = CASH_METHODS.has(p.method) ? a.cash : a.clearing;
    await postJournal(tx, tenant, actor, { kind: 'payment', id: pay.id, key: `payment:${pay.id}`, date, memo: receiptNo, patientId: p.patientId },
      [{ account: tender, debit: p.amountPaise }, { account: a.advances, credit: p.amountPaise }]);
    let remaining = p.amountPaise;
    const ids = await chartIds(tx, p.patientId);
    const targets = p.allocations.length ? p.allocations : p.autoAllocate
      ? (await tx.many<{ invoice_id: string; due_paise: number }>(
        `SELECT invoice_id, due_paise FROM invoice_balance WHERE patient_id = ANY($1) AND status = 'posted' AND due_paise > 0 ORDER BY number`, [ids]))
        .map((r) => ({ invoiceId: r.invoice_id, amountPaise: Number(r.due_paise) }))
      : [];
    for (const t of targets) {
      if (remaining <= 0) break;
      await tx.exec(`SELECT id FROM invoice WHERE id = $1 FOR UPDATE`, [t.invoiceId]);
      const bal = await tx.one<{ due_paise: number; status: string; patient_id: string }>(
        `SELECT due_paise, status, patient_id FROM invoice_balance WHERE invoice_id = $1`, [t.invoiceId]);
      if (bal.status !== 'posted' || !ids.includes(bal.patient_id)) throw rule('Payment can only be applied to this patient’s posted invoices');
      const amt = Math.min(t.amountPaise, Number(bal.due_paise), remaining);
      if (amt <= 0) continue;
      await applyAllocation(tx, tenant, actor, pay.id, t.invoiceId, amt, date, p.patientId);
      remaining -= amt;
    }
    await audit(tx, actor, 'payment.received', 'payment', pay.id, { patientId: p.patientId, data: { receiptNo, amount: p.amountPaise, method: p.method } });
    await emit(tx, 'payment.received', 'payment', pay.id, { receiptNo, amountPaise: p.amountPaise, method: p.method });
    return { paymentId: pay.id, receiptNo, unallocatedPaise: remaining };
  }));
}

// ------------------------------------------------------------------ refunds (dual control)
export const refundInput = z.object({
  paymentId: z.uuid(), amountPaise: z.number().int().positive(),
  method: z.enum(['cash', 'upi', 'card', 'bank_transfer', 'cheque', 'other']), reason: z.string().trim().min(5).max(500),
});

export async function requestRefund(actor: Actor, tenant: Tenant, input: z.input<typeof refundInput>) {
  authorize(actor, 'refund.request');
  const p = refundInput.parse(input);
  return withTenant(tenant.id, async (tx) => {
    const pay = await tx.maybe<{ patient_id: string; amount_paise: number; status: string }>(`SELECT patient_id, amount_paise, status FROM payment WHERE id = $1 FOR UPDATE`, [p.paymentId]);
    if (!pay || pay.status !== 'confirmed') throw notFound('Payment');
    const pending = await tx.one<{ s: number }>(`SELECT COALESCE(sum(amount_paise),0)::bigint AS s FROM refund WHERE payment_id = $1 AND status IN ('requested','approved','paid')`, [p.paymentId]);
    if (Number(pending.s) + p.amountPaise > Number(pay.amount_paise)) throw rule('Refunds cannot exceed the amount received on this receipt');
    const r = await tx.one<{ id: string }>(
      `INSERT INTO refund (tenant_id, payment_id, patient_id, amount_paise, method, reason, requested_by) VALUES (app_tenant_id(), $1,$2,$3,$4,$5,$6) RETURNING id`,
      [p.paymentId, pay.patient_id, p.amountPaise, p.method, p.reason, staffId(actor)]);
    await audit(tx, actor, 'refund.requested', 'refund', r.id, { patientId: pay.patient_id, reason: p.reason, data: { amount: p.amountPaise } });
    return { refundId: r.id };
  });
}

/** CFG-005: self-approval is rejected unless the clinic runs in solo-practice mode, and then it is flagged. */
export async function decideRefund(actor: Actor, tenant: Tenant, refundId: string, approve: boolean, note?: string) {
  authorize(actor, 'refund.approve');
  return withTenant(tenant.id, async (tx) => {
    const r = await tx.maybe<{ status: string; requested_by: string; patient_id: string }>(`SELECT status, requested_by, patient_id FROM refund WHERE id = $1 FOR UPDATE`, [refundId]);
    if (!r) throw notFound('Refund');
    if (r.status !== 'requested') throw rule('This refund has already been decided');
    const self = staffId(actor) === r.requested_by;
    if (self && !tenant.settings.soloPractice) throw rule('A different authorised person must approve this refund (dual control).');
    await tx.exec(`UPDATE refund SET status = $2, decided_by = $3, decided_at = now(), self_approved = $4 WHERE id = $1`,
      [refundId, approve ? 'approved' : 'rejected', staffId(actor), self]);
    await audit(tx, actor, approve ? 'refund.approved' : 'refund.rejected', 'refund', refundId, { patientId: r.patient_id, reason: note, data: { selfApproved: self } });
  });
}

/** Pays an approved refund. Releases allocations if the receipt has no free balance; posts Dr advances / Cr tender. */
export async function payRefund(actor: Actor, tenant: Tenant, refundId: string, reference?: string) {
  authorize(actor, 'billing.collect');
  return withTenant(tenant.id, async (tx) => {
    const r = await tx.maybe<{ id: string; status: string; payment_id: string; amount_paise: number; method: string; patient_id: string }>(`SELECT * FROM refund WHERE id = $1 FOR UPDATE`, [refundId]);
    if (!r) throw notFound('Refund');
    if (r.status !== 'approved') throw rule('Only an approved refund can be paid');
    if (r.method !== 'cash' && !reference) throw invalid('Enter the refund transaction reference');
    const date = businessDate(tenant.timezone);
    const a = await accounts(tx);
    const bal = await tx.one<{ amount_paise: number; allocated_paise: number; refunded_paise: number }>(`SELECT * FROM payment_balance WHERE payment_id = $1`, [r.payment_id]);
    // refunded_paise already includes this approved refund; free = amount - allocated - other refunds.
    let shortfall = Number(r.amount_paise) - (Number(bal.amount_paise) - Number(bal.allocated_paise) - (Number(bal.refunded_paise) - Number(r.amount_paise)));
    if (shortfall > 0) {
      const applied = await tx.many<{ invoice_id: string; net: number }>(
        `SELECT invoice_id, sum(CASE direction WHEN 'apply' THEN amount_paise ELSE -amount_paise END)::bigint AS net
           FROM allocation WHERE payment_id = $1 GROUP BY invoice_id HAVING sum(CASE direction WHEN 'apply' THEN amount_paise ELSE -amount_paise END) > 0
          ORDER BY max(created_at) DESC`, [r.payment_id]);
      for (const x of applied) {
        if (shortfall <= 0) break;
        const amt = Math.min(Number(x.net), shortfall);
        const al = await tx.one<{ id: string }>(
          `INSERT INTO allocation (tenant_id, payment_id, invoice_id, amount_paise, direction, reason, created_by) VALUES (app_tenant_id(), $1,$2,$3,'release','Refund',$4) RETURNING id`,
          [r.payment_id, x.invoice_id, amt, staffId(actor)]);
        await postJournal(tx, tenant, actor, { kind: 'allocation', id: al.id, key: `allocation:${al.id}`, date, memo: 'Released for refund', patientId: r.patient_id },
          [{ account: a.receivable, debit: amt }, { account: a.advances, credit: amt }]);
        shortfall -= amt;
      }
    }
    const tender = r.method === 'cash' ? a.cash : a.clearing;
    await postJournal(tx, tenant, actor, { kind: 'refund', id: r.id, key: `refund:${r.id}`, date, memo: 'Refund paid', patientId: r.patient_id },
      [{ account: a.advances, debit: Number(r.amount_paise) }, { account: tender, credit: Number(r.amount_paise) }]);
    await tx.exec(`UPDATE refund SET status = 'paid', paid_reference = $2, paid_at = now(), business_date = $3 WHERE id = $1`, [refundId, reference ?? null, date]);
    await audit(tx, actor, 'refund.paid', 'refund', refundId, { patientId: r.patient_id, data: { amount: r.amount_paise } });
    await emit(tx, 'refund.paid', 'refund', refundId, { amountPaise: Number(r.amount_paise) });
  });
}

// ------------------------------------------------------------------ reads
export async function patientAccount(actor: Actor, tenant: Tenant, patientId: string) {
  authorize(actor, 'billing.read');
  return withTenant(tenant.id, async (tx) => {
    const ids = await chartIds(tx, patientId);
    const charges = await tx.many<{ id: string; description: string; quantity: number; unit_price_paise: number; discount_paise: number; tax_rate_bp: number; status: string; created_at: Date; discount_reason: string | null }>(
      `SELECT * FROM charge_item WHERE patient_id = ANY($1) AND status = 'unbilled' ORDER BY created_at`, [ids]);
    const invoices = await tx.many<{ invoice_id: string; number: string; status: string; total_paise: number; paid_paise: number; due_paise: number; business_date: string }>(
      `SELECT b.*, i.business_date FROM invoice_balance b JOIN invoice i ON i.id = b.invoice_id WHERE b.patient_id = ANY($1) ORDER BY i.created_at DESC`, [ids]);
    const payments = await tx.many<{ payment_id: string; receipt_no: string; amount_paise: number; allocated_paise: number; refunded_paise: number; status: string; method: string; reference: string | null; received_at: Date }>(
      `SELECT b.*, p.method, p.reference, p.received_at FROM payment_balance b JOIN payment p ON p.id = b.payment_id WHERE b.patient_id = ANY($1) ORDER BY p.received_at DESC`, [ids]);
    const refunds = await tx.many<{ id: string; amount_paise: number; status: string; reason: string; method: string; requested_by_name: string; requested_at: Date }>(
      `SELECT r.*, s.full_name AS requested_by_name FROM refund r JOIN staff s ON s.id = r.requested_by WHERE r.patient_id = ANY($1) ORDER BY requested_at DESC`, [ids]);
    const due = invoices.filter((i) => i.status === 'posted').reduce((s, i) => s + Number(i.due_paise), 0);
    const advance = payments.filter((p) => p.status === 'confirmed').reduce((s, p) => s + Number(p.amount_paise) - Number(p.allocated_paise) - Number(p.refunded_paise), 0);
    return { charges, invoices, payments, refunds, duePaise: due, advancePaise: advance };
  });
}

export async function invoiceDetail(actor: Actor, tenant: Tenant, invoiceId: string) {
  authorize(actor, 'billing.read');
  return withTenant(tenant.id, async (tx) => {
    const invoice = await tx.maybe<{ id: string; number: string; status: string; patient_id: string; subtotal_paise: number; discount_paise: number; tax_paise: number;
      total_paise: number; business_date: string; posted_at: Date; void_reason: string | null; uhid: string; full_name: string; phone_e164: string | null }>(
      `SELECT i.*, p.uhid, p.full_name, p.phone_e164 FROM invoice i JOIN patient p ON p.id = i.patient_id WHERE i.id = $1`, [invoiceId]);
    if (!invoice) throw notFound('Invoice');
    const lines = await tx.many<{ description: string; quantity: number; unit_price_paise: number; discount_paise: number; tax_paise: number; tax_rate_bp: number; line_total_paise: number }>(
      `SELECT * FROM invoice_line WHERE invoice_id = $1 ORDER BY id`, [invoiceId]);
    const balance = await tx.one<{ paid_paise: number; due_paise: number }>(`SELECT paid_paise, due_paise FROM invoice_balance WHERE invoice_id = $1`, [invoiceId]);
    const allocations = await tx.many(`SELECT a.*, p.receipt_no, p.method FROM allocation a JOIN payment p ON p.id = a.payment_id WHERE a.invoice_id = $1 ORDER BY a.created_at`, [invoiceId]);
    return { invoice, lines, balance, allocations };
  });
}

export async function receiptDetail(actor: Actor, tenant: Tenant, paymentId: string) {
  authorize(actor, 'billing.read');
  return withTenant(tenant.id, async (tx) => {
    const payment = await tx.maybe<{ receipt_no: string; method: string; amount_paise: number; reference: string | null; received_at: Date; uhid: string; full_name: string; status: string }>(
      `SELECT pm.*, p.uhid, p.full_name FROM payment pm JOIN patient p ON p.id = pm.patient_id WHERE pm.id = $1`, [paymentId]);
    if (!payment) throw notFound('Receipt');
    const allocations = await tx.many<{ number: string; amount_paise: number; direction: string }>(
      `SELECT i.number, a.amount_paise, a.direction FROM allocation a JOIN invoice i ON i.id = a.invoice_id WHERE a.payment_id = $1 ORDER BY a.created_at`, [paymentId]);
    return { payment, allocations };
  });
}

export async function pendingRefunds(actor: Actor, tenant: Tenant) {
  authorize(actor, 'billing.read');
  return withTenant(tenant.id, (tx) => tx.many<{ id: string; amount_paise: number; method: string; reason: string; status: string; requested_by: string; requested_by_name: string; full_name: string; uhid: string; receipt_no: string; requested_at: Date }>(
    `SELECT r.*, s.full_name AS requested_by_name, p.full_name, p.uhid, pm.receipt_no
       FROM refund r JOIN staff s ON s.id = r.requested_by JOIN patient p ON p.id = r.patient_id JOIN payment pm ON pm.id = r.payment_id
      WHERE r.status IN ('requested','approved') ORDER BY r.requested_at`));
}

export { can };
