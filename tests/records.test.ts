import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { makeClinic, tomorrowAt } from './helpers';
import { pool, withTenant } from '../src/lib/db';
import { AppError, toAppError } from '../src/lib/errors';
import type { Actor } from '../src/lib/actor';
import { createStaff } from '../src/domain/staff';
import { registerPatient, recordAllergyReview, linkIntoExisting } from '../src/domain/patients';
import { uploadPatientDocument } from '../src/domain/attachments';
import { bookDirect, checkIn } from '../src/domain/scheduling';
import { startEncounter, saveRxDraft, signPrescription } from '../src/domain/clinical';
import * as records from '../src/domain/records';
import { scanBuffer } from '../src/lib/virus-scan';

after(async () => { await pool().end(); });
const err = async (p: Promise<unknown>) => { try { await p; return null; } catch (e) { return toAppError(e) as AppError; } };
const PDF = Buffer.from('%PDF-1.4\n% test document\n');
// The standard EICAR anti-virus test string (harmless by design).
const EICAR = 'X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*';

/** Minimal stand-in for clamd's INSTREAM protocol. */
function fakeClamd(): Promise<{ port: number; close: () => void; chunks: () => number }> {
  let chunks = 0;
  const srv = net.createServer((sock) => {
    let buf = Buffer.alloc(0); let gotCmd = false; let body = Buffer.alloc(0);
    sock.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      if (!gotCmd) { const z = buf.indexOf(0); if (z < 0) return; assert.equal(buf.subarray(0, z).toString(), 'zINSTREAM'); buf = buf.subarray(z + 1); gotCmd = true; }
      while (buf.length >= 4) {
        const n = buf.readUInt32BE(0);
        if (n === 0) { sock.end(body.toString('latin1').includes('EICAR-STANDARD') ? 'stream: Eicar-Test-Signature FOUND\0' : 'stream: OK\0'); return; }
        if (buf.length < 4 + n) return;
        body = Buffer.concat([body, buf.subarray(4, 4 + n)]); buf = buf.subarray(4 + n); chunks++;
      }
    });
  });
  return new Promise((res) => srv.listen(0, '127.0.0.1', () => res({ port: (srv.address() as net.AddressInfo).port, close: () => srv.close(), chunks: () => chunks })));
}

test('ClamAV connector: clean, infected, chunked, unreachable; uploads refused or flagged by policy', async () => {
  const clam = await fakeClamd();
  try {
    assert.deepEqual(await scanBuffer(PDF, { host: '127.0.0.1', port: clam.port }), { status: 'clean' });
    const big = Buffer.concat([Buffer.from('%PDF-'), Buffer.alloc(200_000, 0x20)]);
    assert.deepEqual(await scanBuffer(big, { host: '127.0.0.1', port: clam.port }), { status: 'clean' });
    assert.ok(clam.chunks() >= 4, 'large files are streamed in chunks');
    assert.deepEqual(await scanBuffer(Buffer.from(EICAR), { host: '127.0.0.1', port: clam.port }), { status: 'infected', signature: 'Eicar-Test-Signature' });
    const down = await scanBuffer(PDF, { host: '127.0.0.1', port: 1, timeoutMs: 2000 });
    assert.equal(down.status, 'error');

    const c = await makeClinic();
    const p = await registerPatient(c.reception, c.tenant, { fullName: 'Scan Test', birthDate: '1990-01-01', phone: '9000000101' });
    process.env.CLAMAV_HOST = '127.0.0.1'; process.env.CLAMAV_PORT = String(clam.port);
    const infectedPdf = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.from(EICAR)]);
    const e = await err(uploadPatientDocument(c.reception, c.tenant, p.id, { title: 'x', category: 'other', filename: 'x.pdf', contentType: 'application/pdf', data: infectedPdf }));
    assert.match(e!.message, /refused.*Eicar/);
    const ok = await uploadPatientDocument(c.reception, c.tenant, p.id, { title: 'ok', category: 'other', filename: 'ok.pdf', contentType: 'application/pdf', data: PDF });
    process.env.CLAMAV_PORT = '1';
    assert.match((await err(uploadPatientDocument(c.reception, c.tenant, p.id, { title: 'y', category: 'other', filename: 'y.pdf', contentType: 'application/pdf', data: PDF })))!.message, /could not be virus-scanned/);
    process.env.CLAMAV_FAIL_OPEN = '1';
    const flagged = await uploadPatientDocument(c.reception, c.tenant, p.id, { title: 'z', category: 'other', filename: 'z.pdf', contentType: 'application/pdf', data: PDF });
    const rows = await withTenant(c.tenant.id, (tx) => tx.many<{ id: string; scan_status: string }>(`SELECT id, scan_status FROM attachment WHERE patient_id = $1`, [p.id]));
    assert.equal(rows.length, 2, 'the infected file was not stored');
    const st = (id: unknown) => rows.find((r) => r.id === (typeof id === 'string' ? id : (id as { id: string }).id))?.scan_status;
    assert.equal(st(ok), 'clean'); assert.equal(st(flagged), 'error_accepted');
    const log = await withTenant(c.tenant.id, (tx) => tx.one<{ n: number }>(`SELECT count(*)::int AS n FROM audit_event WHERE action = 'attachment.rejected_infected'`));
    assert.equal(log.n, 1, 'rejection audited despite rollback');
  } finally {
    delete process.env.CLAMAV_HOST; delete process.env.CLAMAV_PORT; delete process.env.CLAMAV_FAIL_OPEN; clam.close();
  }
});

