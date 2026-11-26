// DM-002: integer minor units only.
export function lineTax(netPaise: bigint | number, rateBp: number): number {
  // Round half up at line level; the rounded value is persisted at issue.
  const n = BigInt(netPaise);
  return Number((n * BigInt(rateBp) + 5000n) / 10000n);
}

export function formatMoney(paise: number | string | bigint, currency = 'INR', locale = 'en-IN'): string {
  const v = Number(paise) / 100;
  return new Intl.NumberFormat(locale, { style: 'currency', currency }).format(v);
}

/** Parses "1,250.50" or "1250" (major units) to minor units without floating point drift. */
export function toPaise(input: string | number): number {
  const s = String(input).replace(/[,\s₹]/g, '').trim();
  if (!/^\d+(\.\d{1,2})?$/.test(s)) throw new Error(`Invalid amount: ${input}`);
  const [r, f = ''] = s.split('.');
  return Number(r) * 100 + Number((f + '00').slice(0, 2));
}

/** Indian financial year label (April–March), e.g. 2026-27. */
export function financialYear(isoDate: string): string {
  const [y, m] = isoDate.split('-').map(Number);
  const start = m >= 4 ? y : y - 1;
  return `${start}-${String((start + 1) % 100).padStart(2, '0')}`;
}
