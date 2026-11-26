import Link from 'next/link';
import { requireStaff } from '@/lib/session';
import { can } from '@/lib/rbac';
import * as safety from '@/domain/safety';
import { fmtDate, label } from '@/lib/format';
import { Empty, Flash, PageHead } from '@/components/ui';
import { formularyAction } from '../safety-actions';

export default async function Formulary({ params, searchParams }: { params: Promise<{ tenant: string }>; searchParams: Promise<{ tab?: string; edit?: string; ok?: string; err?: string }> }) {
  const { tenant: slug } = await params;
  const sp = await searchParams;
  const { tenant, actor, session } = await requireStaff(slug, 'clinical.read');
  const tab = sp.tab === 'interactions' ? 'interactions' : 'formulary';
  const manage = can(session.role, 'formulary.manage');
  const items = tab === 'formulary' ? await safety.listFormulary(actor, tenant) : [];
  const rules = tab === 'interactions' ? await safety.listInteractionRules(actor, tenant) : [];
  const edit = sp.edit ? items.find((i) => i.id === sp.edit) : undefined;
  const back = `/${slug}/formulary?tab=${tab}`;
  const num = (v: string | null) => (v == null ? '' : String(Number(v)));
  return (
    <>
      <PageHead title="Formulary & prescribing safety" sub="Dose limits, weight-based dosing and drug-interaction rules used when doctors sign prescriptions." />
      <Flash ok={sp.ok} err={sp.err} />
      <p className="flash warn">This data is maintained by your clinic. Nothing is pre-loaded: enter limits from your pharmacy committee or a licensed reference, and record that source on every entry. Checks are only as complete as this data.</p>
      <div className="tabs"><Link href={`/${slug}/formulary`} className={tab === 'formulary' ? 'on' : ''}>Formulary</Link><Link href={`/${slug}/formulary?tab=interactions`} className={tab === 'interactions' ? 'on' : ''}>Interaction rules</Link></div>
      {tab === 'formulary' ? (
        <>
          <div className="card">{items.length === 0 ? <Empty>No formulary entries yet.</Empty> : (
            <table className="table small"><thead><tr><th>Medicine</th><th>Classes</th><th>Per dose</th><th>Per day</th><th>Per kg</th><th>Source</th><th /></tr></thead>
              <tbody>{items.map((i) => <tr key={i.id} className={i.status === 'active' ? '' : 'dim'}>
                <td><b>{i.generic_name}</b> {i.strength} {i.form}{i.brand_names.length ? <><br /><small>{i.brand_names.join(', ')}</small></> : null}{i.schedule ? <span className="pill">Sch {i.schedule}</span> : null}</td>
                <td>{i.classes.join(', ')}</td><td>{i.max_single_dose ? `≤ ${num(i.max_single_dose)} ${i.dose_unit}` : '—'}</td><td>{i.max_daily_dose ? `≤ ${num(i.max_daily_dose)} ${i.dose_unit}` : '—'}</td>
                <td>{i.per_kg_max ? `${i.per_kg_min ? num(i.per_kg_min) + '–' : '≤ '}${num(i.per_kg_max)} ${i.dose_unit}/kg${i.weight_required_under_years != null ? ` (weight needed under ${i.weight_required_under_years} y)` : ''}` : '—'}</td>
                <td><small>{i.source}{i.reviewer ? ` · ${i.reviewer}, ${fmtDate(i.reviewed_at, tenant)}` : ''}</small></td>
                <td>{manage && <Link className="btn small" href={`/${slug}/formulary?edit=${i.id}`}>Edit</Link>}</td></tr>)}</tbody></table>)}</div>
          {manage && (
            <form action={formularyAction.bind(null, slug)} className="card form-grid"><input type="hidden" name="op" value="item" /><input type="hidden" name="back" value={back} />{edit && <input type="hidden" name="id" value={edit.id} />}
              <h2 className="span2">{edit ? `Edit ${edit.generic_name}` : 'Add a medicine'}</h2>
              <label>Generic name<input name="genericName" required defaultValue={edit?.generic_name} /></label>
              <label>Brand names (comma-separated)<input name="brandNames" defaultValue={edit?.brand_names.join(', ')} /></label>
              <label>Drug classes (comma-separated, used for class allergies/interactions)<input name="classes" defaultValue={edit?.classes.join(', ')} placeholder="e.g. penicillin, beta-lactam" /></label>
              <label>Strength<input name="strength" defaultValue={edit?.strength ?? ''} placeholder="500 mg" /></label>
              <label>Form<input name="form" defaultValue={edit?.form ?? ''} /></label><label>Route<input name="route" defaultValue={edit?.route ?? ''} /></label>
              <label>Dose unit<select name="doseUnit" defaultValue={edit?.dose_unit ?? 'mg'}>{['mg', 'mcg', 'g', 'ml', 'units'].map((u) => <option key={u}>{u}</option>)}</select></label>
              <label>Max single dose<input name="maxSingleDose" inputMode="decimal" defaultValue={num(edit?.max_single_dose ?? null)} /></label>
              <label>Max per day<input name="maxDailyDose" inputMode="decimal" defaultValue={num(edit?.max_daily_dose ?? null)} /></label>
              <label>Per-kg dose min (per dose)<input name="perKgMin" inputMode="decimal" defaultValue={num(edit?.per_kg_min ?? null)} /></label>
              <label>Per-kg dose max (per dose)<input name="perKgMax" inputMode="decimal" defaultValue={num(edit?.per_kg_max ?? null)} /></label>
              <label>Require weight under age (years; blank = always)<input name="weightUnder" type="number" min={0} max={18} defaultValue={edit?.weight_required_under_years ?? ''} /></label>
              <label>Schedule (H / H1 / X / OTC)<input name="schedule" defaultValue={edit?.schedule ?? ''} /></label>
              <label className="span2">Source of these limits (required)<input name="source" required minLength={3} defaultValue={edit?.source} placeholder="e.g. Pharmacy & therapeutics committee, 12 Nov 2026" /></label>
              <label className="span2">Notes<input name="notes" defaultValue={edit?.notes ?? ''} /></label>
              {edit && <label className="check"><input type="checkbox" name="active" value="off" defaultChecked={edit.status !== 'active'} /> Inactive</label>}
              <div className="span2"><button className="btn primary">Save</button></div>
            </form>)}
          {can(session.role, 'settings.manage') && (
            <form action={formularyAction.bind(null, slug)} className="card inline-form"><input type="hidden" name="op" value="mode" /><input type="hidden" name="back" value={back} />
              <b>Medicines not in the formulary:</b>
              <select name="mode" defaultValue={tenant.settings.formularyMode}><option value="off">Allow silently</option><option value="warn">Warn the doctor</option><option value="enforce">Require a reason to sign</option></select>
              <button className="btn small">Save</button></form>)}
        </>
      ) : (
        <>
          <div className="card">{rules.length === 0 ? <Empty>No interaction rules. Import a CSV from a licensed source or your pharmacist’s list.</Empty> : (
            <table className="table small"><thead><tr><th>Drug / class A</th><th>Drug / class B</th><th>Severity</th><th>Effect · management</th><th>Source</th><th /></tr></thead>
              <tbody>{rules.map((r) => <tr key={r.id} className={r.active ? '' : 'dim'}><td>{r.a_kind === 'class' ? `class: ${r.a_value}` : r.a_value}</td><td>{r.b_kind === 'class' ? `class: ${r.b_value}` : r.b_value}</td>
                <td>{label(r.severity)}</td><td>{r.effect}{r.management ? <><br /><small>{r.management}</small></> : null}</td><td><small>{r.source}</small></td>
                <td>{manage && <form action={formularyAction.bind(null, slug)}><input type="hidden" name="op" value="ruleActive" /><input type="hidden" name="id" value={r.id} /><input type="hidden" name="active" value={r.active ? '0' : '1'} /><input type="hidden" name="back" value={back} /><button className="btn small">{r.active ? 'Disable' : 'Enable'}</button></form>}</td></tr>)}</tbody></table>)}</div>
          {manage && <>
            <form action={formularyAction.bind(null, slug)} className="card inline-form wrap"><input type="hidden" name="op" value="import" /><input type="hidden" name="back" value={back} />
              <b>Import CSV</b><input type="file" name="file" accept=".csv,text/csv" required /><button className="btn">Import</button>
              <small className="muted">Columns: a,b,severity,effect,management,source. Use “class:nsaid” for a drug class. Severity: contraindicated, major, moderate or minor. The whole file is rejected if any row is invalid.</small></form>
            <form action={formularyAction.bind(null, slug)} className="card form-grid"><input type="hidden" name="op" value="rule" /><input type="hidden" name="back" value={back} />
              <h2 className="span2">Add a rule</h2>
              <label>Drug or class A<input name="a" required placeholder="generic name, or class:xyz" /></label><label>Drug or class B<input name="b" required /></label>
              <label>Severity<select name="severity"><option value="contraindicated">Contraindicated (blocks signing)</option><option value="major">Major (blocks signing)</option><option value="moderate">Moderate (warning)</option><option value="minor">Minor (note)</option></select></label>
              <label>Source (required)<input name="source" required minLength={3} /></label>
              <label className="span2">Effect<input name="effect" required minLength={3} /></label><label className="span2">Management<input name="management" /></label>
              <div className="span2"><button className="btn primary">Save rule</button></div></form>
          </>}
        </>
      )}
    </>
  );
}
