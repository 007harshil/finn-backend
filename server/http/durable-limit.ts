// Sliding-window rate limits shared by every server instance (Postgres).
//
// The in-memory limiters stay in front as a cheap first gate against floods
// on one instance; this check makes the configured limit hold across the
// whole deployment. One row per allowed request in finn_auth.rate_limit_hits,
// keyed by bucket and a SHA-256 prefix of the client key. A refused request
// is not recorded, matching the in-memory limiters.

import { createHash } from 'node:crypto';
import { sql } from 'kysely';
import { getDb } from '../db/client';

export type DurableBucket = 'auth.otp' | 'auth.verify' | 'auth.refresh' | 'agent.completions';

export interface LimitWindow {
  /** Window length in milliseconds. */
  ms: number;
  /** Requests allowed inside the window. */
  limit: number;
}

export type WindowDecision = { allowed: true } | { allowed: false; retryAfterSeconds: number };

/** Rows older than this are removed by the occasional global sweep (longest window in use). */
const SWEEP_AGE_MS = 24 * 60 * 60_000;
const SWEEP_PROBABILITY = 0.01;
const SWEEP_BATCH = 1000;

/** Never stores IPs or user ids in clear. */
export function durableKey(raw: string): string {
  return createHash('sha256').update(raw).digest('hex').slice(0, 32);
}

/**
 * Decision for one more request given earlier allowed requests [hits]
 * (epoch ms, ascending): refused when any window is full, with the time until
 * enough hits leave every full window.
 */
export function decideWindows(hits: number[], windows: LimitWindow[], now: number): WindowDecision {
  let blockedUntil = 0;
  for (const w of windows) {
    const start = now - w.ms;
    let first = hits.length;
    while (first > 0 && hits[first - 1] > start) first--;
    if (hits.length - first >= w.limit) blockedUntil = Math.max(blockedUntil, hits[hits.length - w.limit] + w.ms);
  }
  if (blockedUntil > 0) return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil((blockedUntil - now) / 1000)) };
  return { allowed: true };
}

export interface DurableOptions {
  now?: number;
  /** Test hook: forces (1) or skips (0) the global sweep. */
  sweepRoll?: number;
}

/** Records one request for [rawKey] in [bucket] if every window allows it. */
export async function takeDurable(
  bucket: DurableBucket,
  rawKey: string,
  windows: LimitWindow[],
  opts: DurableOptions = {},
): Promise<WindowDecision> {
  const now = opts.now ?? Date.now();
  const key = durableKey(rawKey);
  const cutoff = new Date(now - Math.max(...windows.map((w) => w.ms)));
  const decision = await getDb()
    .transaction()
    .execute(async (tx) => {
      // Serialise concurrent requests for the same client so two instances
      // cannot both take the last slot.
      await sql`select pg_advisory_xact_lock(hashtextextended(${`${bucket}:${key}`}, 13))`.execute(tx);
      const rows = await sql<{ ms: number | string }>`
        with expired as (
          delete from finn_auth.rate_limit_hits where bucket = ${bucket} and key = ${key} and at <= ${cutoff}
        )
        select (extract(epoch from at) * 1000)::float8 as ms
        from finn_auth.rate_limit_hits
        where bucket = ${bucket} and key = ${key} and at > ${cutoff}
        order by at`.execute(tx);
      const result = decideWindows(rows.rows.map((r) => Number(r.ms)), windows, now);
      if (result.allowed) {
        await sql`insert into finn_auth.rate_limit_hits (bucket, key, at) values (${bucket}, ${key}, ${new Date(now)})`.execute(tx);
      }
      return result;
    });
  if ((opts.sweepRoll ?? Math.random()) < SWEEP_PROBABILITY) await sweep(now);
  return decision;
}

/** Bounded delete of rows no window can still see (keys that went quiet). */
async function sweep(now: number): Promise<void> {
  await sql`
    delete from finn_auth.rate_limit_hits
    where id in (select id from finn_auth.rate_limit_hits where at <= ${new Date(now - SWEEP_AGE_MS)} limit ${SWEEP_BATCH})`.execute(getDb());
}

/** Test-only: forget every shared hit. */
export async function resetDurableLimits(): Promise<void> {
  await sql`delete from finn_auth.rate_limit_hits`.execute(getDb());
}
