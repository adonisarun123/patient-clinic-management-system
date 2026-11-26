import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { AppError, toAppError } from './errors';
import { randomToken } from './crypto';
import { getTenantBySlug, resolveApiKey, type Tenant } from '@/domain/tenants';
import { sessionFromToken } from '@/domain/staff';
import type { Actor } from './actor';

import { kickOutbox } from './outbox';
export const sessionCookie = (slug: string) => `cc_sess_${slug.replace(/-/g, '_')}`;

export function clientIp(req: Request): string {
  return req.headers.get('x-forwarded-for')?.split(',')[0].trim() || req.headers.get('x-real-ip') || 'unknown';
}

// ------------------------------------------------------------------ rate limiting
// In-process token bucket. Good for a single instance; use a shared store (e.g. Redis/Upstash) when scaling out.
const buckets = new Map<string, { tokens: number; at: number }>();
export function rateLimit(key: string, perMinute: number) {
  const now = Date.now();
  const b = buckets.get(key) ?? { tokens: perMinute, at: now };
  b.tokens = Math.min(perMinute, b.tokens + ((now - b.at) / 60_000) * perMinute);
  b.at = now;
  if (b.tokens < 1) throw new AppError('RATE_LIMITED', 'Too many requests');
  b.tokens -= 1;
  buckets.set(key, b);
  if (buckets.size > 50_000) buckets.clear();
}

// ------------------------------------------------------------------ responses
const NO_STORE = { 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex, nofollow' };

export function ok(data: unknown, status = 200, headers: Record<string, string> = {}) {
  return NextResponse.json(data, { status, headers: { ...NO_STORE, ...headers } });
}

export function fail(errIn: unknown, headers: Record<string, string> = {}) {
  const err = toAppError(errIn);
  const correlationId = randomToken(8);
  if (err instanceof AppError) return NextResponse.json(err.toJSON(correlationId), { status: err.status, headers: { ...NO_STORE, ...headers } });
  // Never leak internals or patient data into responses; log with the correlation id only.
  console.error(`[${correlationId}]`, err instanceof Error ? `${err.name}: ${err.message}` : 'unknown error');
  return NextResponse.json(new AppError('INTERNAL', 'Something went wrong').toJSON(correlationId), { status: 500, headers: { ...NO_STORE, ...headers } });
}

export async function body<T = Record<string, unknown>>(req: Request): Promise<T> {
  try {
    return (await req.json()) as T;
  } catch {
    throw new AppError('VALIDATION', 'Request body must be JSON');
  }
}

export const requestKey = (req: Request) => req.headers.get('idempotency-key') ?? req.headers.get('x-request-key');

// ------------------------------------------------------------------ public (website) access
export type PublicCtx = { tenant: Tenant; actor: Actor; cors: Record<string, string> };

function corsHeaders(origin: string | null, allowed: string[]): Record<string, string> {
  if (!origin) return {};
  if (allowed.length && !allowed.includes(origin)) return {};
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Headers': 'Content-Type, X-Clinic-Key, X-Journey, Idempotency-Key',
    'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
    'Access-Control-Max-Age': '600',
    Vary: 'Origin',
  };
}

/**
 * Website-facing calls authenticate with a publishable key (header X-Clinic-Key or ?key=).
 * The key must belong to the clinic in the URL. When the key lists allowed origins, browser calls from any other
 * origin are rejected. The booking journey secret (X-Journey) scopes holds to the visitor who created them.
 */
export async function publicContext(req: Request, slug: string): Promise<PublicCtx> {
  const url = new URL(req.url);
  const key = req.headers.get('x-clinic-key') ?? url.searchParams.get('key') ?? '';
  const k = await resolveApiKey(key);
  if (!k || k.slug !== slug) throw new AppError('UNAUTHENTICATED', 'Invalid clinic key');
  if (k.status !== 'active') throw new AppError('TENANT_SUSPENDED', 'Online booking is unavailable');
  const origin = req.headers.get('origin');
  const self = `${url.protocol}//${url.host}`;
  if (origin && origin !== self && k.allowed_origins.length && !k.allowed_origins.includes(origin)) {
    throw new AppError('FORBIDDEN', 'This website is not allowed to use this clinic key');
  }
  const ip = clientIp(req);
  rateLimit(`pub:${k.tenant_id}:${ip}`, 60);
  const tenant = await getTenantBySlug(slug);
  const journey = req.headers.get('x-journey') ?? '';
  const actor: Actor = k.kind === 'secret'
    ? { kind: 'api_key', tenantId: tenant.id, keyId: k.id, ip }
    : { kind: 'public', tenantId: tenant.id, journey: journey.length >= 20 ? journey : `anon-${ip}-${randomToken(8)}`, ip };
  return { tenant, actor, cors: corsHeaders(origin, k.allowed_origins) };
}

export async function preflight(req: Request, slug: string) {
  const origin = req.headers.get('origin');
  try {
    const key = new URL(req.url).searchParams.get('key');
    const k = key ? await resolveApiKey(key) : null;
    return new NextResponse(null, { status: 204, headers: corsHeaders(origin, k && k.slug === slug ? k.allowed_origins : []) });
  } catch {
    return new NextResponse(null, { status: 204, headers: corsHeaders(origin, []) });
  }
}

// ------------------------------------------------------------------ staff / integration access
/** Staff session cookie, or a secret API key (Authorization: Bearer sk_...) for server-to-server integrations. */
export async function staffContext(req: Request, slug: string): Promise<{ tenant: Tenant; actor: Actor }> {
  const tenant = await getTenantBySlug(slug);
  const auth = req.headers.get('authorization');
  const ip = clientIp(req);
  if (auth?.startsWith('Bearer sk_')) {
    const k = await resolveApiKey(auth.slice(7));
    if (!k || k.slug !== slug || k.kind !== 'secret') throw new AppError('UNAUTHENTICATED', 'Invalid API key');
    rateLimit(`sk:${k.id}`, 600);
    return { tenant, actor: { kind: 'api_key', tenantId: tenant.id, keyId: k.id, ip } };
  }
  const token = (await cookies()).get(sessionCookie(slug))?.value;
  const s = token ? await sessionFromToken(tenant.id, token) : null;
  if (!s) throw new AppError('UNAUTHENTICATED', 'Sign in required');
  if (!s.twoFactorEnabled && tenant.settings.twoFactorRoles.includes(s.role)) throw new AppError('FORBIDDEN', 'Set up two-factor sign-in first');
  // Cookie-authenticated writes must come from our own origin (CSRF defence in depth; cookie is SameSite=Lax).
  if (req.method !== 'GET') {
    const origin = req.headers.get('origin');
    const self = new URL(req.url);
    if (origin && origin !== `${self.protocol}//${self.host}`) throw new AppError('FORBIDDEN', 'Cross-site request rejected');
  }
  return { tenant, actor: { kind: 'staff', tenantId: tenant.id, staffId: s.staffId, role: s.role, clinicianId: s.clinicianId, name: s.name, ip } };
}

type Params<P> = { params: Promise<P> };
/** Wraps a route handler with uniform error handling. */
export function route<P extends { tenant: string }>(fn: (req: Request, p: P) => Promise<Response>) {
  return async (req: Request, ctx: Params<P>) => {
    try {
      const p = await ctx.params;
      const res = await fn(req, p);
      if (req.method !== 'GET' && res.ok) {
        const t = await getTenantBySlug(p.tenant).catch(() => null);
        if (t) kickOutbox(t.id, p.tenant);
      }
      return res;
    } catch (e) {
      return fail(e);
    }
  };
}
