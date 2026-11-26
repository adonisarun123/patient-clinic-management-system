import { z } from 'zod';
import { withTenant, type Tx } from '@/lib/db';
import { AppError, invalid, notFound, rule } from '@/lib/errors';
import { authorize, staffId, type Actor } from '@/lib/actor';
import { audit, emit } from '@/lib/events';
import { requireModule, type Tenant } from './tenants';
import { assertChartAccess } from './access';
import { storeAttachment } from './attachments';

// ------------------------------------------------------------------ catalogue
export const testInput = z.object({
  id: z.uuid().optional(), code: z.string().trim().min(1).max(20), name: z.string().trim().min(2).max(200),
  kind: z.enum(['lab', 'imaging', 'procedure']).default('lab'), specimen: z.string().max(100).optional(), unit: z.string().max(40).optional(),
  refLow: z.number().optional(), refHigh: z.number().optional(), refText: z.string().max(200).optional(),
  criticalLow: z.number().optional(), criticalHigh: z.number().optional(), pricePaise: z.number().int().min(0).default(0),
  departmentId: z.uuid().nullish(), active: z.boolean().default(true),
});

export async function upsertTest(actor: Actor, tenant: Tenant, input: z.input<typeof testInput>) {
  requireModule(tenant, 'labs');
  authorize(actor, 'settings.manage');
  const p = testInput.parse(input);
  if (p.refLow != null && p.refHigh != null && p.refLow > p.refHigh) throw invalid('Reference low must not exceed high');
  return withTenant(tenant.id, async (tx) => {
    const vals = [p.code.toUpperCase(), p.name, p.kind, p.specimen ?? null, p.unit ?? null, p.refLow ?? null, p.refHigh ?? null, p.refText ?? null,
      p.criticalLow ?? null, p.criticalHigh ?? null, p.pricePaise, p.departmentId ?? null, p.active];
    const r = p.id
      ? await tx.one<{ id: string }>(`UPDATE lab_test SET code=$2, name=$3, kind=$4, specimen=$5, unit=$6, ref_low=$7, ref_high=$8, ref_text=$9,
          critical_low=$10, critical_high=$11, price_paise=$12, department_id=$13, active=$14 WHERE id=$1 RETURNING id`, [p.id, ...vals])
      : await tx.one<{ id: string }>(`INSERT INTO lab_test (tenant_id, code, name, kind, specimen, unit, ref_low, ref_high, ref_text, critical_low, critical_high,
          price_paise, department_id, active) VALUES (app_tenant_id(), $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING id`, vals);
    await audit(tx, actor, p.id ? 'lab_test.updated' : 'lab_test.created', 'lab_test', r.id);
    return r.id;
  });
}

export type LabTest = { id: string; code: string; name: string; kind: string; specimen: string | null; unit: string | null; ref_low: string | null; ref_high: string | null;
  ref_text: string | null; critical_low: string | null; critical_high: string | null; price_paise: number; department_id: string | null; active: boolean };

export async function listTests(tenantId: string) {
  return withTenant(tenantId, (tx) => tx.many<LabTest>(`SELECT id, code, name, kind, specimen, unit, trim_scale(ref_low) AS ref_low, trim_scale(ref_high) AS ref_high, ref_text,
    trim_scale(critical_low) AS critical_low, trim_scale(critical_high) AS critical_high, price_paise, department_id, active FROM lab_test ORDER BY kind, name`));
}

// ------------------------------------------------------------------ orders
export const orderInput = z.object({
  patientId: z.uuid(), encounterId: z.uuid().nullish(), admissionId: z.uuid().nullish(),
  testIds: z.array(z.uuid()).min(1, 'Choose at least one test'), priority: z.enum(['routine', 'urgent', 'stat']).default('routine'),
  clinicalInfo: z.string().max(1000).optional(), destination: z.enum(['internal', 'external']).default('internal'), externalLab: z.string().max(200).optional(),
});

