import { withTenant } from '@/lib/db';
import { authorize, type Actor } from '@/lib/actor';
import type { Tenant } from './tenants';

/**
 * Metric contracts (Chapter 11), all by the clinic's local business date:
 *  - Earned revenue: net-of-discount, pre-tax value of invoice lines on invoices posted in the period and not voided.
 *  - Collected: confirmed receipts in the period by tender. Refunds paid are reported separately (not netted silently).
 *  - Outstanding: posted invoice totals minus net allocations, as of now.
 */
export async function summary(actor: Actor, tenant: Tenant, from: string, to: string) {
  authorize(actor, 'reports.read');
  return withTenant(tenant.id, async (tx) => {
    const range = [from, to, tenant.timezone];
    const appointments = await tx.many<{ state: string; n: number }>(
      `SELECT state, count(*)::int AS n FROM appointment
        WHERE lower(period) >= ($1::date)::timestamp AT TIME ZONE $3 AND lower(period) < (($2::date) + 1)::timestamp AT TIME ZONE $3
        GROUP BY state ORDER BY state`, range);
    const walkIns = await tx.one<{ n: number }>(`SELECT count(*)::int AS n FROM queue_ticket WHERE kind = 'walk_in' AND service_date BETWEEN $1 AND $2`, [from, to]);
    const newPatients = await tx.one<{ n: number }>(
      `SELECT count(*)::int AS n FROM patient WHERE status <> 'merged'
          AND created_at >= ($1::date)::timestamp AT TIME ZONE $3 AND created_at < (($2::date) + 1)::timestamp AT TIME ZONE $3`, range);
    const encounters = await tx.one<{ n: number }>(
      `SELECT count(*)::int AS n FROM encounter WHERE status = 'completed'
          AND ended_at >= ($1::date)::timestamp AT TIME ZONE $3 AND ended_at < (($2::date) + 1)::timestamp AT TIME ZONE $3`, range);
    const earnedByDept = await tx.many<{ department: string; net_paise: number; tax_paise: number; lines: number }>(
      `SELECT COALESCE(d.name, 'Unassigned') AS department,
              sum(il.unit_price_paise * il.quantity - il.discount_paise)::bigint AS net_paise, sum(il.tax_paise)::bigint AS tax_paise, count(*)::int AS lines
         FROM invoice_line il JOIN invoice i ON i.id = il.invoice_id LEFT JOIN department d ON d.id = il.department_id
        WHERE i.status = 'posted' AND i.business_date BETWEEN $1 AND $2 GROUP BY 1 ORDER BY 2 DESC`, [from, to]);
    const earnedByClinician = await tx.many<{ clinician: string; net_paise: number; visits: number }>(
      `SELECT COALESCE(c.display_name, 'Unassigned') AS clinician,
              sum(il.unit_price_paise * il.quantity - il.discount_paise)::bigint AS net_paise, count(DISTINCT i.id)::int AS visits
         FROM invoice_line il JOIN invoice i ON i.id = il.invoice_id LEFT JOIN clinician c ON c.id = il.clinician_id
        WHERE i.status = 'posted' AND i.business_date BETWEEN $1 AND $2 GROUP BY 1 ORDER BY 2 DESC`, [from, to]);
    const discounts = await tx.one<{ s: number }>(
      `SELECT COALESCE(sum(discount_paise),0)::bigint AS s FROM invoice WHERE status = 'posted' AND business_date BETWEEN $1 AND $2`, [from, to]);
    const collected = await tx.many<{ method: string; amount_paise: number; receipts: number }>(
      `SELECT method, sum(amount_paise)::bigint AS amount_paise, count(*)::int AS receipts FROM payment
        WHERE status = 'confirmed' AND business_date BETWEEN $1 AND $2 GROUP BY method ORDER BY 2 DESC`, [from, to]);
    const refunds = await tx.one<{ s: number; n: number }>(
      `SELECT COALESCE(sum(amount_paise),0)::bigint AS s, count(*)::int AS n FROM refund WHERE status = 'paid' AND business_date BETWEEN $1 AND $2`, [from, to]);
    const outstanding = await tx.one<{ s: number; n: number }>(
      `SELECT COALESCE(sum(due_paise),0)::bigint AS s, count(*) FILTER (WHERE due_paise > 0)::int AS n FROM invoice_balance WHERE status = 'posted'`);
    const advances = await tx.one<{ s: number }>(
      `SELECT COALESCE(sum(amount_paise - allocated_paise - refunded_paise),0)::bigint AS s FROM payment_balance WHERE status = 'confirmed'`);
    const trial = await tx.many<{ code: string; name: string; debit: number; credit: number }>(
      `SELECT a.code, a.name, COALESCE(sum(l.debit_paise),0)::bigint AS debit, COALESCE(sum(l.credit_paise),0)::bigint AS credit
         FROM ledger_account a LEFT JOIN journal_line l ON l.account_id = a.id
         LEFT JOIN journal j ON j.id = l.journal_id
        WHERE j.id IS NULL OR j.business_date <= $1
        GROUP BY a.code, a.name ORDER BY a.code`, [to]);
    const ledgerBalanced = trial.reduce((s, r) => s + Number(r.debit) - Number(r.credit), 0) === 0;
    const bookedTotal = appointments.reduce((s, r) => s + r.n, 0);
    const noShows = appointments.find((r) => r.state === 'no_show')?.n ?? 0;
    return {
      from, to, appointments, bookedTotal, noShowRate: bookedTotal ? noShows / bookedTotal : 0, walkIns: walkIns.n,
      newPatients: newPatients.n, completedEncounters: encounters.n, earnedByDept, earnedByClinician,
      earnedNetPaise: earnedByDept.reduce((s, r) => s + Number(r.net_paise), 0),
      taxPaise: earnedByDept.reduce((s, r) => s + Number(r.tax_paise), 0),
      discountPaise: Number(discounts.s), collected, collectedPaise: collected.reduce((s, r) => s + Number(r.amount_paise), 0),
      refundsPaidPaise: Number(refunds.s), refundsPaidCount: refunds.n, outstandingPaise: Number(outstanding.s), outstandingInvoices: outstanding.n,
      advancesHeldPaise: Number(advances.s), trial, ledgerBalanced,
    };
  });
}

