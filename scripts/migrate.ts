// Applies db/migrations/*.sql in order, once each, inside a transaction per file.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from 'pg';
import { sha256 } from '../src/lib/crypto';

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is not set');
  const client = new Client({ connectionString: url, ssl: /sslmode=require|neon\.tech/.test(url) ? { rejectUnauthorized: true } : undefined });
  await client.connect();
  await client.query(`CREATE TABLE IF NOT EXISTS schema_migration (name text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())`);
  const dir = join(process.cwd(), 'db', 'migrations');
  const files = readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
  const applied = new Map((await client.query<{ name: string; checksum: string }>(`SELECT name, checksum FROM schema_migration`)).rows.map((r) => [r.name, r.checksum]));
  for (const f of files) {
    const sql = readFileSync(join(dir, f), 'utf8');
    const sum = sha256(sql);
    if (applied.has(f)) {
      if (applied.get(f) !== sum) throw new Error(`Migration ${f} was edited after it was applied. Add a new migration instead.`);
      continue;
    }
    process.stdout.write(`applying ${f} … `);
    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query(`INSERT INTO schema_migration (name, checksum) VALUES ($1, $2)`, [f, sum]);
      await client.query('COMMIT');
      console.log('ok');
    } catch (e) {
      await client.query('ROLLBACK');
      console.log('FAILED');
      throw e;
    }
  }
  await client.end();
  console.log('migrations up to date');
}

main().catch((e) => { console.error(e); process.exit(1); });