async function recordsClerks(c: Awaited<ReturnType<typeof makeClinic>>) {
  const mk = async (n: string) => {
    const s = await createStaff(c.sys, { email: `${n}@${c.slug}.test`, fullName: `Records ${n}`, role: 'records' });
    return { kind: 'staff', tenantId: c.tenant.id, staffId: s.staffId, role: 'records', clinicianId: null, name: n } as Actor;
  };
  return [await mk('r1'), await mk('r2')] as const;
}

test('misfiled document is moved only with a second person, and both charts keep the trail', async () => {
  const c = await makeClinic();
  const [r1, r2] = await recordsClerks(c);
  const a = await registerPatient(c.reception, c.tenant, { fullName: 'Asha Wrong', birthDate: '1985-02-02', phone: '9000000201' });
  const b = await registerPatient(c.reception, c.tenant, { fullName: 'Bina Right', birthDate: '1970-03-03', phone: '9000000202' });
  const doc = await uploadPatientDocument(c.reception, c.tenant, a.id, { title: 'MRI', category: 'imaging', filename: 'mri.pdf', contentType: 'application/pdf', data: PDF });
  const docId = typeof doc === 'string' ? doc : (doc as { id: string }).id;
  assert.equal((await err(records.requestRefile(c.reception, c.tenant, docId, b.id, 'Name on report is Bina')))?.code, 'FORBIDDEN');
  const req = await records.requestRefile(r1, c.tenant, docId, b.id, 'Name and DOB on the report are Bina’s');
  assert.equal(req.status, 'pending');
  assert.match((await err(records.decideRefile(r1, c.tenant, req.refileId, 'approve')))!.message, /second authorised person/);
  await records.decideRefile(r2, c.tenant, req.refileId, 'approve');
  const owner = await withTenant(c.tenant.id, (tx) => tx.one<{ patient_id: string }>(`SELECT patient_id FROM attachment WHERE id = $1`, [docId]));
  assert.equal(owner.patient_id, b.id);
  const trail = await withTenant(c.tenant.id, (tx) => tx.many<{ action: string; patient_id: string }>(`SELECT action, patient_id FROM audit_event WHERE entity_id = $1 AND action LIKE 'attachment.refiled%'`, [docId]));
  assert.deepEqual(trail.map((t) => t.patient_id).sort(), [a.id, b.id].sort());
  assert.equal((await records.listRefiles(r1, c.tenant, { patientId: a.id }))[0].status, 'done');
});

test('two active charts: request, dual-control approval, open work moves, undo restores what is still open', async () => {
  const c = await makeClinic();
  const [r1, r2] = await recordsClerks(c);
  const keep = await registerPatient(c.reception, c.tenant, { fullName: 'Ravi Kumar', birthDate: '1960-05-05', phone: '9000000301' });
  const dup = await registerPatient(c.reception, c.tenant, { fullName: 'Ravi Kumaar', birthDate: '1960-05-05', phone: '9000000302', overrideDuplicateReason: 'test fixture' });
  await recordAllergyReview(c.doctor, dup.id, { substance: 'Sulfa', reaction: 'Rash', severity: 'moderate' });
  const ap1 = await bookDirect(c.reception, c.tenant, { serviceId: c.service, clinicianId: c.clinicianId, start: tomorrowAt(c.tenant.timezone, '09:00'), patientId: dup.id });
  const ap2 = await bookDirect(c.reception, c.tenant, { serviceId: c.service, clinicianId: c.clinicianId, start: tomorrowAt(c.tenant.timezone, '10:00'), patientId: dup.id });

  const req = await records.requestMerge(r1, c.tenant, dup.id, keep.id, 'Same name, DOB and address confirmed');
  assert.equal(req.status, 'pending');
  assert.match((await err(records.requestMerge(r2, c.tenant, dup.id, keep.id, 'again please')))!.message, /already awaiting/);
  assert.match((await err(records.decideMerge(r1, c.tenant, req.mergeId, 'approve')))!.message, /second authorised person/);
  const done = await records.decideMerge(r2, c.tenant, req.mergeId, 'approve');
  assert.equal(done.status, 'done');
  const where = async (id: string) => (await withTenant(c.tenant.id, (tx) => tx.one<{ patient_id: string }>(`SELECT patient_id FROM appointment WHERE id = $1`, [id]))).patient_id;
  assert.equal(await where(ap1.appointmentId), keep.id);
  const kp = await withTenant(c.tenant.id, (tx) => tx.one<{ allergy_status: string }>(`SELECT allergy_status FROM patient WHERE id = $1`, [keep.id]));
  assert.equal(kp.allergy_status, 'has_allergies');

  // One moved appointment progresses on the kept chart before the mistake is noticed.
  await checkIn(c.reception, c.tenant, ap2.appointmentId, { identityConfirmed: true });
  await withTenant(c.tenant.id, (tx) => tx.exec(`UPDATE appointment SET state = 'in_service' WHERE id = $1`, [ap2.appointmentId]));
  assert.equal((await err(records.undoMerge(r1, c.tenant, req.mergeId, 'no')))?.code, 'VALIDATION');
  const undo = await records.undoMerge(r1, c.tenant, req.mergeId, 'Different fathers’ names; two people');
  assert.equal(await where(ap1.appointmentId), dup.id, 'still-open item returns');
  assert.equal(await where(ap2.appointmentId), keep.id, 'progressed item stays and is reported');
  assert.deepEqual(undo.left.appointment, [ap2.appointmentId]);
  const st = await withTenant(c.tenant.id, (tx) => tx.many<{ id: string; status: string; allergy_status: string }>(`SELECT id, status, allergy_status FROM patient WHERE id IN ($1,$2)`, [keep.id, dup.id]));
  assert.equal(st.find((x) => x.id === dup.id)!.status, 'active');
  assert.equal(st.find((x) => x.id === dup.id)!.allergy_status, 'has_allergies');
  assert.notEqual(st.find((x) => x.id === keep.id)!.allergy_status, 'has_allergies', 'allergy went back with its owner');
  assert.equal((await err(records.undoMerge(r1, c.tenant, req.mergeId, 'twice over')))?.code, 'RULE_VIOLATION');
});