/** Daily cash close by tender, with the receipts behind each total. */
export async function dailyClose(actor: Actor, tenant: Tenant, date: string) {
  authorize(actor, 'billing.read');
  return withTenant(tenant.id, async (tx) => ({
    receipts: await tx.many<{ receipt_no: string; method: string; amount_paise: number; reference: string | null; received_at: Date; full_name: string; uhid: string; received_by: string | null }>(
      `SELECT p.receipt_no, p.method, p.amount_paise, p.reference, p.received_at, pt.full_name, pt.uhid, s.full_name AS received_by
         FROM payment p JOIN patient pt ON pt.id = p.patient_id LEFT JOIN staff s ON s.id = p.received_by
        WHERE p.business_date = $1 AND p.status = 'confirmed' ORDER BY p.received_at`, [date]),
    refunds: await tx.many<{ amount_paise: number; method: string; paid_reference: string | null; full_name: string }>(
      `SELECT r.amount_paise, r.method, r.paid_reference, pt.full_name FROM refund r JOIN patient pt ON pt.id = r.patient_id
        WHERE r.status = 'paid' AND r.business_date = $1 ORDER BY r.paid_at`, [date]),
  }));
}

export async function auditLog(actor: Actor, tenant: Tenant, opts: { patientId?: string; limit?: number } = {}) {
  authorize(actor, 'audit.read');
  return withTenant(tenant.id, (tx) => tx.many<{ at: Date; actor_kind: string; actor_role: string | null; action: string; entity_kind: string; reason: string | null; actor_name: string | null; ip: string | null }>(
    `SELECT a.*, s.full_name AS actor_name FROM audit_event a LEFT JOIN staff s ON a.actor_kind = 'staff' AND s.id::text = a.actor_id
      WHERE ($1::uuid IS NULL OR a.patient_id = $1) ORDER BY a.at DESC LIMIT $2`, [opts.patientId ?? null, Math.min(opts.limit ?? 200, 1000)]));
}
