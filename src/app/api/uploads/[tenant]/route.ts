import { handleUpload, type HandleUploadBody } from '@vercel/blob/client';
import { staffContext, fail, rateLimit } from '@/lib/http';
import { can } from '@/lib/rbac';
import { AppError } from '@/lib/errors';
import { ALLOWED_TYPES, MAX_FILE_BYTES, assertTenantKey, objectStorageEnabled } from '@/lib/blob';

/**
 * Issues a short-lived token so a signed-in staff member's browser can upload one file straight to the clinic's
 * private object storage. The file is only recorded against a chart when the form is then submitted, where the
 * server reads it back and validates type signature, size and chart access before saving anything.
 */
export async function POST(req: Request, ctx: { params: Promise<{ tenant: string }> }) {
  try {
    if (!objectStorageEnabled()) throw new AppError('NOT_FOUND', 'Object storage is not configured');
    const { tenant: slug } = await ctx.params;
    const { tenant, actor } = await staffContext(req, slug);
    if (actor.kind !== 'staff' || !(can(actor.role, 'patient.write') || can(actor.role, 'results.enter'))) throw new AppError('FORBIDDEN', 'You cannot upload files');
    rateLimit(`upload:${actor.staffId}`, 30);
    const body = (await req.json()) as HandleUploadBody;
    if (body.type !== 'blob.generate-client-token') throw new AppError('VALIDATION', 'Unsupported request');
    const json = await handleUpload({
      body, request: req,
      onBeforeGenerateToken: async (pathname) => {
        assertTenantKey(tenant.id, pathname);
        return { allowedContentTypes: ALLOWED_TYPES, maximumSizeInBytes: MAX_FILE_BYTES, addRandomSuffix: true,
          validUntil: Date.now() + 10 * 60 * 1000 };
      },
    });
    return Response.json(json);
  } catch (e) { return fail(e); }
}
