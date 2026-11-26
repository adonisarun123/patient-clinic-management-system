'use server';
// Every action re-authenticates and re-authorises on the server (Server Actions are public POST endpoints).
import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { requireStaff } from '@/lib/session';
import { AppError, toAppError } from '@/lib/errors';
import { toPaise } from '@/lib/money';
import { createApiKey, updateTenantSettings, getTenantBySlug, setModules, setSecret, MODULES } from '@/domain/tenants';
import { withTenant } from '@/lib/db';
import { randomToken } from '@/lib/crypto';
import * as patients from '@/domain/patients';
import * as sched from '@/domain/scheduling';
import * as queue from '@/domain/queue';
import * as clinical from '@/domain/clinical';
import * as billing from '@/domain/billing';
import * as catalog from '@/domain/catalog';
import * as staff from '@/domain/staff';
import { audit } from '@/lib/events';
import { authorize } from '@/lib/actor';

import { s, opt, num, localDay, run } from '@/lib/action-helpers';

// ------------------------------------------------------------------ patients
export async function registerPatientAction(slug: string, f: FormData) {
  await run(slug, `/${slug}/patients/new`, async ({ actor, tenant }) => {
    const dobMode = s(f, 'dobMode');
    const r = await patients.registerPatient(actor, tenant, {
      fullName: s(f, 'fullName'), preferredName: opt(f, 'preferredName'),
      birthDate: dobMode === 'date' ? opt(f, 'birthDate') : dobMode === 'year' ? opt(f, 'birthYear') : undefined,
      estimatedAgeYears: dobMode === 'age' ? num(f, 'age') : undefined,
      birthUnknown: dobMode === 'declined' ? 'declined' : dobMode === 'unknown' ? 'unknown' : undefined,
      sex: (s(f, 'sex') || 'unknown') as 'unknown', phone: opt(f, 'phone'),
      phoneStatus: s(f, 'phone') ? 'unverified' : (s(f, 'noPhone') as 'none' | 'declined' | 'unavailable') || 'none',
      email: opt(f, 'email'), preferredLanguage: opt(f, 'language'),
      address: { line1: opt(f, 'line1'), city: opt(f, 'city'), state: opt(f, 'state'), pincode: opt(f, 'pincode') },
      emergencyContact: s(f, 'ecName') ? { name: s(f, 'ecName'), phone: s(f, 'ecPhone'), relation: opt(f, 'ecRelation') } : undefined,
      overrideDuplicateReason: opt(f, 'overrideReason'),
      temporary: s(f, 'temporary') === 'on' ? { label: s(f, 'tempLabel') || 'Unidentified patient' } : undefined,
    }, s(f, 'requestKey'));
    return { redirect: `/${slug}/patients/${r.id}`, msg: `Registered ${r.uhid}` };
  });
}

export async function updatePatientAction(slug: string, id: string, f: FormData) {
  await run(slug, `/${slug}/patients/${id}?edit=1`, async ({ actor }) => {
    await patients.updatePatient(actor, id, {
      expectedVersion: Number(s(f, 'version')), kind: s(f, 'kind') as 'update', reason: s(f, 'reason'),
      fullName: opt(f, 'fullName'), preferredName: s(f, 'preferredName'), sex: opt(f, 'sex') as 'unknown' | undefined,
      phone: s(f, 'phone'), email: s(f, 'email'), preferredLanguage: s(f, 'language'), birthDate: opt(f, 'birthDate'),
      address: { line1: s(f, 'line1'), city: s(f, 'city'), state: s(f, 'state'), pincode: s(f, 'pincode') },
    });
    return { redirect: `/${slug}/patients/${id}`, msg: 'Patient updated' };
  });
}

export async function allergyAction(slug: string, patientId: string, back: string, f: FormData) {
  await run(slug, back, async ({ actor }) => {
    if (s(f, 'nka') === '1') await patients.recordAllergyReview(actor, patientId, { noKnownAllergies: true });
    else await patients.recordAllergyReview(actor, patientId, { substance: s(f, 'substance'), reaction: opt(f, 'reaction'), severity: (opt(f, 'severity') as 'mild') ?? 'unknown' });
    return 'Allergy review recorded';
  });
}

export async function allergyStatusAction(slug: string, allergyId: string, back: string, f: FormData) {
  await run(slug, back, async ({ actor }) => { await patients.setAllergyStatus(actor, allergyId, s(f, 'status') as 'resolved'); return 'Allergy updated'; });
}

