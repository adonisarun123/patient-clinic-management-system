import type { Role } from '@/lib/rbac';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { withPlatform, withTenant, type Tx } from '@/lib/db';
import { AppError, invalid } from '@/lib/errors';
import { randomToken, sha256 } from '@/lib/crypto';

export type TenantSettings = {
  soloPractice: boolean;           // relaxes dual control; every self-approval is audited
  uhidPrefix: string;
  holdMinutes: number;             // OP-019 proposed initial lifetime 5 min
  noShowGraceMinutes: number;      // OP-025
  bookingHorizonDays: number;
  minLeadMinutes: number;
  publicBookingEnabled: boolean;
  requireAllergyReviewToSign: boolean;
  refundApprovalThresholdPaise: number; // refunds at or below can be self-approved by cashier when solo
  modules: Modules;
  autoReleasePrescriptions: boolean;    // release signed prescriptions to the portal automatically
  recordsRequestDays: number;           // response clock for records requests (set by the clinic; verify the legal timeline)
  emergencyAccessMinutes: number;
  jitsiBaseUrl: string;
  twoFactorRoles: Role[];               // roles that must use two-factor sign-in (staff enrol at next sign-in)
  drawerVarianceApprovalPaise: number;  // cash drawer variance above this needs a second person's approval
  formularyMode: 'off' | 'warn' | 'enforce'; // off-formulary prescribing: ignore, warn, or require a reason
};

export const MODULES = ['labs', 'portal', 'payments', 'telemedicine', 'emergencyAccess', 'pharmacy', 'inpatient', 'import', 'daycare', 'theatre'] as const;
export type ModuleName = (typeof MODULES)[number];
export type Modules = Record<ModuleName, boolean>;
export const MODULE_LABEL: Record<ModuleName, string> = {
  labs: 'Lab & imaging orders', portal: 'Patient portal', payments: 'Online payments', telemedicine: 'Video consultations',
  emergencyAccess: 'Restricted records & emergency access', pharmacy: 'Pharmacy & stock', inpatient: 'Inpatient wards', import: 'Data import',
  daycare: 'Day care', theatre: 'Operating theatre',
};

export type Branding = {
  primaryColor?: string; accentColor?: string; logoUrl?: string; address?: string;
  phone?: string; email?: string; website?: string; registrationText?: string; footerNote?: string;
};

export type Tenant = {
  id: string; slug: string; name: string; legal_name: string | null; status: string;
  timezone: string; currency: string; locale: string; branding: Branding; settings: TenantSettings;
};

export const DEFAULT_SETTINGS: TenantSettings = {
  soloPractice: false, uhidPrefix: 'MRN', holdMinutes: 5, noShowGraceMinutes: 30,
  bookingHorizonDays: 60, minLeadMinutes: 30, publicBookingEnabled: true,
  requireAllergyReviewToSign: true, refundApprovalThresholdPaise: 0,
  modules: { labs: false, portal: false, payments: false, telemedicine: false, emergencyAccess: false, pharmacy: false, inpatient: false, import: false, daycare: false, theatre: false },
  autoReleasePrescriptions: false, recordsRequestDays: 30, emergencyAccessMinutes: 60, jitsiBaseUrl: 'https://meet.jit.si',
  twoFactorRoles: [],
  drawerVarianceApprovalPaise: 10000,
  formularyMode: 'warn',
};

/** SRS ch. 1: conditional modules stay inactive until the clinic switches them on. */
export function requireModule(t: Tenant, m: ModuleName) {
  if (!t.settings.modules[m]) throw new AppError('FORBIDDEN', `${MODULE_LABEL[m]} is not enabled for this clinic.`);
}

export async function setModules(tenant: Tenant, modules: Partial<Modules>, extra: Partial<Pick<TenantSettings, 'autoReleasePrescriptions' | 'recordsRequestDays' | 'emergencyAccessMinutes' | 'jitsiBaseUrl' | 'twoFactorRoles' | 'drawerVarianceApprovalPaise' | 'formularyMode'>> = {}) {
  const next = { ...tenant.settings.modules, ...modules };
  await withPlatform((tx) => tx.exec(`UPDATE tenant SET settings = settings || $2::jsonb, updated_at = now() WHERE id = $1`,
    [tenant.id, JSON.stringify({ modules: next, ...extra })]));
  invalidateTenantCache(tenant.slug);
}

