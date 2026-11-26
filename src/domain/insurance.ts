// FN-015–016 insurance, TPA and corporate billing.
// Money model: an invoice is posted to the patient as usual. Raising a claim moves the payer's share from Patient
// receivables (1100) to Insurance/TPA receivables (1150), so the patient's balance shows only their own share
// (co-pay, non-payable items). Settlement brings the cash in (with any TDS the payer deducted as a receivable,
// 1160). Disallowed amounts either go back to the patient or are written off (5200). Every step is a balanced journal.
import { z } from 'zod';
import { withTenant, type Tx } from '@/lib/db';
import { invalid, notFound, rule } from '@/lib/errors';
import { authorize, staffId, type Actor } from '@/lib/actor';
import { audit, emit } from '@/lib/events';
import { accounts, postJournal } from './billing';
import { ensureAccount } from './finance';
import type { Tenant } from './tenants';

const today = (tz: string) => new Date().toLocaleDateString('en-CA', { timeZone: tz });

async function payerAccounts(tx: Tx) {
  return {
    ...(await accounts(tx)),
    payerAr: await ensureAccount(tx, '1150', 'Insurance / TPA receivables', 'asset'),
    tds: await ensureAccount(tx, '1160', 'TDS receivable (deducted by payers)', 'asset'),
    disallowance: await ensureAccount(tx, '5200', 'Insurance disallowances written off', 'expense'),
  };
}

async function logEvent(tx: Tx, actor: Actor, ref: { claimId?: string; preauthId?: string }, action: string, extra: { amount?: number; reference?: string | null; note?: string | null } = {}) {
  await tx.exec(`INSERT INTO claim_event (tenant_id, claim_id, preauth_id, action, amount_paise, reference, note, actor_id) VALUES (app_tenant_id(), $1,$2,$3,$4,$5,$6,$7)`,
    [ref.claimId ?? null, ref.preauthId ?? null, action, extra.amount ?? null, extra.reference ?? null, extra.note ?? null, staffId(actor)]);
}

// ------------------------------------------------------------------ payers and policies
export const payerInput = z.object({
  id: z.uuid().optional(), name: z.string().trim().min(2).max(200), kind: z.enum(['insurer', 'tpa', 'corporate', 'government']),
  code: z.string().max(40).optional(), email: z.email().optional().or(z.literal('')), phone: z.string().max(20).optional(),
  creditDays: z.coerce.number().int().min(0).max(365).default(30), tdsRateBp: z.coerce.number().int().min(0).max(3000).default(0), active: z.boolean().default(true),
});

export async function upsertPayer(actor: Actor, tenant: Tenant, input: z.input<typeof payerInput>) {
  authorize(actor, 'claims.manage');
  const p = payerInput.parse(input);
  return withTenant(tenant.id, async (tx) => {
    const v = [p.name, p.kind, p.code || null, p.email || null, p.phone || null, p.creditDays, p.tdsRateBp, p.active];
    const r = p.id
      ? await tx.one<{ id: string }>(`UPDATE payer SET name=$2, kind=$3, code=$4, email=$5, phone=$6, credit_days=$7, tds_rate_bp=$8, active=$9 WHERE id=$1 RETURNING id`, [p.id, ...v])
      : await tx.one<{ id: string }>(`INSERT INTO payer (tenant_id, name, kind, code, email, phone, credit_days, tds_rate_bp, active) VALUES (app_tenant_id(), $1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`, v);
    await audit(tx, actor, p.id ? 'payer.updated' : 'payer.created', 'payer', r.id);
    return r.id;
  });
}

export async function listPayers(actor: Actor, tenant: Tenant) {
  authorize(actor, 'billing.read');
  return withTenant(tenant.id, (tx) => tx.many<{ id: string; name: string; kind: string; code: string | null; email: string | null; phone: string | null; credit_days: number; tds_rate_bp: number; active: boolean; outstanding: number }>(
    `SELECT p.*, coalesce((SELECT sum(c.claimed_paise - c.settled_paise - c.tds_paise - c.returned_paise - c.written_off_paise) FROM claim c WHERE c.payer_id = p.id AND c.status <> 'closed'), 0)::bigint AS outstanding
       FROM payer p ORDER BY p.active DESC, p.name`));
}

