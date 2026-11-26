import { z } from 'zod';
import { withTenant, type Tx } from '@/lib/db';
import { AppError, invalid, notFound, rule } from '@/lib/errors';
import { authorize, staffId, type Actor } from '@/lib/actor';
import { audit } from '@/lib/events';
import type { Tenant } from './tenants';

/* ============================================================== chart merge engine
 * Signed clinical and posted financial facts keep their original patient reference; chart reads follow the
 * alias (chartIds). Only open, forward-looking work moves to the survivor — and the ids moved are recorded so
 * the merge can be undone exactly.
 */
const MOVES: { table: string; where: string; undoWhere: string }[] = [
  { table: 'appointment', where: `state IN ('booked','arrived')`, undoWhere: `state IN ('booked','arrived')` },
  { table: 'queue_ticket', where: `status IN ('waiting','called','in_room')`, undoWhere: `status IN ('waiting','called','in_room')` },
  { table: 'follow_up', where: `status = 'open'`, undoWhere: `status = 'open'` },
  { table: 'charge_item', where: `status = 'unbilled'`, undoWhere: `status = 'unbilled'` },
  { table: 'waitlist_entry', where: `status = 'waiting'`, undoWhere: `status = 'waiting'` },
  { table: 'allergy', where: `true`, undoWhere: `true` },
  { table: 'patient_policy', where: `true`, undoWhere: `true` },
];

type PatientRow = { id: string; uhid: string; status: string; allergy_status: string; created_by: string | null; merged_into_id: string | null };

async function lockPair(tx: Tx, sourceId: string, survivorId: string) {
  const rows = await tx.many<PatientRow>(`SELECT id, uhid, status, allergy_status, created_by, merged_into_id FROM patient WHERE id IN ($1, $2) ORDER BY id FOR UPDATE`, [sourceId, survivorId]);
  const src = rows.find((r) => r.id === sourceId); const dst = rows.find((r) => r.id === survivorId);
  if (!src || !dst) throw notFound('Patient');
  return { src, dst };
}

async function assertMergeable(tx: Tx, src: PatientRow, dst: PatientRow) {
  if (src.status === 'merged' || dst.status === 'merged') throw rule('One of these records is already merged');
  const adm = await tx.maybe<{ admission_no: string }>(`SELECT admission_no FROM admission WHERE patient_id = $1 AND status = 'admitted' LIMIT 1`, [src.id]);
  if (adm) throw rule(`The record being retired has an active admission (${adm.admission_no}). Discharge or cancel it first, or retire the other chart instead.`);
}

/** Performs the merge inside the caller's transaction and records it in chart_merge (status done). */
export async function executeMerge(tx: Tx, actor: Actor, src: PatientRow, dst: PatientRow, reason: string, opts: { mergeId?: string; requestedBy?: string | null } = {}) {
  await assertMergeable(tx, src, dst);
  const moved: Record<string, string[]> = {};
  for (const m of MOVES) {
    const rows = await tx.many<{ id: string }>(`UPDATE ${m.table} SET patient_id = $2 WHERE patient_id = $1 AND ${m.where} RETURNING id`, [src.id, dst.id]);
    if (rows.length) moved[m.table] = rows.map((r) => r.id);
  }
  if (moved.allergy?.length) {
    await tx.exec(`UPDATE patient SET allergy_status = 'has_allergies' WHERE id = $1 AND EXISTS (SELECT 1 FROM allergy WHERE patient_id = $1 AND status = 'active')`, [dst.id]);
  }
  await tx.exec(`UPDATE patient SET status='merged', merged_into_id=$2, version=version+1, updated_at=now() WHERE id=$1`, [src.id, dst.id]);
  await tx.exec(`INSERT INTO patient_change (tenant_id, patient_id, field, old_value, new_value, kind, reason, actor_id)
                 VALUES (app_tenant_id(), $1, 'identity', $2, $3, 'merge', $4, $5), (app_tenant_id(), $3::uuid, 'identity', $2, $3, 'link', $4, $5)`,
    [src.id, src.uhid, dst.id, reason, staffId(actor)]);
  let mergeId = opts.mergeId;
  if (mergeId) {
    await tx.exec(`UPDATE chart_merge SET status='done', approved_by=$2, done_at=now(), source_prior_status=$3, survivor_prior_allergy_status=$4, moved=$5 WHERE id=$1`,
      [mergeId, staffId(actor), src.status, dst.allergy_status, JSON.stringify(moved)]);
  } else {
    mergeId = (await tx.one<{ id: string }>(
      `INSERT INTO chart_merge (tenant_id, source_id, survivor_id, reason, status, requested_by, approved_by, done_at, source_prior_status, survivor_prior_allergy_status, moved)
       VALUES (app_tenant_id(), $1,$2,$3,'done',$4,$5, now(), $6,$7,$8) RETURNING id`,
      [src.id, dst.id, reason, opts.requestedBy ?? staffId(actor), staffId(actor), src.status, dst.allergy_status, JSON.stringify(moved)])).id;
  }
  const counts = Object.fromEntries(Object.entries(moved).map(([k, v]) => [k, v.length]));
  await audit(tx, actor, 'patient.linked', 'patient', dst.id, { patientId: dst.id, reason, data: { from: src.uhid, to: dst.uhid, moved: counts, mergeId } });
  return { mergeId, survivor: dst.uhid, retired: src.uhid, moved: counts };
}

