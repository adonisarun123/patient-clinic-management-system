import { get } from '@vercel/blob';
import { invalid } from './errors';

/**
 * Private object storage for patient files (Vercel Blob, private store). Enabled when the project has a Blob
 * read-write token; otherwise files are kept in the database (local development, tests, non-Vercel hosts).
 * Browsers upload straight to the store (so the 4.5 MB function body limit does not apply); the server then
 * reads the object back, validates it exactly as before, and records it. Nothing is readable without going
 * through the app's access checks: the store is private and keys are never shown to the browser after upload.
 */
export const MAX_FILE_BYTES = 10 * 1024 * 1024;
export const ALLOWED_TYPES = ['application/pdf', 'image/jpeg', 'image/png'];

export function objectStorageEnabled() {
  return !!process.env.BLOB_READ_WRITE_TOKEN;
}

/** Keys are `<tenantId>/uploads/<name>-<random>`; anything else is rejected. */
export function assertTenantKey(tenantId: string, key: string) {
  if (typeof key !== 'string' || !key.startsWith(`${tenantId}/uploads/`) || key.includes('..') || key.length > 300) throw invalid('Upload not recognised — try again');
}

/** Reads an uploaded object fully (≤ 10 MB) so it can be validated and checksummed. */
export async function readUploaded(tenantId: string, key: string) {
  assertTenantKey(tenantId, key);
  const r = await get(key, { access: 'private' });
  if (!r || r.statusCode !== 200 || !r.stream) throw invalid('The upload did not finish — try again');
  const chunks: Uint8Array[] = []; let n = 0;
  const reader = r.stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    n += value.length;
    if (n > MAX_FILE_BYTES) { await reader.cancel(); throw invalid('Files must be 10 MB or smaller'); }
    chunks.push(value);
  }
  return { data: Buffer.concat(chunks), contentType: r.blob.contentType ?? '' };
}

/** Streams a stored object back (streaming responses are not subject to the 4.5 MB response cap). */
export async function streamStored(key: string) {
  const r = await get(key, { access: 'private' });
  if (!r || r.statusCode !== 200 || !r.stream) return null;
  return r.stream;
}
