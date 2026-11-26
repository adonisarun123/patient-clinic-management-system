'use server';
// Server actions for the conditional modules. Each re-authenticates, checks the module switch and the permission.
import { s, opt, num, run } from '@/lib/action-helpers';
import { AppError } from '@/lib/errors';
import { toPaise } from '@/lib/money';
import * as labs from '@/domain/labs';
import * as portal from '@/domain/portal';
import * as tele from '@/domain/telemedicine';
import * as access from '@/domain/access';
import * as rx from '@/domain/pharmacy';
import * as ip from '@/domain/inpatient';
import * as imp from '@/domain/importer';
import { uploadPatientDocument, markAttachmentError } from '@/domain/attachments';
import { readUploaded } from '@/lib/blob';

/** A file either posted with the form, or already uploaded by the browser to private object storage. */
async function fileFrom(f: FormData, k: string, tenantId: string) {
  const key = f.get(`${k}_key`);
  if (typeof key === 'string' && key) {
    const { data, contentType } = await readUploaded(tenantId, key);
    return { filename: String(f.get(`${k}_name`) ?? 'file').slice(0, 200), contentType, data, storageKey: key };
  }
  const v = f.get(k);
  if (!v || typeof v === 'string' || v.size === 0) return null;
  return { filename: v.name, contentType: v.type, data: Buffer.from(await v.arrayBuffer()) };
}

// ------------------------------------------------------------------ labs
export async function labTestAction(slug: string, f: FormData) {
  await run(slug, `/${slug}/labs?tab=catalogue`, async ({ actor, tenant }) => {
    await labs.upsertTest(actor, tenant, { id: opt(f, 'id'), code: s(f, 'code'), name: s(f, 'name'), kind: (s(f, 'kind') || 'lab') as 'lab', specimen: opt(f, 'specimen'),
      unit: opt(f, 'unit'), refLow: num(f, 'refLow'), refHigh: num(f, 'refHigh'), refText: opt(f, 'refText'), criticalLow: num(f, 'criticalLow'), criticalHigh: num(f, 'criticalHigh'),
      pricePaise: toPaise(s(f, 'price') || '0'), active: s(f, 'active') !== 'off' });
    return 'Test saved';
  });
}

export async function placeOrderAction(slug: string, back: string, f: FormData) {
  await run(slug, back, async ({ actor, tenant }) => {
    const r = await labs.placeOrders(actor, tenant, { patientId: s(f, 'patientId'), encounterId: opt(f, 'encounterId'), admissionId: opt(f, 'admissionId'),
      testIds: f.getAll('testIds').map(String), priority: (s(f, 'priority') || 'routine') as 'routine', clinicalInfo: opt(f, 'clinicalInfo'),
      destination: (s(f, 'destination') || 'internal') as 'internal', externalLab: opt(f, 'externalLab') });
    return `Ordered: ${r.map((x) => x.accession).join(', ')}`;
  });
}

export async function orderAction(slug: string, orderId: string, f: FormData) {
  await run(slug, `/${slug}/labs/${orderId}`, async ({ actor, tenant }) => {
    const op = s(f, 'op');
    if (op === 'collect') { await labs.collect(actor, tenant, orderId, { identityConfirmed: s(f, 'idok') === 'on' }); return 'Marked collected'; }
    if (op === 'cancel') { await labs.cancelOrder(actor, tenant, orderId, s(f, 'reason')); return 'Order cancelled'; }
    if (op === 'result') {
      const file = await fileFrom(f, 'file', tenant.id);
      const r = await labs.recordResult(actor, tenant, orderId, { status: (s(f, 'status') || 'final') as 'final', valueNum: num(f, 'valueNum'), valueText: opt(f, 'valueText'),
        reportText: opt(f, 'reportText'), performingLab: opt(f, 'performingLab'), abnormal: s(f, 'abnormal') === 'on', critical: s(f, 'critical') === 'on',
        amendReason: opt(f, 'amendReason'), file: file ?? undefined });
      return r.critical ? 'CRITICAL result recorded — the ordering doctor must acknowledge it now' : `Result v${r.version} recorded`;
    }
    if (op === 'ack') {
      await labs.acknowledge(actor, tenant, s(f, 'versionId'), { action: s(f, 'action') as 'acknowledged', note: opt(f, 'note'), followUpDueDate: opt(f, 'followUpDueDate') });
      return 'Acknowledged';
    }
    if (op === 'release') { await portal.releaseDocument(actor, tenant, { patientId: s(f, 'patientId'), kind: 'result', docId: orderId }); return 'Released to patient portal'; }
    throw new AppError('VALIDATION', 'Unknown action');
  });
}