export async function linkPatientAction(slug: string, sourceId: string, f: FormData) {
  await run(slug, `/${slug}/patients/${sourceId}`, async ({ actor, tenant }) => {
    const survivor = s(f, 'survivorId');
    const r = await patients.linkIntoExisting(actor, tenant, sourceId, survivor, s(f, 'reason'));
    return { redirect: `/${slug}/patients/${survivor}`, msg: `Linked ${r.retired} into ${r.survivor}` };
  });
}

export async function confirmIdentityAction(slug: string, id: string) {
  await run(slug, `/${slug}/patients/${id}`, async ({ actor }) => { await patients.confirmIdentity(actor, id); return 'Identity confirmed — this is now a regular chart'; });
}

// ------------------------------------------------------------------ appointments
export async function bookAction(slug: string, f: FormData) {
  const back = s(f, 'back') || `/${slug}/appointments/new`;
  await run(slug, back, async ({ actor, tenant }) => {
    const r = await sched.bookDirect(actor, tenant, { serviceId: s(f, 'serviceId'), clinicianId: s(f, 'clinicianId'), start: s(f, 'start'),
      patientId: s(f, 'patientId'), notes: opt(f, 'notes'), source: (s(f, 'source') as 'phone') || 'staff' }, s(f, 'requestKey'));
    return { redirect: `/${slug}/appointments?date=${localDay(r.start, tenant.timezone)}`, msg: `Booked ${r.bookingRef}` };
  });
}

export async function apptAction(slug: string, id: string, back: string, f: FormData) {
  await run(slug, back, async ({ actor, tenant }) => {
    const op = s(f, 'op');
    if (op === 'checkin') { const t = await sched.checkIn(actor, tenant, id, { identityConfirmed: s(f, 'idok') === 'on' }); return `Checked in — token ${t.token}`; }
    if (op === 'cancel') { await sched.cancelAppointment(actor, tenant, id, s(f, 'reason'), { expectedVersion: num(f, 'version') }); return 'Appointment cancelled'; }
    if (op === 'noshow') { await sched.markNoShow(actor, tenant, id); return 'Marked as no-show'; }
    if (op === 'reschedule') {
      const [start, clinicianId] = (s(f, 'slot') || `${s(f, 'start')}|${s(f, 'clinicianId')}`).split('|');
      const r = await sched.reschedule(actor, tenant, id, { expectedVersion: Number(s(f, 'version')), start, clinicianId: clinicianId || undefined, reason: s(f, 'reason') }, s(f, 'requestKey'));
      return { redirect: `/${slug}/appointments?date=${localDay(r.start, tenant.timezone)}`, msg: 'Rescheduled' };
    }
    if (op === 'reinstate') { await sched.correctState(actor, tenant, id, 'booked', s(f, 'reason')); return 'Reinstated'; }
    throw new AppError('VALIDATION', 'Unknown action');
  });
}

// ------------------------------------------------------------------ queue & clinical
export async function walkInAction(slug: string, f: FormData) {
  await run(slug, s(f, 'back') || `/${slug}/queue`, async ({ actor, tenant }) => {
    const t = await queue.addWalkIn(actor, tenant, { patientId: s(f, 'patientId'), departmentId: s(f, 'departmentId'), clinicianId: opt(f, 'clinicianId'),
      serviceId: opt(f, 'serviceId'), priority: num(f, 'priority') ?? 0, priorityReason: opt(f, 'priorityReason'), identityConfirmed: (s(f, 'idok') === 'on') as true });
    return { redirect: `/${slug}/queue`, msg: `Added to queue — token ${t.token}` };
  });
}

export async function queueAction(slug: string, ticketId: string, f: FormData) {
  await run(slug, `/${slug}/queue`, async ({ actor, tenant }) => {
    const op = s(f, 'op');
    if (op === 'call') { await queue.callTicket(actor, tenant, ticketId); return 'Called'; }
    if (op === 'left') { await queue.markLeft(actor, tenant, ticketId, s(f, 'reason') || 'Left before being seen'); return 'Marked as left'; }
    if (op === 'priority') { await queue.setPriority(actor, tenant, ticketId, Number(s(f, 'priority')), s(f, 'reason')); return 'Priority updated'; }
    if (op === 'start') {
      const r = await clinical.startEncounter(actor, tenant, ticketId, { chiefComplaint: opt(f, 'complaint') });
      return { redirect: `/${slug}/encounters/${r.encounterId}`, msg: '' };
    }
    throw new AppError('VALIDATION', 'Unknown action');
  });
}