/** Encrypted provider credentials per clinic. */
export async function setSecret(tx: Tx, name: string, value: string, staffIdValue: string | null) {
  const { encrypt } = await import('@/lib/secrets');
  await tx.exec(`INSERT INTO tenant_secret (tenant_id, name, ciphertext, hint, updated_by) VALUES (app_tenant_id(), $1, $2, $3, $4)
                 ON CONFLICT (tenant_id, name) DO UPDATE SET ciphertext = EXCLUDED.ciphertext, hint = EXCLUDED.hint, updated_at = now(), updated_by = EXCLUDED.updated_by`,
    [name, encrypt(value), value.length > 8 ? `…${value.slice(-4)}` : '…', staffIdValue]);
}

export async function getSecret(tx: Tx, name: string): Promise<string | null> {
  const { decrypt } = await import('@/lib/secrets');
  const r = await tx.maybe<{ ciphertext: string }>(`SELECT ciphertext FROM tenant_secret WHERE name = $1`, [name]);
  return r ? decrypt(r.ciphertext) : null;
}

function hydrate(row: Tenant): Tenant {
  return { ...row, branding: row.branding ?? {}, settings: { ...DEFAULT_SETTINGS, ...(row.settings ?? {}), modules: { ...DEFAULT_SETTINGS.modules, ...(row.settings?.modules ?? {}) } } };
}

const cache = new Map<string, { t: Tenant; at: number }>();

export async function getTenantBySlug(slug: string, { allowSuspended = false } = {}): Promise<Tenant> {
  const hit = cache.get(slug);
  let t: Tenant | null = hit && Date.now() - hit.at < 15_000 ? hit.t : null;
  if (!t) {
    const row = await withPlatform((tx) => tx.maybe<Tenant>(`SELECT * FROM tenant WHERE slug = $1`, [slug]));
    if (!row) throw new AppError('NOT_FOUND', 'Clinic not found');
    t = hydrate(row);
    cache.set(slug, { t, at: Date.now() });
  }
  if (t.status !== 'active' && !allowSuspended) throw new AppError('TENANT_SUSPENDED', 'This clinic account is not active');
  return t;
}

export function invalidateTenantCache(slug?: string) {
  if (slug) cache.delete(slug); else cache.clear();
}

const DEFAULT_ACCOUNTS: [string, string, string][] = [
  ['1000', 'Cash in hand', 'asset'],
  ['1010', 'UPI / card / bank clearing', 'asset'],
  ['1100', 'Patient receivables', 'asset'],
  ['2100', 'Patient advances (unallocated receipts)', 'liability'],
  ['2200', 'Tax payable', 'liability'],
  ['4000', 'Clinical service revenue', 'income'],
];

export const createTenantInput = z.object({
  slug: z.string().regex(/^[a-z0-9][a-z0-9-]{1,40}$/, 'lowercase letters, digits and hyphens'),
  name: z.string().min(2).max(200),
  legalName: z.string().max(200).optional(),
  timezone: z.string().default('Asia/Kolkata'),
  currency: z.string().regex(/^[A-Z]{3}$/).default('INR'),
  ownerEmail: z.email(),
  ownerName: z.string().min(2),
  soloPractice: z.boolean().default(false),
  uhidPrefix: z.string().regex(/^[A-Z0-9]{1,6}$/).default('MRN'),
  allowedOrigins: z.array(z.string().url()).default([]),
});