// ------------------------------------------------------------------ documents, portal links, release
export async function uploadDocAction(slug: string, patientId: string, f: FormData) {
  await run(slug, `/${slug}/patients/${patientId}`, async ({ actor, tenant }) => {
    const file = await fileFrom(f, 'file', tenant.id);
    if (!file) throw new AppError('VALIDATION', 'Choose a file');
    await uploadPatientDocument(actor, tenant, patientId, { ...file, title: s(f, 'title'), category: s(f, 'category'), documentDate: opt(f, 'documentDate'), source: opt(f, 'source') });
    return 'Document filed';
  });
}

export async function docErrorAction(slug: string, patientId: string, attachmentId: string, f: FormData) {
  await run(slug, `/${slug}/patients/${patientId}`, async ({ actor, tenant }) => { await markAttachmentError(actor, tenant, attachmentId, s(f, 'reason')); return 'Marked entered in error'; });
}

export async function portalLinkAction(slug: string, patientId: string, f: FormData) {
  await run(slug, `/${slug}/patients/${patientId}`, async ({ actor, tenant }) => {
    if (s(f, 'op') === 'revoke') { await portal.revokePortalAccess(actor, tenant, s(f, 'linkId'), s(f, 'reason')); return 'Portal access revoked'; }
    await portal.grantPortalAccess(actor, tenant, { patientId, phone: s(f, 'phone'), relation: s(f, 'relation') as 'self', evidence: s(f, 'evidence'),
      canSchedule: s(f, 'canSchedule') === 'on', canViewDocuments: s(f, 'canViewDocuments') === 'on', canPay: s(f, 'canPay') === 'on', validUntil: opt(f, 'validUntil') });
    return 'Portal access granted';
  });
}

export async function releaseAction(slug: string, back: string, f: FormData) {
  await run(slug, back, async ({ actor, tenant }) => {
    if (s(f, 'op') === 'revoke') { await portal.revokeRelease(actor, tenant, s(f, 'kind'), s(f, 'docId')); return 'Removed from portal'; }
    await portal.releaseDocument(actor, tenant, { patientId: s(f, 'patientId'), kind: s(f, 'kind') as 'prescription', docId: s(f, 'docId') });
    return 'Released to patient portal';
  });
}

export async function recordsRequestAction(slug: string, f: FormData) {
  await run(slug, `/${slug}/records-requests`, async ({ actor, tenant }) => {
    const id = opt(f, 'id');
    if (id) { await portal.updateRecordsRequest(actor, tenant, id, s(f, 'status') as 'fulfilled', s(f, 'outcome')); return 'Updated'; }
    const r = await portal.createRecordsRequest(actor, tenant, { patientId: opt(f, 'patientId') ?? null, requesterKind: s(f, 'requesterKind') as 'patient', requesterName: s(f, 'requesterName'),
      requesterContact: opt(f, 'requesterContact'), authorityNote: opt(f, 'authorityNote'), requestType: (s(f, 'requestType') || 'copy') as 'copy', scope: s(f, 'scope'),
      dateFrom: opt(f, 'dateFrom'), dateTo: opt(f, 'dateTo'), delivery: (s(f, 'delivery') || 'print') as 'print' });
    return `Logged as ${r.caseNo}`;
  });
}

// ------------------------------------------------------------------ restricted records & emergency access
export async function restrictAction(slug: string, patientId: string, f: FormData) {
  await run(slug, `/${slug}/patients/${patientId}`, async ({ actor, tenant }) => {
    await access.setRestricted(actor, tenant, patientId, s(f, 'restricted') === '1', s(f, 'reason'));
    return s(f, 'restricted') === '1' ? 'Record restricted' : 'Restriction removed';
  });
}

