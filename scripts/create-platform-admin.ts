// Usage: npm run admin:create -- you@monkmantra.com "Full Name"
// Prints a one-time password for the Monk Mantra platform console (/admin).
import bcrypt from 'bcryptjs';
import { withPlatform, pool } from '../src/lib/db';
import { randomToken } from '../src/lib/crypto';

async function main() {
  const [email, ...name] = process.argv.slice(2);
  if (!email) throw new Error('Usage: npm run admin:create -- email "Full Name"');
  const password = randomToken(12);
  await withPlatform((tx) => tx.exec(
    `INSERT INTO platform_admin (email, full_name, password_hash) VALUES ($1, $2, $3)
     ON CONFLICT (lower(email)) DO UPDATE SET password_hash = EXCLUDED.password_hash, active = true`,
    [email, name.join(' ') || email, bcrypt.hashSync(password, 10)]));
  console.log(`Platform admin ready: ${email}\nTemporary password: ${password}`);
  await pool().end();
}
main().catch((e) => { console.error(e); process.exit(1); });
