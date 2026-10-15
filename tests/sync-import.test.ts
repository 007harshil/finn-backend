import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as importRoute from '@/app/api/v1/import/route';
import * as syncRoute from '@/app/api/v1/sync/route';
import * as inboxRoute from '@/app/api/v1/alerts/inbox/route';
import * as planPreviewRoute from '@/app/api/v1/plans/preview/route';
import * as planExecuteRoute from '@/app/api/v1/plans/execute/route';
import * as actionRoute from '@/app/api/v1/actions/[actionId]/route';
import { createTestDb, type TestDb } from './support/db';
import { makeClient, newKey } from './support/http';
import { act, fixClock, read } from './support/actions';

let t: TestDb;
let call: ReturnType<typeof makeClient>;

beforeAll(async () => {
  t = await createTestDb();
  call = makeClient(t);
  fixClock();
});
afterAll(async () => t.close());

const at = '2026-09-01T10:00:00.000Z';

function devicePayload() {
  return {
    categories: [
      { id: 'cat_food', name: 'Food', type: 'expense', iconKey: 'utensils', colorIndex: 12, description: '', isSystem: false, isArchived: false, isEssential: false, version: 2 },
      { id: 'cat_custom_1', name: 'Pets', type: 'expense', iconKey: 'dog', colorIndex: 3, version: 1 },
    ],
    transactions: [
      { id: 'tx_a', type: 'income', amountPaise: 5_000_000, categoryId: 'cat_salary', date: '2026-09-01', origin: 'manual', createdAt: at, updatedAt: at, version: 1 },
      { id: 'tx_b', type: 'expense', amountPaise: 120_000, categoryId: 'cat_custom_1', date: '2026-09-03', channel: 'UPI', createdAt: at, updatedAt: at, version: 1 },
      { id: 'tx_c', type: 'expense', amountPaise: 40_000, categoryId: 'cat_sys_settle_out', date: '2026-09-05', origin: 'pendingSettlement', originRefId: 'set_1', createdAt: at, updatedAt: at, version: 1 },
    ],
    goals: [{ id: 'goal_1', name: 'Goa', category: 'travel', targetPaise: 3_000_000, colorIndex: 2, createdAt: at, updatedAt: at, version: 1 }],
    savingsMovements: [{ id: 'mov_1', bucketType: 'goal', bucketId: 'goal_1', kind: 'contribution', amountPaise: 500_000, date: '2026-09-02', createdAt: at }],
    pending: [{ id: 'pen_1', counterparty: 'Rahul', direction: 'iOwe', kind: 'borrowed', originalPaise: 100_000, purpose: 'Dinner', createdDate: '2026-09-01', createdAt: at, updatedAt: at, version: 2 }],
    settlements: [{ id: 'set_1', pendingId: 'pen_1', amountPaise: 40_000, date: '2026-09-05', transactionId: 'tx_c', createdAt: at }],
    profile: { exists: true, displayName: 'Aarav', openingPaise: 1_000_000, openingDate: '2026-09-01' },
    emergencyPlan: { configured: true, essentialMonthlyPaise: 2_500_000, targetMonths: 6, updatedAt: at },
  };
}

describe('import', () => {
  it('uploads device data atomically into an empty account, keeping ids and references', async () => {
    const user = await t.createUser('device@example.com');
    const key = newKey();
    const res = await call(importRoute.POST, 'POST', '/api/v1/import', { user, body: devicePayload(), headers: { 'idempotency-key': key } });
    expect(res.status).toBe(200);
    const data = res.body.data;
    expect(data.collections.transactions.upserted.map((x: { id: string }) => x.id).sort()).toEqual(['tx_a', 'tx_b', 'tx_c']);
    expect(data.collections.settlements.upserted[0]).toMatchObject({ id: 'set_1', pendingId: 'pen_1', transactionId: 'tx_c' });
    expect(data.values.profile).toMatchObject({ exists: true, displayName: 'Aarav', openingPaise: 1_000_000 });
    expect(data.values.emergencyPlan).toMatchObject({ configured: true, targetMonths: 6 });
    const balance = await read(user, (s) => s.balance());
    // 10,000 + 50,000 − 1,200 − 400 = 58,400 cash; 5,000 earmarked.
    expect(balance.cashPaise).toBe(5_840_000);
    expect(balance.availablePaise).toBe(5_340_000);

    const replay = await call(importRoute.POST, 'POST', '/api/v1/import', { user, body: devicePayload(), headers: { 'idempotency-key': key } });
    expect(replay.status).toBe(200);
    expect(replay.body.data.replayed).toBe(true);

    const again = await call(importRoute.POST, 'POST', '/api/v1/import', { user, body: devicePayload(), headers: { 'idempotency-key': newKey() } });
    expect(again.status).toBe(409);
  });

  it('writes nothing when any record is invalid', async () => {
    const user = await t.createUser('broken@example.com');
    const payload = devicePayload();
    payload.transactions.push({ id: 'tx_bad', type: 'expense', amountPaise: 100, categoryId: 'cat_missing', date: '2026-09-04', createdAt: at, updatedAt: at, version: 1 } as never);
    const res = await call(importRoute.POST, 'POST', '/api/v1/import', { user, body: payload, headers: { 'idempotency-key': newKey() } });
    expect(res.status).toBeGreaterThanOrEqual(400);
    const sync = await call(syncRoute.GET, 'GET', '/api/v1/sync', { user });
    expect(sync.body.data.collections.transactions).toBeUndefined();
  });
});

