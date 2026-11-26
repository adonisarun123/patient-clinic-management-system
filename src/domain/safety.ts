// Prescribing safety checks (CFG-006, CL-014, CL-017). Runs on a draft for display, and again at signing where
// blocking findings need an explicit override reason. The engine is only as good as the clinic's formulary and
// interaction rules; it ships empty and says so. Nothing here is a substitute for clinical judgement.
import { z } from 'zod';
import { withTenant, type Tx } from '@/lib/db';
import { invalid, notFound, rule } from '@/lib/errors';
import { authorize, staffId, type Actor } from '@/lib/actor';
import { audit } from '@/lib/events';
import type { Tenant } from './tenants';

export type Severity = 'block' | 'warn' | 'info';
export type Finding = { severity: Severity; kind: string; message: string; drugs?: string[]; source?: string };

type Line = { drug_name: string; strength: string | null; dose: string; frequency: string; prn: boolean };
type FormItem = { id: string; generic_name: string; brand_names: string[]; classes: string[]; strength: string | null; dose_unit: string;
  per_kg_min: string | null; per_kg_max: string | null; max_single_dose: string | null; max_daily_dose: string | null;
  weight_required_under_years: number | null; source: string; status: string };

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/** Doses per day from common Indian prescription notations: OD/BD/TDS/QID/HS/SOS, "1-0-1", "every 8 hours", "x times a day". */
export function timesPerDay(freq: string): number | null {
  const f = freq.trim().toLowerCase();
  const pattern = /^(\d(?:\.\d)?)\s*-\s*(\d(?:\.\d)?)\s*-\s*(\d(?:\.\d)?)(?:\s*-\s*(\d(?:\.\d)?))?$/.exec(f);
  if (pattern) return [pattern[1], pattern[2], pattern[3], pattern[4] ?? '0'].reduce((s, x) => s + Number(x), 0);
  const map: Record<string, number> = { od: 1, qd: 1, hs: 1, 'once daily': 1, 'once a day': 1, daily: 1, bd: 2, bid: 2, 'twice daily': 2, 'twice a day': 2,
    tds: 3, tid: 3, 'thrice daily': 3, 'three times a day': 3, qid: 4, 'four times a day': 4, qds: 4 };
  if (map[f] != null) return map[f];
  const q = /every\s+(\d+)\s*(?:h|hr|hrs|hours?)/.exec(f) ?? /q(\d+)h/.exec(f);
  if (q && Number(q[1]) > 0) return 24 / Number(q[1]);
  const t = /(\d+)\s*times?\s*(?:a|per)\s*day/.exec(f);
  if (t) return Number(t[1]);
  return null;
}

const UNIT: Record<string, number> = { mcg: 0.001, mg: 1, g: 1000 };
/** Dose amount in the formulary's unit, from "500 mg", "0.5 g", "2 tabs" × "250 mg" strength, or "5 ml". Null when unreadable. */
export function doseAmount(dose: string, strength: string | null, unit: string): number | null {
  const d = dose.trim().toLowerCase();
  const direct = /^(\d+(?:\.\d+)?)\s*(mcg|mg|g|ml|units?|iu)\b/.exec(d);
  const conv = (n: number, u: string) => {
    u = u.replace(/s$/, '').replace('iu', 'unit');
    const target = unit === 'units' ? 'unit' : unit;
    if (u === target) return n;
    if (UNIT[u] != null && UNIT[target] != null) return (n * UNIT[u]) / UNIT[target];
    return null;
  };
  if (direct) return conv(Number(direct[1]), direct[2]);
  const count = /^(\d+(?:\.\d+)?|½|half)\s*(?:tab|tabs|tablet|tablets|cap|caps|capsule|capsules)?$/.exec(d);
  const st = strength ? /^(\d+(?:\.\d+)?)\s*(mcg|mg|g)\b/.exec(strength.trim().toLowerCase()) : null;
  if (count && st) {
    const n = count[1] === '½' || count[1] === 'half' ? 0.5 : Number(count[1]);
    return conv(n * Number(st[1]), st[2]);
  }
  return null;
}

function matchItem(line: Line, items: FormItem[]): FormItem | null {
  const name = norm(line.drug_name);
  const cands = items.filter((i) => i.status === 'active' && [i.generic_name, ...i.brand_names].some((n) => { const x = norm(n); return x && (name === x || name.startsWith(`${x} `)); }));
  if (cands.length <= 1) return cands[0] ?? null;
  const st = norm(line.strength ?? '');
  return cands.find((c) => norm(c.strength ?? '') === st) ?? cands[0];
}

