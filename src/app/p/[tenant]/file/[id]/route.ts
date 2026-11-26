import { cookies } from 'next/headers';
import { getTenantBySlug } from '@/domain/tenants';
import { portalDocument, portalSession } from '@/domain/portal';
import { withTenant } from '@/lib/db';
import { fail } from '@/lib/http';
import { portalCookie } from '@/lib/portal-session';

/** Portal file download: only files that were released themselves, or the report of a released result. */
export async function GET(_req: Request, ctx: { params: Promise<{ tenant: string; id: string }> }) {
  try {
    const { tenant: slug, id } = await ctx.params;
    const tenant = await getTenantBySlug(slug);
    const s = await portalSession(tenant, (await cookies()).get(portalCookie(slug))?.value);
    if (!s) return new Response('Sign in required', { status: 401 });
    let file: { filename: string; content_type: string; data: Buffer } | undefined;
    const viaResult = await withTenant(tenant.id, (tx) => tx.maybe<{ order_id: string }>(
      `SELECT v.order_id FROM result_version v JOIN document_release r ON r.doc_kind = 'result' AND r.doc_id = v.order_id AND r.revoked_at IS NULL WHERE v.attachment_id = $1 LIMIT 1`, [id]));
    if (viaResult) {
      await portalDocument(tenant, s, 'result', viaResult.order_id); // re-checks the link
      file = await withTenant(tenant.id, (tx) => tx.one<{ filename: string; content_type: string; data: Buffer }>(`SELECT filename, content_type, data FROM attachment WHERE id = $1 AND status = 'active'`, [id]));
    } else {
      const d = await portalDocument(tenant, s, 'attachment', id);
      file = 'file' in d ? d.file : undefined;
    }
    if (!file) return new Response('Not found', { status: 404 });
    return new Response(new Uint8Array(file.data), { headers: { 'Content-Type': file.content_type, 'Content-Disposition': `attachment; filename="${file.filename.replace(/"/g, '')}"`,
      'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'; sandbox" } });
  } catch (e) { return fail(e); }
}
