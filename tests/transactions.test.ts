import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as actionRoute from '@/app/api/v1/actions/[actionId]/route';
import * as txListRoute from '@/app/api/v1/transactions/route';
import * as syncRoute from '@/app/api/v1/sync/route';
import { createTestDb, type TestDb } from './support/db';
import { makeClient, newKey } from './support/http';
import { act, fixClock, read } from './support/actions';
import type { AuthUser } from '@/server/auth/verify';
import { ensureAccount } from '@/server/modules/account/bootstrap';
import { withUserTx } from '@/server/db/tx';

let t: TestDb;
let call: ReturnType<typeof makeClient>;
let alice: AuthUser;
let bob: AuthUser;

beforeAll(async () => {
  t = await createTestDb();
  call = makeClient(t);
  fixClock();
  alice = await t.createUser('alice@example.com');
  bob = await t.createUser('bob@example.com');
  for (const u of [alice, bob]) await withUserTx(u, (tx) => ensureAccount(tx, u), { write: true });
});

afterAll(async () => t.close());

const expense = (amount: string, extra: Record<string, unknown> = {}) => ({
  type: 'expense',
  amount,
  categoryId: 'cat_food',
  date: '2026-10-05',
  paymentMethod: 'upi',
  counterparty: 'Swiggy',
  ...extra,
});

describe('transactions', () => {
  it('records an expense exactly once and updates the balance', async () => {
    const before = await read(alice, (s) => s.balance());
    const created = await act(alice, 'transactions.create', expense('1250.50'));
    expect(created.amountPaise).toBe(125050);
    expect(created.origin).toBe('manual');
    const after = await read(alice, (s) => s.balance());
    expect(after.cashPaise - before.cashPaise).toBe(-125050);
  });

  it('replays a duplicate submission instead of recording twice', async () => {
    const key = newKey();
    const body = { input: expense('99') };
    const first = await call(actionRoute.POST, 'POST', '/api/v1/actions/transactions.create', {
      user: alice,
      body,
      params: { actionId: 'transactions.create' },
      headers: { 'idempotency-key': key },
    });
    const second = await call(actionRoute.POST, 'POST', '/api/v1/actions/transactions.create', {
      user: alice,
      body,
      params: { actionId: 'transactions.create' },
      headers: { 'idempotency-key': key },
    });
    expect(first.status).toBe(200);
    expect(second.body.data.replayed).toBe(true);
    expect(second.body.data.result.id).toBe(first.body.data.result.id);
    const list = await call(txListRoute.GET, 'GET', '/api/v1/transactions', { user: alice, query: { q: 'swiggy', maxPaise: 9900, minPaise: 9900 } });
    expect(list.body.data.items).toHaveLength(1);
  });

  it('rejects a reused key for a different request', async () => {
    const key = newKey();
    await act(alice, 'transactions.create', expense('10'), { key });
    await expect(act(alice, 'transactions.create', expense('11'), { key })).rejects.toMatchObject({ code: 'conflict' });
  });

  it('validates input with field errors', async () => {
    const res = await call(actionRoute.POST, 'POST', '/api/v1/actions/transactions.create', {
      user: alice,
      body: { input: expense('-5', { date: '2026-12-01', categoryId: 'cat_salary' }) },
      params: { actionId: 'transactions.create' },
      headers: { 'idempotency-key': newKey() },
    });
    expect(res.status).toBe(422);
    expect(res.body.error?.code).toBe('validation');
    expect(res.body.error?.fieldErrors?.amount).toBeDefined();
  });

  it('refuses future dates and wrong category types', async () => {
    await expect(act(alice, 'transactions.create', expense('10', { date: '2026-10-11' }))).rejects.toMatchObject({
      code: 'validation',
      fieldErrors: { date: 'The date cannot be in the future.' },
    });
    await expect(act(alice, 'transactions.create', expense('10', { categoryId: 'cat_salary' }))).rejects.toMatchObject({ code: 'validation' });
  });

  it('edits with optimistic concurrency and rejects stale versions', async () => {
    const created = await act(alice, 'transactions.create', expense('500'));
    const updated = await act(alice, 'transactions.update', { id: created.id, expectedVersion: 1, ...expense('450') });
    expect(updated.version).toBe(2);
    expect(updated.amountPaise).toBe(45000);
    await expect(act(alice, 'transactions.update', { id: created.id, expectedVersion: 1, ...expense('400') })).rejects.toMatchObject({
      code: 'staleData',
    });
  });

  it('requires confirmation to delete and leaves a tombstone for sync', async () => {
    const created = await act(alice, 'transactions.create', expense('700'));
    const sync0 = await call(syncRoute.GET, 'GET', '/api/v1/sync', { user: alice });
    const cursor = sync0.body.data.cursor;
    await expect(act(alice, 'transactions.delete', { id: created.id }, { confirm: false })).rejects.toThrow(/needsConfirmation/);
    await act(alice, 'transactions.delete', { id: created.id });
    const sync1 = await call(syncRoute.GET, 'GET', '/api/v1/sync', { user: alice, query: { since: cursor } });
    expect(sync1.body.data.collections.transactions.deleted).toContain(created.id);
  });

  it('isolates users: another user cannot read or change records', async () => {
    const mine = await act(alice, 'transactions.create', expense('321'));
    await expect(act(bob, 'transactions.update', { id: mine.id, expectedVersion: 1, ...expense('1') })).rejects.toMatchObject({
      code: 'notFound',
    });
    const list = await call(txListRoute.GET, 'GET', '/api/v1/transactions', { user: bob });
    expect(list.body.data.items.find((x: { id: string }) => x.id === mine.id)).toBeUndefined();
    // Even raw SQL as Bob cannot see Alice's rows: RLS applies inside the API transaction.
    const count = await withUserTx(bob, (tx) => tx.selectFrom('transactions').select((eb) => eb.fn.countAll().as('n')).executeTakeFirstOrThrow());
    expect(Number(count.n)).toBe(0);
  });

  it('requires authentication', async () => {
    const res = await call(txListRoute.GET, 'GET', '/api/v1/transactions', {});
    expect(res.status).toBe(401);
    expect(res.body.error?.code).toBe('unauthenticated');
  });

  it('paginates with a stable keyset cursor', async () => {
    for (let i = 1; i <= 7; i++) await act(bob, 'transactions.create', expense(String(i), { date: `2026-10-0${i}` }));
    const seen: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await call(txListRoute.GET, 'GET', '/api/v1/transactions', { user: bob, query: { limit: 3, cursor } });
      seen.push(...page.body.data.items.map((x: { id: string }) => x.id));
      cursor = page.body.data.nextCursor ?? undefined;
    } while (cursor);
    expect(seen).toHaveLength(7);
    expect(new Set(seen).size).toBe(7);
  });
});
