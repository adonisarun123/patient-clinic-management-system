import 'server-only';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { getTenantBySlug, type Tenant } from '@/domain/tenants';
import { portalSession, type PortalSession } from '@/domain/portal';

export const portalCookie = (slug: string) => `cc_portal_${slug.replace(/-/g, '_')}`;
export const pendingCookie = (slug: string) => `cc_portal_pending_${slug.replace(/-/g, '_')}`;

export async function portalTenant(slug: string): Promise<Tenant> {
  const t = await getTenantBySlug(slug).catch(() => null);
  if (!t || !t.settings.modules.portal) redirect('/');
  return t;
}

export async function requirePortal(slug: string): Promise<{ tenant: Tenant; s: PortalSession }> {
  const tenant = await portalTenant(slug);
  const s = await portalSession(tenant, (await cookies()).get(portalCookie(slug))?.value);
  if (!s) redirect(`/p/${slug}`);
  return { tenant, s };
}
