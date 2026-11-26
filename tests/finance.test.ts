import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { makeClinic, tomorrowAt } from './helpers';
import { pool, withTenant } from '../src/lib/db';
import { AppError, toAppError } from '../src/lib/errors';
import type { Actor } from '../src/lib/actor';
import { registerPatient } from '../src/domain/patients';
import { bookDirect } from '../src/domain/scheduling';
import { addCharge, billCharges, recordPayment, voidInvoice } from '../src/domain/billing';
import * as fin from '../src/domain/finance';

after(async () => { await pool().end(); });
const code = async (p: Promise<unknown>) => { try { await p; return 'OK'; } catch (e) { const x = toAppError(e); return x instanceof AppError ? x.code : `RAW:${(e as Error).message}`; } };
const owner = (c: Awaited<ReturnType<typeof makeClinic>>, id: string): Actor => ({ kind: 'staff', tenantId: c.tenant.id, staffId: id, role: 'owner', clinicianId: null, name: 'Owner' });

test('cash drawer: expected cash from own receipts; variance needs a reason, posts to cash over/short, and large variance needs another approver', async () => {
  const c = await makeClinic();
  const p = await registerPatient(c.reception, c.tenant, { fullName: 'Cash Payer', birthDate: '1990-01-01', phone: '9800000001' });
  await fin.openDrawer(c.cashier, c.tenant, 50000); // ₹500 float
  assert.equal(await code(fin.openDrawer(c.cashier, c.tenant, 0)), 'RULE_VIOLATION', 'one open drawer per person');
  await recordPayment(c.cashier, c.tenant, { patientId: p.id, method: 'cash', amountPaise: 120000 });   // ₹1,200 cash
  await recordPayment(c.cashier, c.tenant, { patientId: p.id, method: 'upi', amountPaise: 30000, reference: 'UPI-DRAWER-1' }); // not cash
  const m = await fin.myDrawer(c.cashier, c.tenant);
  assert.equal(m?.expected, 170000);
  // Counted ₹1,400 against ₹1,700 expected: short ₹300 (above the ₹100 default threshold).
  assert.equal(await code(fin.closeDrawer(c.cashier, c.tenant, { counts: { '500': 2, '100': 4 } })), 'VALIDATION', 'a variance needs a reason');
  const r = await fin.closeDrawer(c.cashier, c.tenant, { counts: { '500': 2, '100': 4 }, reason: 'Change given' });
  assert.equal(r.variance, -30000);
  assert.equal(r.needsApproval, true);
  const sid = (await fin.drawerSessions(c.admin, c.tenant, new Date().toLocaleDateString('en-CA', { timeZone: c.tenant.timezone })))[0].id;
  assert.equal(await code(fin.approveDrawer(c.cashier, c.tenant, sid)), 'FORBIDDEN', 'cashier cannot approve');
  await fin.approveDrawer(c.admin, c.tenant, sid);
  const os = await withTenant(c.tenant.id, (tx) => tx.one<{ d: number }>(`SELECT coalesce(sum(l.debit_paise - l.credit_paise),0)::int AS d FROM journal_line l JOIN ledger_account a ON a.id = l.account_id WHERE a.code = '5100'`));
  assert.equal(os.d, 30000, 'shortfall expensed to cash over/short');
});

