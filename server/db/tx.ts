// Every user-scoped database operation runs here: one transaction that
// switches to the dedicated `finn_api` role with the caller's JWT claims, so
// Row Level Security isolates users inside the API too. (Clients cannot use
// that role: the Supabase Data API's `authenticated` role has no privileges on
// FiNN tables.) Queries additionally filter by user_id explicitly.
//
// Writes take a per-user advisory lock, which serialises one user's
// operations (balance checks such as "contribution <= available" cannot race)
// and keeps each user's sync_seq ordering consistent with commit order.

import { sql, type Transaction } from 'kysely';
import type { AuthUser } from '../auth/verify';
import { getDb } from './client';
import type { Database } from './types';

export type Tx = Transaction<Database>;

export interface TxOptions {
  /** One snapshot for every statement (sync: a cursor must not skip rows committed mid-read). */
  isolation?: 'repeatable read';
  /** Take the per-user write lock(s). Extra users are locked too (shared items), in a fixed order. */
  write?: boolean;
  alsoLock?: string[];
}

export async function lockUsers(tx: Tx, userIds: string[]): Promise<void> {
  for (const id of [...new Set(userIds)].sort()) {
    await sql`select pg_advisory_xact_lock(hashtextextended(${id}, 7))`.execute(tx);
  }
}

export async function withUserTx<T>(user: AuthUser, fn: (tx: Tx) => Promise<T>, opts: TxOptions = {}): Promise<T> {
  let builder = getDb().transaction();
  if (opts.isolation) builder = builder.setIsolationLevel(opts.isolation);
  return builder.execute(async (tx) => {
      await sql`select set_config('request.jwt.claims', ${JSON.stringify(user.claims)}, true), set_config('role', 'finn_api', true)`.execute(tx);
      if (opts.write) await lockUsers(tx, [user.userId, ...(opts.alsoLock ?? [])]);
      return fn(tx);
    });
}
