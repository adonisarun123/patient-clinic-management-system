'use server';
import { authorize } from '@/lib/actor';
import { AppError } from '@/lib/errors';
import { setModules } from '@/domain/tenants';
import { recordAbha, removeAbha } from '@/domain/abha';
import { abdmTestConnection } from '@/lib/abdm';
import { s, opt, run } from '@/lib/action-helpers';

export async function abdmSettingsAction(slug: string, f: FormData) {
  const back = s(f, 'back') || `/${slug}/settings`;
  await run(slug, back, async ({ actor, tenant }) => {
    authorize(actor, 'settings.manage');
    if (s(f, 'op') === 'test') {
      const r = await abdmTestConnection();
      if (!r.ok) throw new AppError('RULE_VIOLATION', `ABDM ${r.environment}: ${r.error}`);
      return `ABDM ${r.environment} gateway accepted the credentials`;
    }
    const clean = (v: string) => v.replace(/[^A-Za-z0-9_\-]/g, '').slice(0, 40) || undefined;
    await setModules(tenant, {}, { abdmFacility: { hfrId: clean(s(f, 'hfrId')), hipId: clean(s(f, 'hipId')) } });
    return 'ABDM facility details saved';
  });
}

export async function abhaAction(slug: string, patientId: string, f: FormData) {
  await run(slug, `/${slug}/patients/${patientId}`, async ({ actor, tenant }) => {
    if (s(f, 'op') === 'remove') { await removeAbha(actor, tenant, patientId, s(f, 'reason')); return 'ABHA removed from this chart'; }
    await recordAbha(actor, tenant, patientId, { abhaNumber: opt(f, 'abhaNumber'), abhaAddress: opt(f, 'abhaAddress'),
      verification: (s(f, 'verification') || 'self_declared') as 'card_seen', consent: f.get('consent') === 'on', consentNote: opt(f, 'consentNote') });
    return 'ABHA recorded';
  });
}