export const policyInput = z.object({
  patientId: z.uuid(), payerId: z.uuid(), tpaId: z.uuid().nullish(), policyNumber: z.string().trim().min(2).max(80),
  memberId: z.string().max(80).optional(), holderName: z.string().max(200).optional(), relation: z.string().max(40).optional(),
  validFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(), validTo: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  sumInsuredPaise: z.number().int().min(0).optional(), copayBp: z.coerce.number().int().min(0).max(10000).default(0), notes: z.string().max(500).optional(),
});

export async function addPolicy(actor: Actor, tenant: Tenant, input: z.input<typeof policyInput>) {
  authorize(actor, 'claims.manage');
  const p = policyInput.parse(input);
  if (p.validFrom && p.validTo && p.validTo < p.validFrom) throw invalid('The policy ends before it starts');
  return withTenant(tenant.id, async (tx) => {
    const r = await tx.one<{ id: string }>(
      `INSERT INTO patient_policy (tenant_id, patient_id, payer_id, tpa_id, policy_number, member_id, holder_name, relation, valid_from, valid_to, sum_insured_paise, copay_bp, notes, created_by)
       VALUES (app_tenant_id(), $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING id`,
      [p.patientId, p.payerId, p.tpaId ?? null, p.policyNumber, p.memberId ?? null, p.holderName ?? null, p.relation ?? null, p.validFrom ?? null, p.validTo ?? null,
        p.sumInsuredPaise ?? null, p.copayBp, p.notes ?? null, staffId(actor)]);
    await audit(tx, actor, 'policy.added', 'patient_policy', r.id, { patientId: p.patientId });
    return r.id;
  });
}

export async function setPolicyStatus(actor: Actor, tenant: Tenant, id: string, active: boolean) {
  authorize(actor, 'claims.manage');
  await withTenant(tenant.id, async (tx) => {
    await tx.exec(`UPDATE patient_policy SET status = $2 WHERE id = $1`, [id, active ? 'active' : 'inactive']);
    await audit(tx, actor, active ? 'policy.activated' : 'policy.deactivated', 'patient_policy', id);
  });
}

export async function patientPolicies(actor: Actor, tenant: Tenant, patientId: string) {
  authorize(actor, 'billing.read');
  return withTenant(tenant.id, (tx) => tx.many<{ id: string; payer_id: string; payer_name: string; tpa_name: string | null; policy_number: string; member_id: string | null;
      valid_from: string | null; valid_to: string | null; sum_insured_paise: number | null; copay_bp: number; status: string; used_paise: number }>(
    `SELECT pp.*, pp.valid_from::text, pp.valid_to::text, py.name AS payer_name, t.name AS tpa_name,
            coalesce((SELECT sum(c.claimed_paise - c.returned_paise) FROM claim c WHERE c.policy_id = pp.id), 0)::bigint AS used_paise
       FROM patient_policy pp JOIN payer py ON py.id = pp.payer_id LEFT JOIN payer t ON t.id = pp.tpa_id
      WHERE pp.patient_id = $1 ORDER BY pp.status, pp.created_at DESC`, [patientId]));
}

// ------------------------------------------------------------------ pre-authorisation
export const preauthInput = z.object({
  patientId: z.uuid(), policyId: z.uuid(), admissionId: z.uuid().nullish(),
  treatment: z.string().trim().min(3).max(1000), estimatedPaise: z.number().int().positive(),
});

export async function createPreauth(actor: Actor, tenant: Tenant, input: z.input<typeof preauthInput>) {
  authorize(actor, 'claims.manage');
  const p = preauthInput.parse(input);
  return withTenant(tenant.id, async (tx) => {
    const pol = await tx.maybe<{ patient_id: string; status: string }>(`SELECT patient_id, status FROM patient_policy WHERE id = $1`, [p.policyId]);
    if (!pol || pol.patient_id !== p.patientId) throw rule('That policy does not belong to this patient');
    if (pol.status !== 'active') throw rule('That policy is inactive');
    const n = await tx.one<{ v: number }>(`SELECT next_doc_number('preauth') AS v`);
    const r = await tx.one<{ id: string }>(
      `INSERT INTO preauth (tenant_id, ref_number, patient_id, policy_id, admission_id, treatment, estimated_paise, created_by)
       VALUES (app_tenant_id(), $1,$2,$3,$4,$5,$6,$7) RETURNING id`,
      [`PA${String(n.v).padStart(6, '0')}`, p.patientId, p.policyId, p.admissionId ?? null, p.treatment, p.estimatedPaise, staffId(actor)]);
    await logEvent(tx, actor, { preauthId: r.id }, 'created', { amount: p.estimatedPaise });
    await audit(tx, actor, 'preauth.created', 'preauth', r.id, { patientId: p.patientId });
    return r.id;
  });
}

