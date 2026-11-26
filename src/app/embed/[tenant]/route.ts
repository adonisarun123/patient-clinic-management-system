import { resolveApiKey } from '@/domain/tenants';

/**
 * Serves the booking widget page that embed.js places in an iframe on a client website.
 * frame-ancestors is limited to the origins registered on the clinic's publishable key.
 */
export async function GET(req: Request, ctx: { params: Promise<{ tenant: string }> }) {
  const { tenant } = await ctx.params;
  const url = new URL(req.url);
  const key = url.searchParams.get('key') ?? '';
  const k = await resolveApiKey(key).catch(() => null);
  if (!k || k.slug !== tenant || k.kind !== 'publishable') {
    return new Response('Booking is not available: invalid clinic key.', { status: 404, headers: { 'Content-Type': 'text/plain' } });
  }
  const ancestors = k.allowed_origins.length ? k.allowed_origins.join(' ') : '*';
  const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><title>Book an appointment</title>
<link rel="stylesheet" href="/widget/booking.css">
</head><body>
<div id="cc-app" data-clinic="${esc(tenant)}" data-key="${esc(key)}" aria-live="polite"><p class="cc-muted">Loading…</p></div>
<script src="/widget/booking.js" defer></script>
</body></html>`;
  return new Response(html, {
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'Content-Security-Policy': `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' https: data:; connect-src 'self'; frame-ancestors ${ancestors}; base-uri 'none'; form-action 'self'`,
      'Referrer-Policy': 'strict-origin-when-cross-origin',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}