export async function breakGlassAction(slug: string, patientId: string, back: string, f: FormData) {
  await run(slug, back, async ({ actor, tenant }) => {
    await access.requestEmergencyAccess(actor, tenant, { patientId, reason: s(f, 'reason') });
    return `Emergency access granted for ${tenant.settings.emergencyAccessMinutes} minutes. This access is logged and will be reviewed.`;
  });
}

export async function reviewGrantAction(slug: string, grantId: string, f: FormData) {
  await run(slug, `/${slug}/emergency-access`, async ({ actor, tenant }) => {
    await access.reviewEmergencyAccess(actor, tenant, grantId, s(f, 'outcome') as 'appropriate', opt(f, 'note'));
    return 'Review recorded';
  });
}

// ------------------------------------------------------------------ telemedicine
export async function videoAction(slug: string, appointmentId: string, f: FormData) {
  await run(slug, `/${slug}/video/${appointmentId}`, async ({ actor, tenant }) => {
    if (s(f, 'op') === 'end') { await tele.endVideoVisit(actor, tenant, appointmentId, s(f, 'mode') as 'video', opt(f, 'notes')); return 'Video session closed. Complete the visit from the encounter.'; }
    await tele.startVideoVisit(actor, tenant, appointmentId, { identityMethod: s(f, 'identityMethod'), consentMethod: (s(f, 'consentMethod') || 'verbal_recorded') as 'verbal_recorded' });
    return 'Consultation started — join the room and document in the encounter';
  });
}

// ------------------------------------------------------------------ pharmacy
export async function productAction(slug: string, f: FormData) {
  await run(slug, `/${slug}/pharmacy?tab=stock`, async ({ actor, tenant }) => {
    await rx.upsertProduct(actor, tenant, { id: opt(f, 'id'), code: s(f, 'code'), genericName: s(f, 'genericName'), brandName: opt(f, 'brandName'), form: s(f, 'form'),
      strength: opt(f, 'strength'), baseUnit: s(f, 'baseUnit') || 'tablet', schedule: s(f, 'schedule') || 'OTC', restricted: s(f, 'restricted') === 'on',
      salePricePaise: toPaise(s(f, 'price') || '0'), taxRateBp: Math.round(Number(s(f, 'taxRate') || 0) * 100), reorderLevel: num(f, 'reorderLevel') ?? 0, active: s(f, 'active') !== 'off' });
    return 'Product saved';
  });
}

export async function receiveAction(slug: string, f: FormData) {
  await run(slug, `/${slug}/pharmacy?tab=stock`, async ({ actor, tenant }) => {
    await rx.receiveStock(actor, tenant, { locationId: s(f, 'locationId'), productId: s(f, 'productId'), batchNo: s(f, 'batchNo'), expiryDate: s(f, 'expiryDate'),
      qty: Number(s(f, 'qty')), unitCostPaise: s(f, 'unitCost') ? toPaise(s(f, 'unitCost')) : 0, supplier: opt(f, 'supplier'), poLineId: opt(f, 'poLineId'), quarantine: s(f, 'quarantine') === 'on' });
    return 'Stock received';
  });
}

export async function poAction(slug: string, f: FormData) {
  await run(slug, `/${slug}/pharmacy?tab=purchasing`, async ({ actor, tenant }) => {
    if (s(f, 'op') === 'approve') { await rx.approvePurchaseOrder(actor, tenant, s(f, 'poId')); return 'Purchase order approved'; }
    const lines = f.getAll('productId').map((p, i) => ({ productId: String(p), qty: Number(f.getAll('qty')[i] || 0), unitCostPaise: toPaise(String(f.getAll('unitCost')[i] || '0')) })).filter((l) => l.productId && l.qty > 0);
    await rx.createPurchaseOrder(actor, tenant, { supplier: s(f, 'supplier'), locationId: s(f, 'locationId'), note: opt(f, 'note'), lines });
    return 'Purchase order created — awaiting approval';
  });
}

