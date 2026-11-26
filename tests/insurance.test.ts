import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { makeClinic } from './helpers';
import { pool, withTenant } from '../src/lib/db';
import { AppError, toAppError } from '../src/lib/errors';
import { registerPatient } from '../src/domain/patients';
import { addCharge, billCharges, recordPayment } from '../src/domain/billing';
import * as ins from '../src/domain/insurance';

after(async () => { await pool().end(); });
const code = async (p: Promise<unknown>) => { try { await p; return 'OK'; } catch (e) { const x = toAppError(e); return x instanceof AppError ? x.code : `RAW:${(e as Error).message}`; } };

async function balances(tenantId: string, invoiceId: string) {
  return withTenant(tenantId, async (tx) => ({
    inv: await tx.one<{ due_paise: string; payer_paise: string; paid_paise: string }>(`SELECT due_paise, payer_paise, paid_paise FROM invoice_balance WHERE invoice_id = $1`, [invoiceId]),
    acct: Object.fromEntries((await tx.many<{ code: string; bal: string }>(
      `SELECT a.code, coalesce(sum(l.debit_paise - l.credit_paise), 0)::bigint AS bal FROM ledger_account a LEFT JOIN journal_line l ON l.account_id = a.id GROUP BY a.code`)).map((r) => [r.code, Number(r.bal)])),
    balanced: (await tx.one<{ d: string; c: string }>(`SELECT sum(debit_paise)::bigint AS d, sum(credit_paise)::bigint AS c FROM journal_line`)),
  }));
}

test('claims: co-pay split, policy limits, pre-auth link, submit → query → partial settlement with TDS → disallowance back to patient; ledger balances', async () => {
  const c = await makeClinic();
  const p = await registerPatient(c.reception, c.tenant, { fullName: 'Insured Person', birthDate: '1970-03-03', phone: '9800000011' });
  const insurer = await ins.upsertPayer(c.admin, c.tenant, { name: 'Star Health', kind: 'insurer', creditDays: 30, tdsRateBp: 1000 });
  const tpa = await ins.upsertPayer(c.admin, c.tenant, { name: 'Medi Assist', kind: 'tpa' });
  assert.equal(await code(ins.upsertPayer(c.doctor, c.tenant, { name: 'X', kind: 'insurer' })), 'FORBIDDEN');
  const pol = await ins.addPolicy(c.cashier, c.tenant, { patientId: p.id, payerId: insurer, tpaId: tpa, policyNumber: 'SH/123/2026', copayBp: 1000, sumInsuredPaise: 300000 });

  // ₹500 consultation ×4 = ₹2,000 invoice
  const ch = await addCharge(c.cashier, c.tenant, { patientId: p.id, serviceId: c.service, quantity: 4 });
  const inv = await billCharges(c.cashier, c.tenant, p.id, [ch.chargeId]);
  assert.equal(inv.totalPaise, 200000);
  const suggested = await ins.suggestClaim(c.tenant, inv.invoiceId, pol);
  assert.equal(suggested, 180000, '10% co-pay stays with the patient');
  assert.equal(await code(ins.raiseClaim(c.cashier, c.tenant, { invoiceId: inv.invoiceId, policyId: pol, amountPaise: 250000 })), 'RULE_VIOLATION', 'cannot exceed due');

  const pa = await ins.createPreauth(c.cashier, c.tenant, { patientId: p.id, policyId: pol, treatment: 'Physiotherapy course', estimatedPaise: 200000 });
  assert.equal(await code(ins.raiseClaim(c.cashier, c.tenant, { invoiceId: inv.invoiceId, policyId: pol, amountPaise: suggested, preauthId: pa })), 'RULE_VIOLATION', 'pre-auth must be approved');
  assert.equal(await code(ins.updatePreauth(c.cashier, c.tenant, pa, 'approved', { approvedPaise: 100 })), 'RULE_VIOLATION', 'draft cannot jump to approved');
  await ins.updatePreauth(c.cashier, c.tenant, pa, 'submitted', { payerRef: 'MA-PA-77' });
  await ins.updatePreauth(c.cashier, c.tenant, pa, 'approved', { approvedPaise: 180000 });
  assert.equal((await ins.listPreauths(c.cashier, c.tenant, { patientId: p.id }))[0].status, 'partially_approved', 'approved below estimate is recorded as partial');

  const cl = await ins.raiseClaim(c.cashier, c.tenant, { invoiceId: inv.invoiceId, policyId: pol, amountPaise: suggested, preauthId: pa });
  let b = await balances(c.tenant.id, inv.invoiceId);
  assert.equal(Number(b.inv.due_paise), 20000, 'patient now owes only the co-pay');
  assert.equal(Number(b.inv.payer_paise), 180000);
  assert.equal(b.acct['1150'], 180000);
  // Patient pays their share; it settles their part only.
  await recordPayment(c.cashier, c.tenant, { patientId: p.id, method: 'cash', amountPaise: 20000 });
  b = await balances(c.tenant.id, inv.invoiceId);
  assert.equal(Number(b.inv.due_paise), 0);

  assert.equal(await code(ins.settleClaim(c.cashier, c.tenant, cl.claimId, { receivedPaise: 1000, reference: 'UTR1' })), 'RULE_VIOLATION', 'must submit first');
  await ins.submitClaim(c.cashier, c.tenant, cl.claimId, 'MA-CL-991');
  await ins.claimQuery(c.cashier, c.tenant, cl.claimId, 'Need discharge summary');
  await ins.submitClaim(c.cashier, c.tenant, cl.claimId, 'MA-CL-991');
  // Settlement: ₹1,350 received + ₹150 TDS; ₹300 disallowed → back to patient.
  assert.equal(await code(ins.settleClaim(c.cashier, c.tenant, cl.claimId, { receivedPaise: 135000, tdsPaise: 15000, disallowedPaise: 30000 })), 'VALIDATION', 'disallowance needs a reason / payment a UTR');
  const r = await ins.settleClaim(c.cashier, c.tenant, cl.claimId, { receivedPaise: 135000, tdsPaise: 15000, disallowedPaise: 30000, reference: 'UTR123', note: 'Non-payable consumables' });
  assert.equal(r.remaining, 0);
  b = await balances(c.tenant.id, inv.invoiceId);
  assert.equal(Number(b.inv.due_paise), 30000, 'disallowed amount is due from the patient again');
  assert.equal(b.acct['1150'], 0, 'payer receivable cleared');
  assert.equal(b.acct['1160'], 15000, 'TDS recorded as receivable');
  assert.equal(b.balanced.d, b.balanced.c, 'ledger balances');
  const d = await ins.claimDetail(c.cashier, c.tenant, cl.claimId);
  assert.equal(d.claim.status, 'closed');
  assert.deepEqual(d.events.map((e) => e.action), ['raised', 'submitted', 'query', 'submitted', 'settlement']);
  assert.equal(await code(ins.settleClaim(c.cashier, c.tenant, cl.claimId, { receivedPaise: 1, reference: 'X' })), 'RULE_VIOLATION', 'closed claim takes nothing more');
});