type Ctx = { lines: Line[]; patientId: string; excludeRxId?: string };

/** Runs every check and returns findings; does not throw. */
export async function checkLines(tx: Tx, tenant: Tenant, ctx: Ctx): Promise<Finding[]> {
  const out: Finding[] = [];
  if (!ctx.lines.length) return out;
  const items = await tx.many<FormItem>(`SELECT * FROM formulary_item WHERE status = 'active'`);
  const rules = await tx.many<{ a_kind: string; a_value: string; b_kind: string; b_value: string; severity: string; effect: string; management: string | null; source: string }>(
    `SELECT * FROM interaction_rule WHERE active`);
  const pt = await tx.one<{ age: number | null }>(
    `SELECT CASE WHEN birth_date IS NOT NULL THEN extract(year FROM age(current_date, birth_date))::int
                 WHEN estimated_age_years IS NOT NULL THEN estimated_age_years + extract(year FROM age(current_date, coalesce(age_as_of, current_date)))::int END AS age
       FROM patient WHERE id = $1`, [ctx.patientId]);
  const w = await tx.maybe<{ weight_kg: string; measured_at: Date }>(
    `SELECT weight_kg, measured_at FROM vitals WHERE patient_id = $1 AND weight_kg IS NOT NULL AND NOT entered_in_error ORDER BY measured_at DESC LIMIT 1`, [ctx.patientId]);
  const weight = w && (pt.age == null || pt.age >= 18 || Date.now() - +new Date(w.measured_at) < 30 * 86400_000) ? Number(w.weight_kg) : null;
  const allergies = await tx.many<{ substance: string }>(`SELECT substance FROM allergy WHERE patient_id = $1 AND status = 'active'`, [ctx.patientId]);

  if (!items.length) out.push({ severity: 'info', kind: 'no_formulary', message: 'No formulary set up: dose limits are not being checked.' });
  if (!rules.length) out.push({ severity: 'info', kind: 'no_interactions', message: 'No interaction rules loaded: drug–drug interactions are not being checked.' });

  const matched = ctx.lines.map((l) => ({ line: l, item: matchItem(l, items) }));
  for (const { line, item } of matched) {
    const label = line.drug_name;
    // Allergy: by name (as before) and by drug class.
    for (const a of allergies) {
      const al = norm(a.substance);
      const byName = norm(label).includes(al) || al.includes(norm(label).split(' ')[0]) || (item && (norm(item.generic_name) === al || item.brand_names.some((b) => norm(b) === al)));
      const byClass = item?.classes.some((c) => norm(c) === al);
      if (byName || byClass) out.push({ severity: 'block', kind: 'allergy', drugs: [label], message: `Possible allergy match: ${label} — patient is allergic to “${a.substance}”${byClass && !byName ? ' (same drug class)' : ''}.` });
    }
    if (!item) {
      if (items.length && tenant.settings.formularyMode !== 'off') out.push({ severity: tenant.settings.formularyMode === 'enforce' ? 'block' : 'warn', kind: 'off_formulary', drugs: [label], message: `${label} is not in the clinic formulary${tenant.settings.formularyMode === 'enforce' ? ' (needs a reason)' : ''}.` });
      continue;
    }
    const amount = doseAmount(line.dose, line.strength ?? item.strength, item.dose_unit);
    const perDay = line.prn ? null : timesPerDay(line.frequency);
    const u = item.dose_unit;
    const needsWeight = item.per_kg_max != null && (item.weight_required_under_years == null || (pt.age != null && pt.age < item.weight_required_under_years));
    if (amount == null && (item.max_single_dose || item.max_daily_dose || needsWeight)) {
      out.push({ severity: 'warn', kind: 'dose_unreadable', drugs: [label], message: `${label}: write the dose as an amount (e.g. “500 mg”, or “1 tab” with the strength) so it can be checked.` });
    }
    if (amount != null && item.max_single_dose && amount > Number(item.max_single_dose))
      out.push({ severity: 'block', kind: 'max_single', drugs: [label], source: item.source, message: `${label}: ${amount} ${u} per dose is above the formulary maximum of ${Number(item.max_single_dose)} ${u}.` });
    if (amount != null && perDay != null && item.max_daily_dose && amount * perDay > Number(item.max_daily_dose))
      out.push({ severity: 'block', kind: 'max_daily', drugs: [label], source: item.source, message: `${label}: ${+(amount * perDay).toFixed(2)} ${u} per day is above the formulary maximum of ${Number(item.max_daily_dose)} ${u}/day.` });
    if (perDay == null && !line.prn && (item.max_daily_dose)) out.push({ severity: 'info', kind: 'frequency_unreadable', drugs: [label], message: `${label}: frequency “${line.frequency}” not recognised, so the daily maximum was not checked.` });
    if (needsWeight) {
      if (weight == null) out.push({ severity: 'block', kind: 'weight_missing', drugs: [label], message: `${label} is dosed by weight${pt.age != null && pt.age < 18 ? ' for children' : ''}: record a current weight (vitals) first.` });
      else if (amount != null) {
        const perKg = amount / weight;
        const lo = item.per_kg_min != null ? Number(item.per_kg_min) : null; const hi = Number(item.per_kg_max);
        if (perKg > hi * 1.0001) out.push({ severity: 'block', kind: 'per_kg_high', drugs: [label], source: item.source, message: `${label}: ${+perKg.toFixed(2)} ${u}/kg (weight ${weight} kg) is above the ${hi} ${u}/kg maximum.` });
        else if (lo != null && perKg < lo * 0.9999) out.push({ severity: 'warn', kind: 'per_kg_low', drugs: [label], source: item.source, message: `${label}: ${+perKg.toFixed(2)} ${u}/kg (weight ${weight} kg) is below the usual ${lo} ${u}/kg.` });
      }
    }
  }

  // Interactions within this prescription and with medicines from other recent signed prescriptions / active ward orders.
  const recent = await tx.many<{ drug_name: string }>(
    `SELECT DISTINCT l.drug_name FROM rx_line l JOIN prescription p ON p.id = l.prescription_id
      WHERE p.patient_id = $1 AND p.status = 'signed' AND p.signed_at > now() - interval '30 days' AND ($2::uuid IS NULL OR p.id <> $2)
     UNION SELECT DISTINCT drug_name FROM med_order WHERE patient_id = $1 AND status = 'active'`, [ctx.patientId, ctx.excludeRxId ?? null]);
  const entries = [
    ...matched.map((m) => ({ label: m.line.drug_name, item: m.item, current: false })),
    ...recent.map((r) => ({ label: r.drug_name, item: matchItem({ drug_name: r.drug_name, strength: null, dose: '', frequency: '', prn: false }, items), current: true })),
  ];
  const keys = (e: (typeof entries)[number]) => ({ generic: new Set([norm(e.item?.generic_name ?? e.label)]), class: new Set((e.item?.classes ?? []).map(norm)) });
  const hit = (k: ReturnType<typeof keys>, kind: string, value: string) => (kind === 'generic' ? k.generic : k.class).has(norm(value));
  const seen = new Set<string>();
  for (let i = 0; i < entries.length; i++) for (let j = i + 1; j < entries.length; j++) {
    if (entries[i].current && entries[j].current) continue;
    const a = keys(entries[i]); const b = keys(entries[j]);
    for (const r of rules) {
      if (!((hit(a, r.a_kind, r.a_value) && hit(b, r.b_kind, r.b_value)) || (hit(b, r.a_kind, r.a_value) && hit(a, r.b_kind, r.b_value)))) continue;
      const key = [entries[i].label, entries[j].label, r.effect].join('|');
      if (seen.has(key)) continue; seen.add(key);
      const sev: Severity = r.severity === 'contraindicated' || r.severity === 'major' ? 'block' : r.severity === 'moderate' ? 'warn' : 'info';
      const other = entries[j].current ? `${entries[j].label} (already prescribed)` : entries[j].label;
      out.push({ severity: sev, kind: `interaction_${r.severity}`, drugs: [entries[i].label, entries[j].label], source: r.source,
        message: `${r.severity[0].toUpperCase()}${r.severity.slice(1)} interaction: ${entries[i].label} + ${other} — ${r.effect}${r.management ? ` Management: ${r.management}` : ''}` });
    }
  }
  return out;
}

