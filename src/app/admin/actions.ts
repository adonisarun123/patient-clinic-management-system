'use server';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { platformSession, platformBeginTwoFactor, platformConfirmTwoFactor, platformChangePassword } from '@/domain/platform';
import { AppError, toAppError } from '@/lib/errors';

async function requirePlatform() {
  const s = await platformSession((await cookies()).get('cc_platform')?.value);
  if (!s) redirect('/admin/login');
  return s;
}
const msg = (e: unknown) => { const a = toAppError(e); return a instanceof AppError ? a.message : 'Failed'; };

export type PlatformEnrol = { secret?: string; qr?: string; codes?: string[]; error?: string };

export async function adminStartTwoFactor(): Promise<PlatformEnrol> {
  const a = await requirePlatform();
  try {
    const r = await platformBeginTwoFactor(a.id);
    const QR = await import('qrcode');
    return { secret: r.secret, qr: await QR.toDataURL(r.uri, { margin: 1, width: 220 }) };
  } catch (e) { return { error: msg(e) }; }
}

export async function adminConfirmTwoFactor(prev: PlatformEnrol, f: FormData): Promise<PlatformEnrol> {
  const a = await requirePlatform();
  try { return { codes: await platformConfirmTwoFactor(a.id, String(f.get('code') ?? '')) }; }
  catch (e) { return { ...prev, error: msg(e) }; }
}

export async function adminChangePassword(f: FormData) {
  const a = await requirePlatform();
  let to = '/admin?ok=Password+changed';
  try {
    if (f.get('next') !== f.get('confirm')) throw new AppError('VALIDATION', 'New passwords do not match');
    await platformChangePassword(a.id, String(f.get('current') ?? ''), String(f.get('next') ?? ''));
  } catch (e) { to = `/admin?err=${encodeURIComponent(msg(e))}`; }
  redirect(to);
}
