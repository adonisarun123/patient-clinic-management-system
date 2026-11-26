'use server';
import * as fd from '@/domain/frontdesk';
import { s, opt, num, localDay, run } from '@/lib/action-helpers';
import { localToIso } from '@/lib/format';

export async function seriesAction(slug: string, f: FormData) {
  const back = s(f, 'back') || `/${slug}/appointments/new`;
  await run(slug, back, async ({ actor, tenant }) => {
    const op = s(f, 'op');
    if (op === 'cancel') { const r = await fd.cancelSeries(actor, tenant, s(f, 'seriesId'), s(f, 'reason')); return `Cancelled ${r.cancelled} remaining visit(s) in the series`; }
    const r = await fd.bookSeries(actor, tenant, {
      patientId: s(f, 'patientId'), serviceId: s(f, 'serviceId'), clinicianId: s(f, 'clinicianId'),
      firstStart: localToIso(s(f, 'firstStart'), tenant.timezone), freq: s(f, 'freq') as 'weekly', everyN: num(f, 'everyN') ?? 1,
      count: num(f, 'count') ?? 2, skipConflicts: s(f, 'skip') === 'on', notes: opt(f, 'notes'),
    });
    const skipped = r.skipped.length ? ` · ${r.skipped.length} date(s) skipped as unavailable: ${r.skipped.map((x) => localDay(x.start, tenant.timezone)).join(', ')}` : '';
    return { redirect: `/${slug}/appointments?date=${localDay(r.booked[0].start, tenant.timezone)}`, msg: `Booked ${r.booked.length} visits (${r.booked.map((b) => b.bookingRef).join(', ')})${skipped}` };
  });
}

export async function waitlistAction(slug: string, f: FormData) {
  const back = s(f, 'back') || `/${slug}/waitlist`;
  await run(slug, back, async ({ actor, tenant }) => {
    const op = s(f, 'op');
    if (op === 'add') {
      await fd.addToWaitlist(actor, tenant, { patientId: s(f, 'patientId'), serviceId: s(f, 'serviceId'), clinicianId: opt(f, 'clinicianId') ?? null,
        earliestDate: s(f, 'earliestDate'), latestDate: s(f, 'latestDate'), timePref: (s(f, 'timePref') || 'any') as 'any', priority: num(f, 'priority') ?? 0, notes: opt(f, 'notes') });
      return { redirect: `/${slug}/waitlist`, msg: 'Added to the waitlist. You will see it highlighted when a matching slot frees up.' };
    }
    if (op === 'book') {
      const r = await fd.bookFromWaitlist(actor, tenant, s(f, 'id'), { start: s(f, 'start'), clinicianId: s(f, 'clinicianId') }, s(f, 'requestKey'));
      return `Booked ${r.bookingRef}`;
    }
    if (op === 'decline') { await fd.declineWaitlistMatch(actor, tenant, s(f, 'id')); return 'Match cleared; still waiting'; }
    if (op === 'remove') { await fd.removeFromWaitlist(actor, tenant, s(f, 'id'), s(f, 'reason')); return 'Removed from waitlist'; }
  });
}

export async function referralAction(slug: string, f: FormData) {
  const back = s(f, 'back') || `/${slug}/referrals`;
  await run(slug, back, async ({ actor, tenant }) => {
    const op = s(f, 'op');
    const id = s(f, 'id');
    const out = () => ({ patientId: s(f, 'patientId'), encounterId: opt(f, 'encounterId') ?? null, referrerId: opt(f, 'referrerId') ?? null,
      toSpecialty: opt(f, 'toSpecialty'), urgency: (s(f, 'urgency') || 'routine') as 'routine', reason: s(f, 'reason'), clinicalSummary: opt(f, 'clinicalSummary') });
    switch (op) {
      case 'referrer': await fd.upsertReferrer(actor, tenant, { id: opt(f, 'id'), name: s(f, 'name'), specialty: opt(f, 'specialty'), organisation: opt(f, 'organisation'),
        phone: opt(f, 'phone'), email: opt(f, 'email') ?? '', registrationNo: opt(f, 'registrationNo'), active: s(f, 'active') !== 'off' }); return 'Referrer saved';
      case 'draft': { const rid = await fd.draftOutboundReferral(actor, tenant, out()); return { redirect: `/${slug}/referrals/${rid}`, msg: 'Draft saved — review and sign' }; }
      case 'edit': await fd.updateDraftReferral(actor, tenant, id, out()); return 'Draft updated';
      case 'sign': await fd.signReferral(actor, tenant, id); return 'Signed — print or send the letter';
      case 'sent': await fd.markReferralSent(actor, tenant, id, s(f, 'how') || 'handed to patient'); return 'Marked as sent';
      case 'inbound': { const rid = await fd.recordInboundReferral(actor, tenant, { patientId: s(f, 'patientId'), referrerId: s(f, 'referrerId'),
        urgency: (s(f, 'urgency') || 'routine') as 'routine', reason: s(f, 'reason'), clinicalSummary: opt(f, 'clinicalSummary'), clinicianId: opt(f, 'clinicianId') ?? null });
        return { redirect: `/${slug}/referrals/${rid}`, msg: 'Inbound referral recorded' }; }
      case 'link': await fd.linkReferralAppointment(actor, tenant, id, s(f, 'appointmentId')); return 'Linked to the visit';
      case 'close': await fd.closeReferral(actor, tenant, id, s(f, 'status') as 'completed', s(f, 'notes')); return 'Referral closed';
    }
  });
}
