import { cookies } from 'next/headers';
import { getTenantBySlug } from '@/domain/tenants';
import { sessionFromToken } from '@/domain/staff';
import { readAttachment } from '@/domain/attachments';
import { fail, sessionCookie } from '@/lib/http';
import { fileResponse } from '@/lib/file-response';

/** Staff file download. Access-checked and audited; always served as a download, never rendered inline. */
export async function GET(_req: Request, ctx: { params: Promise<{ tenant: string; id: string }> }) {
  try {
    const { tenant: slug, id } = await ctx.params;
    const tenant = await getTenantBySlug(slug);
    const token = (await cookies()).get(sessionCookie(slug))?.value;
    const s = token ? await sessionFromToken(tenant.id, token) : null;
    if (!s) return new Response('Sign in required', { status: 401 });
    const f = await readAttachment({ kind: 'staff', tenantId: tenant.id, staffId: s.staffId, role: s.role, clinicianId: s.clinicianId, name: s.name }, tenant, id);
    return fileResponse(f);
  } catch (e) { return fail(e); }
}