const PREAUTH_NEXT: Record<string, string[]> = {
  draft: ['submitted', 'cancelled'], submitted: ['query', 'approved', 'partially_approved', 'denied', 'cancelled'],
  query: ['submitted', 'cancelled'], approved: ['cancelled'], partially_approved: ['submitted', 'cancelled'], denied: ['submitted'], cancelled: [],
};

/** Moves a pre-auth along: submit (payer ref), query (note), decision (approved amount, validity). Invalid moves are refused. */
export async function updatePreauth(actor: Actor, tenant: Tenant, id: string, to: string, d: { payerRef?: string; approvedPaise?: number; validUntil?: string; note?: string } = {}) {
  authorize(actor, 'claims.manage');
  await withTenant(tenant.id, async (tx) => {
    const pa = await tx.maybe<{ status: string; estimated_paise: number; patient_id: string }>(`SELECT status, estimated_paise, patient_id FROM preauth WHERE id = $1 FOR UPDATE`, [id]);
    if (!pa) throw notFound('Pre-authorisation');
    if (!PREAUTH_NEXT[pa.status]?.includes(to)) throw rule(`A ${pa.status.replace('_', ' ')} pre-authorisation cannot become ${to.replace('_', ' ')}`);
    if (to === 'submitted' && !d.payerRef?.trim() && pa.status === 'draft') throw invalid('Enter the reference the insurer/TPA gave for this request');
    if (['approved', 'partially_approved'].includes(to)) {
      if (d.approvedPaise == null || d.approvedPaise <= 0) throw invalid('Enter the approved amount');
      if (to === 'approved' && d.approvedPaise < Number(pa.estimated_paise)) to = 'partially_approved';
    }
    if (['query', 'denied', 'cancelled'].includes(to) && !d.note?.trim()) throw invalid('Add a note (the query or the reason)');
    await tx.exec(
      `UPDATE preauth SET status = $2, payer_ref = coalesce($3, payer_ref), approved_paise = coalesce($4, approved_paise), valid_until = coalesce($5::date, valid_until),
         submitted_at = CASE WHEN $2 = 'submitted' THEN coalesce(submitted_at, now()) ELSE submitted_at END,
         decided_at = CASE WHEN $2 IN ('approved','partially_approved','denied') THEN now() ELSE decided_at END, updated_at = now() WHERE id = $1`,
      [id, to, d.payerRef?.trim() || null, d.approvedPaise ?? null, d.validUntil || null]);
    await logEvent(tx, actor, { preauthId: id }, to, { amount: d.approvedPaise, reference: d.payerRef, note: d.note });
    await audit(tx, actor, `preauth.${to}`, 'preauth', id, { patientId: pa.patient_id, reason: d.note });
    if (['approved', 'partially_approved', 'denied'].includes(to)) await emit(tx, 'preauth.decided', 'preauth', id, { status: to, approvedPaise: d.approvedPaise ?? null });
  });
}

// ------------------------------------------------------------------ claims
export const claimInput = z.object({ invoiceId: z.uuid(), policyId: z.uuid(), amountPaise: z.number().int().positive(), preauthId: z.uuid().nullish() });

/** Suggested payer share for an invoice under a policy: patient due less the policy's co-pay. */
export async function suggestClaim(tenant: Tenant, invoiceId: string, policyId: string) {
  return withTenant(tenant.id, async (tx) => {
    const b = await tx.one<{ due_paise: number }>(`SELECT due_paise FROM invoice_balance WHERE invoice_id = $1`, [invoiceId]);
    const pol = await tx.one<{ copay_bp: number }>(`SELECT copay_bp FROM patient_policy WHERE id = $1`, [policyId]);
    return Math.max(0, Math.round(Number(b.due_paise) * (10000 - pol.copay_bp) / 10000));
  });
}