test('month close freezes postings dated in the month and its invoices; only the owner can reopen; exports balance', async () => {
  const c = await makeClinic();
  const ownerId = await withTenant(c.tenant.id, async (tx) => (await tx.one<{ id: string }>(`SELECT id FROM staff WHERE role = 'owner'`)).id);
  const o = owner(c, ownerId);
  const p = await registerPatient(c.reception, c.tenant, { fullName: 'Bill Patient', birthDate: '1985-01-01', phone: '9800000002' });
  const ch = await addCharge(c.cashier, c.tenant, { patientId: p.id, serviceId: c.service });
  const inv = await billCharges(c.cashier, c.tenant, p.id, [ch.chargeId]);
  await recordPayment(c.cashier, c.tenant, { patientId: p.id, method: 'card', amountPaise: inv.totalPaise, reference: 'CARD-1' });
  const last = await withTenant(c.tenant.id, (tx) => tx.one<{ d: string; m: string }>(`SELECT (date_trunc('month', now()) - interval '10 days')::date::text AS d, to_char(date_trunc('month', now()) - interval '10 days', 'YYYY-MM') AS m`));
  // Close last month, then try to post into it directly.
  assert.equal(await code(fin.closePeriod(o, c.tenant, new Date().toISOString().slice(0, 7))), 'RULE_VIOLATION', 'current month cannot be closed');
  assert.equal(await code(fin.closePeriod(c.cashier, c.tenant, last.m)), 'FORBIDDEN');
  const snap = await fin.closePeriod(o, c.tenant, last.m);
  assert.ok(Array.isArray(snap.trialBalance));
  // A journal dated in the closed month is refused by the database.
  const refused = await code(withTenant(c.tenant.id, (tx) => tx.exec(
    `INSERT INTO journal (tenant_id, source_kind, source_id, source_key, business_date, memo) VALUES (app_tenant_id(), 'adjustment', gen_random_uuid(), 'x-closed', $1, 'test')`, [last.d])));
  assert.notEqual(refused, 'OK');
  assert.equal(await code(fin.reopenPeriod(c.admin, c.tenant, last.m, 'Admin trying to reopen')), 'FORBIDDEN');
  await fin.reopenPeriod(o, c.tenant, last.m, 'Late supplier invoice to record');
  // Invoices in an open month can still be voided normally.
  await voidInvoice(c.admin, c.tenant, inv.invoiceId, 'Test void');

  const today = new Date().toLocaleDateString('en-CA', { timeZone: c.tenant.timezone });
  const rows = await fin.journalRows(o, c.tenant, last.d, today);
  const dr = rows.reduce((s, r) => s + Number(r.debit), 0); const cr = rows.reduce((s, r) => s + Number(r.credit), 0);
  assert.ok(dr > 0); assert.equal(dr, cr, 'exported vouchers balance');
  const xml = fin.journalsToTallyXml(rows, 'Test & Co');
  assert.ok(xml.includes('<TALLYREQUEST>Import Data</TALLYREQUEST>') && xml.includes('<REPORTNAME>Vouchers</REPORTNAME>') && xml.includes('Test &amp; Co'));
  assert.ok(xml.includes('VCHTYPE="Receipt"'));
  // Debit entries are ISDEEMEDPOSITIVE Yes with negative amount; per voucher the signed amounts net to zero.
  for (const v of xml.split('<VOUCHER ').slice(1)) {
    const amts = [...v.matchAll(/<AMOUNT>(-?[\d.]+)<\/AMOUNT>/g)].map((m) => Number(m[1]));
    assert.equal(Math.round(amts.reduce((s, a) => s + a, 0) * 100), 0);
  }
  const csv = fin.journalsToCsv(rows);
  assert.ok(csv.startsWith('Date,Voucher'));
});

test('scheduled price applies to visits on or after its date; overlaps refused; booking keeps the quoted price', async () => {
  const c = await makeClinic();
  const ownerId = await withTenant(c.tenant.id, async (tx) => (await tx.one<{ id: string }>(`SELECT id FROM staff WHERE role = 'owner'`)).id);
  const o = owner(c, ownerId);
  const p = await registerPatient(c.reception, c.tenant, { fullName: 'Price Patient', birthDate: '1975-01-01', phone: '9800000003' });
  const tomorrow = tomorrowAt(c.tenant.timezone, '10:00');
  const tomorrowDate = new Date(tomorrow).toLocaleDateString('en-CA', { timeZone: c.tenant.timezone });
  const dayAfter = tomorrowAt(c.tenant.timezone, '10:00', 2);
  await fin.schedulePrice(o, c.tenant, { serviceId: c.service, pricePaise: 70000, from: new Date(dayAfter).toLocaleDateString('en-CA', { timeZone: c.tenant.timezone }), reason: 'Revision' });
  assert.equal(await code(fin.schedulePrice(o, c.tenant, { serviceId: c.service, pricePaise: 80000, from: tomorrowDate, reason: 'Overlap' })), 'RULE_VIOLATION');
  assert.equal(await code(fin.schedulePrice(o, c.tenant, { serviceId: c.service, pricePaise: 1, from: '2000-01-01', reason: 'Past' })), 'RULE_VIOLATION');
  const a1 = await bookDirect(c.reception, c.tenant, { serviceId: c.service, clinicianId: c.clinicianId, start: tomorrow, patientId: p.id });
  const a2 = await bookDirect(c.reception, c.tenant, { serviceId: c.service, clinicianId: c.clinicianId, start: dayAfter, patientId: p.id });
  const q = await withTenant(c.tenant.id, (tx) => tx.many<{ id: string; quoted_price_paise: string }>(`SELECT id, quoted_price_paise FROM appointment WHERE id = ANY($1)`, [[a1.appointmentId, a2.appointmentId]]));
  const price = Object.fromEntries(q.map((r) => [r.id, Number(r.quoted_price_paise)]));
  assert.equal(price[a1.appointmentId], 50000, 'before the change: base price');
  assert.equal(price[a2.appointmentId], 70000, 'from the change date: new price');
});