export async function checkDraft(actor: Actor, tenant: Tenant, rxId: string) {
  authorize(actor, 'clinical.read');
  return withTenant(tenant.id, async (tx) => {
    const rx = await tx.maybe<{ patient_id: string }>(`SELECT patient_id FROM prescription WHERE id = $1`, [rxId]);
    if (!rx) throw notFound('Prescription');
    const lines = await tx.many<Line>(`SELECT drug_name, strength, dose, frequency, prn FROM rx_line WHERE prescription_id = $1 ORDER BY sort_order`, [rxId]);
    return checkLines(tx, tenant, { lines, patientId: rx.patient_id, excludeRxId: rxId });
  });
}

// ------------------------------------------------------------------ formulary and rules management
export const formularyInput = z.object({
  id: z.uuid().optional(), genericName: z.string().trim().min(2).max(200), brandNames: z.array(z.string().trim().min(1)).default([]),
  classes: z.array(z.string().trim().min(2)).default([]), strength: z.string().max(60).optional(), form: z.string().max(60).optional(), route: z.string().max(40).optional(),
  doseUnit: z.enum(['mg', 'mcg', 'g', 'ml', 'units']).default('mg'),
  perKgMin: z.number().positive().optional(), perKgMax: z.number().positive().optional(),
  maxSingleDose: z.number().positive().optional(), maxDailyDose: z.number().positive().optional(),
  weightRequiredUnderYears: z.number().int().min(0).max(18).optional(), schedule: z.string().max(10).optional(),
  source: z.string().trim().min(3, 'Say where the limits come from').max(300), notes: z.string().max(1000).optional(), active: z.boolean().default(true),
});

