import type { Tx } from './db';
import { AppError } from './errors';
import { canonicalJson, sha256 } from './crypto';

/**
 * API-002 / DM-006: same key + same payload → original result; same key + different payload → conflict.
 * Runs inside the caller's transaction, so the stored outcome commits atomically with the change.
 * The primary key serialises concurrent submissions: the loser waits, then sees the winner's row.
 */
export async function idempotent<T>(tx: Tx, principal: string, operation: string, key: string | null | undefined,
  payload: unknown, fn: () => Promise<T>): Promise<T> {
  if (!key) return fn();
  if (key.length > 200) throw new AppError('VALIDATION', 'Request key too long');
  const digest = sha256(canonicalJson(payload));
  const claimed = await tx.maybe<{ key: string }>(
    `INSERT INTO idempotency_key (tenant_id, principal, operation, key, request_digest, status_code, response)
     VALUES (app_tenant_id(), $1, $2, $3, $4, 0, '{}'::jsonb)
     ON CONFLICT DO NOTHING RETURNING key`, [principal, operation, key, digest]);
  if (!claimed) {
    const prior = await tx.one<{ request_digest: string; response: T; status_code: number }>(
      `SELECT request_digest, response, status_code FROM idempotency_key
        WHERE tenant_id = app_tenant_id() AND principal = $1 AND operation = $2 AND key = $3`,
      [principal, operation, key]);
    if (prior.request_digest !== digest) {
      throw new AppError('IDEMPOTENCY_MISMATCH', 'This request key was already used with a different request.');
    }
    return prior.response;
  }
  const result = await fn();
  await tx.exec(
    `UPDATE idempotency_key SET status_code = 200, response = $4
      WHERE tenant_id = app_tenant_id() AND principal = $1 AND operation = $2 AND key = $3`,
    [principal, operation, key, JSON.stringify(result ?? null)]);
  return result;
}
