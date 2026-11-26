'use server';
import * as fin from '@/domain/finance';
import { s, opt, run } from '@/lib/action-helpers';
import { toPaise } from '@/lib/money';
import { setModules } from '@/domain/tenants';
import { authorize } from '@/lib/actor';

export async function drawerAction(slug: string, f: FormData) {
  const back = s(f, 'back') || `/${slug}/billing/close`;
  await run(slug, back, async ({ actor, tenant }) => {
    const op = s(f, 'op');
    if (op === 'open') { await fin.openDrawer(actor, tenant, toPaise(s(f, 'float') || '0')); return 'Cash drawer opened'; }
    if (op === 'approve') { await fin.approveDrawer(actor, tenant, s(f, 'id')); return 'Variance approved'; }
    if (op === 'close') {
      const counts: Record<string, number> = {};
      for (const d of fin.DENOMINATIONS) counts[String(d)] = Number(s(f, `d${d}`) || 0);
      const r = await fin.closeDrawer(actor, tenant, { counts, reason: opt(f, 'reason') });
      const v = r.variance === 0 ? 'balanced' : `${r.variance > 0 ? 'over' : 'short'} by ₹${(Math.abs(r.variance) / 100).toFixed(2)}`;
      return `Drawer closed — ${v}${r.needsApproval ? '. Needs approval by a manager.' : ''}`;
    }
  });
}

export async function periodAction(slug: string, f: FormData) {
  const back = s(f, 'back') || `/${slug}/accounts`;
  await run(slug, back, async ({ actor, tenant }) => {
    const op = s(f, 'op');
    if (op === 'close') { await fin.closePeriod(actor, tenant, s(f, 'month')); return `${s(f, 'month')} closed. Its figures are frozen and kept as tax evidence.`; }
    if (op === 'reopen') { await fin.reopenPeriod(actor, tenant, s(f, 'month'), s(f, 'reason')); return `${s(f, 'month')} reopened`; }
    if (op === 'mapping') {
      const ids = f.getAll('id').map(String);
      await fin.setAccountMapping(actor, tenant, ids.map((id) => ({ id, externalName: s(f, `name_${id}`), externalGroup: s(f, `group_${id}`) })));
      return 'Export mapping saved';
    }
    if (op === 'threshold') {
      authorize(actor, 'settings.manage');
      await setModules(tenant, {}, { drawerVarianceApprovalPaise: toPaise(s(f, 'threshold') || '0') });
      return 'Drawer approval threshold saved';
    }
    if (op === 'price') {
      await fin.schedulePrice(actor, tenant, { serviceId: s(f, 'serviceId'), pricePaise: toPaise(s(f, 'price')), from: s(f, 'from'), to: opt(f, 'to'), reason: s(f, 'reason') });
      return 'Price change scheduled';
    }
    if (op === 'unprice') { await fin.removeScheduledPrice(actor, tenant, s(f, 'id')); return 'Scheduled price removed'; }
  });
}