export async function vitalsAction(slug: string, encId: string, f: FormData) {
  await run(slug, `/${slug}/encounters/${encId}`, async ({ actor, tenant }) => {
    await clinical.recordVitals(actor, tenant, encId, { systolic: num(f, 'systolic'), diastolic: num(f, 'diastolic'), pulse: num(f, 'pulse'),
      respRate: num(f, 'respRate'), tempC: num(f, 'tempC'), spo2: num(f, 'spo2'), weightKg: num(f, 'weightKg'), heightCm: num(f, 'heightCm') });
    return 'Vitals recorded';
  });
}

export async function noteAction(slug: string, encId: string, f: FormData) {
  await run(slug, `/${slug}/encounters/${encId}`, async ({ actor, tenant }) => {
    const diagnoses = s(f, 'diagnoses').split('\n').map((x) => x.trim()).filter(Boolean).map((text) => ({ text }));
    const saved = await clinical.saveNoteDraft(actor, tenant, encId,
      { subjective: s(f, 'subjective'), objective: s(f, 'objective'), assessment: s(f, 'assessment'), plan: s(f, 'plan'), diagnoses },
      { noteId: opt(f, 'noteId'), expectedRowVersion: num(f, 'rowVersion') });
    if (s(f, 'intent') === 'sign') { await clinical.signNote(actor, tenant, saved.noteId, saved.rowVersion); return 'Note signed'; }
    return 'Draft saved';
  });
}

export async function amendNoteAction(slug: string, encId: string, noteId: string, f: FormData) {
  await run(slug, `/${slug}/encounters/${encId}`, async ({ actor, tenant }) => { await clinical.amendNote(actor, tenant, noteId, s(f, 'reason')); return 'Amendment draft created'; });
}

export async function rxAction(slug: string, encId: string, f: FormData) {
  await run(slug, `/${slug}/encounters/${encId}`, async ({ actor, tenant }) => {
    const lines = JSON.parse(s(f, 'lines') || '[]') as Record<string, string | boolean>[];
    const saved = await clinical.saveRxDraft(actor, tenant, encId, {
      lines: lines.filter((l) => String(l.drugName ?? '').trim()).map((l) => ({
        drugName: String(l.drugName), strength: String(l.strength || '') || undefined, form: String(l.form || '') || undefined, dose: String(l.dose ?? ''),
        route: String(l.route || 'oral'), frequency: String(l.frequency ?? ''), duration: String(l.duration ?? ''), quantity: String(l.quantity || '') || undefined,
        prn: l.prn === true, prnIndication: String(l.prnIndication || '') || undefined, instructions: String(l.instructions || '') || undefined,
      })),
      advice: opt(f, 'advice'), followUpInDays: num(f, 'followUpInDays') ?? null, expectedRowVersion: num(f, 'rowVersion'),
    }, opt(f, 'rxId'));
    if (s(f, 'intent') === 'sign') {
      const r = await clinical.signPrescription(actor, tenant, saved.prescriptionId, { expectedRowVersion: saved.rowVersion,
        patientConfirmed: s(f, 'patientConfirmed') === 'on', safetyOverrideReason: opt(f, 'override') });
      return `Prescription ${r.rxNumber} signed`;
    }
    return 'Prescription draft saved';
  });
}

export async function amendRxAction(slug: string, encId: string, rxId: string, f: FormData) {
  await run(slug, `/${slug}/encounters/${encId}`, async ({ actor, tenant }) => { await clinical.amendPrescription(actor, tenant, rxId, s(f, 'reason')); return 'Amendment draft created'; });
}

export async function completeEncounterAction(slug: string, encId: string) {
  await run(slug, `/${slug}/encounters/${encId}`, async ({ actor, tenant }) => {
    const r = await clinical.completeEncounter(actor, tenant, encId);
    return { redirect: `/${slug}/queue`, msg: r.charged ? 'Visit completed — consultation charge sent to billing' : 'Visit completed' };
  });
}

export async function followUpAction(slug: string, back: string, f: FormData) {
  await run(slug, back, async ({ actor, tenant }) => {
    const id = opt(f, 'followUpId');
    if (id) { await clinical.closeFollowUp(actor, tenant, id, s(f, 'status') as 'completed', s(f, 'outcome')); return 'Follow-up updated'; }
    await clinical.addFollowUp(actor, tenant, { patientId: s(f, 'patientId'), encounterId: opt(f, 'encounterId'), dueDate: s(f, 'dueDate'), reason: s(f, 'reason'), clinicianId: opt(f, 'clinicianId') });
    return 'Follow-up added';
  });
}

