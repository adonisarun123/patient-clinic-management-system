'use server';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { requireStaff } from '@/lib/session';
import { sessionCookie } from '@/lib/http';
import { toAppError, AppError } from '@/lib/errors';
import * as staff from '@/domain/staff';

export type EnrolState = { secret?: string; uri?: string; qr?: string; codes?: string[]; error?: string };

export async function startEnrolment(slug: string): Promise<EnrolState> {
  const { actor, tenant } = await requireStaff(slug, undefined, { twoFactorSetup: true });
  try {
    const r = await staff.beginTwoFactor(actor, tenant.name);
    const QR = await import('qrcode');
    return { secret: r.secret, uri: r.uri, qr: await QR.toDataURL(r.uri, { margin: 1, width: 220 }) };
  } catch (e) { const a = toAppError(e); return { error: a instanceof AppError ? a.message : 'Could not start set-up' }; }
}

export async function confirmEnrolment(slug: string, prev: EnrolState, f: FormData): Promise<EnrolState> {
  const { actor } = await requireStaff(slug, undefined, { twoFactorSetup: true });
  try {
    const token = (await cookies()).get(sessionCookie(slug))?.value;
    const codes = await staff.confirmTwoFactor(actor, String(f.get('code') ?? ''), token);
    return { codes };
  } catch (e) { const a = toAppError(e); return { ...prev, error: a instanceof AppError ? a.message : 'Could not confirm' }; }
}

export async function turnOff(slug: string, f: FormData) {
  const { actor, tenant, session } = await requireStaff(slug, undefined, { twoFactorSetup: true });
  let msg = 'Two-factor sign-in turned off';
  let key = 'ok';
  try {
    await staff.disableTwoFactor(actor, tenant.settings.twoFactorRoles.includes(session.role), String(f.get('password') ?? ''), String(f.get('code') ?? ''));
  } catch (e) { const a = toAppError(e); key = 'err'; msg = a instanceof AppError ? a.message : 'Failed'; }
  redirect(`/${slug}/account/two-factor?${key}=${encodeURIComponent(msg)}`);
}
