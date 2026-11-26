// CI guard for database migrations, run against the commit being merged or deployed.
//   npx tsx scripts/check-migrations.ts <base-git-ref>
// Production applies migrations during the Vercel build, before Deployment Checks decide whether the new code goes
// live — so a migration can reach the database while the old code is still serving. This guard enforces the rules
// that keep that safe:
//   1. Migrations already on the base commit are never edited or deleted (the migrator also refuses at deploy time).
//   2. New migrations sort after every existing one (so they apply in the order they were written).
//   3. New migrations are additive ("expand" only). Dropping, renaming, retyping or emptying anything needs an
//      explicit `-- allow-destructive: <reason>` line, and should ship only after the code that stopped using the
//      old shape is already live.
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';

const DIR = 'db/migrations';
const base = process.argv[2];
const errors: string[] = [];

const head = readdirSync(DIR).filter((f) => f.endsWith('.sql')).sort();
for (const f of head) if (!/^\d{3}_[a-z0-9_]+\.sql$/.test(f)) errors.push(`${f}: name must look like 001_short_description.sql`);

let baseFiles: string[] = [];
if (base && !/^0+$/.test(base)) {
  try {
    baseFiles = execFileSync('git', ['ls-tree', '--name-only', base, `${DIR}/`], { encoding: 'utf8' })
      .split('\n').filter((p) => p.endsWith('.sql')).map((p) => p.slice(DIR.length + 1)).sort();
  } catch { console.warn(`base ${base} not found; checking new-migration rules against all files`); }
}

for (const f of baseFiles) {
  if (!head.includes(f)) { errors.push(`${f}: deleted — applied migrations must never be removed`); continue; }
  const before = execFileSync('git', ['show', `${base}:${DIR}/${f}`], { encoding: 'utf8' });
  if (before !== readFileSync(`${DIR}/${f}`, 'utf8')) errors.push(`${f}: edited after it shipped — add a new migration instead`);
}

const added = head.filter((f) => !baseFiles.includes(f));
const lastBase = baseFiles.at(-1);
const DESTRUCTIVE = [
  /\bDROP\s+(TABLE|COLUMN|SCHEMA|TYPE|VIEW|FUNCTION|TRIGGER|INDEX)\b/i,
  /\bRENAME\s+(COLUMN|TO)\b/i, /\bALTER\s+COLUMN\s+\w+\s+(SET\s+DATA\s+)?TYPE\b/i,
  /\bTRUNCATE\b/i, /\bDELETE\s+FROM\b/i, /\bSET\s+NOT\s+NULL\b/i,
];
for (const f of added) {
  if (lastBase && f <= lastBase) errors.push(`${f}: sorts before the latest shipped migration ${lastBase}; renumber it`);
  const sql = readFileSync(`${DIR}/${f}`, 'utf8');
  const code = sql.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n');
  const hits = DESTRUCTIVE.filter((re) => re.test(code)).map((re) => code.match(re)![0]);
  if (hits.length && !/^--\s*allow-destructive:\s*\S/m.test(sql))
    errors.push(`${f}: destructive change (${hits.join(', ')}) — split into expand/contract, or add "-- allow-destructive: <reason>"`);
}

if (errors.length) { console.error('Migration check failed:\n- ' + errors.join('\n- ')); process.exit(1); }
console.log(`Migration check passed (${baseFiles.length} shipped, ${added.length} new${added.length ? ': ' + added.join(', ') : ''})`);