// ------------------------------------------------------------------ billing
export async function chargeAction(slug: string, patientId: string, f: FormData) {
  await run(slug, `/${slug}/billing?patient=${patientId}`, async ({ actor, tenant }) => {
    await billing.addCharge(actor, tenant, { patientId, serviceId: opt(f, 'serviceId'), description: opt(f, 'description'),
      quantity: num(f, 'quantity') ?? 1, unitPricePaise: s(f, 'price') ? toPaise(s(f, 'price')) : undefined,
      discountPaise: s(f, 'discount') ? toPaise(s(f, 'discount')) : 0, discountReason: opt(f, 'discountReason') }, s(f, 'requestKey'));
    return 'Charge added';
  });
}

export async function billAction(slug: string, patientId: string, f: FormData) {
  await run(slug, `/${slug}/billing?patient=${patientId}`, async ({ actor, tenant }) => {
    const r = await billing.billCharges(actor, tenant, patientId, f.getAll('chargeId').map(String), s(f, 'requestKey'));
    return `Invoice ${r.number} posted`;
  });
}

export async function paymentAction(slug: string, patientId: string, f: FormData) {
  await run(slug, `/${slug}/billing?patient=${patientId}`, async ({ actor, tenant }) => {
    const r = await billing.recordPayment(actor, tenant, { patientId, method: s(f, 'method') as 'cash', amountPaise: toPaise(s(f, 'amount') || '0'),
      reference: opt(f, 'reference'), note: opt(f, 'note') }, s(f, 'requestKey'));
    return { redirect: `/${slug}/billing/receipts/${r.paymentId}`, msg: `Receipt ${r.receiptNo}` };
  });
}

export async function refundRequestAction(slug: string, patientId: string, f: FormData) {
  await run(slug, `/${slug}/billing?patient=${patientId}`, async ({ actor, tenant }) => {
    await billing.requestRefund(actor, tenant, { paymentId: s(f, 'paymentId'), amountPaise: toPaise(s(f, 'amount') || '0'), method: s(f, 'method') as 'cash', reason: s(f, 'reason') });
    return 'Refund requested — awaiting approval';
  });
}

export async function refundDecisionAction(slug: string, refundId: string, f: FormData) {
  await run(slug, `/${slug}/billing`, async ({ actor, tenant }) => {
    const op = s(f, 'op');
    if (op === 'pay') { await billing.payRefund(actor, tenant, refundId, opt(f, 'reference')); return 'Refund paid'; }
    await billing.decideRefund(actor, tenant, refundId, op === 'approve', opt(f, 'note'));
    return op === 'approve' ? 'Refund approved' : 'Refund rejected';
  });
}

export async function voidInvoiceAction(slug: string, invoiceId: string, f: FormData) {
  await run(slug, `/${slug}/billing/invoices/${invoiceId}`, async ({ actor, tenant }) => { await billing.voidInvoice(actor, tenant, invoiceId, s(f, 'reason')); return 'Invoice voided'; });
}

export async function voidChargeAction(slug: string, patientId: string, chargeId: string, f: FormData) {
  await run(slug, `/${slug}/billing?patient=${patientId}`, async ({ actor, tenant }) => { await billing.voidCharge(actor, tenant, chargeId, s(f, 'reason')); return 'Charge voided'; });
}

// ------------------------------------------------------------------ settings
const back = (slug: string, tab: string) => `/${slug}/settings?tab=${tab}`;

export async function clinicSettingsAction(slug: string, f: FormData) {
  await run(slug, back(slug, 'clinic'), async ({ actor, tenant }) => {
    authorize(actor, 'settings.manage');
    await updateTenantSettings(tenant, {
      name: s(f, 'name'), timezone: s(f, 'timezone'), soloPractice: s(f, 'soloPractice') === 'on',
      holdMinutes: Number(s(f, 'holdMinutes')), noShowGraceMinutes: Number(s(f, 'noShowGraceMinutes')),
      bookingHorizonDays: Number(s(f, 'bookingHorizonDays')), minLeadMinutes: Number(s(f, 'minLeadMinutes')),
      publicBookingEnabled: s(f, 'publicBookingEnabled') === 'on', requireAllergyReviewToSign: s(f, 'requireAllergyReviewToSign') === 'on',
      branding: { primaryColor: opt(f, 'primaryColor'), accentColor: opt(f, 'accentColor'), logoUrl: s(f, 'logoUrl'), address: opt(f, 'address'),
        phone: opt(f, 'phone'), email: opt(f, 'email'), website: opt(f, 'website'), registrationText: opt(f, 'registrationText'), footerNote: opt(f, 'footerNote') },
    });
    await withTenant(tenant.id, (tx) => audit(tx, actor, 'settings.updated', 'tenant', tenant.id));
    return 'Clinic settings saved';
  });
}

