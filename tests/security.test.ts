// Regression tests for the security/correctness review findings.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'kysely';
import * as actionRoute from '@/app/api/v1/actions/[actionId]/route';
import * as syncRoute from '@/app/api/v1/sync/route';
import { createTestDb, type TestDb } from './support/db';
import { makeClient, newKey } from './support/http';
import { act, fixClock, read } from './support/actions';
import { withUserTx } from '@/server/db/tx';
import type { AuthUser } from '@/server/auth/verify';

let t: TestDb;
let call: ReturnType<typeof makeClient>;

beforeAll(async () => {
  t = await createTestDb();
  call = makeClient(t);
  fixClock();
});
afterAll(async () => t.close());

const item = (extra: Record<string, unknown> = {}) => ({
  counterparty: 'Bob',
  direction: 'owedToMe',
  kind: 'lent',
  amount: '1000',
  purpose: 'Concert tickets',
  createdDate: '2026-10-01',
  ...extra,
});

async function asRole<T>(user: AuthUser, role: string, fn: (tx: Parameters<Parameters<typeof withUserTx>[1]>[0]) => Promise<T>): Promise<T> {
  return withUserTx(user, async (tx) => {
    await sql`select set_config('role', ${role}, true)`.execute(tx);
    return fn(tx);
  });
}

describe('Data API cannot reach FiNN tables', () => {
  it('the authenticated role (Supabase Data API) has no privileges', async () => {
    const u = await t.createUser();
    await expect(asRole(u, 'authenticated', (tx) => tx.selectFrom('transactions').selectAll().execute())).rejects.toMatchObject({
      code: '42501',
    });
    await expect(
      asRole(u, 'anon', (tx) => tx.selectFrom('profiles').selectAll().execute()),
    ).rejects.toMatchObject({ code: '42501' });
  });

  it('the other party of a shared item cannot rewrite it, even with raw SQL as the API role', async () => {
    const alice = await t.createUser('sec-alice@example.com');
    const bob = await t.createUser('sec-bob@example.com');
    await t.befriend(alice, bob);
    const p = await act(alice, 'pending.create', item({ linkedUserId: bob.userId }));
    await expect(
      withUserTx(bob, (tx) =>
        tx.updateTable('pending_payments').set({ original_paise: 1 }).where('user_id', '=', alice.userId).where('id', '=', p.id).execute(),
      ),
    ).rejects.toMatchObject({ code: '42501' });
    await expect(
      withUserTx(bob, (tx) =>
        tx
          .updateTable('pending_payments')
          .set({ user_id: bob.userId, shared_with_user_id: alice.userId })
          .where('user_id', '=', alice.userId)
          .where('id', '=', p.id)
          .execute(),
      ),
    ).rejects.toMatchObject({ code: '42501' });
    // Alice is owed here, so Bob (who owes) cannot write it off.
    await expect(
      withUserTx(bob, (tx) =>
        tx.updateTable('pending_payments').set({ is_cancelled: true }).where('user_id', '=', alice.userId).where('id', '=', p.id).execute(),
      ),
    ).rejects.toMatchObject({ code: '42501' });
  });
});

describe('sharing an item that already has settlements', () => {
  it('shows the other person the same outstanding amount and prevents over-settlement', async () => {
    const alice = await t.createUser('share-alice@example.com');
    const bob = await t.createUser('share-bob@example.com');
    await t.befriend(alice, bob);
    const p = await act(alice, 'pending.create', item());
    await act(alice, 'pending.settle', { pendingId: p.id, amount: '600', date: '2026-10-05', recordCashMovement: false });
    const before = await call(syncRoute.GET, 'GET', '/api/v1/sync', { user: bob });
    const cursor = before.body.data.cursor;

    await act(alice, 'pending.update', { id: p.id, expectedVersion: 1, ...item({ linkedUserId: bob.userId }) });

    const views = await read(bob, async (s) => ({ pending: await s.pending(), settlements: await s.settlements() }));
    const mirrored = views.pending.find((x) => x.id.startsWith('mir_'))!;
    expect(views.settlements.filter((x) => x.pendingId === mirrored.id).map((x) => x.amountPaise)).toEqual([60000]);
    // Incremental sync delivers the earlier settlement to Bob as well.
    const after = await call(syncRoute.GET, 'GET', '/api/v1/sync', { user: bob, query: { since: cursor } });
    expect(after.body.data.collections.settlements.upserted).toHaveLength(1);

    await expect(act(bob, 'pending.settle', { pendingId: mirrored.id, amount: '1000', date: '2026-10-06' })).rejects.toMatchObject({
      code: 'validation',
    });
    await act(bob, 'pending.settle', { pendingId: mirrored.id, amount: '400', date: '2026-10-06' });
  });
});

describe('input limits', () => {
  it('caps split size before taking any lock', async () => {
    const u = await t.createUser();
    const people = Array.from({ length: 21 }, (_, i) => ({ counterparty: `P${i}` }));
    await expect(
      act(u, 'pending.split', { direction: 'owedToMe', kind: 'sharedExpense', purpose: 'Big dinner', createdDate: '2026-10-01', total: '2100', method: 'equally', includesMe: true, people }),
    ).rejects.toMatchObject({ code: 'validation' });
  });

  it('rejects an oversized body even without content-length', async () => {
    const u = await t.createUser();
    const big = 'x'.repeat(1_100_000);
    const stream = new ReadableStream({
      start(c) {
        c.enqueue(new TextEncoder().encode(JSON.stringify({ input: { note: big } })));
        c.close();
      },
    });
    const req = new Request('http://localhost/api/v1/actions/transactions.create', {
      method: 'POST',
      headers: { authorization: `Bearer ${t.tokenFor(u)}`, 'idempotency-key': newKey() },
      body: stream,
      duplex: 'half',
    } as RequestInit);
    const res = await actionRoute.POST(req, { params: Promise.resolve({ actionId: 'transactions.create' }) });
    expect(res.status).toBe(422);
  });

  it('rejects implausible years as validation errors, not database errors', async () => {
    const u = await t.createUser();
    for (const date of ['0000-01-01', '0050-06-01', '1899-12-31']) {
      await expect(act(u, 'transactions.create', { type: 'expense', amount: '10', categoryId: 'cat_food', date })).rejects.toMatchObject({
        code: 'validation',
      });
    }
  });
});

describe('loan edits keep the disbursement consistent', () => {
  it('updates the linked disbursement when principal changes before any payment', async () => {
    const u = await t.createUser();
    const terms = {
      name: 'Bike loan',
      counterparty: 'HDFC',
      direction: 'borrowed',
      structure: 'amortizing',
      principal: '100000',
      rateBps: 1000,
      startDate: '2026-09-01',
      firstDueDate: '2026-10-01',
      frequency: 'monthly',
      tenureInstallments: 12,
      recordDisbursement: true,
    };
    const loan = await act(u, 'loans.create', terms);
    const cashBefore = (await read(u, (s) => s.balance())).cashPaise;
    await act(u, 'loans.update', { id: loan.id, expectedVersion: 1, ...terms, principal: '80000' });
    const disb = await read(u, (s) => s.transaction(loan.disbursementTransactionId));
    expect(disb).toMatchObject({ amountPaise: 8_000_000, version: 2 });
    expect((await read(u, (s) => s.balance())).cashPaise).toBe(cashBefore - 2_000_000);
  });
});
