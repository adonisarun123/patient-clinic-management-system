import { randomUUID } from 'node:crypto';
import { AppError } from './errors';

/**
 * ABDM gateway adapter. OFF until the integrator credentials issued by NHA are set:
 *   ABDM_CLIENT_ID, ABDM_CLIENT_SECRET, optional ABDM_GATEWAY_URL (default: sandbox HIE-CM base), ABDM_CM_ID (default "sbx").
 * Only the session call is implemented. It follows the V3 pattern (POST {base}/gateway/v3/sessions with clientId, clientSecret,
 * grantType=client_credentials and REQUEST-ID / TIMESTAMP / X-CM-ID headers) as described in secondary sources — confirm
 * against NHA's current sandbox documentation when credentials are issued. ABHA verification, care-context linking and
 * health-information exchange (Milestones 1–3) need sandbox access, NHA's encryption keys and certification, and are not
 * implemented: their functions refuse with a clear message rather than guessing at payloads.
 */
const SANDBOX_BASE = 'https://dev.abdm.gov.in/api/hiecm';

export function abdmConfigured() { return !!(process.env.ABDM_CLIENT_ID && process.env.ABDM_CLIENT_SECRET); }
export function abdmEnvironment() {
  const base = process.env.ABDM_GATEWAY_URL ?? SANDBOX_BASE;
  return { base, cmId: process.env.ABDM_CM_ID ?? 'sbx', sandbox: base.includes('dev.abdm.gov.in') };
}

let cached: { token: string; until: number } | null = null;

export async function abdmAccessToken(fetchImpl: typeof fetch = fetch): Promise<string> {
  if (!abdmConfigured()) throw new AppError('RULE_VIOLATION', 'ABDM is not connected. NHA integrator credentials have not been configured.');
  if (cached && cached.until > Date.now() + 60_000) return cached.token;
  const env = abdmEnvironment();
  const res = await fetchImpl(`${env.base}/gateway/v3/sessions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'REQUEST-ID': randomUUID(), TIMESTAMP: new Date().toISOString(), 'X-CM-ID': env.cmId },
    body: JSON.stringify({ clientId: process.env.ABDM_CLIENT_ID, clientSecret: process.env.ABDM_CLIENT_SECRET, grantType: 'client_credentials' }),
    signal: AbortSignal.timeout(15_000),
  }).catch((e: Error) => { throw new AppError('INTERNAL', `ABDM gateway unreachable: ${e.message}`); });
  const body = await res.json().catch(() => ({})) as { accessToken?: string; expiresIn?: number };
  if (!res.ok || !body.accessToken) throw new AppError('RULE_VIOLATION', `ABDM gateway refused the session (HTTP ${res.status}). Check the credentials and environment.`);
  cached = { token: body.accessToken, until: Date.now() + Math.max(60, Number(body.expiresIn ?? 600)) * 1000 };
  return body.accessToken;
}

export async function abdmTestConnection(fetchImpl: typeof fetch = fetch) {
  const env = abdmEnvironment();
  try { await abdmAccessToken(fetchImpl); return { ok: true as const, environment: env.sandbox ? 'sandbox' : 'production', base: env.base }; }
  catch (e) { return { ok: false as const, environment: env.sandbox ? 'sandbox' : 'production', base: env.base, error: (e as Error).message }; }
}

/** Placeholder for ABHA verification (OTP via ABDM). Deliberately not implemented until sandbox access exists. */
export async function verifyAbhaWithAbdm(): Promise<never> {
  throw new AppError('RULE_VIOLATION', abdmConfigured()
    ? 'ABHA verification through ABDM is not yet enabled in this version. Record what you checked (ABHA card seen) instead.'
    : 'ABDM is not connected. Record what you checked (ABHA card seen) instead.');
}

/** Test hook. */
export function _resetAbdmCache() { cached = null; }