export async function departmentAction(slug: string, f: FormData) {
  await run(slug, back(slug, 'structure'), async ({ actor }) => {
    if (s(f, 'kind') === 'location') await catalog.upsertLocation(actor, { id: opt(f, 'id'), code: s(f, 'code'), name: s(f, 'name'), kind: opt(f, 'locKind'), departmentId: opt(f, 'departmentId') ?? null });
    else await catalog.upsertDepartment(actor, { id: opt(f, 'id'), code: s(f, 'code'), name: s(f, 'name') });
    return 'Saved';
  });
}

export async function staffAction(slug: string, f: FormData) {
  await run(slug, back(slug, 'staff'), async ({ actor }) => {
    const op = s(f, 'op');
    if (op === 'toggle') { await staff.setStaffActive(actor, s(f, 'staffId'), s(f, 'active') === '1'); return 'Updated'; }
    if (op === 'reset') { const p = await staff.resetStaffPassword(actor, s(f, 'staffId')); return `Temporary password: ${p} (shown once)`; }
    const isClin = s(f, 'isClinician') === 'on';
    const r = await staff.createStaff(actor, { email: s(f, 'email'), fullName: s(f, 'fullName'), role: s(f, 'role') as 'doctor',
      clinician: isClin ? { qualification: opt(f, 'qualification'), specialty: opt(f, 'specialty'), registrationCouncil: opt(f, 'council'),
        registrationNumber: opt(f, 'regNo'), departmentIds: f.getAll('departmentIds').map(String) } : undefined });
    return `Account created. Temporary password: ${r.tempPassword} (shown once — share securely)`;
  });
}

export async function clinicianAction(slug: string, f: FormData) {
  await run(slug, back(slug, 'doctors'), async ({ actor }) => {
    await catalog.upsertClinician(actor, { id: opt(f, 'id'), displayName: s(f, 'displayName'), qualification: opt(f, 'qualification'), specialty: opt(f, 'specialty'),
      registrationCouncil: opt(f, 'council'), registrationNumber: opt(f, 'regNo'), bio: opt(f, 'bio'), publicProfile: s(f, 'publicProfile') === 'on',
      active: s(f, 'active') !== 'off', departmentIds: f.getAll('departmentIds').map(String) });
    return 'Doctor profile saved';
  });
}

export async function serviceAction(slug: string, f: FormData) {
  await run(slug, back(slug, 'services'), async ({ actor }) => {
    await catalog.upsertService(actor, { id: opt(f, 'id'), departmentId: s(f, 'departmentId'), code: s(f, 'code'), name: s(f, 'name'), kind: s(f, 'kind') as 'consultation',
      durationMin: Number(s(f, 'durationMin')), bufferBeforeMin: num(f, 'bufferBeforeMin') ?? 0, bufferAfterMin: num(f, 'bufferAfterMin') ?? 0,
      pricePaise: toPaise(s(f, 'price') || '0'), taxRateBp: Math.round(Number(s(f, 'taxRate') || '0') * 100), followUpFreeDays: num(f, 'followUpFreeDays') ?? 0,
      publicBookable: s(f, 'publicBookable') === 'on', modality: (s(f, 'modality') || 'in_person') as 'video', patientInstructions: opt(f, 'instructions'), active: s(f, 'active') !== 'off',
      clinicianIds: f.getAll('clinicianIds').map(String) });
    return 'Service saved';
  });
}

export async function scheduleAction(slug: string, f: FormData) {
  await run(slug, back(slug, 'schedules'), async ({ actor, tenant }) => {
    const op = s(f, 'op');
    if (op === 'end') { await catalog.removeScheduleTemplate(actor, s(f, 'id')); return 'Session ended'; }
    if (op === 'lift') { await catalog.removeScheduleException(actor, s(f, 'id')); return 'Exception removed'; }
    if (op === 'exception') {
      const r = await catalog.addScheduleException(actor, tenant.timezone, { kind: s(f, 'kind') as 'leave', clinicianId: opt(f, 'clinicianId') ?? null,
        locationId: opt(f, 'locationId') ?? null, startsAt: s(f, 'startsAt'), endsAt: s(f, 'endsAt'), reason: opt(f, 'reason') });
      return r.affected.length ? `Published. ${r.affected.length} booked appointment(s) need rebooking — see Appointments › Impacted.` : 'Published';
    }
    await catalog.addScheduleTemplate(actor, { clinicianId: s(f, 'clinicianId'), locationId: s(f, 'locationId'), weekdays: f.getAll('weekdays').map(Number),
      startTime: s(f, 'startTime'), endTime: s(f, 'endTime'), slotStepMin: num(f, 'slotStepMin') ?? 10 });
    return 'Session added';
  });
}

