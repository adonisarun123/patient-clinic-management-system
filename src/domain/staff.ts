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
  clinicianId: string | null; mustChangePassword: boolean;
};

export async function login(tenantId: string, email: string, password: string, ip?: string) {
  return withTenant(tenantId, async (tx) => {
    const s = await tx.maybe<{ id: string; password_hash: string; active: boolean; role: Role }>(
      `SELECT id, password_hash, active, role FROM staff WHERE lower(email) = lower($1)`, [email.trim()]);
    // Constant-ish work whether or not the account exists.
    const ok = await bcrypt.compare(password, s?.password_hash ?? DUMMY_HASH);
    if (!s || !ok || !s.active) {
      await tx.exec(`INSERT INTO audit_event (tenant_id, actor_kind, action, entity_kind, ip, data)
                     VALUES (app_tenant_id(), 'public', 'auth.login_failed', 'staff', $1, $2)`,
        [ip ?? null, JSON.stringify({ email: email.toLowerCase().slice(0, 3) + '…' })]);
      throw new AppError('UNAUTHENTICATED', 'Email or password is incorrect');
    }
    const token = randomToken(32);
    await tx.exec(`INSERT INTO staff_session (tenant_id, staff_id, token_hash, expires_at)
                   VALUES (app_tenant_id(), $1, $2, now() + make_interval(hours => $3))`, [s.id, sha256(token), SESSION_HOURS]);
    await tx.exec(`INSERT INTO audit_event (tenant_id, actor_kind, actor_id, actor_role, action, entity_kind, entity_id, ip)
                   VALUES (app_tenant_id(), 'staff', $1, $2, 'auth.login', 'staff', $4, $3)`, [s.id, s.role, ip ?? null, s.id]);
    return { token, maxAge: SESSION_HOURS * 3600 };
  });
}

export async function sessionFromToken(tenantId: string, token: string): Promise<StaffSession | null> {
  if (!token || token.length < 20) return null;
  return withTenant(tenantId, (tx) => tx.maybe<StaffSession>(
    `SELECT s.id AS "staffId", s.tenant_id AS "tenantId", s.role, s.full_name AS name, s.email,
            c.id AS "clinicianId", s.must_change_password AS "mustChangePassword"
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
  return withTenant(actor.tenantId, (tx) => tx.many<{ id: string; email: string; full_name: string; role: Role; active: boolean; clinician_id: string | null; must_change_password: boolean }>(
    `SELECT s.id, s.email, s.full_name, s.role, s.active, s.must_change_password, c.id AS clinician_id
       FROM staff s LEFT JOIN clinician c ON c.staff_id = s.id ORDER BY s.active DESC, s.full_name`));
}