describe('sync', () => {
  it('pages through changes with a cursor and reports hasMore', async () => {
    const user = await t.createUser('pager@example.com');
    for (let i = 0; i < 60; i++) {
      await act(user, 'transactions.create', { type: 'expense', amount: String(i + 1), categoryId: 'cat_food', date: '2026-10-01' });
    }
    const ids = new Set<string>();
    let since: string | undefined;
    let pages = 0;
    for (;;) {
      const res = await call(syncRoute.GET, 'GET', '/api/v1/sync', { user, query: { since, limit: 50 } });
      const d = res.body.data;
      for (const x of d.collections.transactions?.upserted ?? []) ids.add(x.id);
      since = d.cursor;
      pages++;
      if (!d.hasMore) break;
    }
    expect(ids.size).toBe(60);
    expect(pages).toBeGreaterThan(1);
    const after = await call(syncRoute.GET, 'GET', '/api/v1/sync', { user, query: { since } });
    expect(after.body.data.collections).toEqual({});
  });

  it('returns action changes with the completed result', async () => {
    const user = await t.createUser('changes@example.com');
    const res = await call(actionRoute.POST, 'POST', '/api/v1/actions/transactions.create', {
      user,
      params: { actionId: 'transactions.create' },
      headers: { 'idempotency-key': newKey() },
      body: { input: { type: 'income', amount: '100', categoryId: 'cat_salary', date: '2026-10-02' } },
    });
    expect(res.body.data.status).toBe('completed');
    expect(res.body.data.changes.collections.transactions.upserted[0].id).toBe(res.body.data.result.id);
  });
});

describe('alert inbox', () => {
  it('adds read and dismissed keys idempotently', async () => {
    const user = await t.createUser('inbox@example.com');
    await call(inboxRoute.PUT, 'PUT', '/api/v1/alerts/inbox', { user, body: { read: ['a'], dismissed: ['b'] } });
    const res = await call(inboxRoute.PUT, 'PUT', '/api/v1/alerts/inbox', { user, body: { read: ['a', 'c'] } });
    expect(res.body.data).toEqual({ read: ['a', 'b', 'c'], dismissed: ['b'] });
    const restored = await call(inboxRoute.PUT, 'PUT', '/api/v1/alerts/inbox', { user, body: { restore: ['b'] } });
    expect(restored.body.data).toEqual({ read: ['a', 'b', 'c'], dismissed: [] });
  });
});

describe('plans', () => {
  it('previews every step, runs only approved ones and skips dependants', async () => {
    const user = await t.createUser('planner@example.com');
    const plan = {
      planId: 'plan_0001',
      channel: 'agent',
      steps: [
        { stepId: 's1', actionId: 'transactions.create', input: { type: 'expense', amount: '500', categoryId: 'cat_food', date: '2026-10-09' } },
        { stepId: 's2', actionId: 'transactions.create', input: { type: 'expense', amount: '-1', categoryId: 'cat_food', date: '2026-10-09' } },
        { stepId: 's3', actionId: 'transactions.create', input: { type: 'income', amount: '50', categoryId: 'cat_salary', date: '2026-10-09' }, dependsOn: ['s2'] },
      ],
    };
    const preview = await call(planPreviewRoute.POST, 'POST', '/api/v1/plans/preview', { user, body: plan });
    const steps = preview.body.data.steps;
    expect(steps.map((s: { status: string }) => s.status)).toEqual(['ready', 'invalid', 'ready']);
    expect(steps[0].preview.requiresConfirmation).toBe(true); // agent channel always confirms

    const approved = [steps[0].preview.fingerprint, steps[2].preview.fingerprint];
    const run = await call(planExecuteRoute.POST, 'POST', '/api/v1/plans/execute', {
      user,
      body: { ...plan, approvedFingerprints: approved, stopOnFailure: false },
    });
    expect(run.body.data.steps.map((s: { status: string }) => s.status)).toEqual(['succeeded', 'invalid', 'skipped']);

    // Retrying the same plan does not record the expense twice.
    const retry = await call(planExecuteRoute.POST, 'POST', '/api/v1/plans/execute', {
      user,
      body: { ...plan, approvedFingerprints: approved, stopOnFailure: false },
    });
    expect(retry.body.data.steps[0]).toMatchObject({ status: 'succeeded', replayed: true });
  });

  it('refuses deletes from the agent channel', async () => {
    const user = await t.createUser('agentdelete@example.com');
    const tx = await act(user, 'transactions.create', { type: 'expense', amount: '5', categoryId: 'cat_food', date: '2026-10-09' });
    await expect(act(user, 'transactions.delete', { id: tx.id }, { channel: 'agent' })).rejects.toMatchObject({ code: 'notPermitted' });
  });
});
