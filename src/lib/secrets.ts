import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

/**
 * AES-256-GCM for provider credentials stored per clinic (Razorpay, SMS).
 * APP_ENCRYPTION_KEY: 32 random bytes, base64 (openssl rand -base64 32). Required in production.
 */
function key(): Buffer {
  const k = process.env.APP_ENCRYPTION_KEY;
  if (k) {
    const b = Buffer.from(k, 'base64');
    if (b.length !== 32) throw new Error('APP_ENCRYPTION_KEY must be 32 bytes, base64-encoded');
    return b;
  }
  if (process.env.NODE_ENV === 'production') throw new Error('APP_ENCRYPTION_KEY is required in production');
  return createHash('sha256').update('clinic-core-development-only-key').digest();
}

export function encrypt(plain: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key(), iv);
  const enc = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return ['v1', iv.toString('base64'), c.getAuthTag().toString('base64'), enc.toString('base64')].join('.');
}

export function decrypt(blob: string): string {
  const [v, iv, tag, data] = blob.split('.');
  if (v !== 'v1') throw new Error('Unknown secret format');
  const d = createDecipheriv('aes-256-gcm', key(), Buffer.from(iv, 'base64'));
  d.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([d.update(Buffer.from(data, 'base64')), d.final()]).toString('utf8');
}
