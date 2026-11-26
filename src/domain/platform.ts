import bcrypt from 'bcryptjs';
import { withPlatform, type Tx } from '@/lib/db';
import { AppError } from '@/lib/errors';
import { randomToken, sha256 } from '@/lib/crypto';
import { invalidateTenantCache } from './tenants';

const DUMMY = bcrypt.hashSync('platform-timing', 10);

/** Step 1. Returns a session token, or a challenge when the admin has two-factor sign-in on. */
export async function platformLogin(email: string, password: string): Promise<{ kind: 'session'; token: string } | { kind: 'challenge'; challenge: string }> {
  return withPlatform(async (tx) => {
    const a = await tx.maybe<{ id: string; password_hash: string; active: boolean; totp_enabled_at: Date | null }>(`SELECT * FROM platform_admin WHERE lower(email) = lower($1)`, [email.trim()]);
    const ok = await bcrypt.compare(password, a?.password_hash ?? DUMMY);
    if (!a || !ok || !a.active) throw new AppError('UNAUTHENTICATED', 'Email or password is incorrect');
    if (a.totp_enabled_at) {
      const challenge = randomToken(32);
      await tx.exec(`INSERT INTO platform_login_challenge (admin_id, token_hash, expires_at) VALUES ($1, $2, now() + interval '5 minutes')`, [a.id, sha256(challenge)]);
      return { kind: 'challenge', challenge };
    }
    return { kind: 'session', token: await newPlatformSession(tx, a.id) };
  });
}

async function newPlatformSession(tx: Tx, adminId: string) {
  const token = randomToken(32);
  await tx.exec(`INSERT INTO platform_session (admin_id, token_hash, expires_at) VALUES ($1, $2, now() + interval '8 hours')`, [adminId, sha256(token)]);
  return token;
}

export async function platformCompleteLogin(challenge: string, code: string) {
  const { decrypt } = await import('@/lib/secrets');
  const { verifyTotp, hashRecovery } = await import('@/lib/totp');
  const c = await withPlatform((tx) => tx.maybe<{ id: string; admin_id: string }>(
    `UPDATE platform_login_challenge SET attempts = attempts + 1 WHERE token_hash = $1 AND used_at IS NULL AND expires_at > now() AND attempts < 5 RETURNING id, admin_id`, [sha256(challenge ?? '')]));
  if (!c) throw new AppError('UNAUTHENTICATED', 'Sign-in expired or too many attempts. Start again.');
  return withPlatform(async (tx) => {
    const a = await tx.one<{ id: string; active: boolean; totp_secret_enc: string; totp_last_step: string | null; recovery_code_hashes: string[] }>(`SELECT * FROM platform_admin WHERE id = $1 FOR UPDATE`, [c.admin_id]);
    if (!a.active) throw new AppError('UNAUTHENTICATED', 'Sign-in failed');
    const t = code.trim();
    if (/^\d{3}\s?\d{3}$/.test(t)) {
      const step = verifyTotp(decrypt(a.totp_secret_enc), t);
      if (step === null || (a.totp_last_step !== null && step <= Number(a.totp_last_step))) throw new AppError('UNAUTHENTICATED', 'That code is not valid');
      await tx.exec(`UPDATE platform_admin SET totp_last_step = $2 WHERE id = $1`, [a.id, step]);
    } else {
      const h = hashRecovery(t);
      if (!a.recovery_code_hashes.includes(h)) throw new AppError('UNAUTHENTICATED', 'That recovery code is not valid');
      await tx.exec(`UPDATE platform_admin SET recovery_code_hashes = array_remove(recovery_code_hashes, $2) WHERE id = $1`, [a.id, h]);
    }
    await tx.exec(`UPDATE platform_login_challenge SET used_at = now() WHERE id = $1`, [c.id]);
    return newPlatformSession(tx, a.id);
  });
}

