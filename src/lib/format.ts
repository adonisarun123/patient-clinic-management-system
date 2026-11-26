import type { Tenant } from '@/domain/tenants';

export function fmtTime(d: Date | string | null | undefined, t: Pick<Tenant, 'timezone' | 'locale'>) {
  if (!d) return '—';
  return new Date(d).toLocaleTimeString(t.locale, { hour: 'numeric', minute: '2-digit', timeZone: t.timezone });
}
export function fmtDate(d: Date | string | null | undefined, t: Pick<Tenant, 'timezone' | 'locale'>, opts: Intl.DateTimeFormatOptions = { day: 'numeric', month: 'short', year: 'numeric' }) {
  if (!d) return '—';
  const v = typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d) ? new Date(`${d}T12:00:00Z`) : new Date(d);
  return v.toLocaleDateString(t.locale, { ...opts, timeZone: typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d) ? 'UTC' : t.timezone });
}
export function fmtDateTime(d: Date | string | null | undefined, t: Pick<Tenant, 'timezone' | 'locale'>) {
  if (!d) return '—';
  return `${fmtDate(d, t, { day: 'numeric', month: 'short' })}, ${fmtTime(d, t)}`;
}
export function money(paise: number | string | null | undefined, t: Pick<Tenant, 'currency' | 'locale'>) {
  return new Intl.NumberFormat(t.locale, { style: 'currency', currency: t.currency }).format(Number(paise ?? 0) / 100);
}
export const today = (t: Pick<Tenant, 'timezone'>) => new Date().toLocaleDateString('en-CA', { timeZone: t.timezone });
export const label = (s: string) => s.replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase());

/** Converts a clinic-local "YYYY-MM-DDTHH:MM" (from <input type="datetime-local">) to an ISO instant with offset. */
export function localToIso(local: string, timeZone: string) {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(local);
  if (!m) throw new Error('Invalid local date-time');
  const asUtc = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]);
  const offsetAt = (t: number) => {
    const p = new Intl.DateTimeFormat('en-US', { timeZone, timeZoneName: 'longOffset' }).formatToParts(new Date(t)).find((x) => x.type === 'timeZoneName')?.value ?? 'GMT';
    const o = /GMT([+-])(\d{2}):?(\d{2})?/.exec(p);
    return o ? (o[1] === '-' ? -1 : 1) * (Number(o[2]) * 60 + Number(o[3] ?? 0)) * 60_000 : 0;
  };
  let t = asUtc - offsetAt(asUtc);
  t = asUtc - offsetAt(t); // second pass settles DST edges
  return new Date(t).toISOString();
}

/** The reverse: an instant shown as "YYYY-MM-DDTHH:MM" in the clinic's zone (for prefilled datetime-local inputs). */
export function isoToLocalInput(d: Date | string, timeZone: string) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
    .formatToParts(new Date(d)).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`;
}
