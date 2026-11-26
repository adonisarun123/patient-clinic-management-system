import 'server-only';
import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { requireStaff } from '@/lib/session';
import { AppError, toAppError } from '@/lib/errors';

import { kickOutbox } from './outbox';
export const s = (f: FormData, k: string) => { const v = f.get(k); return typeof v === 'string' ? v.trim() : ''; };
export const opt = (f: FormData, k: string) => s(f, k) || undefined;
export const num = (f: FormData, k: string) => (s(f, k) === '' ? undefined : Number(s(f, k)));
export const localDay = (iso: string, tz: string) => new Date(iso).toLocaleDateString('en-CA', { timeZone: tz });
const withMsg = (path: string, key: 'ok' | 'err', msg: string) => `${path}${path.includes('?') ? '&' : '?'}${key}=${encodeURIComponent(msg)}`;

/** Runs an action, then redirects back with a flash message. Errors become friendly messages, never stack traces. */
export async function run(slug: string, back: string, fn: (ctx: Awaited<ReturnType<typeof requireStaff>>) => Promise<string | { redirect: string; msg?: string } | void>) {
  const ctx = await requireStaff(slug);
  let target = back; let msg = 'Saved';
  try {
    const r = await fn(ctx);
    if (typeof r === 'string') msg = r;
    else if (r && 'redirect' in r) { target = r.redirect; msg = r.msg ?? ''; }
  } catch (raw) {
    const e = toAppError(raw);
    if (e instanceof AppError) {
      let m = e.message;
      const d = e.details as { candidates?: { uhid: string; full_name: string; reason: string }[] } | { message?: string; path?: string[] }[] | undefined;
      if (d && !Array.isArray(d) && d.candidates) m += ` Matches: ${d.candidates.map((c) => `${c.full_name} (${c.uhid}, ${c.reason})`).join('; ')}`;
      if (Array.isArray(d) && d[0]?.message) m += ` — ${d[0].path?.join('.') ?? ''} ${d[0].message}`;
      redirect(withMsg(back, 'err', m));
    }
    throw raw;
  }
  kickOutbox(ctx.tenant.id, slug);
  revalidatePath(`/${slug}`, 'layout');
  redirect(msg ? withMsg(target, 'ok', msg) : target);
}

