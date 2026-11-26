import type { NextConfig } from 'next';

// Staff screens: no framing, no indexing, no referrer leakage. The booking widget route sets its own
// frame-ancestors from the clinic's allowed origins (src/app/embed/[tenant]/route.ts).
const staffHeaders = [
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'Content-Security-Policy', value: "frame-ancestors 'none'; base-uri 'self'; form-action 'self'; object-src 'none'" },
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'Referrer-Policy', value: 'same-origin' },
  { key: 'X-Robots-Tag', value: 'noindex, nofollow' },
  { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
];

const config: NextConfig = {
  poweredByHeader: false,
  // Lab reports and documents up to 10 MB (plus form overhead) and CSV imports.
  experimental: { serverActions: { bodySizeLimit: '21mb' } },
  async headers() {
    return [
      { source: '/((?!embed|widget|embed\\.js|api/public|api/webhooks).*)', headers: staffHeaders },
      { source: '/embed.js', headers: [{ key: 'Cache-Control', value: 'public, max-age=300' }, { key: 'Access-Control-Allow-Origin', value: '*' }] },
      { source: '/widget/:path*', headers: [{ key: 'Cache-Control', value: 'public, max-age=300' }, { key: 'X-Content-Type-Options', value: 'nosniff' }] },
    ];
  },
};

export default config;
