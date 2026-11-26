// OP-004: comparison keys. Source strings are preserved separately.

export function normalizeName(name: string): string {
  return name
    .normalize('NFKC')
    .toLocaleLowerCase('en-IN')
    .replace(/[.,'’`"()\-_/]+/g, ' ')
    .replace(/\b(mr|mrs|ms|miss|dr|master|baby|smt|shri|sri)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Country-aware (default India) normalisation to E.164. Returns null when not a plausible number. */
export function normalizePhone(raw: string | null | undefined, defaultCountry = '91'): string | null {
  if (!raw) return null;
  let d = raw.replace(/[^\d+]/g, '');
  if (d.startsWith('+')) d = d.slice(1);
  else if (d.startsWith('00')) d = d.slice(2);
  else if (d.startsWith('0') && d.length === 11) d = defaultCountry + d.slice(1);
  else if (d.length === 10) d = defaultCountry + d;
  if (!/^\d{8,15}$/.test(d)) return null;
  if (d.startsWith('91') && !/^91[6-9]\d{9}$/.test(d)) return null; // Indian mobile
  return `+${d}`;
}

export function maskPhone(e164: string | null): string {
  if (!e164) return '—';
  return e164.slice(0, 3) + ' ' + '•'.repeat(Math.max(0, e164.length - 7)) + e164.slice(-4);
}

/** Age label that respects stated precision (DM-003): never invent a day/month. */
export function ageLabel(p: {
  birth_date: string | Date | null; birth_precision: string; estimated_age_years: number | null; age_as_of: string | Date | null;
}, today = new Date()): string {
  if (p.birth_precision === 'declined') return 'Age declined';
  if (p.birth_date && ['day', 'month', 'year'].includes(p.birth_precision)) {
    const b = new Date(p.birth_date);
    let years = today.getFullYear() - b.getFullYear();
    const beforeBirthday = today.getMonth() < b.getMonth() || (today.getMonth() === b.getMonth() && today.getDate() < b.getDate());
    if (p.birth_precision === 'day' && beforeBirthday) years -= 1;
    if (years < 2 && p.birth_precision === 'day') {
      const months = (today.getFullYear() - b.getFullYear()) * 12 + today.getMonth() - b.getMonth() - (today.getDate() < b.getDate() ? 1 : 0);
      return `${Math.max(0, months)} mo`;
    }
    return p.birth_precision === 'day' ? `${years} y` : `~${years} y`;
  }
  if (p.birth_precision === 'estimated' && p.estimated_age_years != null && p.age_as_of) {
    const asOf = new Date(p.age_as_of);
    const years = p.estimated_age_years + Math.floor((today.getTime() - asOf.getTime()) / (365.25 * 86400000));
    return `~${years} y (est.)`;
  }
  return 'Age unknown';
}

export function birthLabel(birth_date: string | Date | null, precision: string): string {
  if (!birth_date) return precision === 'declined' ? 'Declined' : 'Unknown';
  const d = new Date(birth_date);
  const iso = d.toISOString().slice(0, 10);
  if (precision === 'year') return iso.slice(0, 4);
  if (precision === 'month') return iso.slice(0, 7);
  return iso;
}
