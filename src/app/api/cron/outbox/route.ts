import { timingSafeEqual } from 'node:crypto';
import { runOutboxPass } from '@/lib/outbox';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/**
 * Scheduled by Vercel Cron (vercel.json). Vercel sends `Authorization: Bearer <CRON_SECRET>`; anything else is refused.
 * Each invocation runs passes for ~45 s so deliveries go out within seconds even though cron fires once a minute.
 */
export async function GET(req: Request) {
  const secret = process.env.CRON_SECRET;
  const got = Buffer.from(req.headers.get('authorization') ?? '');
  const want = Buffer.from(`Bearer ${secret ?? ''}`);
  if (!secret || got.length !== want.length || !timingSafeEqual(got, want)) return new Response('Unauthorized', { status: 401 });
  const until = Date.now() + 45_000;
  let events = 0, sent = 0, passes = 0;
  do {
    const r = await runOutboxPass();
    events += r.events; sent += r.sent; passes++;
    if (Date.now() + 10_000 > until) break;
    await new Promise((res) => setTimeout(res, 5_000));
  } while (Date.now() < until);
  console.log(JSON.stringify({ cron: 'outbox', passes, events, sent }));
  return Response.json({ passes, events, sent });
}
