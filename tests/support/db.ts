// Integration-test database: an in-process Postgres (PGlite) with a minimal
// stand-in for Supabase's auth schema and roles, plus the real migrations from
// supabase/migrations. RLS, triggers, constraints and functions all run for real.

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { Kysely, PGliteDialect } from 'kysely';
import { setDb, type Db } from '@/server/db/client';
import type { Database } from '@/server/db/types';
import { setTokenVerifier, type AuthUser } from '@/server/auth/verify';
import { resetBootstrapCache } from '@/server/http/handler';
import { dispatcherEnv } from '@/server/actions/dispatcher';
import { sequentialIds } from '@/server/core/ids';
import { withUserTx } from '@/server/db/tx';
import { ensureAccount } from '@/server/modules/account/bootstrap';

const SUPABASE_STUB = `
create role anon nologin;
create role authenticated nologin;
create role service_role nologin;
create schema auth;
create table auth.users (id uuid primary key, email text);
create function auth.uid() returns uuid language sql stable as $$
  select nullif(coalesce(current_setting('request.jwt.claim.sub', true),
                         (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')), '')::uuid
$$;
grant usage on schema public to anon, authenticated, service_role;
grant usage on schema auth to anon, authenticated, service_role;
grant execute on function auth.uid() to anon, authenticated, service_role;
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
alter default privileges in schema public grant all on functions to anon, authenticated, service_role;
`;

const MIGRATIONS_DIR = join(__dirname, '..', '..', 'supabase', 'migrations');

export interface TestDb {
  db: Db;
  pglite: PGlite;
  /** Creates an auth user with a bootstrapped account (profile, preferences, categories). */
  createUser(email?: string): Promise<AuthUser>;
  /** Bearer token accepted by the test verifier for [user]. */
  tokenFor(user: AuthUser): string;
  close(): Promise<void>;
}

export async function createTestDb(): Promise<TestDb> {
  const pglite = new PGlite({
    parsers: {
      20: (v: string) => {
        const n = Number(v);
        if (!Number.isSafeInteger(n)) throw new RangeError('int8 out of range');
        return n;
      },
      1082: (v: string) => v,
    },
  });
  await pglite.waitReady;
  await pglite.exec(SUPABASE_STUB);
  for (const file of readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort()) {
    await pglite.exec(readFileSync(join(MIGRATIONS_DIR, file), 'utf8'));
  }
  const db = new Kysely<Database>({ dialect: new PGliteDialect({ pglite }) });
  setDb(db);
  resetBootstrapCache();
  dispatcherEnv.ids = sequentialIds();

  const users = new Map<string, AuthUser>();
  setTokenVerifier(async (token) => {
    const u = users.get(token);
    if (!u) {
      const { AppFailure } = await import('@/server/core/failure');
      throw new AppFailure('unauthenticated', 'Your session has expired. Please sign in again.');
    }
    return u;
  });

  return {
    db,
    pglite,
    async createUser(email) {
      const id = randomUUID();
      const mail = email ?? `user${users.size + 1}@example.com`;
      await pglite.query('insert into finn_auth.users (id, email) values ($1, $2)', [id, mail]);
      const user: AuthUser = { userId: id, email: mail, claims: { sub: id, role: 'authenticated', email: mail } };
      users.set(`token-${id}`, user);
      // Same bootstrap the HTTP layer runs on a user's first request.
      await withUserTx(user, (tx) => ensureAccount(tx, user), { write: true });
      return user;
    },
    tokenFor(user) {
      return `token-${user.userId}`;
    },
    async close() {
      setDb(null);
      setTokenVerifier(null);
      await db.destroy();
    },
  };
}
