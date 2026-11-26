// FN-019 cash drawer close, FN-020–022 period close with tax evidence, accounting export (Tally XML + CSV),
// CFG-008 effective-dated service prices.
import { z } from 'zod';
import { withTenant, type Tx } from '@/lib/db';
import { AppError, invalid, notFound, rule } from '@/lib/errors';
import { authorize, staffId, type Actor } from '@/lib/actor';
import { audit } from '@/lib/events';
import type { Tenant } from './tenants';

const businessDate = (tz: string) => new Date().toLocaleDateString('en-CA', { timeZone: tz });

/** Indian currency notes and coins in common use (₹). Counts × face value = counted cash. */
export const DENOMINATIONS = [2000, 500, 200, 100, 50, 20, 10, 5, 2, 1] as const;

async function ensureAccount(tx: Tx, code: string, name: string, type: string) {
  await tx.exec(`INSERT INTO ledger_account (tenant_id, code, name, type) VALUES (app_tenant_id(), $1, $2, $3) ON CONFLICT (tenant_id, code) DO NOTHING`, [code, name, type]);
  return (await tx.one<{ id: string }>(`SELECT id FROM ledger_account WHERE code = $1`, [code])).id;
}

// ------------------------------------------------------------------ cash drawer (FN-019)
export async function openDrawer(actor: Actor, tenant: Tenant, floatPaise: number) {
  authorize(actor, 'billing.collect');
  if (!Number.isInteger(floatPaise) || floatPaise < 0) throw invalid('Enter the opening float');
  return withTenant(tenant.id, async (tx) => {
    const open = await tx.maybe(`SELECT 1 FROM desk_session WHERE staff_id = $1 AND status = 'open'`, [staffId(actor)]);
    if (open) throw rule('You already have an open cash drawer. Close it first.');
    const r = await tx.one<{ id: string }>(`INSERT INTO desk_session (tenant_id, staff_id, business_date, opening_float_paise) VALUES (app_tenant_id(), $1, $2, $3) RETURNING id`,
      [staffId(actor), businessDate(tenant.timezone), floatPaise]);
    await audit(tx, actor, 'drawer.opened', 'desk_session', r.id, { data: { floatPaise } });
    return r.id;
  });
}

/** Cash this person should hold now: float + cash they received − cash refunds they paid, since the drawer opened. */
async function expectedCash(tx: Tx, sessionId: string) {
  return tx.one<{ float: number; receipts: number; refunds: number; expected: number; staff_id: string; opened_at: Date }>(
    `SELECT d.staff_id, d.opened_at, d.opening_float_paise::bigint AS float,
            coalesce((SELECT sum(amount_paise) FROM payment p WHERE p.received_by = d.staff_id AND p.method = 'cash' AND p.status = 'confirmed'
                       AND p.received_at >= d.opened_at AND p.received_at <= coalesce(d.closed_at, now())), 0)::bigint AS receipts,
            coalesce((SELECT sum(amount_paise) FROM refund r WHERE r.paid_by = d.staff_id AND r.method = 'cash' AND r.status = 'paid'
                       AND r.paid_at >= d.opened_at AND r.paid_at <= coalesce(d.closed_at, now())), 0)::bigint AS refunds,
            0::bigint AS expected
       FROM desk_session d WHERE d.id = $1`, [sessionId]).then((r) => ({ ...r, float: Number(r.float), receipts: Number(r.receipts), refunds: Number(r.refunds),
        expected: Number(r.float) + Number(r.receipts) - Number(r.refunds) }));
}

export async function myDrawer(actor: Actor, tenant: Tenant) {
  authorize(actor, 'billing.collect');
  return withTenant(tenant.id, async (tx) => {
    const d = await tx.maybe<{ id: string; opened_at: Date; opening_float_paise: number; business_date: string }>(
      `SELECT id, opened_at, opening_float_paise, business_date::text FROM desk_session WHERE staff_id = $1 AND status = 'open'`, [staffId(actor)]);
    return d ? { ...d, ...(await expectedCash(tx, d.id)) } : null;
  });
}

export const closeDrawerInput = z.object({
  counts: z.record(z.string(), z.coerce.number().int().min(0).max(100000)),
  reason: z.string().max(500).optional(),
});

