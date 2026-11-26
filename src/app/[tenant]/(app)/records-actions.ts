'use server';
import * as records from '@/domain/records';
import { withTenant } from '@/lib/db';
import { AppError } from '@/lib/errors';
import { s, opt, num, run } from '@/lib/action-helpers';

const back = (f: FormData, slug: string) => s(f, 'back') || `/${slug}/records`;

export async function mergeAction(slug: string, f: FormData) {
  await run(slug, back(f, slug), async ({ actor, tenant }) => {
    switch (s(f, 'op')) {
      case 'request': {
        const r = await records.requestMerge(actor, tenant, s(f, 'sourceId'), s(f, 'survivorId'), s(f, 'reason'));
        return r.status === 'done' ? `Merged ${r.retired} into ${r.survivor}` : `Merge of ${r.retired} into ${r.survivor} sent for a second person to approve`;
      }
      case 'approve': { const r = await records.decideMerge(actor, tenant, s(f, 'id'), 'approve'); return r.status === 'done' ? `Merged ${r.retired} into ${r.survivor}` : 'Done'; }
      case 'reject': await records.decideMerge(actor, tenant, s(f, 'id'), 'reject', s(f, 'note')); return 'Merge rejected';
      case 'cancel': await records.decideMerge(actor, tenant, s(f, 'id'), 'cancel'); return 'Request withdrawn';
      case 'undo': {
        const r = await records.undoMerge(actor, tenant, s(f, 'id'), s(f, 'reason'));
        const left = Object.values(r.left).reduce((n, a) => n + a.length, 0);
        return `Restored ${r.restored} as a separate chart${left ? `; ${left} item(s) had progressed and stayed on ${r.from} — review them` : ''}`;
      }
    }
  });
}

export async function refileAction(slug: string, f: FormData) {
  await run(slug, back(f, slug), async ({ actor, tenant }) => {
    switch (s(f, 'op')) {
      case 'request': {
        const uhid = s(f, 'toUhid').toUpperCase();
        const to = await withTenant(tenant.id, (tx) => tx.maybe<{ id: string }>(`SELECT id FROM patient WHERE upper(uhid) = $1 AND status <> 'merged'`, [uhid]));
        if (!to) throw new AppError('NOT_FOUND', `No chart with UHID ${uhid}`);
        const r = await records.requestRefile(actor, tenant, s(f, 'attachmentId'), to.id, s(f, 'reason'));
        return r.status === 'done' ? `Document moved to ${uhid}` : `Move to ${uhid} sent for a second person to approve`;
      }
      case 'approve': await records.decideRefile(actor, tenant, s(f, 'id'), 'approve', opt(f, 'note')); return 'Document moved';
      case 'reject': await records.decideRefile(actor, tenant, s(f, 'id'), 'reject', s(f, 'note')); return 'Request rejected';
      case 'cancel': await records.decideRefile(actor, tenant, s(f, 'id'), 'cancel'); return 'Request withdrawn';
    }
  });
}

export async function layoutAction(slug: string, f: FormData) {
  await run(slug, back(f, slug), async ({ actor, tenant }) => {
    const kind = s(f, 'kind') as records.PrintKind;
    if (s(f, 'op') === 'restore') { const r = await records.restoreLayout(actor, tenant, kind, Number(s(f, 'version'))); return `Restored as version ${r.version}`; }
    const r = await records.saveLayout(actor, tenant, kind, {
      paper: s(f, 'paper') as 'A4', preprintedTopMm: num(f, 'preprintedTopMm') ?? 0, preprintedBottomMm: num(f, 'preprintedBottomMm') ?? 0, marginMm: num(f, 'marginMm') ?? 12,
      showHeader: f.get('showHeader') === 'on', showLogo: f.get('showLogo') === 'on', headerAlign: s(f, 'headerAlign') as 'left', accent: s(f, 'accent') || '#111827',
      fontScale: Number(s(f, 'fontScale') || '1'), extraHeaderLines: s(f, 'extraHeaderLines').split('\n').map((x) => x.trim()).filter(Boolean),
      footerText: s(f, 'footerText'), signatureLabel: s(f, 'signatureLabel'),
    }, opt(f, 'note'));
    return `Saved as version ${r.version}`;
  });
}