export async function upsertFormularyItem(actor: Actor, tenant: Tenant, input: z.input<typeof formularyInput>) {
  authorize(actor, 'formulary.manage');
  const p = formularyInput.parse(input);
  if (p.perKgMin && p.perKgMax && p.perKgMax < p.perKgMin) throw invalid('Per-kg maximum is below the minimum');
  return withTenant(tenant.id, async (tx) => {
    const v = [p.genericName, p.brandNames, p.classes.map((c) => c.toLowerCase()), p.strength ?? null, p.form ?? null, p.route ?? null, p.doseUnit, p.perKgMin ?? null, p.perKgMax ?? null,
      p.maxSingleDose ?? null, p.maxDailyDose ?? null, p.weightRequiredUnderYears ?? null, p.schedule ?? null, p.source, p.notes ?? null, p.active ? 'active' : 'inactive', staffId(actor)];
    const r = p.id
      ? await tx.one<{ id: string }>(`UPDATE formulary_item SET generic_name=$2, brand_names=$3, classes=$4, strength=$5, form=$6, route=$7, dose_unit=$8, per_kg_min=$9, per_kg_max=$10,
           max_single_dose=$11, max_daily_dose=$12, weight_required_under_years=$13, schedule=$14, source=$15, notes=$16, status=$17, reviewed_by=$18, reviewed_at=now(), updated_at=now() WHERE id=$1 RETURNING id`, [p.id, ...v])
      : await tx.one<{ id: string }>(`INSERT INTO formulary_item (tenant_id, generic_name, brand_names, classes, strength, form, route, dose_unit, per_kg_min, per_kg_max, max_single_dose,
           max_daily_dose, weight_required_under_years, schedule, source, notes, status, reviewed_by, reviewed_at) VALUES (app_tenant_id(), $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17, now()) RETURNING id`, v);
    await audit(tx, actor, p.id ? 'formulary.updated' : 'formulary.added', 'formulary_item', r.id, { data: { generic: p.genericName, source: p.source } });
    return r.id;
  });
}

export async function listFormulary(actor: Actor, tenant: Tenant) {
  authorize(actor, 'clinical.read');
  return withTenant(tenant.id, (tx) => tx.many<FormItem & { form: string | null; route: string | null; schedule: string | null; notes: string | null; reviewed_at: Date | null; reviewer: string | null }>(
    `SELECT f.*, s.full_name AS reviewer FROM formulary_item f LEFT JOIN staff s ON s.id = f.reviewed_by ORDER BY f.status, lower(f.generic_name), f.strength`));
}

export const ruleInput = z.object({
  a: z.string().trim().min(2), b: z.string().trim().min(2), severity: z.enum(['contraindicated', 'major', 'moderate', 'minor']),
  effect: z.string().trim().min(3).max(500), management: z.string().max(500).optional(), source: z.string().trim().min(3).max(300),
});
/** "class:nsaid" or a generic name. */
const parseSide = (s: string) => { const m = /^class:\s*(.+)$/i.exec(s.trim()); return m ? { kind: 'class', value: m[1].trim().toLowerCase() } : { kind: 'generic', value: s.trim().toLowerCase() }; };

