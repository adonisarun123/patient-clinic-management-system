'use client';
import { useState } from 'react';

export type Line = { drugName: string; strength: string; form: string; dose: string; route: string; frequency: string; duration: string; quantity: string; prn: boolean; prnIndication: string; instructions: string };
const blank: Line = { drugName: '', strength: '', form: '', dose: '', route: 'oral', frequency: '', duration: '', quantity: '', prn: false, prnIndication: '', instructions: '' };
const FREQ = ['OD (once daily)', 'BD (twice daily)', 'TDS (three times daily)', 'QID (four times daily)', 'HS (at bedtime)', 'SOS (when required)', 'Weekly'];

/** Prescription lines editor. Serialises to a hidden field; the server validates every line again before saving or signing. */
export function RxEditor({ initial }: { initial: Line[] }) {
  const [lines, setLines] = useState<Line[]>(initial.length ? initial : [{ ...blank }]);
  const set = (i: number, k: keyof Line, v: string | boolean) => setLines((ls) => ls.map((l, j) => (j === i ? { ...l, [k]: v } : l)));
  return (
    <div className="rx">
      <input type="hidden" name="lines" value={JSON.stringify(lines)} />
      <datalist id="freq">{FREQ.map((f) => <option key={f} value={f} />)}</datalist>
      {lines.map((l, i) => (
        <fieldset key={i} className="rx-line">
          <legend>Medicine {i + 1}</legend>
          <div className="rx-grid">
            <label className="w2">Medicine (generic name preferred)<input value={l.drugName} onChange={(e) => set(i, 'drugName', e.target.value)} placeholder="e.g. Paracetamol" /></label>
            <label>Strength<input value={l.strength} onChange={(e) => set(i, 'strength', e.target.value)} placeholder="650 mg" /></label>
            <label>Form<input value={l.form} onChange={(e) => set(i, 'form', e.target.value)} placeholder="Tablet" /></label>
            <label>Dose<input value={l.dose} onChange={(e) => set(i, 'dose', e.target.value)} placeholder="1 tablet" /></label>
            <label>Route<input value={l.route} onChange={(e) => set(i, 'route', e.target.value)} /></label>
            <label>Frequency<input list="freq" value={l.frequency} onChange={(e) => set(i, 'frequency', e.target.value)} /></label>
            <label>Duration<input value={l.duration} onChange={(e) => set(i, 'duration', e.target.value)} placeholder="5 days" /></label>
            <label>Quantity<input value={l.quantity} onChange={(e) => set(i, 'quantity', e.target.value)} placeholder="15" /></label>
            <label className="check"><input type="checkbox" checked={l.prn} onChange={(e) => set(i, 'prn', e.target.checked)} /> Only when needed</label>
            {l.prn && <label className="w2">When needed for<input value={l.prnIndication} onChange={(e) => set(i, 'prnIndication', e.target.value)} placeholder="fever above 100°F" /></label>}
            <label className="w3">Instructions<input value={l.instructions} onChange={(e) => set(i, 'instructions', e.target.value)} placeholder="After food" /></label>
          </div>
          {lines.length > 1 && <button type="button" className="link danger" onClick={() => setLines((ls) => ls.filter((_, j) => j !== i))}>Remove</button>}
        </fieldset>
      ))}
      <button type="button" className="btn small" onClick={() => setLines((ls) => [...ls, { ...blank }])}>+ Add medicine</button>
    </div>
  );
}
