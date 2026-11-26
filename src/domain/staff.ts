import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { withTenant, type Tx } from '@/lib/db';
import { AppError, invalid } from '@/lib/errors';
import { randomToken, sha256 } from '@/lib/crypto';
import { ROLES, type Role } from '@/lib/rbac';
import { audit } from '@/lib/events';
import { authorize, type Actor } from '@/lib/actor';

const SESSION_HOURS = 12;
const DUMMY_HASH = bcrypt.hashSync('timing-equaliser', 10);

export type StaffSession = {
  staffId: string; tenantId: string; role: Role; name: string; email: string;
  clinicianId: string | null; mustChangePassword: boolean; twoFactorEnabled: boolean;
};

export type LoginResult = { kind: 'session'; token: string; maxAge: number } | { kind: 'challenge'; challenge: string; maxAge: number };
const CHALLENGE_MINUTES = 5;
const MAX_CODE_ATTEMPTS = 5;

async function issueSession(tx: Tx, staffIdValue: string, role: Role, ip?: string, how = 'password') {
  const token = randomToken(32);
  await tx.exec(`INSERT INTO staff_session (tenant_id, staff_id, token_hash, expires_at)
                 VALUES (app_tenant_id(), $1, $2, now() + make_interval(hours => $3))`, [staffIdValue, sha256(token), SESSION_HOURS]);
  await tx.exec(`INSERT INTO audit_event (tenant_id, actor_kind, actor_id, actor_role, action, entity_kind, entity_id, ip, data)
                 VALUES (app_tenant_id(), 'staff', $1, $2, 'auth.login', 'staff', $5, $3, $4)`, [staffIdValue, role, ip ?? null, JSON.stringify({ factor: how }), staffIdValue]);
  return { kind: 'session' as const, token, maxAge: SESSION_HOURS * 3600 };
}

/** Step 1: password. Staff with two-factor switched on get a short-lived challenge instead of a session. */
export async function login(tenantId: string, email: string, password: string, ip?: string): Promise<LoginResult> {
  return withTenant(tenantId, async (tx) => {
    const s = await tx.maybe<{ id: string; password_hash: string; active: boolean; role: Role; totp_enabled_at: Date | null }>(
      `SELECT id, password_hash, active, role, totp_enabled_at FROM staff WHERE lower(email) = lower($1)`, [email.trim()]);
    // Constant-ish work whether or not the account exists.
    const ok = await bcrypt.compare(password, s?.password_hash ?? DUMMY_HASH);
    if (!s || !ok || !s.active) {
      await tx.exec(`INSERT INTO audit_event (tenant_id, actor_kind, action, entity_kind, ip, data)
                     VALUES (app_tenant_id(), 'public', 'auth.login_failed', 'staff', $1, $2)`,
        [ip ?? null, JSON.stringify({ email: email.toLowerCase().slice(0, 3) + '…' })]);
      throw new AppError('UNAUTHENTICATED', 'Email or password is incorrect');
    }
    if (!s.totp_enabled_at) return issueSession(tx, s.id, s.role, ip);
    const challenge = randomToken(32);
    await tx.exec(`INSERT INTO staff_login_challenge (tenant_id, staff_id, token_hash, expires_at, ip)
                   VALUES (app_tenant_id(), $1, $2, now() + make_interval(mins => $3), $4)`, [s.id, sha256(challenge), CHALLENGE_MINUTES, ip ?? null]);
    return { kind: 'challenge', challenge, maxAge: CHALLENGE_MINUTES * 60 };
  });
}