export async function addInteractionRule(actor: Actor, tenant: Tenant, input: z.input<typeof ruleInput>) {
  authorize(actor, 'formulary.manage');
  const p = ruleInput.parse(input);
  return withTenant(tenant.id, async (tx) => {
    const a = parseSide(p.a); const b = parseSide(p.b);
    const r = await tx.one<{ id: string }>(
      `INSERT INTO interaction_rule (tenant_id, a_kind, a_value, b_kind, b_value, severity, effect, management, source, created_by) VALUES (app_tenant_id(), $1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT (tenant_id, a_kind, lower(a_value), b_kind, lower(b_value)) DO UPDATE SET severity = EXCLUDED.severity, effect = EXCLUDED.effect, management = EXCLUDED.management, source = EXCLUDED.source, active = true
       RETURNING id`, [a.kind, a.value, b.kind, b.value, p.severity, p.effect, p.management ?? null, p.source, staffId(actor)]);
    await audit(tx, actor, 'interaction_rule.saved', 'interaction_rule', r.id, { data: { a: p.a, b: p.b, severity: p.severity } });
    return r.id;
  });
}

/** CSV import: a,b,severity,effect,management,source (header row required). Returns counts and per-row errors; all-or-nothing. */
export async function importInteractionCsv(actor: Actor, tenant: Tenant, csv: string) {
  authorize(actor, 'formulary.manage');
  const rows = parseCsv(csv);
  if (rows.length < 2) throw invalid('The file has no rows');
  const head = rows[0].map((h) => h.trim().toLowerCase());
  const idx = (k: string) => head.indexOf(k);
  for (const k of ['a', 'b', 'severity', 'effect', 'source']) if (idx(k) < 0) throw invalid(`Missing column “${k}”. Expected: a,b,severity,effect,management,source`);
  const errors: string[] = [];
  const parsed = rows.slice(1).filter((r) => r.some((c) => c.trim())).map((r, n) => {
    const v = { a: r[idx('a')] ?? '', b: r[idx('b')] ?? '', severity: (r[idx('severity')] ?? '').trim().toLowerCase(), effect: r[idx('effect')] ?? '',
      management: idx('management') >= 0 ? r[idx('management')] || undefined : undefined, source: r[idx('source')] ?? '' };
    const ok = ruleInput.safeParse(v);
    if (!ok.success) errors.push(`Row ${n + 2}: ${ok.error.issues.map((i) => `${i.path.join('.')} ${i.message}`).join('; ')}`);
    return ok.success ? ok.data : null;
  });
  if (errors.length) throw rule(`Nothing imported. Fix these rows: ${errors.slice(0, 10).join(' · ')}${errors.length > 10 ? ` … and ${errors.length - 10} more` : ''}`);
  for (const p of parsed) await addInteractionRule(actor, tenant, p!);
  return { imported: parsed.length };
}

export async function listInteractionRules(actor: Actor, tenant: Tenant) {
  authorize(actor, 'clinical.read');
  return withTenant(tenant.id, (tx) => tx.many<{ id: string; a_kind: string; a_value: string; b_kind: string; b_value: string; severity: string; effect: string; management: string | null; source: string; active: boolean }>(
    `SELECT * FROM interaction_rule ORDER BY active DESC, CASE severity WHEN 'contraindicated' THEN 0 WHEN 'major' THEN 1 WHEN 'moderate' THEN 2 ELSE 3 END, a_value, b_value`));
}

export async function setRuleActive(actor: Actor, tenant: Tenant, id: string, active: boolean) {
  authorize(actor, 'formulary.manage');
  await withTenant(tenant.id, async (tx) => {
    await tx.exec(`UPDATE interaction_rule SET active = $2 WHERE id = $1`, [id, active]);
    await audit(tx, actor, active ? 'interaction_rule.enabled' : 'interaction_rule.disabled', 'interaction_rule', id);
  });
}

function parseCsv(text: string): string[][] {
  const out: string[][] = []; let row: string[] = []; let cell = ''; let q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) { if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++; } else if (ch === '"') q = false; else cell += ch; continue; }
    if (ch === '"') q = true; else if (ch === ',') { row.push(cell); cell = ''; } else if (ch === '\n' || ch === '\r') { if (ch === '\r' && text[i + 1] === '\n') i++; row.push(cell); out.push(row); row = []; cell = ''; } else cell += ch;
  }
  if (cell || row.length) { row.push(cell); out.push(row); }
  return out;
}