/** Provision a new client clinic: tenant row, ledger, owner login and a publishable website key. */
export async function provisionTenant(input: z.input<typeof createTenantInput>) {
  const p = createTenantInput.parse(input);
  const tempPassword = randomToken(9);
  const tenant = await withPlatform((tx) => tx.one<{ id: string }>(
    `INSERT INTO tenant (slug, name, legal_name, timezone, currency, settings)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
    [p.slug, p.name, p.legalName ?? null, p.timezone, p.currency,
      JSON.stringify({ ...DEFAULT_SETTINGS, soloPractice: p.soloPractice, uhidPrefix: p.uhidPrefix })]));
  const keys = await withTenant(tenant.id, async (tx) => {
    for (const [code, name, type] of DEFAULT_ACCOUNTS) {
      await tx.exec(`INSERT INTO ledger_account (tenant_id, code, name, type) VALUES (app_tenant_id(), $1, $2, $3)`, [code, name, type]);
    }
    await tx.exec(
      `INSERT INTO staff (tenant_id, email, full_name, password_hash, role, must_change_password)
       VALUES (app_tenant_id(), $1, $2, $3, 'owner', true)`,
      [p.ownerEmail, p.ownerName, await bcrypt.hash(tempPassword, 10)]);
    return createApiKey(tx, 'publishable', 'Website booking widget', p.allowedOrigins);
  });
  return { tenantId: tenant.id, slug: p.slug, ownerEmail: p.ownerEmail, tempPassword, publishableKey: keys.key };
}

export async function createApiKey(tx: Tx, kind: 'publishable' | 'secret', label: string, allowedOrigins: string[] = []) {
  const prefix = kind === 'publishable' ? 'pk_' : 'sk_';
  const key = prefix + randomToken(24);
  const origins = allowedOrigins.map((o) => {
    const u = new URL(o);
    return `${u.protocol}//${u.host}`;
  });
  const row = await tx.one<{ id: string }>(
    `INSERT INTO tenant_api_key (tenant_id, kind, label, key_prefix, key_hash, allowed_origins)
     VALUES (app_tenant_id(), $1, $2, $3, $4, $5) RETURNING id`,
    [kind, label, key.slice(0, 10), sha256(key), origins]);
  return { id: row.id, key };
}

/** Resolves an API key to its tenant. tenant_api_key is a routing table, read on the platform connection. */
export async function resolveApiKey(key: string) {
  if (!/^(pk|sk)_[A-Za-z0-9_-]{20,}$/.test(key)) return null;
  return withPlatform((tx) => tx.maybe<{ id: string; tenant_id: string; kind: 'publishable' | 'secret'; allowed_origins: string[]; slug: string; status: string }>(
    `UPDATE tenant_api_key k SET last_used_at = now()
       FROM tenant t
      WHERE k.key_hash = $1 AND k.revoked_at IS NULL AND t.id = k.tenant_id
      RETURNING k.id, k.tenant_id, k.kind, k.allowed_origins, t.slug, t.status`, [sha256(key)]));
}

export const settingsInput = z.object({
  name: z.string().min(2).max(200),
  timezone: z.string(),
  soloPractice: z.boolean(),
  holdMinutes: z.number().int().min(1).max(30),
  noShowGraceMinutes: z.number().int().min(0).max(240),
  bookingHorizonDays: z.number().int().min(1).max(365),
  minLeadMinutes: z.number().int().min(0).max(10080),
  publicBookingEnabled: z.boolean(),
  requireAllergyReviewToSign: z.boolean(),
  branding: z.object({
    primaryColor: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
    accentColor: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
    logoUrl: z.string().url().optional().or(z.literal('')),
    address: z.string().max(500).optional(),
    phone: z.string().max(50).optional(),
    email: z.string().max(200).optional(),
    website: z.string().max(200).optional(),
    registrationText: z.string().max(300).optional(),
    footerNote: z.string().max(500).optional(),
  }),
});

export async function updateTenantSettings(tenant: Tenant, input: z.input<typeof settingsInput>) {
  const p = settingsInput.safeParse(input);
  if (!p.success) throw invalid('Invalid settings', p.error.issues);
  const { name, timezone, branding, ...rest } = p.data;
  await withPlatform((tx) => tx.exec(
    `UPDATE tenant SET name = $2, timezone = $3, branding = $4, settings = settings || $5::jsonb, updated_at = now() WHERE id = $1`,
    [tenant.id, name, timezone, JSON.stringify(branding), JSON.stringify(rest)]));
  invalidateTenantCache(tenant.slug);
}

export async function listIntegrations(tenantId: string) {
  return withTenant(tenantId, async (tx) => ({
    keys: await tx.many<{ id: string; kind: string; label: string; key_prefix: string; allowed_origins: string[]; created_at: Date; last_used_at: Date | null; revoked_at: Date | null }>(
      `SELECT id, kind, label, key_prefix, allowed_origins, created_at, last_used_at, revoked_at FROM tenant_api_key ORDER BY revoked_at NULLS FIRST, created_at DESC`),
    webhooks: await tx.many<{ id: string; url: string; events: string[]; active: boolean; include_contact: boolean }>(
      `SELECT id, url, events, active, include_contact FROM webhook_endpoint ORDER BY created_at DESC`),
    deliveries: await tx.many<{ status: string; n: number }>(
      `SELECT status, count(*)::int AS n FROM webhook_delivery WHERE next_attempt_at > now() - interval '7 days' GROUP BY status`),
  }));
}