/** Step 2: authenticator code (or a one-time recovery code). Five wrong codes void the challenge. */
export async function completeTwoFactorLogin(tenantId: string, challenge: string, code: string, ip?: string) {
  const { decrypt } = await import('@/lib/secrets');
  const { verifyTotp, hashRecovery } = await import('@/lib/totp');
  // Wrong codes must count even though the request fails, so the attempt counter is updated in its own transaction.
  const c = await withTenant(tenantId, (tx) => tx.maybe<{ id: string; staff_id: string; attempts: number }>(
    `UPDATE staff_login_challenge SET attempts = attempts + 1
      WHERE token_hash = $1 AND used_at IS NULL AND expires_at > now() AND attempts < $2
      RETURNING id, staff_id, attempts`, [sha256(challenge ?? ''), MAX_CODE_ATTEMPTS]));
  if (!c) throw new AppError('UNAUTHENTICATED', 'Sign-in expired or too many attempts. Start again.');
  return withTenant(tenantId, async (tx) => {
    const s = await tx.one<{ id: string; role: Role; active: boolean; totp_secret_enc: string | null; totp_last_step: string | null; recovery_code_hashes: string[] }>(
      `SELECT id, role, active, totp_secret_enc, totp_last_step, recovery_code_hashes FROM staff WHERE id = $1 FOR UPDATE`, [c.staff_id]);
    if (!s.active || !s.totp_secret_enc) throw new AppError('UNAUTHENTICATED', 'Sign-in expired. Start again.');
    const trimmed = code.trim();
    let how = 'totp';
    if (/^\d{3}\s?\d{3}$/.test(trimmed)) {
      const step = verifyTotp(decrypt(s.totp_secret_enc), trimmed);
      if (step === null || (s.totp_last_step !== null && step <= Number(s.totp_last_step))) {
        await tx.exec(`INSERT INTO audit_event (tenant_id, actor_kind, actor_id, action, entity_kind, entity_id, ip)
                       VALUES (app_tenant_id(), 'public', $1, 'auth.second_factor_failed', 'staff', $3, $2)`, [s.id, ip ?? null, s.id]);
        throw new AppError('UNAUTHENTICATED', `That code is not valid. ${MAX_CODE_ATTEMPTS - c.attempts} attempt(s) left.`);
      }
      await tx.exec(`UPDATE staff SET totp_last_step = $2 WHERE id = $1`, [s.id, step]);
    } else {
      const h = hashRecovery(trimmed);
      if (!s.recovery_code_hashes.includes(h)) throw new AppError('UNAUTHENTICATED', `That recovery code is not valid. ${MAX_CODE_ATTEMPTS - c.attempts} attempt(s) left.`);
      await tx.exec(`UPDATE staff SET recovery_code_hashes = array_remove(recovery_code_hashes, $2) WHERE id = $1`, [s.id, h]);
      how = 'recovery_code';
    }
    await tx.exec(`UPDATE staff_login_challenge SET used_at = now() WHERE id = $1`, [c.id]);
    return issueSession(tx, s.id, s.role, ip, how);
  });
}

export async function sessionFromToken(tenantId: string, token: string): Promise<StaffSession | null> {
  if (!token || token.length < 20) return null;
  return withTenant(tenantId, (tx) => tx.maybe<StaffSession>(
    `SELECT s.id AS "staffId", s.tenant_id AS "tenantId", s.role, s.full_name AS name, s.email,
            c.id AS "clinicianId", s.must_change_password AS "mustChangePassword",
            (s.totp_enabled_at IS NOT NULL) AS "twoFactorEnabled"
       FROM staff_session ss JOIN staff s ON s.id = ss.staff_id
       LEFT JOIN clinician c ON c.staff_id = s.id AND c.active
      WHERE ss.token_hash = $1 AND ss.revoked_at IS NULL AND ss.expires_at > now() AND s.active`, [sha256(token)]));
}

export async function logout(tenantId: string, token: string) {
  await withTenant(tenantId, (tx) => tx.exec(`UPDATE staff_session SET revoked_at = now() WHERE token_hash = $1`, [sha256(token)]));
}

export async function changePassword(actor: Actor, current: string, next: string) {
  if (actor.kind !== 'staff') throw new AppError('FORBIDDEN', 'Staff only');
  if (next.length < 10) throw invalid('Use at least 10 characters for the new password');
  await withTenant(actor.tenantId, async (tx) => {
    const s = await tx.one<{ password_hash: string }>(`SELECT password_hash FROM staff WHERE id = $1`, [actor.staffId]);
    if (!(await bcrypt.compare(current, s.password_hash))) throw new AppError('UNAUTHENTICATED', 'Current password is incorrect');
    await tx.exec(`UPDATE staff SET password_hash = $2, must_change_password = false WHERE id = $1`, [actor.staffId, await bcrypt.hash(next, 10)]);
    await audit(tx, actor, 'staff.password_changed', 'staff', actor.staffId);
  });
}

export const staffInput = z.object({
  email: z.email(),
  fullName: z.string().min(2).max(200),
  role: z.enum(ROLES),
  // When the person practises, a clinician profile is created alongside the login.
  clinician: z.object({
    qualification: z.string().max(200).optional(),
    specialty: z.string().max(200).optional(),
    registrationCouncil: z.string().max(200).optional(),
    registrationNumber: z.string().max(100).optional(),
    departmentIds: z.array(z.uuid()).default([]),
  }).optional(),
});