/**
 * Blind-ish close: the cashier enters the denomination count; the system computes expected cash and the variance.
 * Any variance needs a reason; above the clinic's threshold it also needs another person's approval. The variance is
 * posted to "Cash over/short" so the books match the drawer.
 */
export async function closeDrawer(actor: Actor, tenant: Tenant, input: z.input<typeof closeDrawerInput>) {
  authorize(actor, 'billing.collect');
  const p = closeDrawerInput.parse(input);
  return withTenant(tenant.id, async (tx) => {
    const d = await tx.maybe<{ id: string }>(`SELECT id FROM desk_session WHERE staff_id = $1 AND status = 'open' FOR UPDATE`, [staffId(actor)]);
    if (!d) throw rule('You have no open cash drawer');
    const counts: Record<string, number> = {};
    let counted = 0;
    for (const den of DENOMINATIONS) { const n = Number(p.counts[String(den)] ?? 0); if (n) counts[String(den)] = n; counted += n * den * 100; }
    await tx.exec(`UPDATE desk_session SET closed_at = now() WHERE id = $1`, [d.id]);
    const e = await expectedCash(tx, d.id);
    const variance = counted - e.expected;
    if (variance !== 0 && !p.reason?.trim()) throw invalid(`The count is ${variance > 0 ? 'over' : 'short'} by ₹${Math.abs(variance) / 100}. Recount, or give a reason.`);
    const needsApproval = Math.abs(variance) > tenant.settings.drawerVarianceApprovalPaise && !tenant.settings.soloPractice;
    await tx.exec(`UPDATE desk_session SET status = $2, counted = $3, counted_paise = $4, expected_paise = $5, variance_paise = $6, variance_reason = $7 WHERE id = $1`,
      [d.id, needsApproval ? 'pending_approval' : 'closed', JSON.stringify(counts), counted, e.expected, variance, p.reason ?? null]);
    if (variance !== 0) await postVariance(tx, tenant, actor, d.id, variance);
    await audit(tx, actor, 'drawer.closed', 'desk_session', d.id, { reason: p.reason, data: { counted, expected: e.expected, variance } });
    return { counted, expected: e.expected, variance, needsApproval };
  });
}

async function postVariance(tx: Tx, tenant: Tenant, actor: Actor, sessionId: string, variance: number) {
  const cash = (await tx.one<{ id: string }>(`SELECT id FROM ledger_account WHERE code = '1000'`)).id;
  const overShort = await ensureAccount(tx, '5100', 'Cash over / short', 'expense');
  const j = await tx.one<{ id: string }>(
    `INSERT INTO journal (tenant_id, source_kind, source_id, source_key, business_date, memo, posted_by) VALUES (app_tenant_id(), 'drawer_variance', $1, $2, $3, $4, $5) RETURNING id`,
    [sessionId, `drawer_variance:${sessionId}`, businessDate(tenant.timezone), `Drawer ${variance > 0 ? 'over' : 'short'}`, staffId(actor)]);
  const amt = Math.abs(variance);
  const [dr, cr] = variance > 0 ? [cash, overShort] : [overShort, cash];
  await tx.exec(`INSERT INTO journal_line (tenant_id, journal_id, account_id, currency, debit_paise) VALUES (app_tenant_id(), $1, $2, $3, $4)`, [j.id, dr, tenant.currency, amt]);
  await tx.exec(`INSERT INTO journal_line (tenant_id, journal_id, account_id, currency, credit_paise) VALUES (app_tenant_id(), $1, $2, $3, $4)`, [j.id, cr, tenant.currency, amt]);
}

export async function approveDrawer(actor: Actor, tenant: Tenant, sessionId: string) {
  authorize(actor, 'finance.close');
  await withTenant(tenant.id, async (tx) => {
    const d = await tx.maybe<{ staff_id: string; status: string }>(`SELECT staff_id, status FROM desk_session WHERE id = $1 FOR UPDATE`, [sessionId]);
    if (!d) throw notFound('Drawer session');
    if (d.status !== 'pending_approval') throw rule('This drawer does not need approval');
    if (d.staff_id === staffId(actor)) throw rule('Another person must approve your own drawer variance');
    await tx.exec(`UPDATE desk_session SET status = 'approved', approved_by = $2, approved_at = now() WHERE id = $1`, [sessionId, staffId(actor)]);
    await audit(tx, actor, 'drawer.variance_approved', 'desk_session', sessionId);
  });
}