/** OP-011 for two established charts: one person requests, a second authorised person approves. */
export async function requestMerge(actor: Actor, tenant: Tenant, sourceId: string, survivorId: string, reason: string) {
  authorize(actor, 'patient.merge');
  if (sourceId === survivorId) throw invalid('Choose two different records');
  if (!reason || reason.trim().length < 5) throw invalid('Give the evidence used to confirm these are the same person');
  return withTenant(tenant.id, async (tx) => {
    const { src, dst } = await lockPair(tx, sourceId, survivorId);
    await assertMergeable(tx, src, dst);
    if (tenant.settings.soloPractice) {
      const r = await executeMerge(tx, actor, src, dst, reason.trim());
      await audit(tx, actor, 'patient.merge_self_approved', 'chart_merge', r.mergeId, { patientId: dst.id, reason: 'Solo practice' });
      return { status: 'done' as const, ...r };
    }
    const open = await tx.maybe(`SELECT 1 FROM chart_merge WHERE source_id = $1 AND status = 'pending'`, [sourceId]);
    if (open) throw rule('A merge of this record is already awaiting approval');
    const { id } = await tx.one<{ id: string }>(`INSERT INTO chart_merge (tenant_id, source_id, survivor_id, reason, requested_by) VALUES (app_tenant_id(), $1,$2,$3,$4) RETURNING id`,
      [sourceId, survivorId, reason.trim(), staffId(actor)]);
    await audit(tx, actor, 'patient.merge_requested', 'chart_merge', id, { patientId: survivorId, reason, data: { from: src.uhid, to: dst.uhid } });
    return { status: 'pending' as const, mergeId: id, survivor: dst.uhid, retired: src.uhid };
  });
}

export async function decideMerge(actor: Actor, tenant: Tenant, mergeId: string, decision: 'approve' | 'reject' | 'cancel', note?: string) {
  authorize(actor, 'patient.merge');
  return withTenant(tenant.id, async (tx) => {
    const m = await tx.maybe<{ id: string; source_id: string; survivor_id: string; reason: string; status: string; requested_by: string | null }>(
      `SELECT * FROM chart_merge WHERE id = $1 FOR UPDATE`, [mergeId]);
    if (!m) throw notFound('Merge request');
    if (m.status !== 'pending') throw rule('This request has already been decided');
    if (decision === 'cancel') {
      if (m.requested_by !== staffId(actor)) throw rule('Only the person who asked can withdraw the request');
      await tx.exec(`UPDATE chart_merge SET status='cancelled', decision_note=$2 WHERE id=$1`, [mergeId, note ?? null]);
      await audit(tx, actor, 'patient.merge_cancelled', 'chart_merge', mergeId, { patientId: m.survivor_id });
      return { status: 'cancelled' as const };
    }
    if (m.requested_by === staffId(actor)) throw rule('A second authorised person must approve or reject this merge (dual control).');
    if (decision === 'reject') {
      if (!note || note.trim().length < 3) throw invalid('Say why the merge is rejected');
      await tx.exec(`UPDATE chart_merge SET status='rejected', approved_by=$2, decision_note=$3 WHERE id=$1`, [mergeId, staffId(actor), note.trim()]);
      await audit(tx, actor, 'patient.merge_rejected', 'chart_merge', mergeId, { patientId: m.survivor_id, reason: note });
      return { status: 'rejected' as const };
    }
    const { src, dst } = await lockPair(tx, m.source_id, m.survivor_id);
    const r = await executeMerge(tx, actor, src, dst, m.reason, { mergeId, requestedBy: m.requested_by });
    return { status: 'done' as const, ...r };
  });
}