export async function dispenseAction(slug: string, rxId: string, f: FormData) {
  await run(slug, `/${slug}/pharmacy/dispense/${rxId}`, async ({ actor, tenant }) => {
    const lineIds = f.getAll('rxLineId').map(String);
    const lines = lineIds.map((id, i) => ({ rxLineId: id, productId: String(f.getAll('productId')[i] || ''), qty: Number(f.getAll('qty')[i] || 0),
      substitutionReason: String(f.getAll('subReason')[i] || '') || undefined })).filter((l) => l.productId && l.qty > 0);
    if (!lines.length) throw new AppError('VALIDATION', 'Choose a product and quantity for at least one line');
    const r = await rx.dispense(actor, tenant, { prescriptionId: rxId, patientId: s(f, 'patientId'), locationId: s(f, 'locationId'), counselled: s(f, 'counselled') === 'on', lines });
    return { redirect: `/${slug}/pharmacy`, msg: `Dispensed ${r.dispenseNo}: ${r.lines.map((l) => `${l.product} ×${l.qty} (batch ${l.lots.join(', ')})`).join('; ')}` };
  });
}

export async function returnAction(slug: string, back: string, f: FormData) {
  await run(slug, back, async ({ actor, tenant }) => {
    const r = await rx.returnDispensed(actor, tenant, s(f, 'lineId'), Number(s(f, 'qty')), { restock: s(f, 'restock') === 'on', reason: s(f, 'reason') });
    return r.restocked ? 'Returned to stock' : 'Return recorded (not restocked)';
  });
}

export async function recallAction(slug: string, f: FormData) {
  await run(slug, `/${slug}/pharmacy?tab=stock`, async ({ actor, tenant }) => {
    const affected = await rx.recallLot(actor, tenant, s(f, 'lotId'), s(f, 'reference'));
    return `Batch recalled. ${affected.length} patient(s) received it: ${affected.slice(0, 10).map((a) => `${a.full_name} (${a.uhid}${a.phone_e164 ? `, ${a.phone_e164}` : ''})`).join('; ')}`;
  });
}

export async function countAction(slug: string, f: FormData) {
  const id = s(f, 'countId');
  await run(slug, id ? `/${slug}/pharmacy/counts/${id}` : `/${slug}/pharmacy?tab=counts`, async ({ actor, tenant }) => {
    const op = s(f, 'op');
    if (op === 'open') { const c = await rx.openCount(actor, tenant, s(f, 'locationId')); return { redirect: `/${slug}/pharmacy/counts/${c}`, msg: 'Count opened' }; }
    if (op === 'enter') {
      await rx.enterCount(actor, tenant, id, f.getAll('lotId').map((l, i) => ({ lotId: String(l), qty: Number(f.getAll('qty')[i]) })));
      return 'Counts saved';
    }
    const r = await rx.postCount(actor, tenant, id, s(f, 'reason') || 'Stock count');
    return { redirect: `/${slug}/pharmacy?tab=counts`, msg: `Count posted: ${r.adjusted} batch(es) adjusted` };
  });
}

// ------------------------------------------------------------------ inpatient
export async function bedAction(slug: string, f: FormData) {
  await run(slug, `/${slug}/inpatient?tab=beds`, async ({ actor, tenant }) => {
    if (s(f, 'op') === 'status') { await ip.setBedStatus(actor, tenant, s(f, 'bedId'), s(f, 'status') as 'available'); return 'Bed updated'; }
    await ip.upsertBed(actor, tenant, { wardId: s(f, 'wardId'), code: s(f, 'code'), category: opt(f, 'category'), dailyRatePaise: toPaise(s(f, 'rate') || '0') });
    return 'Bed added';
  });
}

export async function admitAction(slug: string, f: FormData) {
  await run(slug, `/${slug}/inpatient`, async ({ actor, tenant }) => {
    const r = await ip.admit(actor, tenant, { patientId: s(f, 'patientId'), bedId: s(f, 'bedId'), departmentId: s(f, 'departmentId'), admittingClinicianId: s(f, 'clinicianId'),
      reason: s(f, 'reason'), expectedDischarge: opt(f, 'expectedDischarge') });
    return { redirect: `/${slug}/inpatient/${r.admissionId}`, msg: `Admitted ${r.admissionNo}` };
  });
}