export async function drawerSessions(actor: Actor, tenant: Tenant, date: string) {
  authorize(actor, 'billing.read');
  return withTenant(tenant.id, (tx) => tx.many<{ id: string; full_name: string; status: string; opened_at: Date; closed_at: Date | null; opening_float_paise: number;
      counted_paise: number | null; expected_paise: number | null; variance_paise: number | null; variance_reason: string | null; approver: string | null }>(
    `SELECT d.*, s.full_name, a.full_name AS approver FROM desk_session d JOIN staff s ON s.id = d.staff_id LEFT JOIN staff a ON a.id = d.approved_by
      WHERE d.business_date = $1 OR d.status IN ('open','pending_approval') ORDER BY d.opened_at`, [date]));
}

// ------------------------------------------------------------------ month close (FN-020–022)
export async function periodSummary(tx: Tx, start: string) {
  const end = (await tx.one<{ e: string }>(`SELECT ($1::date + interval '1 month')::date::text AS e`, [start])).e;
  return {
    trialBalance: await tx.many<{ code: string; name: string; debit: number; credit: number }>(
      `SELECT a.code, a.name,
              coalesce(sum(l.debit_paise) FILTER (WHERE j.business_date >= $1 AND j.business_date < $2), 0)::bigint AS debit,
              coalesce(sum(l.credit_paise) FILTER (WHERE j.business_date >= $1 AND j.business_date < $2), 0)::bigint AS credit
         FROM ledger_account a LEFT JOIN journal_line l ON l.account_id = a.id LEFT JOIN journal j ON j.id = l.journal_id
        GROUP BY a.code, a.name ORDER BY a.code`, [start, end]),
    invoices: await tx.one<{ n: number; total: number; tax: number; voided: number }>(
      `SELECT count(*) FILTER (WHERE status = 'posted')::int AS n, coalesce(sum(total_paise) FILTER (WHERE status = 'posted'), 0)::bigint AS total,
              coalesce(sum(tax_paise) FILTER (WHERE status = 'posted'), 0)::bigint AS tax, count(*) FILTER (WHERE status = 'void')::int AS voided
         FROM invoice WHERE business_date >= $1 AND business_date < $2`, [start, end]),
    taxByRate: await tx.many<{ rate_bp: number; taxable: number; tax: number }>(
      `SELECT l.tax_rate_bp AS rate_bp, sum(l.line_total_paise - l.tax_paise)::bigint AS taxable, sum(l.tax_paise)::bigint AS tax
         FROM invoice_line l JOIN invoice i ON i.id = l.invoice_id WHERE i.status = 'posted' AND i.business_date >= $1 AND i.business_date < $2
        GROUP BY l.tax_rate_bp ORDER BY l.tax_rate_bp`, [start, end]),
    receiptsByTender: await tx.many<{ method: string; n: number; amount: number }>(
      `SELECT method, count(*)::int AS n, sum(amount_paise)::bigint AS amount FROM payment WHERE status = 'confirmed' AND business_date >= $1 AND business_date < $2 GROUP BY method ORDER BY method`, [start, end]),
    refunds: await tx.one<{ n: number; amount: number }>(`SELECT count(*)::int AS n, coalesce(sum(amount_paise), 0)::bigint AS amount FROM refund WHERE status = 'paid' AND business_date >= $1 AND business_date < $2`, [start, end]),
    openDrawers: (await tx.one<{ n: number }>(`SELECT count(*)::int AS n FROM desk_session WHERE status IN ('open','pending_approval') AND business_date < $1`, [end])).n,
  };
}

export async function listPeriods(actor: Actor, tenant: Tenant) {
  authorize(actor, 'finance.close');
  return withTenant(tenant.id, (tx) => tx.many<{ period_start: string; status: string; closed_at: Date | null; reopened_at: Date | null; reopen_reason: string | null; closer: string | null }>(
    `SELECT ap.period_start::text, ap.status, ap.closed_at, ap.reopened_at, ap.reopen_reason, s.full_name AS closer
       FROM accounting_period ap LEFT JOIN staff s ON s.id = ap.closed_by ORDER BY ap.period_start DESC`));
}