/**
 * Reverses a completed merge. Items moved by the merge return to the retired record if they are still open;
 * items that progressed on the surviving chart since (e.g. an appointment that was attended) stay where they are
 * and are listed so records staff can review them. Anything recorded on the survivor after the merge stays there.
 */
export async function undoMerge(actor: Actor, tenant: Tenant, mergeId: string, reason: string) {
  authorize(actor, 'patient.merge');
  if (!reason || reason.trim().length < 5) throw invalid('Say why the merge is being undone');
  return withTenant(tenant.id, async (tx) => {
    const m = await tx.maybe<{ id: string; source_id: string; survivor_id: string; status: string; source_prior_status: string; survivor_prior_allergy_status: string; moved: Record<string, string[]> | null }>(
      `SELECT * FROM chart_merge WHERE id = $1 FOR UPDATE`, [mergeId]);
    if (!m) throw notFound('Merge');
    if (m.status !== 'done') throw rule('Only a completed merge can be undone');
    const { src, dst } = await lockPair(tx, m.source_id, m.survivor_id);
    if (src.merged_into_id !== dst.id) throw rule('This record has changed since the merge; undo is not possible automatically');
    const later = await tx.maybe(`SELECT 1 FROM chart_merge WHERE survivor_id = $1 AND status = 'done' AND done_at > (SELECT done_at FROM chart_merge WHERE id = $2) LIMIT 1`, [src.id, mergeId]);
    if (later) throw rule('Another record was merged into the retired one afterwards; undo that first');
    const returned: Record<string, number> = {}; const left: Record<string, string[]> = {};
    for (const mv of MOVES) {
      const ids = m.moved?.[mv.table] ?? [];
      if (!ids.length) continue;
      const back = await tx.many<{ id: string }>(`UPDATE ${mv.table} SET patient_id = $1 WHERE id = ANY($3::uuid[]) AND patient_id = $2 AND ${mv.undoWhere} RETURNING id`, [src.id, dst.id, ids]);
      returned[mv.table] = back.length;
      const backSet = new Set(back.map((b) => b.id));
      const stay = ids.filter((i) => !backSet.has(i));
      if (stay.length) left[mv.table] = stay;
    }
    await tx.exec(`UPDATE patient SET status=$2, merged_into_id=NULL, version=version+1, updated_at=now() WHERE id=$1`, [src.id, m.source_prior_status ?? 'active']);
    await tx.exec(`UPDATE patient SET allergy_status = $2 WHERE id = $1 AND NOT EXISTS (SELECT 1 FROM allergy WHERE patient_id = $1 AND status = 'active')`, [dst.id, m.survivor_prior_allergy_status ?? 'unknown']);
    await tx.exec(`UPDATE patient SET allergy_status = 'has_allergies' WHERE id = $1 AND EXISTS (SELECT 1 FROM allergy WHERE patient_id = $1 AND status = 'active')`, [src.id]);
    await tx.exec(`UPDATE chart_merge SET status='undone', undone_by=$2, undone_at=now(), undo_reason=$3, undo_left=$4 WHERE id=$1`, [mergeId, staffId(actor), reason.trim(), JSON.stringify(left)]);
    await tx.exec(`INSERT INTO patient_change (tenant_id, patient_id, field, old_value, new_value, kind, reason, actor_id)
                   VALUES (app_tenant_id(), $1, 'identity', $5, $6, 'unmerge', $3, $4), (app_tenant_id(), $2, 'identity', $5, $6, 'unmerge', $3, $4)`,
      [src.id, dst.id, reason.trim(), staffId(actor), dst.uhid, src.uhid]);
    await audit(tx, actor, 'patient.unmerged', 'chart_merge', mergeId, { patientId: src.id, reason, data: { returned, left } });
    return { restored: src.uhid, from: dst.uhid, returned, left };
  });
}

