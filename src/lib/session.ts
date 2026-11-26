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

/** For server components and server actions: resolves the signed-in staff member or redirects to sign-in. */
export async function requireStaff(slug: string, perm?: Permission): Promise<StaffCtx> {
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
  const h = await headers();
  const actor = { kind: 'staff' as const, tenantId: tenant.id, staffId: session.staffId, role: session.role, clinicianId: session.clinicianId,
    name: session.name, ip: h.get('x-forwarded-for')?.split(',')[0] ?? undefined };
  if (perm && !can(session.role, perm)) throw new AppError('FORBIDDEN', 'You do not have access to this page');
  return { tenant, session, actor };
}