export async function createStaff(actor: Actor, input: z.input<typeof staffInput>) {
  authorize(actor, 'staff.manage');
  const p = staffInput.parse(input);
  if (p.role === 'owner' && !(actor.kind === 'staff' && actor.role === 'owner')) throw new AppError('FORBIDDEN', 'Only an owner can add another owner');
  const tempPassword = randomToken(9);
  return withTenant(actor.tenantId, async (tx) => {
    const s = await tx.one<{ id: string }>(
      `INSERT INTO staff (tenant_id, email, full_name, password_hash, role, must_change_password)
       VALUES (app_tenant_id(), $1, $2, $3, $4, true) RETURNING id`,
      [p.email, p.fullName, await bcrypt.hash(tempPassword, 10), p.role]);
    let clinicianId: string | null = null;
    if (p.clinician) clinicianId = await createClinicianRow(tx, { ...p.clinician, staffId: s.id, displayName: p.fullName });
    await audit(tx, actor, 'staff.created', 'staff', s.id, { data: { role: p.role, clinician: !!clinicianId } });
    return { staffId: s.id, clinicianId, tempPassword };
  });
}

export async function createClinicianRow(tx: Tx, c: {
  staffId?: string | null; displayName: string; qualification?: string; specialty?: string;
  registrationCouncil?: string; registrationNumber?: string; departmentIds?: string[];
}) {
  const row = await tx.one<{ id: string }>(
    `INSERT INTO clinician (tenant_id, staff_id, display_name, qualification, specialty, registration_council, registration_number)
     VALUES (app_tenant_id(), $1, $2, $3, $4, $5, $6) RETURNING id`,
    [c.staffId ?? null, c.displayName, c.qualification ?? null, c.specialty ?? null, c.registrationCouncil ?? null, c.registrationNumber ?? null]);
  for (const d of c.departmentIds ?? []) {
    await tx.exec(`INSERT INTO clinician_department (tenant_id, clinician_id, department_id) VALUES (app_tenant_id(), $1, $2)`, [row.id, d]);
  }
  return row.id;
}

/** CFG-002: deactivation closes access immediately (sessions revoked). */
export async function setStaffActive(actor: Actor, staffIdToChange: string, active: boolean) {
  authorize(actor, 'staff.manage');
  if (actor.kind === 'staff' && actor.staffId === staffIdToChange && !active) throw invalid('You cannot deactivate your own account');
  await withTenant(actor.tenantId, async (tx) => {
    await tx.exec(`UPDATE staff SET active = $2, deactivated_at = CASE WHEN $2 THEN NULL ELSE now() END WHERE id = $1`, [staffIdToChange, active]);
    if (!active) await tx.exec(`UPDATE staff_session SET revoked_at = now() WHERE staff_id = $1 AND revoked_at IS NULL`, [staffIdToChange]);
    await audit(tx, actor, active ? 'staff.activated' : 'staff.deactivated', 'staff', staffIdToChange);
  });
}

export async function resetStaffPassword(actor: Actor, target: string) {
  authorize(actor, 'staff.manage');
  const tempPassword = randomToken(9);
  await withTenant(actor.tenantId, async (tx) => {
    await tx.exec(`UPDATE staff SET password_hash = $2, must_change_password = true WHERE id = $1`, [target, await bcrypt.hash(tempPassword, 10)]);
    await tx.exec(`UPDATE staff_session SET revoked_at = now() WHERE staff_id = $1 AND revoked_at IS NULL`, [target]);
    await audit(tx, actor, 'staff.password_reset', 'staff', target);
  });
  return tempPassword;
}

export async function listStaff(actor: Actor) {
  authorize(actor, 'staff.manage');
  return withTenant(actor.tenantId, (tx) => tx.many<{ id: string; email: string; full_name: string; role: Role; active: boolean; clinician_id: string | null; must_change_password: boolean; two_factor: boolean }>(
    `SELECT s.id, s.email, s.full_name, s.role, s.active, s.must_change_password, c.id AS clinician_id, (s.totp_enabled_at IS NOT NULL) AS two_factor
       FROM staff s LEFT JOIN clinician c ON c.staff_id = s.id ORDER BY s.active DESC, s.full_name`));
}

// ------------------------------------------------------------------ two-factor enrolment (staff)
/** Starts (or restarts) enrolment: a new secret is stored encrypted but not active until a code from it is confirmed. */
export async function beginTwoFactor(actor: Actor, issuer: string) {
  if (actor.kind !== 'staff') throw new AppError('FORBIDDEN', 'Staff only');
  const { encrypt } = await import('@/lib/secrets');
  const { newSecret, otpauthUri } = await import('@/lib/totp');
  return withTenant(actor.tenantId, async (tx) => {
    const s = await tx.one<{ email: string; totp_enabled_at: Date | null }>(`SELECT email, totp_enabled_at FROM staff WHERE id = $1`, [actor.staffId]);
    if (s.totp_enabled_at) throw invalid('Two-factor sign-in is already on. Turn it off first to move it to a new phone.');
    const secret = newSecret();
    await tx.exec(`UPDATE staff SET totp_secret_enc = $2 WHERE id = $1`, [actor.staffId, encrypt(secret)]);
    return { secret, uri: otpauthUri(secret, s.email, issuer) };
  });
}