export async function listMerges(actor: Actor, tenant: Tenant, opts: { patientId?: string; status?: string } = {}) {
  authorize(actor, 'patient.read');
  return withTenant(tenant.id, (tx) => tx.many<{ id: string; status: string; reason: string; requested_at: Date; done_at: Date | null; undone_at: Date | null; undo_reason: string | null; decision_note: string | null;
    source_id: string; source_uhid: string; source_name: string; survivor_id: string; survivor_uhid: string; survivor_name: string; requested_by: string | null; requested_by_name: string | null; approved_by_name: string | null;
    moved: Record<string, string[]> | null; undo_left: Record<string, string[]> | null }>(
    `SELECT m.*, s.uhid AS source_uhid, s.full_name AS source_name, d.uhid AS survivor_uhid, d.full_name AS survivor_name,
            rq.full_name AS requested_by_name, ap.full_name AS approved_by_name
       FROM chart_merge m JOIN patient s ON s.id = m.source_id JOIN patient d ON d.id = m.survivor_id
       LEFT JOIN staff rq ON rq.id = m.requested_by LEFT JOIN staff ap ON ap.id = m.approved_by
      WHERE ($1::uuid IS NULL OR m.source_id = $1 OR m.survivor_id = $1) AND ($2::text IS NULL OR m.status = $2)
      ORDER BY m.requested_at DESC LIMIT 200`, [opts.patientId ?? null, opts.status ?? null]));
}

/* ============================================================== re-filing misfiled documents */
const REFILABLE = ['patient_document', 'import'];

export async function requestRefile(actor: Actor, tenant: Tenant, attachmentId: string, toPatientId: string, reason: string) {
  authorize(actor, 'patient.merge');
  if (!reason || reason.trim().length < 5) throw invalid('Say how you know the document belongs to the other patient');
  return withTenant(tenant.id, async (tx) => {
    const a = await tx.maybe<{ id: string; patient_id: string; entity_kind: string; status: string; title: string }>(`SELECT id, patient_id, entity_kind, status, title FROM attachment WHERE id = $1 FOR UPDATE`, [attachmentId]);
    if (!a) throw notFound('Document');
    if (!REFILABLE.includes(a.entity_kind)) throw rule('Results and discharge papers belong to their order or admission; correct those at the source instead of moving the file');
    if (a.status !== 'active') throw rule('This document is marked entered in error');
    if (a.patient_id === toPatientId) throw invalid('The document is already on that chart');
    const to = await tx.maybe<{ status: string; uhid: string }>(`SELECT status, uhid FROM patient WHERE id = $1`, [toPatientId]);
    if (!to || to.status === 'merged') throw notFound('Destination chart');
    const released = await tx.maybe(`SELECT 1 FROM document_release WHERE doc_kind = 'attachment' AND doc_id = $1 AND revoked_at IS NULL`, [attachmentId]);
    if (released) throw rule('This document is visible in the patient portal; remove it from the portal first');
    const { id } = await tx.one<{ id: string }>(`INSERT INTO attachment_refile (tenant_id, attachment_id, from_patient_id, to_patient_id, reason, requested_by) VALUES (app_tenant_id(), $1,$2,$3,$4,$5) RETURNING id`,
      [attachmentId, a.patient_id, toPatientId, reason.trim(), staffId(actor)]);
    await audit(tx, actor, 'attachment.refile_requested', 'attachment', attachmentId, { patientId: a.patient_id, reason, data: { to: to.uhid } });
    if (tenant.settings.soloPractice) {
      await applyRefile(tx, actor, id, 'Solo practice');
      return { status: 'done' as const, refileId: id };
    }
    return { status: 'pending' as const, refileId: id };
  });
}

