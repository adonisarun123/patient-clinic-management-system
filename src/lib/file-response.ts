import { streamStored } from './blob';

/** Serves a stored file as a download: never rendered inline, never cached, sandboxed. */
export async function fileResponse(f: { filename: string; content_type: string; data: Buffer | null; storage_key?: string | null }) {
  const body = f.storage_key ? await streamStored(f.storage_key) : f.data ? new Uint8Array(f.data) : null;
  if (!body) return new Response('File unavailable', { status: 404 });
  return new Response(body, { headers: {
    'Content-Type': f.content_type, 'Content-Disposition': `attachment; filename="${f.filename.replace(/["\\\r\n]/g, '')}"`,
    'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'; sandbox" } });
}