export async function confirmTwoFactor(actor: Actor, code: string, currentToken?: string) {
  if (actor.kind !== 'staff') throw new AppError('FORBIDDEN', 'Staff only');
  const { decrypt } = await import('@/lib/secrets');
  const { verifyTotp, newRecoveryCodes } = await import('@/lib/totp');
  return withTenant(actor.tenantId, async (tx) => {
    const s = await tx.one<{ totp_secret_enc: string | null; totp_enabled_at: Date | null }>(`SELECT totp_secret_enc, totp_enabled_at FROM staff WHERE id = $1 FOR UPDATE`, [actor.staffId]);
    if (s.totp_enabled_at) throw invalid('Two-factor sign-in is already on');
    if (!s.totp_secret_enc) throw invalid('Start set-up first');
    const step = verifyTotp(decrypt(s.totp_secret_enc), code);
    if (step === null) throw invalid('That code did not match. Check the phone’s clock is set automatically, then try the newest code.');
    const rc = newRecoveryCodes();
    await tx.exec(`UPDATE staff SET totp_enabled_at = now(), totp_last_step = $2, recovery_code_hashes = $3 WHERE id = $1`, [actor.staffId, step, rc.hashes]);
    // Other signed-in sessions were created with the password alone; end them.
    await tx.exec(`UPDATE staff_session SET revoked_at = now() WHERE staff_id = $1 AND revoked_at IS NULL AND token_hash <> $2`, [actor.staffId, sha256(currentToken ?? '')]);
    await audit(tx, actor, 'staff.two_factor_enabled', 'staff', actor.staffId);
    return rc.codes;
  });
}

/** Turning it off needs the password and a current code; not allowed when the clinic requires it for this role. */
export async function disableTwoFactor(actor: Actor, requiredForRole: boolean, password: string, code: string) {
  if (actor.kind !== 'staff') throw new AppError('FORBIDDEN', 'Staff only');
  if (requiredForRole) throw new AppError('RULE_VIOLATION', 'Your clinic requires two-factor sign-in for your role. Ask an administrator to reset it if you changed phones.');
  const { decrypt } = await import('@/lib/secrets');
  const { verifyTotp } = await import('@/lib/totp');
  await withTenant(actor.tenantId, async (tx) => {
    const s = await tx.one<{ password_hash: string; totp_secret_enc: string | null; totp_enabled_at: Date | null }>(
      `SELECT password_hash, totp_secret_enc, totp_enabled_at FROM staff WHERE id = $1 FOR UPDATE`, [actor.staffId]);
    if (!s.totp_enabled_at || !s.totp_secret_enc) throw invalid('Two-factor sign-in is not on');
    if (!(await bcrypt.compare(password, s.password_hash))) throw new AppError('UNAUTHENTICATED', 'Password is incorrect');
    if (verifyTotp(decrypt(s.totp_secret_enc), code) === null) throw new AppError('UNAUTHENTICATED', 'That code did not match');
    await tx.exec(`UPDATE staff SET totp_secret_enc = NULL, totp_enabled_at = NULL, totp_last_step = NULL, recovery_code_hashes = '{}' WHERE id = $1`, [actor.staffId]);
    await audit(tx, actor, 'staff.two_factor_disabled', 'staff', actor.staffId);
  });
}

/** Lost phone: an administrator clears the second factor; the person must enrol again at next sign-in. */
export async function resetStaffTwoFactor(actor: Actor, target: string) {
  authorize(actor, 'staff.manage');
  if (actor.kind === 'staff' && actor.staffId === target) throw invalid('Ask another administrator to reset your own two-factor sign-in');
  await withTenant(actor.tenantId, async (tx) => {
    await tx.exec(`UPDATE staff SET totp_secret_enc = NULL, totp_enabled_at = NULL, totp_last_step = NULL, recovery_code_hashes = '{}' WHERE id = $1`, [target]);
    await tx.exec(`UPDATE staff_session SET revoked_at = now() WHERE staff_id = $1 AND revoked_at IS NULL`, [target]);
    await audit(tx, actor, 'staff.two_factor_reset', 'staff', target);
  });
}

export async function recoveryCodesLeft(actor: Actor) {
  if (actor.kind !== 'staff') return 0;
  return withTenant(actor.tenantId, async (tx) => (await tx.one<{ n: number }>(`SELECT cardinality(recovery_code_hashes)::int AS n FROM staff WHERE id = $1`, [actor.staffId])).n);
}
