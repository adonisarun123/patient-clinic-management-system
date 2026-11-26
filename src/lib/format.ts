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
