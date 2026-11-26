import bcrypt from 'bcryptjs';
import { withPlatform } from '@/lib/db';
import { AppError } from '@/lib/errors';
import { randomToken, sha256 } from '@/lib/crypto';
import { invalidateTenantCache } from './tenants';

const DUMMY = bcrypt.hashSync('platform-timing', 10);

export async function platformLogin(email: string, password: string) {
  return withPlatform(async (tx) => {
    const a = await tx.maybe<{ id: string; password_hash: string; active: boolean }>(`SELECT * FROM platform_admin WHERE lower(email) = lower($1)`, [email.trim()]);
    const ok = await bcrypt.compare(password, a?.password_hash ?? DUMMY);
    if (!a || !ok || !a.active) throw new AppError('UNAUTHENTICATED', 'Email or password is incorrect');
    const token = randomToken(32);
    await tx.exec(`INSERT INTO platform_session (admin_id, token_hash, expires_at) VALUES ($1, $2, now() + interval '8 hours')`, [a.id, sha256(token)]);
    return token;
  });
}

export async function platformSession(token: string | undefined) {
  if (!token) return null;
  return withPlatform((tx) => tx.maybe<{ id: string; email: string; full_name: string }>(
    `SELECT a.id, a.email, a.full_name FROM platform_session s JOIN platform_admin a ON a.id = s.admin_id
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
