import { Pool, types, type PoolClient, type QueryResultRow } from 'pg';
import { fromPg, AppError } from './errors';

// Dates stay as 'YYYY-MM-DD' strings (no local-midnight shifting); int8 money fits safely in Number.
types.setTypeParser(1082, (v: string) => v);
types.setTypeParser(20, (v: string) => Number(v));

declare global {
  // eslint-disable-next-line no-var
  var __clinicPool: Pool | undefined;
}

export function pool(): Pool {
  if (!globalThis.__clinicPool) {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error('DATABASE_URL is not set');
    globalThis.__clinicPool = new Pool({
      connectionString: url,
      max: Number(process.env.DB_POOL_MAX ?? 10),
      ssl: /sslmode=require|neon\.tech/.test(url) ? { rejectUnauthorized: true } : undefined,
    });
  }
  return globalThis.__clinicPool;
}

/** A transaction-bound client. All queries in one call of withTenant share one transaction. */
export class Tx {
  constructor(private readonly client: PoolClient, readonly tenantId: string | null) {}
  async many<T extends QueryResultRow = QueryResultRow>(sql: string, params: unknown[] = []): Promise<T[]> {
    try {
      return (await this.client.query<T>(sql, params)).rows;
    } catch (e) {
      throw fromPg(e);
    }
  }
  async one<T extends QueryResultRow = QueryResultRow>(sql: string, params: unknown[] = []): Promise<T> {
    const rows = await this.many<T>(sql, params);
    if (rows.length !== 1) throw new AppError('NOT_FOUND', 'Record not found');
    return rows[0];
  }
  async maybe<T extends QueryResultRow = QueryResultRow>(sql: string, params: unknown[] = []): Promise<T | null> {
    const rows = await this.many<T>(sql, params);
    return rows[0] ?? null;
  }
  async exec(sql: string, params: unknown[] = []): Promise<number> {
    try {
      return (await this.client.query(sql, params)).rowCount ?? 0;
    } catch (e) {
      throw fromPg(e);
    }
  }
  /** Savepoint so a recoverable failure (e.g. a losing slot race) does not abort the outer transaction. */
  async savepoint<T>(fn: () => Promise<T>): Promise<T> {
    const name = `sp_${Math.random().toString(36).slice(2, 10)}`;
    await this.client.query(`SAVEPOINT ${name}`);
    try {
      const r = await fn();
      await this.client.query(`RELEASE SAVEPOINT ${name}`);
      return r;
    } catch (e) {
      await this.client.query(`ROLLBACK TO SAVEPOINT ${name}`);
      throw e;
    }
  }
}

async function run<T>(tenantId: string | null, fn: (tx: Tx) => Promise<T>): Promise<T> {
  const client = await pool().connect();
  try {
    await client.query('BEGIN');
    if (tenantId) await client.query(`SELECT set_config('app.tenant_id', $1, true)`, [tenantId]);
    const result = await fn(new Tx(client, tenantId));
    await client.query('COMMIT');
    return result;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw fromPg(e);
  } finally {
    client.release();
  }
}

/** Run inside one transaction with row-level security bound to a single tenant. */
export function withTenant<T>(tenantId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  if (!/^[0-9a-f-]{36}$/i.test(tenantId)) throw new AppError('VALIDATION', 'Invalid tenant');
  return run(tenantId, fn);
}

/** Platform-level transaction (tenant routing table, platform admins). Tenant tables return no rows here. */
export function withPlatform<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
  return run(null, fn);
}
