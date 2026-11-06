// Concurrent writes from a flaky mobile connection: retries that overlap the
// original request, and two different writes racing for the same money.
// (PGlite runs one transaction at a time; the per-user advisory lock gives
// the same ordering on Postgres. What is checked here is that the outcome is
// correct whatever order the requests run in.)

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as actionRoute from '@/app/api/v1/actions/[actionId]/route';
import * as syncRoute from '@/app/api/v1/sync/route';
import { dispatch } from '@/server/actions/dispatcher';
import type { AuthUser } from '@/server/auth/verify';
import { act, fixClock, read } from './support/actions';
import { createTestDb, type TestDb } from './support/db';
import { makeClient, newKey } from './support/http';

let t: TestDb;
let call: ReturnType<typeof makeClient>;
let alice: AuthUser;

beforeAll(async () => {
  t = await createTestDb();
  call = makeClient(t);
  fixClock();
  alice = await t.createUser('alice@example.com');
  await t.fund(alice, 10_000);
});
afterAll(async () => t.close());

const expense = { type: 'expense', amount: '250', categoryId: 'cat_food', date: '2026-10-09' };

async function transactionCount(user: AuthUser): Promise<number> {
  const res = await call(syncRoute.GET, 'GET', '/api/v1/sync', { user });
  return ((res.body.data.collections.transactions?.upserted ?? []) as unknown[]).length;
}

describe('overlapping retries', () => {
  it('records one transaction when the same request arrives five times at once', async () => {
    const before = await transactionCount(alice);
    const key = newKey();
    const responses = await Promise.all(
      Array.from({ length: 5 }, () =>
        call(actionRoute.POST, 'POST', '/api/v1/actions/transactions.create', {
          user: alice,
          params: { actionId: 'transactions.create' },
          headers: { 'idempotency-key': key },
          body: { input: expense },
        }),
      ),
    );
    expect(responses.map((r) => r.status)).toEqual([200, 200, 200, 200, 200]);
    const ids = new Set(responses.map((r) => r.body.data.result.id));
    expect(ids.size).toBe(1);
    expect(responses.filter((r) => r.body.data.replayed === true)).toHaveLength(4);
    expect(await transactionCount(alice)).toBe(before + 1);
  });

  it('rejects the same key reused for a different request, even concurrently', async () => {
    const key = newKey();
    const results = await Promise.allSettled([
      dispatch(alice, 'transactions.create', expense, { idempotencyKey: key }),
      dispatch(alice, 'transactions.create', { ...expense, amount: '999' }, { idempotencyKey: key }),
    ]);
    const ok = results.filter((r) => r.status === 'fulfilled');
    const failed = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    expect(ok).toHaveLength(1);
    expect(failed).toHaveLength(1);
    expect(failed[0].reason).toMatchObject({ code: 'conflict' });
  });
});

describe('racing writes against one balance', () => {
  it('lets only as many goal contributions through as the cash allows', async () => {
    const bob = await t.createUser('bob@example.com');
    await t.fund(bob, 1_000);
    const goal = await act(bob, 'goals.create', { name: 'Bike', category: 'other', target: '5000', colorIndex: 1 });
    // Each contribution fits alone (₹600 of ₹1,000) but not both together.
    const results = await Promise.allSettled(
      [0, 1].map(() => act(bob, 'goals.contribute', { goalId: goal.id, amount: '600', date: '2026-10-10' })),
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const refused = results.find((r): r is PromiseRejectedResult => r.status === 'rejected');
    expect(refused?.reason).toMatchObject({ code: expect.stringMatching(/^(validation|insufficientFunds)$/) });
    const balance = await read(bob, (s) => s.balance());
    expect(balance.availablePaise).toBeGreaterThanOrEqual(0);
  });

  it('applies concurrent edits of one record once, refusing the stale one', async () => {
    const tx = await act(alice, 'transactions.create', expense);
    const update = (amount: string) =>
      act(alice, 'transactions.update', { id: tx.id, expectedVersion: tx.version, ...expense, amount });
    const results = await Promise.allSettled([update('300'), update('400')]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.find((r) => r.status === 'rejected')).toMatchObject({ reason: { code: 'staleData' } });
  });
});