export async function admissionAction(slug: string, admissionId: string, f: FormData) {
  await run(slug, `/${slug}/inpatient/${admissionId}`, async ({ actor, tenant }) => {
    const op = s(f, 'op');
    switch (op) {
      case 'transfer': await ip.transferBed(actor, tenant, admissionId, s(f, 'bedId'), s(f, 'reason')); return 'Transferred';
      case 'order': {
        const times = s(f, 'times').split(/[\s,]+/).filter(Boolean);
        await ip.orderMedication(actor, tenant, admissionId, { drugName: s(f, 'drugName'), dose: s(f, 'dose'), route: s(f, 'route') || 'oral', scheduleTimes: times,
          prn: s(f, 'prn') === 'on', prnIndication: opt(f, 'prnIndication'), instructions: opt(f, 'instructions'), replacesOrderId: opt(f, 'replacesOrderId'),
          changeReason: opt(f, 'changeReason'), startAt: opt(f, 'startAt') ? new Date(s(f, 'startAt')).toISOString() : undefined });
        return 'Medication order signed';
      }
      case 'stop': await ip.stopMedication(actor, tenant, s(f, 'orderId'), s(f, 'reason')); return 'Order stopped';
      case 'dose': await ip.recordDose(actor, tenant, s(f, 'doseId'), { outcome: s(f, 'outcome') as 'given', note: opt(f, 'note'), doseGiven: opt(f, 'doseGiven'), patientConfirmed: s(f, 'idok') === 'on' }); return 'Dose recorded';
      case 'prn': await ip.recordPrnDose(actor, tenant, s(f, 'orderId'), { outcome: 'given', note: opt(f, 'note'), doseGiven: opt(f, 'doseGiven'), patientConfirmed: s(f, 'idok') === 'on' }); return 'Dose recorded';
      case 'handover': await ip.createHandover(actor, tenant, admissionId, s(f, 'toStaffId'), s(f, 'summary')); return 'Handover sent';
      case 'accept': await ip.acceptHandover(actor, tenant, s(f, 'handoverId')); return 'Handover accepted';
      case 'summary': await ip.signDischargeSummary(actor, tenant, admissionId, { diagnosis: s(f, 'diagnosis'), courseInHospital: s(f, 'course'), conditionAtDischarge: s(f, 'condition'),
        medicationsOnDischarge: opt(f, 'meds'), followUp: opt(f, 'followUp'), instructions: opt(f, 'instructions') }); return 'Discharge summary signed';
      case 'discharge': { const r = await ip.discharge(actor, tenant, admissionId, { disposition: s(f, 'disposition') as 'home', financialClearance: opt(f, 'clearance') });
        return { redirect: `/${slug}/inpatient`, msg: r.outstandingPaise > 0 ? 'Discharged on authorised credit' : 'Discharged' }; }
      default: throw new AppError('VALIDATION', 'Unknown action');
    }
  });
}

// ------------------------------------------------------------------ import
export async function importAction(slug: string, f: FormData) {
  await run(slug, `/${slug}/import`, async ({ actor, tenant }) => {
    const op = s(f, 'op');
    if (op === 'commit') {
      const r = await imp.commitBatch(actor, tenant, s(f, 'batchId'), f.getAll('approveRow').map(Number));
      return `Imported ${r.imported} row(s)${r.failures.length ? `; ${r.failures.length} failed — see the batch rows` : ''}`;
    }
    const file = f.get('file');
    if (!file || typeof file === 'string' || !file.size) throw new AppError('VALIDATION', 'Choose a CSV file');
    const r = await imp.dryRun(actor, tenant, s(f, 'kind') as 'patients', s(f, 'sourceSystem'), file.name, await file.text());
    return { redirect: `/${slug}/import?batch=${r.batchId}`, msg: `Checked ${r.rows} rows: ${r.ok} ready, ${r.review} to review, ${r.errors} with errors, ${r.skipped} already imported` };
  });
}
