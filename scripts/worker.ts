// Background worker: fans out outbox events to webhooks, delivers them with signed requests and bounded
// exponential retries, and releases expired booking holds. Safe to run as several replicas
// (SKIP LOCKED); safe to stop and restart (all state is in the database).
//   npm run worker            # loop forever
//   npm run worker -- --once  # one pass (for cron / serverless schedulers)
import { withPlatform, withTenant, pool } from '../src/lib/db';
import { hmacSha256 } from '../src/lib/crypto';
import { sweepExpiredHolds } from '../src/domain/scheduling';

const MAX_ATTEMPTS = 8;
const once = process.argv.includes('--once');

type Ev = { id: string; type: string; aggregate_kind: string; aggregate_id: string; aggregate_version: number | null; payload: Record<string, unknown>; occurred_at: Date };

async function fanOut(tenantId: string) {
  return withTenant(tenantId, async (tx) => {
    const events = await tx.many<Ev>(`SELECT * FROM outbox_event WHERE processed_at IS NULL ORDER BY occurred_at LIMIT 200 FOR UPDATE SKIP LOCKED`);
    if (!events.length) return 0;
    const endpoints = await tx.many<{ id: string; events: string[] }>(`SELECT id, events FROM webhook_endpoint WHERE active`);
    for (const e of events) {
      for (const ep of endpoints) {
        if (ep.events.length && !ep.events.includes(e.type)) continue;
        await tx.exec(`INSERT INTO webhook_delivery (tenant_id, endpoint_id, event_id) VALUES (app_tenant_id(), $1, $2) ON CONFLICT DO NOTHING`, [ep.id, e.id]);
      }
      await tx.exec(`UPDATE outbox_event SET processed_at = now() WHERE id = $1`, [e.id]);
    }
    return events.length;
  });
}

async function deliver(tenantId: string, slug: string) {
  const due = await withTenant(tenantId, (tx) => tx.many<{ id: string; attempts: number; url: string; secret: string; include_contact: boolean } & Ev & { event_id: string }>(
    `SELECT d.id, d.attempts, w.url, w.secret, w.include_contact, e.id AS event_id, e.type, e.aggregate_kind, e.aggregate_id, e.aggregate_version, e.payload, e.occurred_at
       FROM webhook_delivery d JOIN webhook_endpoint w ON w.id = d.endpoint_id JOIN outbox_event e ON e.id = d.event_id
      WHERE d.status = 'pending' AND d.next_attempt_at <= now() AND w.active
      ORDER BY d.next_attempt_at LIMIT 50`));
  for (const d of due) {
    let contact: Record<string, unknown> | undefined;
    if (d.include_contact) {
      // Re-check at send time: the patient may have been merged or changed contact preference since the event.
      contact = await withTenant(tenantId, (tx) => tx.maybe<{ name: string; phone: string | null; language: string | null }>(
        `SELECT p.full_name AS name, CASE WHEN p.phone_status IN ('declined','unavailable') THEN NULL ELSE p.phone_e164 END AS phone, p.preferred_language AS language
           FROM patient p WHERE p.id = (
             CASE $1 WHEN 'appointment' THEN (SELECT patient_id FROM appointment WHERE id = $2)
                     WHEN 'invoice' THEN (SELECT patient_id FROM invoice WHERE id = $2)
                     WHEN 'payment' THEN (SELECT patient_id FROM payment WHERE id = $2)
                     WHEN 'prescription' THEN (SELECT patient_id FROM prescription WHERE id = $2)
                     WHEN 'patient' THEN $2 ELSE NULL END)`, [d.aggregate_kind, d.aggregate_id])) ?? undefined;
    }
    const { patientId: _omit, ...payload } = d.payload as Record<string, unknown>;
    void _omit;
    const body = JSON.stringify({ id: d.event_id, type: d.type, clinic: slug, occurredAt: d.occurred_at, object: { kind: d.aggregate_kind, id: d.aggregate_id, version: d.aggregate_version },
      data: payload, contact });
    const ts = Math.floor(Date.now() / 1000);
    let code = 0; let error: string | null = null;
    try {
      const res = await fetch(d.url, { method: 'POST', signal: AbortSignal.timeout(10_000), redirect: 'error',
        headers: { 'Content-Type': 'application/json', 'User-Agent': 'ClinicCore-Webhooks/1', 'X-Clinic-Event': d.type, 'X-Clinic-Delivery': d.id,
          'X-Clinic-Signature': `t=${ts},v1=${hmacSha256(d.secret, `${ts}.${body}`)}` }, body });
      code = res.status;
      if (!res.ok) error = `HTTP ${res.status}`;
    } catch (e) { error = (e as Error).message.slice(0, 200); }
    await withTenant(tenantId, (tx) => error
      ? tx.exec(`UPDATE webhook_delivery SET attempts = attempts + 1, response_code = $2, last_error = $3,
                   status = CASE WHEN attempts + 1 >= $4 THEN 'failed' ELSE 'pending' END,
                   next_attempt_at = now() + make_interval(secs => LEAST(3600, 15 * power(2, attempts)) * (0.8 + random() * 0.4)) WHERE id = $1`,
        [d.id, code || null, error, MAX_ATTEMPTS])
      : tx.exec(`UPDATE webhook_delivery SET status = 'delivered', attempts = attempts + 1, response_code = $2, delivered_at = now(), last_error = NULL WHERE id = $1`, [d.id, code]));
  }
  return due.length;
}

async function pass() {
  const tenants = await withPlatform((tx) => tx.many<{ id: string; slug: string }>(`SELECT id, slug FROM tenant WHERE status = 'active'`));
  let events = 0; let sent = 0;
  for (const t of tenants) {
    try {
      await withTenant(t.id, (tx) => sweepExpiredHolds(tx));
      events += await fanOut(t.id);
      sent += await deliver(t.id, t.slug);
    } catch (e) { console.error(`[worker] tenant ${t.slug}:`, (e as Error).message); }
  }
  return { events, sent };
}

async function main() {
  do {
    const r = await pass();
    if (r.events || r.sent) console.log(`[worker] ${new Date().toISOString()} events=${r.events} deliveries=${r.sent}`);
    if (!once) await new Promise((res) => setTimeout(res, 5000));
  } while (!once);
  await pool().end();
}
main().catch((e) => { console.error(e); process.exit(1); });