/** CL-024: an order is attributable to an ordering clinician and keeps its encounter. */
export async function placeOrders(actor: Actor, tenant: Tenant, input: z.input<typeof orderInput>) {
  requireModule(tenant, 'labs');
  authorize(actor, 'orders.write');
  if (actor.kind !== 'staff' || !actor.clinicianId) throw new AppError('FORBIDDEN', 'Orders must be placed by a clinician');
  const p = orderInput.parse(input);
  if (p.destination === 'external' && !p.externalLab) throw invalid('Name the external laboratory');
  return withTenant(tenant.id, async (tx) => {
    await assertChartAccess(tx, actor, tenant, p.patientId);
    const ids: { id: string; accession: string }[] = [];
    for (const testId of p.testIds) {
      const t = await tx.maybe<{ active: boolean }>(`SELECT active FROM lab_test WHERE id = $1`, [testId]);
      if (!t?.active) throw notFound('Test');
      const n = await tx.one<{ v: number }>(`SELECT next_doc_number('accession') AS v`);
      const accession = `LAB${String(n.v).padStart(7, '0')}`;
      const r = await tx.one<{ id: string }>(
        `INSERT INTO service_order (tenant_id, accession_no, patient_id, encounter_id, admission_id, test_id, ordering_clinician_id, ordered_by, priority, clinical_info, destination, external_lab)
         VALUES (app_tenant_id(), $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
        [accession, p.patientId, p.encounterId ?? null, p.admissionId ?? null, testId, actor.clinicianId, actor.staffId, p.priority, p.clinicalInfo ?? null,
          p.destination, p.externalLab ?? null]);
      ids.push({ id: r.id, accession });
      await audit(tx, actor, 'order.placed', 'service_order', r.id, { patientId: p.patientId, data: { accession, priority: p.priority } });
    }
    return ids;
  });
}

type OrderRow = { id: string; accession_no: string; patient_id: string; status: string; test_id: string; ordering_clinician_id: string; encounter_id: string | null; admission_id: string | null; version: number; destination: string };

async function lockOrder(tx: Tx, id: string) {
  const o = await tx.maybe<OrderRow>(`SELECT * FROM service_order WHERE id = $1 FOR UPDATE`, [id]);
  if (!o) throw notFound('Order');
  return o;
}

/** Specimen collected (or patient attended imaging): the service is delivered, so the charge is captured once. */
export async function collect(actor: Actor, tenant: Tenant, orderId: string, opts: { identityConfirmed: boolean }) {
  requireModule(tenant, 'labs');
  authorize(actor, 'results.enter');
  if (!opts.identityConfirmed) throw rule('Confirm two patient identifiers and label the specimen before marking it collected.');
  return withTenant(tenant.id, async (tx) => {
    const o = await lockOrder(tx, orderId);
    if (o.status !== 'requested') throw rule(`Order is ${o.status}`);
    await tx.exec(`UPDATE service_order SET status = 'collected', collected_at = now(), collected_by = $2, version = version + 1 WHERE id = $1`, [orderId, staffId(actor)]);
    const t = await tx.one<{ name: string; price_paise: number; department_id: string | null }>(`SELECT name, price_paise, department_id FROM lab_test WHERE id = $1`, [o.test_id]);
    if (o.destination === 'internal' && Number(t.price_paise) > 0) {
      await tx.exec(
        `INSERT INTO charge_item (tenant_id, patient_id, encounter_id, clinician_id, department_id, description, unit_price_paise, source_key, created_by)
         VALUES (app_tenant_id(), $1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (tenant_id, source_key) DO NOTHING`,
        [o.patient_id, o.encounter_id, o.ordering_clinician_id, t.department_id, `${t.name} (${o.accession_no})`, t.price_paise, `order:${orderId}`, staffId(actor)]);
    }
    await audit(tx, actor, 'order.collected', 'service_order', orderId, { patientId: o.patient_id });
  });
}

export async function cancelOrder(actor: Actor, tenant: Tenant, orderId: string, reason: string) {
  requireModule(tenant, 'labs');
  authorize(actor, 'orders.write');
  if (!reason?.trim()) throw invalid('Give a reason');
  return withTenant(tenant.id, async (tx) => {
    const o = await lockOrder(tx, orderId);
    if (!['requested', 'collected'].includes(o.status)) throw rule('Only an order without a result can be cancelled');
    await tx.exec(`UPDATE service_order SET status = 'cancelled', cancel_reason = $2, version = version + 1 WHERE id = $1`, [orderId, reason]);
    // Release an unbilled charge; a billed one needs the invoice voided by finance.
    await tx.exec(`UPDATE charge_item SET status = 'voided' WHERE source_key = $1 AND status = 'unbilled'`, [`order:${orderId}`]);
    await audit(tx, actor, 'order.cancelled', 'service_order', orderId, { patientId: o.patient_id, reason });
  });
}

// ------------------------------------------------------------------ results
export const resultInput = z.object({
  status: z.enum(['preliminary', 'final']).default('final'),
  valueNum: z.number().optional(), valueText: z.string().max(4000).optional(), reportText: z.string().max(20000).optional(),
  performingLab: z.string().max(200).optional(), abnormal: z.boolean().optional(), critical: z.boolean().optional(),
  amendReason: z.string().max(500).optional(),
  file: z.object({ filename: z.string(), contentType: z.string(), data: z.instanceof(Buffer), storageKey: z.string().nullish() }).optional(),
});

function flagFor(t: LabTest, v: number | undefined, manualAbnormal?: boolean, manualCritical?: boolean) {
  if (manualCritical) return { flag: 'critical', critical: true };
  if (v == null) return { flag: manualAbnormal ? 'abnormal' : 'none', critical: false };
  const n = (x: string | null) => (x == null ? null : Number(x));
  if (n(t.critical_low) != null && v <= n(t.critical_low)!) return { flag: 'critical_low', critical: true };
  if (n(t.critical_high) != null && v >= n(t.critical_high)!) return { flag: 'critical_high', critical: true };
  if (n(t.ref_low) != null && v < n(t.ref_low)!) return { flag: 'low', critical: false };
  if (n(t.ref_high) != null && v > n(t.ref_high)!) return { flag: 'high', critical: false };
  if (n(t.ref_low) != null || n(t.ref_high) != null) return { flag: manualAbnormal ? 'abnormal' : 'normal', critical: false };
  return { flag: manualAbnormal ? 'abnormal' : 'none', critical: false };
}

/**
 * CL-026–028: a result names the verifier and the accountable recipient (the ordering clinician). Each version is
 * immutable; an amendment appends a new version that needs its own acknowledgement. Critical values raise an event.
 */
export async function recordResult(actor: Actor, tenant: Tenant, orderId: string, input: z.input<typeof resultInput>) {
  requireModule(tenant, 'labs');
  authorize(actor, 'results.enter');
  const p = resultInput.parse(input);
  if (p.valueNum == null && !p.valueText?.trim() && !p.reportText?.trim() && !p.file) throw invalid('Enter a value, report text or attach the report');
  return withTenant(tenant.id, async (tx) => {
    const o = await lockOrder(tx, orderId);
    if (o.status === 'cancelled') throw rule('This order was cancelled');
    if (o.status === 'requested') throw rule('Mark the specimen collected before entering a result');
    const t = await tx.one<LabTest>(`SELECT * FROM lab_test WHERE id = $1`, [o.test_id]);
    const prev = await tx.maybe<{ id: string; version_no: number; status: string }>(
      `SELECT id, version_no, status FROM result_version WHERE order_id = $1 ORDER BY version_no DESC LIMIT 1`, [orderId]);
    if (prev && prev.status === 'final' && !p.amendReason?.trim()) throw rule('A final result exists. Give a reason to issue an amended result.');
    const f = flagFor(t, p.valueNum, p.abnormal, p.critical);
    let attachmentId: string | null = null;
    if (p.file) attachmentId = await storeAttachment(tx, actor, { patientId: o.patient_id, entityKind: 'result', entityId: orderId, category: 'lab_report',
      title: `${t.name} report`, filename: p.file.filename, contentType: p.file.contentType, data: p.file.data, storageKey: p.file.storageKey, source: p.performingLab });
    const status = prev && (prev.status === 'final' || prev.status === 'amended') ? 'amended' : p.status;
    const fmt = (x: string | null) => (x == null ? '' : String(Number(x)));
    const refRange = t.ref_text ?? (t.ref_low != null || t.ref_high != null ? `${fmt(t.ref_low)}–${fmt(t.ref_high)}` : null);
    const r = await tx.one<{ id: string; version_no: number }>(
      `INSERT INTO result_version (tenant_id, order_id, patient_id, version_no, supersedes_id, status, value_num, value_text, unit, ref_range, flag, is_critical,
          report_text, performing_lab, attachment_id, amend_reason, verified_by, recipient_clinician_id)
       VALUES (app_tenant_id(), $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17) RETURNING id, version_no`,
      [orderId, o.patient_id, (prev?.version_no ?? 0) + 1, prev?.id ?? null, status, p.valueNum ?? null, p.valueText ?? null, t.unit, refRange,
        f.flag, f.critical, p.reportText ?? null, p.performingLab ?? (o.destination === 'internal' ? tenant.name : null), attachmentId,
        p.amendReason ?? null, staffId(actor), o.ordering_clinician_id]);
    await tx.exec(`UPDATE service_order SET status = $2, version = version + 1 WHERE id = $1`, [orderId, p.status === 'preliminary' && !prev ? 'in_progress' : 'resulted']);
    await audit(tx, actor, status === 'amended' ? 'result.amended' : 'result.recorded', 'result_version', r.id,
      { patientId: o.patient_id, reason: p.amendReason, data: { version: r.version_no, critical: f.critical } });
    if (f.critical) await emit(tx, 'result.critical', 'service_order', orderId, { accession: o.accession_no, resultVersionId: r.id, clinicianId: o.ordering_clinician_id });
    if (status === 'final' || status === 'amended') await emit(tx, 'result.final', 'service_order', orderId, { accession: o.accession_no, version: r.version_no });
    return { resultVersionId: r.id, version: r.version_no, flag: f.flag, critical: f.critical, status };
  });
}

export const ackInput = z.object({
  action: z.enum(['acknowledged', 'patient_informed', 'follow_up_created', 'no_action_needed']),
  note: z.string().max(1000).optional(),
  followUpDueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
});

/** POST /v1/results/{id}/acknowledgements — version-specific. */
export async function acknowledge(actor: Actor, tenant: Tenant, resultVersionId: string, input: z.input<typeof ackInput>) {
  requireModule(tenant, 'labs');
  authorize(actor, 'results.ack');
  const p = ackInput.parse(input);
  return withTenant(tenant.id, async (tx) => {
    const r = await tx.maybe<{ id: string; patient_id: string; is_critical: boolean; order_id: string; recipient_clinician_id: string }>(
      `SELECT id, patient_id, is_critical, order_id, recipient_clinician_id FROM result_version WHERE id = $1`, [resultVersionId]);
    if (!r) throw notFound('Result');
    await assertChartAccess(tx, actor, tenant, r.patient_id);
    const latest = await tx.one<{ id: string }>(`SELECT id FROM result_version WHERE order_id = $1 ORDER BY version_no DESC LIMIT 1`, [r.order_id]);
    if (latest.id !== r.id) throw rule('A newer version of this result exists. Review and acknowledge the latest version.');
    if (r.is_critical && p.action === 'no_action_needed' && !p.note?.trim()) throw invalid('Record why no action is needed for a critical result');
    let followUpId: string | null = null;
    if (p.action === 'follow_up_created') {
      if (!p.followUpDueDate) throw invalid('Choose the follow-up date');
      followUpId = (await tx.one<{ id: string }>(
        `INSERT INTO follow_up (tenant_id, patient_id, clinician_id, owner_id, due_date, reason) VALUES (app_tenant_id(), $1,$2,$3,$4,$5) RETURNING id`,
        [r.patient_id, r.recipient_clinician_id, staffId(actor), p.followUpDueDate, p.note || 'Result follow-up'])).id;
    }
    await tx.exec(`INSERT INTO result_ack (tenant_id, result_version_id, staff_id, action, note, follow_up_id) VALUES (app_tenant_id(), $1,$2,$3,$4,$5)`,
      [resultVersionId, staffId(actor), p.action, p.note ?? null, followUpId]);
    await audit(tx, actor, 'result.acknowledged', 'result_version', resultVersionId, { patientId: r.patient_id, data: { action: p.action } });
  });
}

// ------------------------------------------------------------------ reads
export type OrderView = { id: string; accession_no: string; status: string; priority: string; created_at: Date; collected_at: Date | null; test_name: string; kind: string;
  patient_id: string; full_name: string; uhid: string; clinician_name: string; destination: string; external_lab: string | null; clinical_info: string | null;
  latest_version_id: string | null; latest_status: string | null; latest_flag: string | null; latest_critical: boolean | null; acked: boolean | null };

const ORDER_VIEW = `
  SELECT o.id, o.accession_no, o.status, o.priority, o.created_at, o.collected_at, o.destination, o.external_lab, o.clinical_info,
         t.name AS test_name, t.kind, p.id AS patient_id, p.full_name, p.uhid, c.display_name AS clinician_name,
         rv.id AS latest_version_id, rv.status AS latest_status, rv.flag AS latest_flag, rv.is_critical AS latest_critical,
         (ra.id IS NOT NULL) AS acked
    FROM service_order o JOIN lab_test t ON t.id = o.test_id JOIN patient p ON p.id = o.patient_id
    JOIN clinician c ON c.id = o.ordering_clinician_id
    LEFT JOIN LATERAL (SELECT * FROM result_version v WHERE v.order_id = o.id ORDER BY v.version_no DESC LIMIT 1) rv ON true
    LEFT JOIN result_ack ra ON ra.result_version_id = rv.id`;

/** Worklists: lab bench (to collect / to result), clinician inbox (unacknowledged), and overdue critical results. */
export async function worklists(actor: Actor, tenant: Tenant) {
  requireModule(tenant, 'labs');
  authorize(actor, 'schedule.read');
  return withTenant(tenant.id, async (tx) => {
    const toCollect = await tx.many<OrderView>(`${ORDER_VIEW} WHERE o.status = 'requested' ORDER BY (o.priority = 'stat') DESC, (o.priority = 'urgent') DESC, o.created_at LIMIT 200`);
    const toResult = await tx.many<OrderView>(`${ORDER_VIEW} WHERE o.status IN ('collected','in_progress') ORDER BY (o.priority = 'stat') DESC, o.collected_at LIMIT 200`);
    const inbox = actor.kind === 'staff' && actor.clinicianId ? await tx.many<OrderView>(
      `${ORDER_VIEW} WHERE o.ordering_clinician_id = $1 AND rv.id IS NOT NULL AND ra.id IS NULL ORDER BY rv.is_critical DESC, rv.verified_at LIMIT 200`, [actor.clinicianId]) : [];
    const criticalOpen = await tx.many<OrderView & { minutes_open: number }>(
      `${ORDER_VIEW.replace('rv.is_critical AS latest_critical,', 'rv.is_critical AS latest_critical, floor(extract(epoch FROM now() - rv.verified_at) / 60)::int AS minutes_open,')}
       WHERE rv.is_critical AND ra.id IS NULL ORDER BY rv.verified_at`);
    return { toCollect, toResult, inbox, criticalOpen };
  });
}

export async function orderDetail(actor: Actor, tenant: Tenant, orderId: string) {
  requireModule(tenant, 'labs');
  authorize(actor, 'schedule.read');
  return withTenant(tenant.id, async (tx) => {
    const order = await tx.maybe<OrderView & { test_id: string; encounter_id: string | null }>(`${ORDER_VIEW.replace('SELECT o.id,', 'SELECT o.test_id, o.encounter_id, o.id,')} WHERE o.id = $1`, [orderId]);
    if (!order) throw notFound('Order');
    await assertChartAccess(tx, actor, tenant, order.patient_id);
    const test = await tx.one<LabTest>(`SELECT * FROM lab_test WHERE id = $1`, [order.test_id]);
    const versions = await tx.many<{ id: string; version_no: number; status: string; value_num: string | null; value_text: string | null; unit: string | null; ref_range: string | null;
      flag: string; is_critical: boolean; report_text: string | null; performing_lab: string | null; attachment_id: string | null; amend_reason: string | null;
      verified_at: Date; verifier: string; ack_action: string | null; ack_by: string | null; ack_at: Date | null; ack_note: string | null }>(
      `SELECT v.*, trim_scale(v.value_num) AS value_num, s.full_name AS verifier, a.action AS ack_action, s2.full_name AS ack_by, a.at AS ack_at, a.note AS ack_note
         FROM result_version v JOIN staff s ON s.id = v.verified_by LEFT JOIN result_ack a ON a.result_version_id = v.id LEFT JOIN staff s2 ON s2.id = a.staff_id
        WHERE v.order_id = $1 ORDER BY v.version_no DESC`, [orderId]);
    await audit(tx, actor, 'order.viewed', 'service_order', orderId, { patientId: order.patient_id });
    return { order, test, versions };
  });
}

export async function patientOrders(actor: Actor, tenant: Tenant, patientId: string, encounterId?: string) {
  if (!tenant.settings.modules.labs) return [];
  authorize(actor, 'clinical.read');
  return withTenant(tenant.id, async (tx) => {
    await assertChartAccess(tx, actor, tenant, patientId);
    return tx.many<OrderView & { value_num: string | null; value_text: string | null; unit: string | null }>(
      `${ORDER_VIEW.replace('rv.id AS latest_version_id,', 'rv.id AS latest_version_id, trim_scale(rv.value_num) AS value_num, rv.value_text, rv.unit,')}
       WHERE o.patient_id = $1 AND ($2::uuid IS NULL OR o.encounter_id = $2) ORDER BY o.created_at DESC LIMIT 200`, [patientId, encounterId ?? null]);
  });
}
