'use server';
import * as safety from '@/domain/safety';
import { setModules } from '@/domain/tenants';
import { authorize } from '@/lib/actor';
import { s, opt, run } from '@/lib/action-helpers';

const n = (v: string) => (v.trim() === '' ? undefined : Number(v));
const list = (v: string) => v.split(',').map((x) => x.trim()).filter(Boolean);

export async function formularyAction(slug: string, f: FormData) {
  const back = s(f, 'back') || `/${slug}/formulary`;
  await run(slug, back, async ({ actor, tenant }) => {
    switch (s(f, 'op')) {
      case 'item': await safety.upsertFormularyItem(actor, tenant, { id: opt(f, 'id'), genericName: s(f, 'genericName'), brandNames: list(s(f, 'brandNames')), classes: list(s(f, 'classes')),
        strength: opt(f, 'strength'), form: opt(f, 'form'), route: opt(f, 'route'), doseUnit: (s(f, 'doseUnit') || 'mg') as 'mg', perKgMin: n(s(f, 'perKgMin')), perKgMax: n(s(f, 'perKgMax')),
        maxSingleDose: n(s(f, 'maxSingleDose')), maxDailyDose: n(s(f, 'maxDailyDose')), weightRequiredUnderYears: n(s(f, 'weightUnder')), schedule: opt(f, 'schedule'),
        source: s(f, 'source'), notes: opt(f, 'notes'), active: s(f, 'active') !== 'off' }); return 'Formulary entry saved';
      case 'rule': await safety.addInteractionRule(actor, tenant, { a: s(f, 'a'), b: s(f, 'b'), severity: s(f, 'severity') as 'major', effect: s(f, 'effect'), management: opt(f, 'management'), source: s(f, 'source') }); return 'Interaction rule saved';
      case 'ruleActive': await safety.setRuleActive(actor, tenant, s(f, 'id'), s(f, 'active') === '1'); return 'Rule updated';
      case 'import': {
        const file = f.get('file');
        if (!(file instanceof File) || !file.size) return 'Choose a CSV file';
        if (file.size > 2_000_000) return 'The file is larger than 2 MB';
        const r = await safety.importInteractionCsv(actor, tenant, await file.text());
        return `Imported ${r.imported} interaction rule(s)`;
      }
      case 'mode': authorize(actor, 'settings.manage'); await setModules(tenant, {}, { formularyMode: s(f, 'mode') as 'warn' }); return 'Formulary policy saved';
    }
  });
}
