import { withTenant } from '@/lib/db';
import { AppError, invalid, notFound, rule } from '@/lib/errors';
import { authorize, staffId, type Actor } from '@/lib/actor';
import { audit } from '@/lib/events';
import { sha256 } from '@/lib/crypto';
import { normalizeName, normalizePhone } from '@/lib/identity';
import { findCandidates, registerPatient } from './patients';
import { requireModule, type Tenant } from './tenants';

/**
 * Migration (MG-001–014): upload CSV → dry run (every row validated, likely duplicates held for review) →
 * a person commits. import_map makes a re-run skip rows already imported, so a rehearsal can be repeated safely.
 * Patients:      source_id, full_name, dob (YYYY-MM-DD | YYYY-MM | YYYY), age, sex, phone, email, address, city, pincode, legacy_uhid
 * Appointments:  source_id, patient_source_id | uhid, doctor_registration_no | doctor_name, service_code, start (YYYY-MM-DD HH:MM local), notes
 */
export function parseCsv(text: string): Record<string, string>[] {
  const rows: string[][] = [];
  let row: string[] = []; let field = ''; let q = false;
  const s = text.replace(/^﻿/, '');
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) {
      if (c === '"' && s[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') q = false;
      else field += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && s[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.some((x) => x.trim() !== '')) rows.push(row);
      row = [];
    } else field += c;
  }
  row.push(field);
  if (row.some((x) => x.trim() !== '')) rows.push(row);
  if (!rows.length) return [];
  const head = rows[0].map((h) => h.trim().toLowerCase().replace(/\s+/g, '_'));
  return rows.slice(1).map((r) => Object.fromEntries(head.map((h, i) => [h, (r[i] ?? '').trim()])));
}

type RowResult = { rowNo: number; sourceId: string | null; data: Record<string, string>; status: 'ok' | 'error' | 'review' | 'skipped'; messages: string[] };

