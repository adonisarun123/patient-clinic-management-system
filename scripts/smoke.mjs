// Post-deploy smoke test. Read-only and unauthenticated, so it is safe against production.
//   node scripts/smoke.mjs https://<deployment-host>
// Proves: the app serves pages, the database is reachable (a clinic lookup answers 404, not 500), the cron
// endpoint refuses callers without the secret, uploads refuse anonymous callers, and security headers are set.
const base = (process.argv[2] || process.env.BASE_URL || '').replace(/\/$/, '');
if (!base) { console.error('usage: node scripts/smoke.mjs <url>'); process.exit(2); }
const url = /^https?:\/\//.test(base) ? base : `https://${base}`;
const headers = process.env.VERCEL_AUTOMATION_BYPASS_SECRET ? { 'x-vercel-protection-bypass': process.env.VERCEL_AUTOMATION_BYPASS_SECRET } : {};

async function hit(path, init = {}) {
  for (let attempt = 1; ; attempt++) {
    try {
      const r = await fetch(url + path, { redirect: 'manual', ...init, headers: { ...headers, ...(init.headers || {}) }, signal: AbortSignal.timeout(20000) });
      return { status: r.status, text: await r.text(), headers: r.headers };
    } catch (e) {
      if (attempt >= 3) throw e;
      await new Promise((res) => setTimeout(res, 3000 * attempt)); // cold start / propagation
    }
  }
}

const checks = [
  ['platform login page renders', async () => { const r = await hit('/admin/login'); return r.status === 200 && r.text.includes('Platform console'); }],
  ['database reachable (API: unknown clinic → 404, not 500)', async () => (await hit('/api/v1/smoke-test-no-such-clinic/availability')).status === 404],
  ['patient portal handles unknown clinic without an error', async () => { const r = await hit('/p/smoke-test-no-such-clinic'); return r.status < 500; }],
  ['cron endpoint refuses callers without the secret', async () => (await hit('/api/cron/outbox')).status === 401],
  ['uploads refuse anonymous callers', async () => { const r = await hit('/api/uploads/smoke-test-no-such-clinic', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }); return r.status >= 400 && r.status < 500; }],
  ['favicon is static (does not hit a clinic route)', async () => (await hit('/favicon.ico')).status === 200],
  ['security headers present', async () => { const r = await hit('/admin/login'); return !!r.headers.get('content-security-policy') && r.headers.get('x-content-type-options') === 'nosniff'; }],
];

let failed = 0;
for (const [name, fn] of checks) {
  let ok = false; let note = '';
  try { ok = await fn(); } catch (e) { note = ` (${e.message})`; }
  console.log(`${ok ? '✓' : '✗'} ${name}${note}`);
  if (!ok) failed++;
}
console.log(failed ? `\n${failed} smoke check(s) failed against ${url}` : `\nAll ${checks.length} smoke checks passed against ${url}`);
process.exit(failed ? 1 : 0);