async function applyRefile(tx: Tx, actor: Actor, refileId: string, note: string | null) {
  const r = await tx.one<{ attachment_id: string; from_patient_id: string; to_patient_id: string; reason: string }>(`SELECT * FROM attachment_refile WHERE id = $1`, [refileId]);
  const moved = await tx.exec(`UPDATE attachment SET patient_id = $2 WHERE id = $1 AND patient_id = $3 AND status = 'active'`, [r.attachment_id, r.to_patient_id, r.from_patient_id]);
  if (!moved) throw rule('The document has changed since the request; ask again');
  await tx.exec(`UPDATE attachment_refile SET status='done', decided_by=$2, decided_at=now(), decision_note=$3 WHERE id=$1`, [refileId, staffId(actor), note]);
  await audit(tx, actor, 'attachment.refiled_out', 'attachment', r.attachment_id, { patientId: r.from_patient_id, reason: r.reason, data: { refileId } });
  await audit(tx, actor, 'attachment.refiled_in', 'attachment', r.attachment_id, { patientId: r.to_patient_id, reason: r.reason, data: { refileId } });
}

export async function decideRefile(actor: Actor, tenant: Tenant, refileId: string, decision: 'approve' | 'reject' | 'cancel', note?: string) {
  authorize(actor, 'patient.merge');
  return withTenant(tenant.id, async (tx) => {
    const r = await tx.maybe<{ status: string; requested_by: string; attachment_id: string; from_patient_id: string }>(`SELECT * FROM attachment_refile WHERE id = $1 FOR UPDATE`, [refileId]);
    if (!r) throw notFound('Re-file request');
    if (r.status !== 'pending') throw rule('This request has already been decided');
    if (decision === 'cancel') {
      if (r.requested_by !== staffId(actor)) throw rule('Only the person who asked can withdraw the request');
      await tx.exec(`UPDATE attachment_refile SET status='cancelled', decided_at=now() WHERE id=$1`, [refileId]); return;
    }
    if (r.requested_by === staffId(actor)) throw rule('A second authorised person must approve or reject this (dual control).');
    if (decision === 'reject') {
      if (!note || note.trim().length < 3) throw invalid('Say why');
      await tx.exec(`UPDATE attachment_refile SET status='rejected', decided_by=$2, decided_at=now(), decision_note=$3 WHERE id=$1`, [refileId, staffId(actor), note.trim()]);
      await audit(tx, actor, 'attachment.refile_rejected', 'attachment', r.attachment_id, { patientId: r.from_patient_id, reason: note });
      return;
    }
    await applyRefile(tx, actor, refileId, note?.trim() || null);
  });
}

export async function listRefiles(actor: Actor, tenant: Tenant, opts: { patientId?: string; status?: string } = {}) {
  authorize(actor, 'patient.read');
  return withTenant(tenant.id, (tx) => tx.many<{ id: string; status: string; reason: string; requested_at: Date; decided_at: Date | null; decision_note: string | null; attachment_id: string; title: string;
    from_patient_id: string; from_uhid: string; from_name: string; to_patient_id: string; to_uhid: string; to_name: string; requested_by: string; requested_by_name: string; decided_by_name: string | null }>(
    `SELECT r.*, a.title, f.uhid AS from_uhid, f.full_name AS from_name, t.uhid AS to_uhid, t.full_name AS to_name, rq.full_name AS requested_by_name, dc.full_name AS decided_by_name
       FROM attachment_refile r JOIN attachment a ON a.id = r.attachment_id JOIN patient f ON f.id = r.from_patient_id JOIN patient t ON t.id = r.to_patient_id
       JOIN staff rq ON rq.id = r.requested_by LEFT JOIN staff dc ON dc.id = r.decided_by
      WHERE ($1::uuid IS NULL OR r.from_patient_id = $1 OR r.to_patient_id = $1) AND ($2::text IS NULL OR r.status = $2)
      ORDER BY r.requested_at DESC LIMIT 200`, [opts.patientId ?? null, opts.status ?? null]));
}

/* ============================================================== print layouts (versioned) */
export const PRINT_KINDS = ['prescription', 'receipt', 'referral'] as const;
export type PrintKind = typeof PRINT_KINDS[number];