export async function dryRun(actor: Actor, tenant: Tenant, kind: 'patients' | 'appointments', sourceSystem: string, filename: string, text: string) {
  requireModule(tenant, 'import');
  authorize(actor, 'import.run');
  if (text.length > 20 * 1024 * 1024) throw invalid('File too large (max 20 MB)');
  const rows = parseCsv(text);
  if (!rows.length) throw invalid('No data rows found. The first row must be the column headings.');
  if (rows.length > 50_000) throw invalid('Split files larger than 50,000 rows');
  const system = sourceSystem.trim() || 'legacy';
  return withTenant(tenant.id, async (tx) => {
    const results: RowResult[] = [];
    const seen = new Set<string>();
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i]; const msgs: string[] = []; let status: RowResult['status'] = 'ok';
      const sid = r.source_id || null;
      if (!sid) msgs.push('source_id is missing (needed for repeatable imports)');
      else if (seen.has(sid)) msgs.push('duplicate source_id in this file');
      if (sid) seen.add(sid);
      if (sid && await tx.maybe(`SELECT 1 FROM import_map WHERE source_system = $1 AND entity_kind = $2 AND source_id = $3`, [system, kind, sid])) {
        results.push({ rowNo: i + 2, sourceId: sid, data: r, status: 'skipped', messages: ['already imported in an earlier batch'] });
        continue;
      }
      if (kind === 'patients') {
        if (!r.full_name) msgs.push('full_name is required');
        if (r.dob && !/^\d{4}(-\d{2}(-\d{2})?)?$/.test(r.dob)) msgs.push('dob must be YYYY-MM-DD, YYYY-MM or YYYY');
        if (r.age && !/^\d{1,3}$/.test(r.age)) msgs.push('age must be a whole number');
        if (r.phone && !normalizePhone(r.phone)) msgs.push('phone is not a valid mobile number');
        if (r.sex && !['female', 'male', 'other', 'unknown', 'f', 'm', 'o'].includes(r.sex.toLowerCase())) msgs.push('sex must be female/male/other/unknown');
        if (!msgs.length && r.full_name) {
          const c = (await findCandidates(tx, { phone: r.phone || null, fullName: r.full_name, birthDate: r.dob?.length === 10 ? r.dob : null, birthYear: r.dob ? Number(r.dob.slice(0, 4)) : null }, 3)).filter((x) => x.score >= 80);
          if (c.length) { status = 'review'; msgs.push(`possible existing patient: ${c.map((x) => `${x.full_name} ${x.uhid}`).join(', ')}`); }
        }
      } else {
        if (!r.patient_source_id && !r.uhid) msgs.push('patient_source_id or uhid is required');
        if (!r.service_code) msgs.push('service_code is required');
        if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(r.start ?? '')) msgs.push('start must be "YYYY-MM-DD HH:MM" (clinic local time)');
        if (!r.doctor_registration_no && !r.doctor_name) msgs.push('doctor_registration_no or doctor_name is required');
        if (!msgs.length) {
          const svc = await tx.maybe(`SELECT 1 FROM service WHERE upper(code) = upper($1) AND active`, [r.service_code]);
          if (!svc) msgs.push(`unknown service_code ${r.service_code}`);
          const doc = await tx.many(`SELECT id FROM clinician WHERE active AND (registration_number = $1 OR lower(display_name) = lower($2))`, [r.doctor_registration_no || '', r.doctor_name || '']);
          if (doc.length !== 1) msgs.push(doc.length ? 'doctor name matches more than one clinician — use doctor_registration_no' : 'doctor not found');
          const pat = r.uhid ? await tx.maybe(`SELECT 1 FROM patient WHERE upper(uhid) = upper($1)`, [r.uhid])
            : await tx.maybe(`SELECT 1 FROM import_map WHERE source_system = $1 AND entity_kind = 'patients' AND source_id = $2`, [system, r.patient_source_id]);
          if (!pat) msgs.push('patient not found (import patients first)');
          const startOk = await tx.one<{ future: boolean }>(`SELECT ($1::timestamp AT TIME ZONE $2) > now() AS future`, [r.start, tenant.timezone]);
          if (!startOk.future) msgs.push('only future appointments are imported (past visits belong in historical records)');
        }
      }
      if (msgs.length && status !== 'review') status = 'error';
      results.push({ rowNo: i + 2, sourceId: sid, data: r, status, messages: msgs });
    }
    const count = (st: string) => results.filter((x) => x.status === st).length;
    const b = await tx.one<{ id: string }>(
      `INSERT INTO import_batch (tenant_id, kind, source_system, filename, checksum, row_count, ok_count, error_count, review_count, created_by)
       VALUES (app_tenant_id(), $1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
      [kind, system, filename.slice(0, 200), sha256(text), results.length, count('ok'), count('error'), count('review'), staffId(actor)]);
    for (const x of results) {
      await tx.exec(`INSERT INTO import_row (tenant_id, batch_id, row_no, source_id, data, status, messages) VALUES (app_tenant_id(), $1,$2,$3,$4,$5,$6)`,
        [b.id, x.rowNo, x.sourceId, JSON.stringify(x.data), x.status, x.messages]);
    }
    await audit(tx, actor, 'import.validated', 'import_batch', b.id, { data: { kind, rows: results.length, ok: count('ok'), errors: count('error'), review: count('review') } });
    return { batchId: b.id, rows: results.length, ok: count('ok'), errors: count('error'), review: count('review'), skipped: count('skipped') };
  });
}

/** Commit imports only rows marked ok (review rows can be approved individually first). */
export async function commitBatch(actor: Actor, tenant: Tenant, batchId: string, approveReviewRows: number[] = []) {
  requireModule(tenant, 'import');
  authorize(actor, 'import.run');
  const batch = await withTenant(tenant.id, (tx) => tx.maybe<{ kind: 'patients' | 'appointments'; status: string; source_system: string }>(`SELECT kind, status, source_system FROM import_batch WHERE id = $1`, [batchId]));
  if (!batch) throw notFound('Import batch');
  if (batch.status !== 'validated') throw rule('This batch is already committed or discarded');
  const rows = await withTenant(tenant.id, (tx) => tx.many<{ row_no: number; source_id: string; data: Record<string, string>; status: string }>(
    `SELECT row_no, source_id, data, status FROM import_row WHERE batch_id = $1 AND (status = 'ok' OR (status = 'review' AND row_no = ANY($2))) ORDER BY row_no`, [batchId, approveReviewRows]));
  let imported = 0; const failures: { row: number; error: string }[] = [];
  for (const r of rows) {
    try {
      await withTenant(tenant.id, async (tx) => {
        if (await tx.maybe(`SELECT 1 FROM import_map WHERE source_system = $1 AND entity_kind = $2 AND source_id = $3`, [batch.source_system, batch.kind, r.source_id])) return;
        let targetId: string;
        if (batch.kind === 'patients') {
          const d = r.data; const sex = (d.sex || 'unknown').toLowerCase();
          const res = await registerPatient(actor, tenant, {
            fullName: d.full_name, birthDate: d.dob || undefined, estimatedAgeYears: !d.dob && d.age ? Number(d.age) : undefined,
            sex: (({ f: 'female', m: 'male', o: 'other' } as Record<string, string>)[sex] ?? sex) as 'female' | 'male' | 'other' | 'unknown',
            phone: d.phone || undefined, phoneStatus: d.phone ? 'unverified' : 'none', email: d.email || undefined,
            address: { line1: d.address || undefined, city: d.city || undefined, pincode: d.pincode || undefined },
            source: 'staff', overrideDuplicateReason: r.status === 'review' ? 'Approved during data migration review' : undefined,
          }, null, { tx, skipDuplicateCheck: true });
          await tx.exec(`UPDATE patient SET registration_source = 'import' WHERE id = $1`, [res.id]);
          if (d.legacy_uhid) await tx.exec(`INSERT INTO patient_identifier (tenant_id, patient_id, issuer, value) VALUES (app_tenant_id(), $1, $2, $3) ON CONFLICT DO NOTHING`,
            [res.id, batch.source_system, d.legacy_uhid]);
          targetId = res.id;
        } else {
          const d = r.data;
          const patientId = d.uhid ? (await tx.one<{ id: string }>(`SELECT id FROM patient WHERE upper(uhid) = upper($1)`, [d.uhid])).id
            : (await tx.one<{ target_id: string }>(`SELECT target_id FROM import_map WHERE source_system = $1 AND entity_kind = 'patients' AND source_id = $2`, [batch.source_system, d.patient_source_id])).target_id;
          const svc = await tx.one<{ id: string; duration_min: number; buffer_before_min: number; buffer_after_min: number; department_id: string; price_paise: number; version: number; modality: string }>(
            `SELECT * FROM service WHERE upper(code) = upper($1) AND active`, [d.service_code]);
          const doc = await tx.one<{ id: string }>(`SELECT id FROM clinician WHERE active AND (registration_number = $1 OR lower(display_name) = lower($2)) LIMIT 1`, [d.doctor_registration_no || '', d.doctor_name || '']);
          const loc = await tx.maybe<{ location_id: string }>(`SELECT location_id FROM schedule_template WHERE clinician_id = $1 ORDER BY valid_from DESC LIMIT 1`, [doc.id]);
          if (!loc) throw new AppError('VALIDATION', 'Doctor has no consulting room configured');
          const t = await tx.one<{ s: Date }>(`SELECT ($1::timestamp AT TIME ZONE $2) AS s`, [d.start, tenant.timezone]);
          const start = new Date(t.s); const end = new Date(+start + svc.duration_min * 60_000);
          const n = await tx.one<{ v: number }>(`SELECT next_doc_number('booking') AS v`);
          const appt = await tx.one<{ id: string }>(
            `INSERT INTO appointment (tenant_id, booking_ref, patient_id, clinician_id, service_id, service_version, department_id, location_id, period, source, quoted_price_paise, notes, modality, created_by)
             VALUES (app_tenant_id(), $1,$2,$3,$4,$5,$6,$7, tstzrange($8,$9,'[)'), 'import', $10, $11, $12, $13) RETURNING id`,
            [`BK${String(n.v).padStart(6, '0')}`, patientId, doc.id, svc.id, svc.version, svc.department_id, loc.location_id, start, end, svc.price_paise, d.notes || null, svc.modality, staffId(actor)]);
          const os = new Date(+start - svc.buffer_before_min * 60_000); const oe = new Date(+end + svc.buffer_after_min * 60_000);
          for (const [k, id] of [['clinician', doc.id], ['location', loc.location_id]] as const) {
            await tx.exec(`INSERT INTO resource_claim (tenant_id, resource_kind, resource_id, period, status, appointment_id) VALUES (app_tenant_id(), $1,$2, tstzrange($3,$4,'[)'), 'booked', $5)`, [k, id, os, oe, appt.id]);
          }
          await tx.exec(`INSERT INTO appointment_event (tenant_id, appointment_id, action, to_state, actor_kind, actor_id, data) VALUES (app_tenant_id(), $1, 'imported', 'booked', 'staff', $2, $3)`,
            [appt.id, staffId(actor), JSON.stringify({ batchId, sourceId: r.source_id })]);
          targetId = appt.id;
        }
        await tx.exec(`INSERT INTO import_map (tenant_id, source_system, entity_kind, source_id, target_id, batch_id) VALUES (app_tenant_id(), $1,$2,$3,$4,$5)`,
          [batch.source_system, batch.kind, r.source_id, targetId, batchId]);
        await tx.exec(`UPDATE import_row SET status = 'imported', target_id = $3 WHERE batch_id = $1 AND row_no = $2`, [batchId, r.row_no, targetId]);
        imported++;
      });
    } catch (e) {
      const msg = e instanceof AppError ? (e.code === 'SLOT_TAKEN' ? 'overlaps an existing booking for this doctor or room' : e.message) : 'unexpected error';
      failures.push({ row: r.row_no, error: msg });
      await withTenant(tenant.id, (tx) => tx.exec(`UPDATE import_row SET status = 'error', messages = array_append(messages, $3) WHERE batch_id = $1 AND row_no = $2`, [batchId, r.row_no, msg]));
    }
  }
  await withTenant(tenant.id, async (tx) => {
    await tx.exec(`UPDATE import_batch SET status = 'committed', committed_by = $2, committed_at = now() WHERE id = $1`, [batchId, staffId(actor)]);
    await audit(tx, actor, 'import.committed', 'import_batch', batchId, { data: { imported, failed: failures.length } });
  });
  return { imported, failures };
}

export async function batches(actor: Actor, tenant: Tenant) {
  authorize(actor, 'import.run');
  return withTenant(tenant.id, (tx) => tx.many<{ id: string; kind: string; source_system: string; filename: string; status: string; row_count: number; ok_count: number; error_count: number; review_count: number; created_at: Date; committed_at: Date | null }>(
    `SELECT * FROM import_batch ORDER BY created_at DESC LIMIT 50`));
}

export async function batchRows(actor: Actor, tenant: Tenant, batchId: string, onlyProblems = true) {
  authorize(actor, 'import.run');
  return withTenant(tenant.id, (tx) => tx.many<{ row_no: number; source_id: string | null; status: string; messages: string[]; data: Record<string, string> }>(
    `SELECT row_no, source_id, status, messages, data FROM import_row WHERE batch_id = $1 AND ($2 = false OR status IN ('error','review')) ORDER BY row_no LIMIT 1000`, [batchId, onlyProblems]));
}

export { normalizeName };