export async function platformChangePassword(adminId: string, current: string, next: string) {
  if (next.length < 12) throw new AppError('VALIDATION', 'Use at least 12 characters for the platform password');
  await withPlatform(async (tx) => {
    const a = await tx.one<{ password_hash: string }>(`SELECT password_hash FROM platform_admin WHERE id = $1`, [adminId]);
    if (!(await bcrypt.compare(current, a.password_hash))) throw new AppError('UNAUTHENTICATED', 'Current password is incorrect');
    await tx.exec(`UPDATE platform_admin SET password_hash = $2, password_changed_at = now() WHERE id = $1`, [adminId, await bcrypt.hash(next, 10)]);
  });
}

export async function platformBeginTwoFactor(adminId: string) {
  const { encrypt } = await import('@/lib/secrets');
  const { newSecret, otpauthUri } = await import('@/lib/totp');
  return withPlatform(async (tx) => {
    const a = await tx.one<{ email: string; totp_enabled_at: Date | null }>(`SELECT email, totp_enabled_at FROM platform_admin WHERE id = $1`, [adminId]);
    if (a.totp_enabled_at) throw new AppError('VALIDATION', 'Two-factor sign-in is already on');
    const secret = newSecret();
    await tx.exec(`UPDATE platform_admin SET totp_secret_enc = $2 WHERE id = $1`, [adminId, encrypt(secret)]);
    return { secret, uri: otpauthUri(secret, a.email, 'Clinic Core platform') };
  });
}

export async function platformConfirmTwoFactor(adminId: string, code: string) {
  const { decrypt } = await import('@/lib/secrets');
  const { verifyTotp, newRecoveryCodes } = await import('@/lib/totp');
  return withPlatform(async (tx) => {
    const a = await tx.one<{ totp_secret_enc: string | null; totp_enabled_at: Date | null }>(`SELECT totp_secret_enc, totp_enabled_at FROM platform_admin WHERE id = $1 FOR UPDATE`, [adminId]);
    if (a.totp_enabled_at || !a.totp_secret_enc) throw new AppError('VALIDATION', 'Start set-up first');
    const step = verifyTotp(decrypt(a.totp_secret_enc), code);
    if (step === null) throw new AppError('VALIDATION', 'That code did not match');
    const rc = newRecoveryCodes();
    await tx.exec(`UPDATE platform_admin SET totp_enabled_at = now(), totp_last_step = $2, recovery_code_hashes = $3 WHERE id = $1`, [adminId, step, rc.hashes]);
    return rc.codes;
  });
}

export async function platformSession(token: string | undefined) {
  if (!token) return null;
  return withPlatform((tx) => tx.maybe<{ id: string; email: string; full_name: string; two_factor: boolean; password_changed_at: Date | null }>(
    `SELECT a.id, a.email, a.full_name, (a.totp_enabled_at IS NOT NULL) AS two_factor, a.password_changed_at FROM platform_session s JOIN platform_admin a ON a.id = s.admin_id
      WHERE s.token_hash = $1 AND s.expires_at > now() AND a.active`, [sha256(token)]));
}

export async function listTenants() {
  return withPlatform((tx) => tx.many<{ id: string; slug: string; name: string; status: string; created_at: Date }>(
    `SELECT id, slug, name, status, created_at FROM tenant ORDER BY created_at DESC`));
}

/** Usage figures across tenants need a per-tenant transaction because every clinical table is RLS-protected. */
export async function tenantUsage(tenantIds: string[]) {
  const { withTenant } = await import('@/lib/db');
  const out: Record<string, { patients: number; appts30: number; staff: number }> = {};
  for (const id of tenantIds) {
    out[id] = await withTenant(id, (tx) => tx.one<{ patients: number; appts30: number; staff: number }>(
      `SELECT (SELECT count(*)::int FROM patient WHERE status <> 'merged') AS patients,
              (SELECT count(*)::int FROM appointment WHERE created_at > now() - interval '30 days') AS appts30,
              (SELECT count(*)::int FROM staff WHERE active) AS staff`));
  }
  return out;
}

export async function setTenantStatus(id: string, status: 'active' | 'suspended') {
  const slug = await withPlatform(async (tx) => (await tx.one<{ slug: string }>(`UPDATE tenant SET status = $2, updated_at = now() WHERE id = $1 RETURNING slug`, [id, status])).slug);
  invalidateTenantCache(slug);
}