/** Raises a claim: the payer's share leaves the patient's balance and becomes a payer receivable. */
export async function raiseClaim(actor: Actor, tenant: Tenant, input: z.input<typeof claimInput>) {
  authorize(actor, 'claims.manage');
  const p = claimInput.parse(input);
  return withTenant(tenant.id, async (tx) => {
    await tx.exec(`SELECT id FROM invoice WHERE id = $1 FOR UPDATE`, [p.invoiceId]);
    const inv = await tx.maybe<{ patient_id: string; status: string; due_paise: number; number: string }>(
      `SELECT patient_id, status, due_paise, number FROM invoice_balance WHERE invoice_id = $1`, [p.invoiceId]);
    if (!inv) throw notFound('Invoice');
    if (inv.status !== 'posted') throw rule('Only a posted invoice can be claimed');
    const pol = await tx.maybe<{ patient_id: string; payer_id: string; tpa_id: string | null; status: string; valid_from: string | null; valid_to: string | null; sum_insured_paise: number | null; used: number }>(
      `SELECT pp.patient_id, pp.payer_id, pp.tpa_id, pp.status, pp.valid_from::text, pp.valid_to::text, pp.sum_insured_paise,
              coalesce((SELECT sum(c.claimed_paise - c.returned_paise) FROM claim c WHERE c.policy_id = pp.id), 0)::bigint AS used
         FROM patient_policy pp WHERE pp.id = $1`, [p.policyId]);
    if (!pol || pol.patient_id !== inv.patient_id) throw rule('That policy does not belong to this invoice’s patient');
    if (pol.status !== 'active') throw rule('That policy is inactive');
    const d = today(tenant.timezone);
    if ((pol.valid_from && d < pol.valid_from) || (pol.valid_to && d > pol.valid_to)) throw rule('The policy is not valid today. Check the dates on the policy card.');
    if (p.amountPaise > Number(inv.due_paise)) throw rule(`The claim cannot exceed what is still due from the patient on ${inv.number}.`);
    if (pol.sum_insured_paise != null && Number(pol.used) + p.amountPaise > Number(pol.sum_insured_paise)) throw rule('This would exceed the remaining sum insured on the policy.');
    if (p.preauthId) {
      const pa = await tx.maybe<{ status: string; policy_id: string }>(`SELECT status, policy_id FROM preauth WHERE id = $1`, [p.preauthId]);
      if (!pa || pa.policy_id !== p.policyId || !['approved', 'partially_approved'].includes(pa.status)) throw rule('Link only an approved pre-authorisation for the same policy');
    }
    const n = await tx.one<{ v: number }>(`SELECT next_doc_number('claim') AS v`);
    const number = `CL${String(n.v).padStart(6, '0')}`;
    const c = await tx.one<{ id: string }>(
      `INSERT INTO claim (tenant_id, claim_number, invoice_id, patient_id, policy_id, payer_id, preauth_id, claimed_paise, created_by)
       VALUES (app_tenant_id(), $1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
      [number, p.invoiceId, inv.patient_id, p.policyId, pol.tpa_id ?? pol.payer_id, p.preauthId ?? null, p.amountPaise, staffId(actor)]);
    const a = await payerAccounts(tx);
    await postJournal(tx, tenant, actor, { kind: 'payer_transfer', id: c.id, key: `claim:${c.id}`, date: d, memo: `${number} on ${inv.number}`, patientId: inv.patient_id },
      [{ account: a.payerAr, debit: p.amountPaise }, { account: a.receivable, credit: p.amountPaise }]);
    await logEvent(tx, actor, { claimId: c.id }, 'raised', { amount: p.amountPaise });
    await audit(tx, actor, 'claim.raised', 'claim', c.id, { patientId: inv.patient_id, data: { amount: p.amountPaise } });
    return { claimId: c.id, claimNumber: number };
  });
}

async function lockClaim(tx: Tx, id: string) {
  const c = await tx.maybe<{ id: string; status: string; claim_number: string; patient_id: string; payer_id: string; claimed_paise: number; settled_paise: number; tds_paise: number;
      returned_paise: number; written_off_paise: number }>(`SELECT * FROM claim WHERE id = $1 FOR UPDATE`, [id]);
  if (!c) throw notFound('Claim');
  const open = Number(c.claimed_paise) - Number(c.settled_paise) - Number(c.tds_paise) - Number(c.returned_paise) - Number(c.written_off_paise);
  return { ...c, open };
}

export async function submitClaim(actor: Actor, tenant: Tenant, id: string, payerRef: string) {
  authorize(actor, 'claims.manage');
  if (!payerRef?.trim()) throw invalid('Enter the claim reference from the insurer/TPA portal');
  await withTenant(tenant.id, async (tx) => {
    const c = await lockClaim(tx, id);
    if (!['open', 'query'].includes(c.status)) throw rule('Only an open claim (or one with a query) can be submitted');
    await tx.exec(`UPDATE claim SET status = 'submitted', payer_claim_ref = $2, submitted_at = coalesce(submitted_at, now()), updated_at = now() WHERE id = $1`, [id, payerRef.trim()]);
    await logEvent(tx, actor, { claimId: id }, 'submitted', { reference: payerRef });
    await audit(tx, actor, 'claim.submitted', 'claim', id, { patientId: c.patient_id });
    await emit(tx, 'claim.submitted', 'claim', id, { claimNumber: c.claim_number });
  });
}

export async function claimQuery(actor: Actor, tenant: Tenant, id: string, note: string) {
  authorize(actor, 'claims.manage');
  if (!note?.trim()) throw invalid('Record what the payer asked for');
  await withTenant(tenant.id, async (tx) => {
    const c = await lockClaim(tx, id);
    if (c.status !== 'submitted') throw rule('Only a submitted claim can receive a query');
    await tx.exec(`UPDATE claim SET status = 'query', updated_at = now() WHERE id = $1`, [id]);
    await logEvent(tx, actor, { claimId: id }, 'query', { note });
    await audit(tx, actor, 'claim.query', 'claim', id, { patientId: c.patient_id, reason: note });
  });
}

export const settleInput = z.object({
  receivedPaise: z.number().int().min(0), tdsPaise: z.number().int().min(0).default(0),
  disallowedPaise: z.number().int().min(0).default(0), disallowedTo: z.enum(['patient', 'write_off']).default('patient'),
  reference: z.string().trim().max(120).optional(), note: z.string().max(500).optional(),
});

/**
 * Records a settlement advice: cash received (bank/UTR reference), TDS deducted, and any disallowance — moved back
 * to the patient or written off. Partial settlements are allowed; the claim closes when nothing is left open.
 */
export async function settleClaim(actor: Actor, tenant: Tenant, id: string, input: z.input<typeof settleInput>) {
  authorize(actor, 'claims.manage');
  const p = settleInput.parse(input);
  const total = p.receivedPaise + p.tdsPaise + p.disallowedPaise;
  if (total <= 0) throw invalid('Enter what was received, deducted or disallowed');
  if (p.receivedPaise > 0 && !p.reference) throw invalid('Enter the bank / UTR reference of the payment');
  if (p.disallowedPaise > 0 && !p.note?.trim()) throw invalid('Give the disallowance reason from the settlement letter');
  return withTenant(tenant.id, async (tx) => {
    const c = await lockClaim(tx, id);
    if (!['submitted', 'query', 'settled'].includes(c.status)) throw rule('Submit the claim before recording a settlement');
    if (total > c.open) throw rule(`That is more than the ${(c.open / 100).toFixed(2)} still open on this claim`);
    if (p.disallowedPaise > 0 && p.disallowedTo === 'write_off') authorize(actor, 'finance.close');
    const a = await payerAccounts(tx);
    const d = today(tenant.timezone);
    const key = `claim_settlement:${id}:${Date.now()}`;
    const legs = [
      { account: a.clearing, debit: p.receivedPaise }, { account: a.tds, debit: p.tdsPaise },
      { account: p.disallowedTo === 'patient' ? a.receivable : a.disallowance, debit: p.disallowedPaise },
      { account: a.payerAr, credit: total },
    ];
    await postJournal(tx, tenant, actor, { kind: p.disallowedTo === 'write_off' && p.disallowedPaise && !p.receivedPaise && !p.tdsPaise ? 'claim_writeoff' : 'claim_settlement',
      id, key, date: d, memo: `${c.claim_number} settlement${p.reference ? ` ${p.reference}` : ''}`, patientId: c.patient_id }, legs);
    const remaining = c.open - total;
    await tx.exec(
      `UPDATE claim SET settled_paise = settled_paise + $2, tds_paise = tds_paise + $3,
         returned_paise = returned_paise + $4, written_off_paise = written_off_paise + $5,
         status = CASE WHEN $6 = 0 THEN 'closed' ELSE 'settled' END, updated_at = now() WHERE id = $1`,
      [id, p.receivedPaise, p.tdsPaise, p.disallowedTo === 'patient' ? p.disallowedPaise : 0, p.disallowedTo === 'write_off' ? p.disallowedPaise : 0, remaining]);
    await logEvent(tx, actor, { claimId: id }, 'settlement', { amount: total, reference: p.reference, note: [p.note, p.tdsPaise ? `TDS ${(p.tdsPaise / 100).toFixed(2)}` : '', p.disallowedPaise ? `Disallowed ${(p.disallowedPaise / 100).toFixed(2)} → ${p.disallowedTo === 'patient' ? 'patient' : 'written off'}` : ''].filter(Boolean).join(' · ') });
    await audit(tx, actor, 'claim.settled', 'claim', id, { patientId: c.patient_id, data: p });
    await emit(tx, 'claim.settled', 'claim', id, { claimNumber: c.claim_number, receivedPaise: p.receivedPaise, remainingPaise: remaining });
    return { remaining };
  });
}

/** Payer rejected the whole claim: the open amount goes back to the patient (or is written off). */
export async function rejectClaim(actor: Actor, tenant: Tenant, id: string, reason: string, to: 'patient' | 'write_off' = 'patient') {
  authorize(actor, 'claims.manage');
  const open = await withTenant(tenant.id, async (tx) => (await lockClaim(tx, id)).open);
  if (open <= 0) throw rule('Nothing is open on this claim');
  return settleClaim(actor, tenant, id, { receivedPaise: 0, disallowedPaise: open, disallowedTo: to, note: `Rejected: ${reason}` });
}

/** A claim not yet submitted can be withdrawn; its amount goes back to the patient. */
export async function withdrawClaim(actor: Actor, tenant: Tenant, id: string, reason: string) {
  authorize(actor, 'claims.manage');
  if (!reason?.trim()) throw invalid('Give a reason');
  await withTenant(tenant.id, async (tx) => {
    const c = await lockClaim(tx, id);
    if (c.status !== 'open') throw rule('Only a claim that has not been submitted can be withdrawn. Record the payer’s rejection instead.');
    const a = await payerAccounts(tx);
    await postJournal(tx, tenant, actor, { kind: 'payer_transfer', id, key: `claim_withdraw:${id}`, date: today(tenant.timezone), memo: `${c.claim_number} withdrawn`, patientId: c.patient_id },
      [{ account: a.receivable, debit: c.open }, { account: a.payerAr, credit: c.open }]);
    await tx.exec(`UPDATE claim SET returned_paise = returned_paise + $2, status = 'closed', updated_at = now() WHERE id = $1`, [id, c.open]);
    await logEvent(tx, actor, { claimId: id }, 'withdrawn', { amount: c.open, note: reason });
    await audit(tx, actor, 'claim.withdrawn', 'claim', id, { patientId: c.patient_id, reason });
  });
}

export async function listClaims(actor: Actor, tenant: Tenant, f: { status?: string; payerId?: string; patientId?: string } = {}) {
  authorize(actor, 'billing.read');
  return withTenant(tenant.id, (tx) => tx.many<{ id: string; claim_number: string; status: string; claimed_paise: number; settled_paise: number; tds_paise: number; returned_paise: number;
      written_off_paise: number; open_paise: number; payer_name: string; full_name: string; uhid: string; patient_id: string; invoice_number: string; submitted_at: Date | null; created_at: Date; age_days: number; payer_claim_ref: string | null }>(
    `SELECT c.*, (c.claimed_paise - c.settled_paise - c.tds_paise - c.returned_paise - c.written_off_paise)::bigint AS open_paise,
            py.name AS payer_name, p.full_name, p.uhid, i.number AS invoice_number,
            (current_date - coalesce(c.submitted_at, c.created_at)::date)::int AS age_days
       FROM claim c JOIN payer py ON py.id = c.payer_id JOIN patient p ON p.id = c.patient_id JOIN invoice i ON i.id = c.invoice_id
      WHERE ($1::text IS NULL OR c.status = $1) AND ($2::uuid IS NULL OR c.payer_id = $2) AND ($3::uuid IS NULL OR c.patient_id = $3)
      ORDER BY (c.status = 'closed'), c.created_at DESC LIMIT 500`, [f.status ?? null, f.payerId ?? null, f.patientId ?? null]));
}

export async function claimDetail(actor: Actor, tenant: Tenant, id: string) {
  authorize(actor, 'billing.read');
  return withTenant(tenant.id, async (tx) => {
    const c = await tx.maybe<Record<string, unknown> & { id: string; patient_id: string; invoice_id: string; status: string; claim_number: string; claimed_paise: number }>(
      `SELECT c.*, (c.claimed_paise - c.settled_paise - c.tds_paise - c.returned_paise - c.written_off_paise)::bigint AS open_paise,
              py.name AS payer_name, py.tds_rate_bp, p.full_name, p.uhid, i.number AS invoice_number, i.total_paise AS invoice_total,
              pp.policy_number, pp.member_id, pa.ref_number AS preauth_ref
         FROM claim c JOIN payer py ON py.id = c.payer_id JOIN patient p ON p.id = c.patient_id JOIN invoice i ON i.id = c.invoice_id
         JOIN patient_policy pp ON pp.id = c.policy_id LEFT JOIN preauth pa ON pa.id = c.preauth_id WHERE c.id = $1`, [id]);
    if (!c) throw notFound('Claim');
    const events = await tx.many<{ action: string; amount_paise: number | null; reference: string | null; note: string | null; at: Date; actor: string | null }>(
      `SELECT e.action, e.amount_paise, e.reference, e.note, e.at, s.full_name AS actor FROM claim_event e LEFT JOIN staff s ON s.id = e.actor_id WHERE e.claim_id = $1 ORDER BY e.at`, [id]);
    return { claim: c, events };
  });
}

export async function listPreauths(actor: Actor, tenant: Tenant, f: { patientId?: string; open?: boolean } = {}) {
  authorize(actor, 'billing.read');
  return withTenant(tenant.id, (tx) => tx.many<{ id: string; ref_number: string; status: string; treatment: string; estimated_paise: number; approved_paise: number | null; payer_ref: string | null;
      valid_until: string | null; full_name: string; uhid: string; patient_id: string; payer_name: string; policy_id: string; created_at: Date }>(
    `SELECT pa.*, pa.valid_until::text, p.full_name, p.uhid, py.name AS payer_name
       FROM preauth pa JOIN patient p ON p.id = pa.patient_id JOIN patient_policy pp ON pp.id = pa.policy_id JOIN payer py ON py.id = coalesce(pp.tpa_id, pp.payer_id)
      WHERE ($1::uuid IS NULL OR pa.patient_id = $1) AND (NOT $2 OR pa.status IN ('draft','submitted','query'))
      ORDER BY pa.created_at DESC LIMIT 300`, [f.patientId ?? null, !!f.open]));
}

export async function preauthEvents(tenant: Tenant, id: string) {
  return withTenant(tenant.id, (tx) => tx.many<{ action: string; amount_paise: number | null; reference: string | null; note: string | null; at: Date; actor: string | null }>(
    `SELECT e.action, e.amount_paise, e.reference, e.note, e.at, s.full_name AS actor FROM claim_event e LEFT JOIN staff s ON s.id = e.actor_id WHERE e.preauth_id = $1 ORDER BY e.at`, [id]));
}

/** Outstanding payer receivables by age since submission (unsubmitted claims count from creation). */
export async function payerAging(actor: Actor, tenant: Tenant) {
  authorize(actor, 'billing.read');
  return withTenant(tenant.id, (tx) => tx.many<{ payer_id: string; payer_name: string; credit_days: number; b0: number; b30: number; b60: number; b90: number; total: number; overdue: number }>(
    `WITH o AS (
       SELECT c.payer_id, (c.claimed_paise - c.settled_paise - c.tds_paise - c.returned_paise - c.written_off_paise) AS amt,
              current_date - coalesce(c.submitted_at, c.created_at)::date AS age FROM claim c WHERE c.status <> 'closed')
     SELECT py.id AS payer_id, py.name AS payer_name, py.credit_days,
            coalesce(sum(amt) FILTER (WHERE age <= 30), 0)::bigint AS b0, coalesce(sum(amt) FILTER (WHERE age BETWEEN 31 AND 60), 0)::bigint AS b30,
            coalesce(sum(amt) FILTER (WHERE age BETWEEN 61 AND 90), 0)::bigint AS b60, coalesce(sum(amt) FILTER (WHERE age > 90), 0)::bigint AS b90,
            coalesce(sum(amt), 0)::bigint AS total, coalesce(sum(amt) FILTER (WHERE age > py.credit_days), 0)::bigint AS overdue
       FROM o JOIN payer py ON py.id = o.payer_id GROUP BY py.id, py.name, py.credit_days HAVING sum(amt) > 0 ORDER BY total DESC`));
}

