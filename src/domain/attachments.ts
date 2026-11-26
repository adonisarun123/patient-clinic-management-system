import { withTenant, type Tx } from '@/lib/db';
import { AppError, invalid, notFound } from '@/lib/errors';
import { authorize, staffId, type Actor } from '@/lib/actor';
import { audit } from '@/lib/events';
import { sha256 } from '@/lib/crypto';
import { createHash } from 'node:crypto';
import type { Tenant } from './tenants';
import { assertChartAccess } from './access';

import { MAX_FILE_BYTES as MAX, assertTenantKey } from '@/lib/blob';
import { scanBuffer, scannerConfigured, scannerFailOpen } from '@/lib/virus-scan';

const MAGIC: Record<string, (b: Buffer) => boolean> = {
  'application/pdf': (b) => b.subarray(0, 5).toString('latin1') === '%PDF-',
  'image/jpeg': (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  'image/png': (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
};

/**
 * SE-010: uploads are bound to a patient (and an order or document), limited to PDF/JPEG/PNG, size-capped and
 * checked by file signature rather than the declared type or extension. A checksum is stored with the bytes.
 * When a ClamAV scanner is configured (CLAMAV_HOST), every file is scanned first: infected files are refused and
 * logged, and a scanner failure refuses the upload unless CLAMAV_FAIL_OPEN=1 (then it is stored and flagged).
 */
export async function storeAttachment(tx: Tx, actor: Actor, a: { patientId: string; entityKind: 'result' | 'patient_document' | 'discharge' | 'import'; entityId?: string | null;
  category: string; title: string; filename: string; contentType: string; data: Buffer; storageKey?: string | null; documentDate?: string | null; source?: string | null }) {
  if (!a.data.length) throw invalid('The file is empty');
  if (a.data.length > MAX) throw invalid('Files must be 10 MB or smaller');
  const check = MAGIC[a.contentType];
  if (!check || !check(a.data)) throw invalid('Only PDF, JPEG or PNG files are accepted, and the file contents must match its type');
  // When the bytes already sit in object storage, keep them there and store only the key.
  if (a.storageKey) assertTenantKey(tx.tenantId!, a.storageKey);
  let scan: { status: 'not_scanned' | 'clean' | 'error_accepted'; detail: string | null } = { status: 'not_scanned', detail: null };
  if (scannerConfigured()) {
    const r = await scanBuffer(a.data);
    if (r.status === 'infected') {
      await logRejectedUpload(tx.tenantId!, actor, a.patientId, a.filename, r.signature);
      throw new AppError('RULE_VIOLATION', `This file was refused: the virus scanner reported ${r.signature}. It has not been stored.`);
    }
    if (r.status === 'error') {
      if (!scannerFailOpen()) throw new AppError('RULE_VIOLATION', `The file could not be virus-scanned (${r.detail}). Try again shortly or ask your administrator.`);
      scan = { status: 'error_accepted', detail: r.detail };
    } else scan = { status: 'clean', detail: null };
  }
  const safeName = a.filename.replace(/[^\w.\- ]+/g, '_').slice(0, 120) || 'file';
  const r = await tx.one<{ id: string }>(
    `INSERT INTO attachment (tenant_id, patient_id, entity_kind, entity_id, category, title, filename, content_type, size_bytes, sha256, data, storage_key, document_date, source, uploaded_by,
       scan_status, scan_detail, scanned_at)
     VALUES (app_tenant_id(), $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$14,$11,$12,$13,$15,$16, CASE WHEN $15 = 'not_scanned' THEN NULL ELSE now() END) RETURNING id`,
    [a.patientId, a.entityKind, a.entityId ?? null, a.category, a.title.slice(0, 200), safeName, a.contentType, a.data.length,
      createHash('sha256').update(a.data).digest('hex'), a.storageKey ? null : a.data, a.documentDate ?? null, a.source ?? null, staffId(actor), a.storageKey ?? null, scan.status, scan.detail]);
  await audit(tx, actor, 'attachment.uploaded', 'attachment', r.id, { patientId: a.patientId, data: { kind: a.entityKind, size: a.data.length } });
  return r.id;
}

/** The rejection is audited in its own transaction, so it survives the rollback of the refused upload. */
async function logRejectedUpload(tenantId: string, actor: Actor, patientId: string, filename: string, signature: string) {
  try {
    await withTenant(tenantId, (t) => audit(t, actor, 'attachment.rejected_infected', 'patient', patientId, { patientId, data: { filename: filename.slice(0, 120), signature } }));
  } catch { /* never mask the refusal itself */ }
}

/** CL-011: outside or historical documents filed to the chart with category, date and source. */
export async function uploadPatientDocument(actor: Actor, tenant: Tenant, patientId: string, f: { title: string; category: string; documentDate?: string; source?: string; filename: string; contentType: string; data: Buffer; storageKey?: string | null }) {
  authorize(actor, 'patient.write');
  return withTenant(tenant.id, async (tx) => {
    await assertChartAccess(tx, actor, tenant, patientId);
    return storeAttachment(tx, actor, { patientId, entityKind: 'patient_document', category: f.category || 'other', title: f.title || f.filename,
      filename: f.filename, contentType: f.contentType, data: f.data, storageKey: f.storageKey, documentDate: f.documentDate || null, source: f.source || null });
  });
}

export async function listPatientDocuments(actor: Actor, tenant: Tenant, patientId: string) {
  authorize(actor, 'clinical.read');
  return withTenant(tenant.id, async (tx) => {
    await assertChartAccess(tx, actor, tenant, patientId);
    return tx.many<{ id: string; title: string; category: string; filename: string; content_type: string; size_bytes: number; document_date: string | null; source: string | null; created_at: Date; entity_kind: string; status: string; scan_status: string; scan_detail: string | null }>(
      `SELECT id, title, category, filename, content_type, size_bytes, document_date, source, created_at, entity_kind, status, scan_status, scan_detail FROM attachment
        WHERE patient_id = $1 ORDER BY COALESCE(document_date::timestamptz, created_at) DESC`, [patientId]);
  });
}

/** Staff download. Every access is audited. */
export async function readAttachment(actor: Actor, tenant: Tenant, id: string) {
  authorize(actor, 'clinical.read');
  return withTenant(tenant.id, async (tx) => {
    const a = await tx.maybe<{ patient_id: string; filename: string; content_type: string; data: Buffer | null; storage_key: string | null; status: string }>(
      `SELECT patient_id, filename, content_type, data, storage_key, status FROM attachment WHERE id = $1`, [id]);
    if (!a) throw notFound('File');
    await assertChartAccess(tx, actor, tenant, a.patient_id);
    await audit(tx, actor, 'attachment.downloaded', 'attachment', id, { patientId: a.patient_id });
    return a;
  });
}

export async function markAttachmentError(actor: Actor, tenant: Tenant, id: string, reason: string) {
  authorize(actor, 'patient.merge');
  if (!reason?.trim()) throw invalid('Give a reason');
  return withTenant(tenant.id, async (tx) => {
    const a = await tx.one<{ patient_id: string }>(`UPDATE attachment SET status = 'entered_in_error' WHERE id = $1 RETURNING patient_id`, [id]);
    await audit(tx, actor, 'attachment.entered_in_error', 'attachment', id, { patientId: a.patient_id, reason });
  });
}

export { AppError, sha256 };
