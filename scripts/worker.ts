// Background worker for long-running hosts. On Vercel the same pass runs from /api/cron/outbox instead.
//   npm run worker            # loop forever
//   npm run worker -- --once  # one pass
import { pool } from '../src/lib/db';
import { runOutboxPass } from '../src/lib/outbox';

const once = process.argv.includes('--once');

async function main() {
  do {
    const r = await runOutboxPass();
    if (r.events || r.sent) console.log(`[worker] ${new Date().toISOString()} events=${r.events} deliveries=${r.sent}`);
    if (!once) await new Promise((res) => setTimeout(res, 5000));
  } while (!once);
  await pool().end();
}
main().catch((e) => { console.error(e); process.exit(1); });