export const layoutInput = z.object({
  paper: z.enum(['A4', 'A5']).default('A4'),
  preprintedTopMm: z.number().int().min(0).max(80).default(0),     // blank space for pre-printed letterhead stationery
  preprintedBottomMm: z.number().int().min(0).max(60).default(0),
  marginMm: z.number().int().min(5).max(30).default(12),
  showHeader: z.boolean().default(true),
  showLogo: z.boolean().default(true),
  headerAlign: z.enum(['left', 'center']).default('left'),
  accent: z.string().regex(/^#[0-9a-fA-F]{6}$/, 'Use a colour like #0f766e').default('#111827'),
  fontScale: z.number().min(0.85).max(1.25).default(1),
  extraHeaderLines: z.array(z.string().max(120)).max(4).default([]),
  footerText: z.string().max(500).default(''),
  signatureLabel: z.string().max(80).default(''),
});
export type PrintLayout = z.infer<typeof layoutInput>;
export const DEFAULT_LAYOUT: PrintLayout = layoutInput.parse({});

export async function activeLayout(tx: Tx, kind: PrintKind): Promise<{ version: number; layout: PrintLayout }> {
  const r = await tx.maybe<{ version: number; layout: PrintLayout }>(`SELECT version, layout FROM print_template WHERE doc_kind = $1 ORDER BY version DESC LIMIT 1`, [kind]);
  return r ? { version: r.version, layout: { ...DEFAULT_LAYOUT, ...r.layout } } : { version: 0, layout: DEFAULT_LAYOUT };
}

export async function currentLayout(actor: Actor, tenant: Tenant, kind: PrintKind) {
  return withTenant(tenant.id, (tx) => activeLayout(tx, kind));
}

export async function layoutVersion(actor: Actor, tenant: Tenant, kind: PrintKind, version: number) {
  if (version <= 0) return { version: 0, layout: DEFAULT_LAYOUT };
  return withTenant(tenant.id, async (tx) => {
    const r = await tx.maybe<{ version: number; layout: PrintLayout }>(`SELECT version, layout FROM print_template WHERE doc_kind = $1 AND version = $2`, [kind, version]);
    return r ? { version: r.version, layout: { ...DEFAULT_LAYOUT, ...r.layout } } : activeLayout(tx, kind);
  });
}

export async function saveLayout(actor: Actor, tenant: Tenant, kind: PrintKind, input: z.input<typeof layoutInput>, note?: string) {
  authorize(actor, 'settings.manage');
  if (!PRINT_KINDS.includes(kind)) throw invalid('Unknown document type');
  const p = layoutInput.safeParse(input);
  if (!p.success) throw invalid(p.error.issues[0]?.message ?? 'Check the layout', p.error.issues);
  return withTenant(tenant.id, async (tx) => {
    await tx.exec(`SELECT pg_advisory_xact_lock(hashtext('print_template:' || app_tenant_id()::text || $1))`, [kind]);
    const { version } = await tx.one<{ version: number }>(`SELECT COALESCE(max(version), 0) + 1 AS version FROM print_template WHERE doc_kind = $1`, [kind]);
    await tx.exec(`INSERT INTO print_template (tenant_id, doc_kind, version, layout, note, created_by) VALUES (app_tenant_id(), $1,$2,$3,$4,$5)`,
      [kind, version, JSON.stringify(p.data), note?.trim() || null, staffId(actor)]);
    await audit(tx, actor, 'print_template.saved', 'print_template', null, { data: { kind, version } });
    return { version };
  });
}

export async function layoutHistory(actor: Actor, tenant: Tenant, kind: PrintKind) {
  authorize(actor, 'settings.manage');
  return withTenant(tenant.id, (tx) => tx.many<{ version: number; layout: PrintLayout; note: string | null; created_at: Date; by: string | null }>(
    `SELECT t.version, t.layout, t.note, t.created_at, s.full_name AS by FROM print_template t LEFT JOIN staff s ON s.id = t.created_by WHERE t.doc_kind = $1 ORDER BY t.version DESC`, [kind]));
}

/** Restoring an earlier version publishes it again as the newest version, so history stays linear. */
export async function restoreLayout(actor: Actor, tenant: Tenant, kind: PrintKind, version: number) {
  const hist = await layoutHistory(actor, tenant, kind);
  const v = hist.find((h) => h.version === version);
  if (!v) throw notFound('Version');
  return saveLayout(actor, tenant, kind, v.layout, `Restored version ${version}`);
}

export { AppError };
