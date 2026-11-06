// Shared (all-instance) rate limits: the same limit must hold when requests
// land on different server instances, i.e. when each instance's in-memory
// limiter is fresh.

import { sql } from 'kysely';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { decideWindows, durableKey, resetDurableLimits, takeDurable } from '@/server/http/durable-limit';
import { limit, limiters } from '@/server/auth/service';
import { createTestDb, type TestDb } from './support/db';

let t: TestDb;

beforeAll(async () => {
  t = await createTestDb();
});
afterAll(async () => t.close());
beforeEach(async () => {
  for (const l of Object.values(limiters)) l.reset();
  await resetDurableLimits();
});

const MIN = 60_000;
const T0 = Date.parse('2026-10-10T03:30:00.000Z');

describe('decideWindows', () => {
  it('allows until a window is full, then reports when the oldest hit leaves', () => {
    expect(decideWindows([], [{ ms: MIN, limit: 2 }], T0)).toEqual({ allowed: true });
    expect(decideWindows([T0 - 10_000], [{ ms: MIN, limit: 2 }], T0)).toEqual({ allowed: true });
    expect(decideWindows([T0 - 10_000, T0 - 5_000], [{ ms: MIN, limit: 2 }], T0)).toEqual({ allowed: false, retryAfterSeconds: 50 });
  });

  it('ignores hits outside the window and takes the longest wait across windows', () => {
    expect(decideWindows([T0 - MIN - 1, T0 - 1_000], [{ ms: MIN, limit: 2 }], T0)).toEqual({ allowed: true });
    const hits = [T0 - 50 * MIN, T0 - 30_000];
    expect(decideWindows(hits, [{ ms: MIN, limit: 5 }, { ms: 60 * MIN, limit: 2 }], T0)).toEqual({ allowed: false, retryAfterSeconds: 600 });
  });
});

describe('takeDurable', () => {
  it('enforces the limit across instances and records only allowed requests', async () => {
    const w = [{ ms: MIN, limit: 2 }];
    expect(await takeDurable('auth.otp', '203.0.113.9', w, { now: T0, sweepRoll: 1 })).toEqual({ allowed: true });
    expect(await takeDurable('auth.otp', '203.0.113.9', w, { now: T0 + 1_000, sweepRoll: 1 })).toEqual({ allowed: true });
    expect(await takeDurable('auth.otp', '203.0.113.9', w, { now: T0 + 2_000, sweepRoll: 1 })).toEqual({ allowed: false, retryAfterSeconds: 58 });
    // Other keys and buckets are independent.
    expect(await takeDurable('auth.otp', '198.51.100.1', w, { now: T0 + 2_000, sweepRoll: 1 })).toEqual({ allowed: true });
    expect(await takeDurable('auth.verify', '203.0.113.9', w, { now: T0 + 2_000, sweepRoll: 1 })).toEqual({ allowed: true });
    // The refused request was not recorded: the first hit leaving frees a slot.
    expect(await takeDurable('auth.otp', '203.0.113.9', w, { now: T0 + MIN + 1, sweepRoll: 1 })).toEqual({ allowed: true });
  });

  it('stores hashed keys only and prunes rows outside the window', async () => {
    await takeDurable('agent.completions', 'user-123', [{ ms: MIN, limit: 5 }], { now: T0, sweepRoll: 1 });
    await takeDurable('agent.completions', 'user-123', [{ ms: MIN, limit: 5 }], { now: T0 + 2 * MIN, sweepRoll: 1 });
    const rows = (await sql<{ key: string }>`select key from finn_auth.rate_limit_hits`.execute(t.db)).rows;
    expect(rows).toEqual([{ key: durableKey('user-123') }]);
    expect(rows[0].key).not.toContain('user-123');
  });

  it('sweeps rows older than a day for keys that went quiet', async () => {
    await takeDurable('auth.refresh', 'quiet', [{ ms: MIN, limit: 5 }], { now: T0, sweepRoll: 1 });
    await takeDurable('auth.refresh', 'busy', [{ ms: MIN, limit: 5 }], { now: T0 + 25 * 60 * MIN, sweepRoll: 0 });
    const keys = (await sql<{ key: string }>`select key from finn_auth.rate_limit_hits order by key`.execute(t.db)).rows.map((r) => r.key);
    expect(keys).toEqual([durableKey('busy')]);
  });
});

describe('sign-in limiter', () => {
  it('keeps the per-IP limit when every request lands on a fresh instance', async () => {
    const ip = '192.0.2.44';
    for (let i = 0; i < limiters.verify.limit; i++) {
      await limit(limiters.verify, ip);
      limiters.verify.reset(); // next request on another instance
    }
    await expect(limit(limiters.verify, ip)).rejects.toMatchObject({ code: 'unavailable', details: { retryAfterSeconds: expect.any(Number) } });
  });

  it('does not let a shared refusal linger in the local window', async () => {
    const ip = '192.0.2.45';
    for (let i = 0; i < limiters.otp.limit; i++) await limit(limiters.otp, ip);
    limiters.otp.reset();
    await expect(limit(limiters.otp, ip)).rejects.toMatchObject({ code: 'unavailable' });
    // Local window holds no entry for the refused request.
    expect(limiters.otp.take(ip)).toEqual({ allowed: true });
  });
});