export async function closePeriod(actor: Actor, tenant: Tenant, month: string) {
  authorize(actor, 'finance.close');
  if (!/^\d{4}-\d{2}$/.test(month)) throw invalid('Choose a month');
  const start = `${month}-01`;
  if (start >= businessDate(tenant.timezone).slice(0, 7) + '-01') throw rule('Only a past month can be closed');
  return withTenant(tenant.id, async (tx) => {
    const snap = await periodSummary(tx, start);
    if (snap.openDrawers > 0) throw rule('Close (and approve) every cash drawer from this month first');
    const ex = await tx.maybe<{ status: string }>(`SELECT status FROM accounting_period WHERE period_start = $1 FOR UPDATE`, [start]);
    if (ex?.status === 'closed') throw rule('This month is already closed');
    const row = await tx.one<{ id: string }>(
      `INSERT INTO accounting_period (tenant_id, period_start, status, closed_by, closed_at, snapshot) VALUES (app_tenant_id(), $1, 'closed', $2, now(), $3)
       ON CONFLICT (tenant_id, period_start) DO UPDATE SET status = 'closed', closed_by = EXCLUDED.closed_by, closed_at = now(), snapshot = EXCLUDED.snapshot RETURNING id`,
      [start, staffId(actor), JSON.stringify(snap)]);
    await audit(tx, actor, 'period.closed', 'accounting_period', row.id, { data: { month } });
    return snap;
  });
}

export async function reopenPeriod(actor: Actor, tenant: Tenant, month: string, reason: string) {
  authorize(actor, 'finance.close');
  if (actor.kind !== 'staff' || actor.role !== 'owner') throw new AppError('FORBIDDEN', 'Only the clinic owner can reopen a closed month');
  if (!reason?.trim() || reason.trim().length < 10) throw invalid('Explain why the month must be reopened (this is kept in the audit trail)');
  await withTenant(tenant.id, async (tx) => {
    const r = await tx.maybe<{ id: string }>(`UPDATE accounting_period SET status = 'reopened', reopened_by = $2, reopened_at = now(), reopen_reason = $3 WHERE period_start = $1 AND status = 'closed' RETURNING id`,
      [`${month}-01`, staffId(actor), reason]);
    if (!r) throw rule('That month is not closed');
    await audit(tx, actor, 'period.reopened', 'accounting_period', r.id, { reason, data: { month } });
  });
}

// ------------------------------------------------------------------ accounting export
export type JournalRow = { journal_id: string; business_date: string; source_kind: string; memo: string | null; code: string; account: string;
  external_name: string | null; external_group: string | null; debit: number; credit: number; uhid: string | null };

export async function journalRows(actor: Actor, tenant: Tenant, from: string, to: string) {
  authorize(actor, 'finance.close');
  return withTenant(tenant.id, (tx) => tx.many<JournalRow>(
    `SELECT j.id AS journal_id, j.business_date::text, j.source_kind, j.memo, a.code, a.name AS account, a.external_name, a.external_group,
            l.debit_paise::bigint AS debit, l.credit_paise::bigint AS credit, p.uhid
       FROM journal j JOIN journal_line l ON l.journal_id = j.id JOIN ledger_account a ON a.id = l.account_id LEFT JOIN patient p ON p.id = l.patient_id
      WHERE j.business_date BETWEEN $1 AND $2 ORDER BY j.business_date, j.posted_at, j.id, l.debit_paise DESC`, [from, to]));
}

