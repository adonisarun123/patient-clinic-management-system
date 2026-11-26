import 'server-only';
import { cookies, headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { getTenantBySlug, type Tenant } from '@/domain/tenants';
import { sessionFromToken, type StaffSession } from '@/domain/staff';
import { sessionCookie } from './http';
import type { Actor } from './actor';
import { can, type Permission } from './rbac';
import { AppError } from './errors';

export type StaffCtx = { tenant: Tenant; session: StaffSession; actor: Actor & { kind: 'staff' } };

/** For server components and server actions: resolves the signed-in staff member or redirects to sign-in (or to two-factor set-up when the clinic requires it). */
export async function requireStaff(slug: string, perm?: Permission, opts: { twoFactorSetup?: boolean } = {}): Promise<StaffCtx> {
  let tenant: Tenant;
  try {
    tenant = await getTenantBySlug(slug);
  } catch (e) {
    if (e instanceof AppError && e.code === 'NOT_FOUND') redirect('/');
    throw e;
  }
  const token = (await cookies()).get(sessionCookie(slug))?.value;
  const session = token ? await sessionFromToken(tenant.id, token) : null;
  if (!session) redirect(`/${slug}/login`);
  // Clinic policy: roles listed in settings.twoFactorRoles must enrol before using anything else.
  if (!opts.twoFactorSetup && !session.twoFactorEnabled && tenant.settings.twoFactorRoles.includes(session.role)) redirect(`/${slug}/account/two-factor?required=1`);
  const h = await headers();
  const actor = { kind: 'staff' as const, tenantId: tenant.id, staffId: session.staffId, role: session.role, clinicianId: session.clinicianId,
    name: session.name, ip: h.get('x-forwarded-for')?.split(',')[0] ?? undefined };
  if (perm && !can(session.role, perm)) throw new AppError('FORBIDDEN', 'You do not have access to this page');
  return { tenant, session, actor };
}
