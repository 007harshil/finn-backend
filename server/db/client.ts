// Database access: one Kysely instance per server process over a small pg
// pool connected to the Supabase pooler (transaction mode). Tests replace it
// with an in-process PGlite database via setDb().

import { Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';
import { env } from '../env';
import { logger } from '../http/logger';
import type { Database } from './types';

export type Db = Kysely<Database>;

let instance: Db | null = null;

const INT8 = 20;
const DATE = 1082;

function parseInt8(value: string): number {
  const n = Number(value);
  if (!Number.isSafeInteger(n)) throw new RangeError('bigint column out of safe range');
  return n;
}

function createDb(): Db {
  const e = env();
  const ca = process.env.DATABASE_CA_CERT;
  if (!ca) {
    logger.warn('db.tls', { message: 'DATABASE_CA_CERT not set; TLS is used without certificate verification' });
  }
  const pool = new pg.Pool({
    connectionString: e.DATABASE_URL,
    max: e.DATABASE_POOL_MAX,
    idleTimeoutMillis: 10_000,
    connectionTimeoutMillis: 5_000,
    // Bounded statements: a stuck query must not hold a pooled connection.
    statement_timeout: 15_000,
    ssl: ca ? { ca, rejectUnauthorized: true } : { rejectUnauthorized: false },
    types: {
      getTypeParser(oid: number, format?: 'text' | 'binary') {
        if (oid === INT8) return parseInt8;
        if (oid === DATE) return (v: string) => v;
        return pg.types.getTypeParser(oid, format);
      },
    } as pg.CustomTypesConfig,
  });
  pool.on('error', (err) => logger.error('db.pool', { message: err.message }));
  return new Kysely<Database>({ dialect: new PostgresDialect({ pool }) });
}

export function getDb(): Db {
  if (!instance) instance = createDb();
  return instance;
}

/** Test hook: use another database (e.g. PGlite). */
export function setDb(db: Db | null): void {
  instance = db;
}