const csvCell = (v: unknown) => { const s = String(v ?? ''); return /[",\n\r]/.test(s) || /^[=+\-@]/.test(s) ? `"${s.replace(/"/g, '""').replace(/^([=+\-@])/, "'$1")}"` : s; };
export function journalsToCsv(rows: JournalRow[]) {
  const head = ['Date', 'Voucher', 'Type', 'Narration', 'Account code', 'Account', 'Export ledger', 'Debit', 'Credit', 'Patient UHID'];
  const lines = rows.map((r) => [r.business_date, r.journal_id.slice(0, 8), r.source_kind, r.memo, r.code, r.account, r.external_name ?? r.account,
    (Number(r.debit) / 100).toFixed(2), (Number(r.credit) / 100).toFixed(2), r.uhid].map(csvCell).join(','));
  return [head.join(','), ...lines].join('\r\n');
}

const xml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
const VCH: Record<string, string> = { payment: 'Receipt', refund: 'Payment' };

/**
 * Tally XML "Import Data › Vouchers" envelope. Debits are written ISDEEMEDPOSITIVE=Yes with a negative AMOUNT and
 * credits ISDEEMEDPOSITIVE=No with a positive AMOUNT, as Tally's own samples do. Receipts/refunds use the Receipt and
 * Payment voucher types; everything else is a Journal. Ledger names come from the mapping in Settings › Accounting
 * (falling back to Clinic Core's account names); those ledgers must exist in Tally — import the ledger masters first.
 */
export function journalsToTallyXml(rows: JournalRow[], companyName?: string) {
  const byJournal = new Map<string, JournalRow[]>();
  for (const r of rows) byJournal.set(r.journal_id, [...(byJournal.get(r.journal_id) ?? []), r]);
  const vouchers = [...byJournal.values()].map((lines) => {
    const h = lines[0];
    const type = VCH[h.source_kind] ?? 'Journal';
    const entries = lines.map((l) => {
      const debit = Number(l.debit) > 0;
      const amt = (Number(debit ? l.debit : l.credit) / 100).toFixed(2);
      return `<ALLLEDGERENTRIES.LIST><LEDGERNAME>${xml(l.external_name ?? l.account)}</LEDGERNAME><ISDEEMEDPOSITIVE>${debit ? 'Yes' : 'No'}</ISDEEMEDPOSITIVE><AMOUNT>${debit ? '-' : ''}${amt}</AMOUNT></ALLLEDGERENTRIES.LIST>`;
    }).join('');
    return `<VOUCHER VCHTYPE="${type}" ACTION="Create"><DATE>${h.business_date.replace(/-/g, '')}</DATE><VOUCHERTYPENAME>${type}</VOUCHERTYPENAME>`
      + `<VOUCHERNUMBER>${xml(`CC-${h.journal_id.slice(0, 8)}`)}</VOUCHERNUMBER><NARRATION>${xml(`${h.memo ?? h.source_kind}${h.uhid ? ` · ${h.uhid}` : ''}`)}</NARRATION>${entries}</VOUCHER>`;
  }).join('');
  const company = companyName ? `<STATICVARIABLES><SVCURRENTCOMPANY>${xml(companyName)}</SVCURRENTCOMPANY></STATICVARIABLES>` : '';
  return `<?xml version="1.0" encoding="UTF-8"?><ENVELOPE><HEADER><TALLYREQUEST>Import Data</TALLYREQUEST></HEADER><BODY><IMPORTDATA><REQUESTDESC><REPORTNAME>Vouchers</REPORTNAME>${company}</REQUESTDESC><REQUESTDATA><TALLYMESSAGE xmlns:UDF="TallyUDF">${vouchers}</TALLYMESSAGE></REQUESTDATA></IMPORTDATA></BODY></ENVELOPE>`;
}

/** Ledger masters for Tally ("All Masters"), so the export's ledgers exist under the mapped groups. */
export async function tallyLedgerMasters(actor: Actor, tenant: Tenant) {
  authorize(actor, 'finance.close');
  const accts = await accountMap(actor, tenant);
  const ledgers = accts.map((a) => `<LEDGER NAME="${xml(a.external_name ?? a.name)}" ACTION="Create"><NAME.LIST><NAME>${xml(a.external_name ?? a.name)}</NAME></NAME.LIST><PARENT>${xml(a.external_group ?? DEFAULT_GROUP[a.type] ?? 'Suspense A/c')}</PARENT></LEDGER>`).join('');
  return `<?xml version="1.0" encoding="UTF-8"?><ENVELOPE><HEADER><TALLYREQUEST>Import Data</TALLYREQUEST></HEADER><BODY><IMPORTDATA><REQUESTDESC><REPORTNAME>All Masters</REPORTNAME></REQUESTDESC><REQUESTDATA><TALLYMESSAGE xmlns:UDF="TallyUDF">${ledgers}</TALLYMESSAGE></REQUESTDATA></IMPORTDATA></BODY></ENVELOPE>`;
}
/** Tally's predefined groups that fit each account type; override per account in Settings. */
export const DEFAULT_GROUP: Record<string, string> = { asset: 'Current Assets', liability: 'Current Liabilities', income: 'Direct Incomes', expense: 'Indirect Expenses', equity: 'Capital Account' };

export async function accountMap(actor: Actor, tenant: Tenant) {
  authorize(actor, 'finance.close');
  return withTenant(tenant.id, (tx) => tx.many<{ id: string; code: string; name: string; type: string; external_name: string | null; external_group: string | null }>(
    `SELECT id, code, name, type, external_name, external_group FROM ledger_account ORDER BY code`));
}

export async function setAccountMapping(actor: Actor, tenant: Tenant, rows: { id: string; externalName?: string; externalGroup?: string }[]) {
  authorize(actor, 'finance.close');
  await withTenant(tenant.id, async (tx) => {
    for (const r of rows) await tx.exec(`UPDATE ledger_account SET external_name = $2, external_group = $3 WHERE id = $1`, [r.id, r.externalName?.trim() || null, r.externalGroup?.trim() || null]);
    await audit(tx, actor, 'settings.account_mapping', 'tenant', tenant.id);
  });
}

// ------------------------------------------------------------------ effective-dated prices (CFG-008)
export const priceChangeInput = z.object({
  serviceId: z.uuid(), pricePaise: z.number().int().min(0),
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  reason: z.string().trim().min(3).max(300),
});

/** Schedules a price for a date range (open-ended if no end). Overlaps are refused by the database. Past dates cannot change. */
export async function schedulePrice(actor: Actor, tenant: Tenant, input: z.input<typeof priceChangeInput>) {
  authorize(actor, 'settings.manage');
  const p = priceChangeInput.parse(input);
  if (p.from < businessDate(tenant.timezone)) throw rule('A price change can start today at the earliest; past prices are history.');
  if (p.to && p.to < p.from) throw invalid('The end date is before the start date');
  return withTenant(tenant.id, async (tx) => {
    try {
      const r = await tx.savepoint(() => tx.one<{ id: string }>(
        `INSERT INTO service_price (tenant_id, service_id, price_paise, valid, reason, created_by) VALUES (app_tenant_id(), $1, $2, daterange($3::date, $4::date, '[]'), $5, $6) RETURNING id`,
        [p.serviceId, p.pricePaise, p.from, p.to ?? null, p.reason, staffId(actor)]));
      await audit(tx, actor, 'service.price_scheduled', 'service', p.serviceId, { reason: p.reason, data: p });
      return r.id;
    } catch (e) {
      const x = e as { code?: string };
      if (x.code === '23P01' || x.code === 'SLOT_TAKEN') throw rule('That period overlaps an existing scheduled price. End or remove the other one first.');
      throw e;
    }
  });
}

/** Only changes that have not started can be removed. */
export async function removeScheduledPrice(actor: Actor, tenant: Tenant, id: string) {
  authorize(actor, 'settings.manage');
  await withTenant(tenant.id, async (tx) => {
    const n = await tx.exec(`DELETE FROM service_price WHERE id = $1 AND lower(valid) > $2::date`, [id, businessDate(tenant.timezone)]);
    if (!n) throw rule('A price that has already applied cannot be removed (it is part of history).');
    await audit(tx, actor, 'service.price_unscheduled', 'service_price', id);
  });
}

export async function priceSchedule(actor: Actor, tenant: Tenant) {
  authorize(actor, 'settings.manage');
  return withTenant(tenant.id, (tx) => tx.many<{ id: string; service_id: string; service_name: string; price_paise: number; from: string; to: string | null; reason: string | null; current: boolean }>(
    `SELECT sp.id, sp.service_id, s.name AS service_name, sp.price_paise, lower(sp.valid)::text AS "from", (upper(sp.valid) - 1)::text AS "to", sp.reason,
            sp.valid @> $1::date AS current
       FROM service_price sp JOIN service s ON s.id = sp.service_id WHERE upper_inf(sp.valid) OR upper(sp.valid) > $1::date - 90 ORDER BY s.name, lower(sp.valid)`,
    [businessDate(tenant.timezone)]));
}