test('claims: sum insured enforced; full rejection to write-off needs finance permission; aging buckets', async () => {
  const c = await makeClinic();
  const p = await registerPatient(c.reception, c.tenant, { fullName: 'Small Cover', birthDate: '1966-06-06', phone: '9800000012' });
  const corp = await ins.upsertPayer(c.admin, c.tenant, { name: 'Acme Corp', kind: 'corporate', creditDays: 15 });
  const pol = await ins.addPolicy(c.cashier, c.tenant, { patientId: p.id, payerId: corp, policyNumber: 'EMP-9', sumInsuredPaise: 60000 });
  const ch = await addCharge(c.cashier, c.tenant, { patientId: p.id, serviceId: c.service, quantity: 2 });
  const inv = await billCharges(c.cashier, c.tenant, p.id, [ch.chargeId]);
  assert.equal(await code(ins.raiseClaim(c.cashier, c.tenant, { invoiceId: inv.invoiceId, policyId: pol, amountPaise: 100000 })), 'RULE_VIOLATION', 'over sum insured');
  const cl = await ins.raiseClaim(c.cashier, c.tenant, { invoiceId: inv.invoiceId, policyId: pol, amountPaise: 60000 });
  await ins.submitClaim(c.cashier, c.tenant, cl.claimId, 'ACME-1');
  const aging = await ins.payerAging(c.admin, c.tenant);
  assert.equal(Number(aging[0].b0), 60000);
  assert.equal(await code(ins.rejectClaim(c.cashier, c.tenant, cl.claimId, 'Not covered', 'write_off')), 'FORBIDDEN', 'cashier cannot write off');
  await ins.rejectClaim(c.admin, c.tenant, cl.claimId, 'Not covered', 'write_off');
  const b = await balances(c.tenant.id, inv.invoiceId);
  assert.equal(b.acct['5200'], 60000, 'written off as disallowance expense');
  assert.equal(Number(b.inv.due_paise), 40000, 'patient still owes only the part never claimed');
});
