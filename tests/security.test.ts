import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import bcrypt from 'bcryptjs';
import { makeClinic } from './helpers';
import { withTenant, pool } from '../src/lib/db';
after(async () => { await pool().end(); });
import { AppError, toAppError } from '../src/lib/errors';
import { hotp, currentStep, verifyTotp, base32Decode, base32Encode } from '../src/lib/totp';
import { login, completeTwoFactorLogin, beginTwoFactor, confirmTwoFactor, resetStaffTwoFactor, sessionFromToken, disableTwoFactor } from '../src/domain/staff';

const code = async (p: Promise<unknown>) => { try { await p; return 'OK'; } catch (e) { const x = toAppError(e); return x instanceof AppError ? x.code : `RAW:${(e as Error).message}`; } };

test('TOTP matches RFC 6238 test vectors (SHA-1)', () => {
  // RFC 6238 Appendix B secret "12345678901234567890"; 8-digit vectors truncated to the 6 digits authenticator apps show.
  const secret = base32Encode(Buffer.from('12345678901234567890'));
  assert.equal(base32Decode(secret).toString(), '12345678901234567890');
  assert.equal(hotp(secret, Math.floor(59 / 30)), '287082');
  assert.equal(hotp(secret, Math.floor(1111111109 / 30)), '081804');
  assert.equal(hotp(secret, Math.floor(1234567890 / 30)), '005924');
  assert.equal(verifyTotp(secret, '287082', 59_000), 1);
  assert.equal(verifyTotp(secret, '000000', 59_000), null);
});

test('staff two-factor: enrol, challenge, wrong code, replay refused, recovery code single-use, admin reset', async () => {
  const c = await makeClinic();
  const email = `rec@${c.slug}.test`;
  await withTenant(c.tenant.id, (tx) => tx.exec(`UPDATE staff SET password_hash = $1 WHERE lower(email) = $2`, [bcrypt.hashSync('Correct-horse-1', 4), email]));

  const { secret } = await beginTwoFactor(c.reception, c.tenant.name);
  assert.equal(await code(confirmTwoFactor(c.reception, '000000')), 'VALIDATION');
  // Before confirmation, password alone still signs in.
  assert.equal((await login(c.tenant.id, email, 'Correct-horse-1')).kind, 'session');
  const recovery = await confirmTwoFactor(c.reception, hotp(secret, currentStep()));
  assert.equal(recovery.length, 10);

  // Now password gives only a challenge.
  const r1 = await login(c.tenant.id, email, 'Correct-horse-1');
  assert.ok(r1.kind === 'challenge');
  assert.equal(await code(completeTwoFactorLogin(c.tenant.id, r1.challenge, '000000')), 'UNAUTHENTICATED');
  // The code used during enrolment is spent; the next step's code works (simulate by using the next step).
  const next = hotp(secret, currentStep() + 1);
  const ok = await completeTwoFactorLogin(c.tenant.id, r1.challenge, next);
  assert.ok(await sessionFromToken(c.tenant.id, ok.token));
  // A challenge cannot be reused, and the same code cannot be replayed on a fresh challenge.
  assert.equal(await code(completeTwoFactorLogin(c.tenant.id, r1.challenge, next)), 'UNAUTHENTICATED');
  const r2 = await login(c.tenant.id, email, 'Correct-horse-1');
  assert.ok(r2.kind === 'challenge');
  assert.equal(await code(completeTwoFactorLogin(c.tenant.id, r2.challenge, next)), 'UNAUTHENTICATED');
  // Recovery code works once.
  const viaRecovery = await completeTwoFactorLogin(c.tenant.id, r2.challenge, recovery[0]);
  assert.ok(viaRecovery.token);
  const r3 = await login(c.tenant.id, email, 'Correct-horse-1');
  assert.ok(r3.kind === 'challenge');
  assert.equal(await code(completeTwoFactorLogin(c.tenant.id, r3.challenge, recovery[0])), 'UNAUTHENTICATED');

  // Five wrong codes void the challenge even if the sixth is right.
  const r4 = await login(c.tenant.id, email, 'Correct-horse-1');
  assert.ok(r4.kind === 'challenge');
  for (let i = 0; i < 5; i++) await code(completeTwoFactorLogin(c.tenant.id, r4.challenge, '111111'));
  assert.equal(await code(completeTwoFactorLogin(c.tenant.id, r4.challenge, recovery[1])), 'UNAUTHENTICATED');

  // When the clinic requires 2FA for the role, the person cannot switch it off themselves.
  assert.equal(await code(disableTwoFactor(c.reception, true, 'Correct-horse-1', hotp(secret, currentStep()))), 'RULE_VIOLATION');
  // Reception cannot reset others; an admin can, and that revokes sessions.
  assert.equal(await code(resetStaffTwoFactor(c.reception, c.admin.kind === 'staff' ? c.admin.staffId : '')), 'FORBIDDEN');
  await resetStaffTwoFactor(c.admin, c.reception.kind === 'staff' ? c.reception.staffId : '');
  assert.equal(await sessionFromToken(c.tenant.id, ok.token), null);
  assert.equal((await login(c.tenant.id, email, 'Correct-horse-1')).kind, 'session');
});