export async function integrationAction(slug: string, f: FormData) {
  await run(slug, back(slug, 'website'), async ({ actor, tenant }) => {
    authorize(actor, 'settings.manage');
    const op = s(f, 'op');
    return withTenant(tenant.id, async (tx) => {
      if (op === 'revoke') { await tx.exec(`UPDATE tenant_api_key SET revoked_at = now() WHERE id = $1`, [s(f, 'id')]); await audit(tx, actor, 'api_key.revoked', 'tenant_api_key', s(f, 'id')); return 'Key revoked'; }
      if (op === 'webhook') {
        const secret = `whsec_${randomToken(24)}`;
        await tx.exec(`INSERT INTO webhook_endpoint (tenant_id, url, secret, events, include_contact) VALUES (app_tenant_id(), $1, $2, $3, $4)`,
          [s(f, 'url'), secret, f.getAll('events').map(String), s(f, 'includeContact') === 'on']);
        await audit(tx, actor, 'webhook.created', 'webhook_endpoint', null);
        return `Webhook added. Signing secret: ${secret} (shown once)`;
      }
      if (op === 'webhook-off') { await tx.exec(`UPDATE webhook_endpoint SET active = false WHERE id = $1`, [s(f, 'id')]); return 'Webhook disabled'; }
      const origins = s(f, 'origins').split(/[\s,]+/).filter(Boolean);
      const k = await createApiKey(tx, s(f, 'kind') === 'secret' ? 'secret' : 'publishable', s(f, 'label') || 'Website', origins);
      await audit(tx, actor, 'api_key.created', 'tenant_api_key', k.id);
      return `New key: ${k.key} — copy it now; it is shown once.`;
    });
  });
}

export async function changePasswordAction(slug: string, f: FormData) {
  await run(slug, `/${slug}/account`, async ({ actor }) => {
    if (s(f, 'next') !== s(f, 'confirm')) throw new AppError('VALIDATION', 'New passwords do not match');
    await staff.changePassword(actor, s(f, 'current'), s(f, 'next'));
    return { redirect: `/${slug}`, msg: 'Password changed' };
  });
}

export async function refreshTenant(slug: string) { return getTenantBySlug(slug); }

export async function modulesAction(slug: string, f: FormData) {
  await run(slug, `/${slug}/settings?tab=modules`, async ({ actor, tenant }) => {
    authorize(actor, 'settings.manage');
    if (s(f, 'secretsOnly') === '1') {
      const names = ['razorpay_key_id', 'razorpay_key_secret', 'razorpay_webhook_secret', 'msg91_authkey', 'msg91_otp_template_id'];
      await withTenant(tenant.id, async (tx) => {
        for (const n of names) if (s(f, n)) await setSecret(tx, n, s(f, n), actor.staffId);
        await audit(tx, actor, 'secrets.updated', 'tenant', tenant.id, { data: { names: names.filter((n) => s(f, n)) } });
      });
      return 'Credentials saved';
    }
    if (actor.role !== 'owner') throw new AppError('FORBIDDEN', 'Only the clinic owner can switch modules');
    const mods = Object.fromEntries(MODULES.map((m) => [m, s(f, `m_${m}`) === 'on']));
    const jitsi = s(f, 'jitsiBaseUrl') || 'https://meet.jit.si';
    if (!/^https:\/\//.test(jitsi)) throw new AppError('VALIDATION', 'Video server URL must start with https://');
    await setModules(tenant, mods, { autoReleasePrescriptions: s(f, 'autoReleasePrescriptions') === 'on', recordsRequestDays: Number(s(f, 'recordsRequestDays') || 30),
      emergencyAccessMinutes: Number(s(f, 'emergencyAccessMinutes') || 60), jitsiBaseUrl: jitsi });
    await withTenant(tenant.id, (tx) => audit(tx, actor, 'modules.updated', 'tenant', tenant.id, { data: mods }));
    return 'Modules saved';
  });
}