test('provisional-record linking is recorded as an undoable merge', async () => {
  const c = await makeClinic();
  const [r1] = await recordsClerks(c);
  const real = await registerPatient(c.reception, c.tenant, { fullName: 'Meena Iyer', birthDate: '1975-07-07', phone: '9000000401' });
  const temp = await registerPatient(c.reception, c.tenant, { fullName: 'Unknown female', temporary: { label: 'Unknown F' } });
  const r = await linkIntoExisting(r1, c.tenant, temp.id, real.id, 'Family identified her at the desk');
  assert.ok((r as { mergeId?: string }).mergeId);
  const back = await records.undoMerge(r1, c.tenant, (r as { mergeId: string }).mergeId, 'Family were mistaken');
  const t = await withTenant(c.tenant.id, (tx) => tx.one<{ status: string }>(`SELECT status FROM patient WHERE id = $1`, [temp.id]));
  assert.equal(t.status, 'temporary'); assert.ok(back.restored);
});

test('print layouts are versioned, immutable, restorable, and frozen into signed prescriptions', async () => {
  const c = await makeClinic();
  assert.equal((await err(records.saveLayout(c.reception, c.tenant, 'prescription', {})))?.code, 'FORBIDDEN');
  assert.equal((await err(records.saveLayout(c.admin, c.tenant, 'prescription', { accent: 'red; } body {' })))?.code, 'VALIDATION', 'no CSS injection through colour');
  const v1 = await records.saveLayout(c.admin, c.tenant, 'prescription', { paper: 'A5', preprintedTopMm: 40, showHeader: false, footerText: 'v1 footer' }, 'stationery');
  const v2 = await records.saveLayout(c.admin, c.tenant, 'prescription', { paper: 'A4', footerText: 'v2 footer' });
  assert.deepEqual([v1.version, v2.version], [1, 2]);
  assert.equal((await err(withTenant(c.tenant.id, (tx) => tx.exec(`UPDATE print_template SET note = 'x'`))))?.code, 'RULE_VIOLATION');

  const p = await registerPatient(c.reception, c.tenant, { fullName: 'Layout Test', birthDate: '1990-01-01', phone: '9000000501' });
  const ap = await bookDirect(c.reception, c.tenant, { serviceId: c.service, clinicianId: c.clinicianId, start: tomorrowAt(c.tenant.timezone, '11:00'), patientId: p.id });
  const tk = await checkIn(c.reception, c.tenant, ap.appointmentId, { identityConfirmed: true });
  const { encounterId } = await startEncounter(c.doctor, c.tenant, tk.ticketId);
  await recordAllergyReview(c.doctor, p.id, { noKnownAllergies: true });
  const rx = await saveRxDraft(c.doctor, c.tenant, encounterId, { lines: [{ drugName: 'Fixture tab', dose: '1 tab', frequency: 'OD', duration: '3 days' }] });
  await signPrescription(c.doctor, c.tenant, rx.prescriptionId, { patientConfirmed: true });
  const restored = await records.restoreLayout(c.admin, c.tenant, 'prescription', 1);
  assert.equal(restored.version, 3);
  const snap = await withTenant(c.tenant.id, (tx) => tx.one<{ snapshot: { printLayout: { version: number; layout: { footerText: string } } } }>(`SELECT snapshot FROM prescription WHERE id = $1`, [rx.prescriptionId]));
  assert.equal(snap.snapshot.printLayout.version, 2, 'signed Rx keeps the layout it was signed with');
  assert.equal(snap.snapshot.printLayout.layout.footerText, 'v2 footer');
  const cur = await records.currentLayout(c.admin, c.tenant, 'prescription');
  assert.equal(cur.layout.paper, 'A5');
});
