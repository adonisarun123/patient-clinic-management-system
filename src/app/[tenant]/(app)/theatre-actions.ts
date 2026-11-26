'use server';
import * as ot from '@/domain/theatre';
import { localToIso } from '@/lib/format';
import { s, opt, num, run } from '@/lib/action-helpers';

const back = (f: FormData, slug: string) => s(f, 'back') || `/${slug}/theatre`;

export async function theatreAction(slug: string, f: FormData) {
  await run(slug, back(f, slug), async ({ actor, tenant }) => {
    const id = s(f, 'caseId');
    switch (s(f, 'op')) {
      case 'room': await ot.upsertTheatre(actor, tenant, { id: opt(f, 'id'), code: s(f, 'code'), name: s(f, 'name'), hourlyRatePaise: Math.round(Number(s(f, 'rate') || '0') * 100),
        turnoverMinutes: num(f, 'turnover') ?? 30, active: s(f, 'active') !== 'off' }); return 'Theatre saved';
      case 'schedule': {
        const r = await ot.scheduleCase(actor, tenant, { patientId: s(f, 'patientId'), theatreId: s(f, 'theatreId'), surgeonId: s(f, 'surgeonId'), anaesthetistId: opt(f, 'anaesthetistId') ?? null,
          admissionId: opt(f, 'admissionId') ?? null, procedureName: s(f, 'procedureName'), laterality: s(f, 'laterality') as 'na', anaesthesia: s(f, 'anaesthesia') as 'general',
          priority: s(f, 'priority') as 'elective', serviceId: opt(f, 'serviceId') ?? null, start: localToIso(s(f, 'start'), tenant.timezone), durationMin: num(f, 'duration') ?? 60, notes: opt(f, 'notes') });
        return { redirect: `/${slug}/theatre/${r.caseId}`, msg: `Scheduled ${r.caseNo}` };
      }
      case 'reschedule': await ot.rescheduleCase(actor, tenant, id, { start: localToIso(s(f, 'start'), tenant.timezone), durationMin: num(f, 'duration') ?? 60, theatreId: opt(f, 'theatreId'), reason: s(f, 'reason') }); return 'Moved';
      case 'cancel': await ot.cancelCase(actor, tenant, id, s(f, 'reason')); return 'Cancelled';
      case 'checklist': {
        const phase = s(f, 'phase') as ot.Phase;
        const answers: Record<string, string> = {};
        for (const it of ot.CHECKLIST[phase].items) answers[it.key] = s(f, `a_${it.key}`);
        await ot.recordChecklist(actor, tenant, id, phase, answers, { concerns: opt(f, 'concerns'), team: opt(f, 'team') });
        return `${ot.CHECKLIST[phase].title} recorded`;
      }
      case 'time': await ot.markTime(actor, tenant, id, s(f, 'which') as 'incision', opt(f, 'at') ? localToIso(s(f, 'at'), tenant.timezone) : undefined); return 'Time recorded';
      case 'item': {
        const [lotId, locationId] = s(f, 'stock').split('|');
        await ot.recordConsumable(actor, tenant, id, { lotId, locationId, qty: num(f, 'qty') ?? 1, implantSerial: opt(f, 'serial') }); return 'Recorded';
      }
      case 'return': await ot.returnConsumable(actor, tenant, s(f, 'itemId'), s(f, 'reason')); return 'Returned to stock';
      case 'note': {
        const blood = s(f, 'bloodLossMl');
        await ot.saveOpNote(actor, tenant, id, Object.fromEntries([...Object.keys(ot.opNoteInput.shape)].map((k) => [k, k === 'bloodLossMl' ? (blood === '' ? null : Number(blood)) : s(f, k)])) as never);
        return 'Operation note saved';
      }
      case 'sign': await ot.signOpNote(actor, tenant, id); return 'Operation note signed';
      case 'complete': { const r = await ot.completeCase(actor, tenant, id); return `Case completed (${r.minutes} min in theatre); charges added`; }
    }
  });
}
