// Agent history: written by POST /plans/execute from the real step outcomes,
// listed by GET /agent/history (paginated, filterable, owner-only), cleared by
// DELETE /agent/history. Retries and second waves update one entry.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as planPreviewRoute from '@/app/api/v1/plans/preview/route';
import * as planExecuteRoute from '@/app/api/v1/plans/execute/route';
import * as historyRoute from '@/app/api/v1/agent/history/route';
import type { AuthUser } from '@/server/auth/verify';
import { recordIdsOf, runStatus } from '@/server/agent/history';
import { createTestDb, type TestDb } from './support/db';
import { makeClient } from './support/http';
import { act, fixClock } from './support/actions';

let t: TestDb;
let call: ReturnType<typeof makeClient>;

beforeAll(async () => {
  t = await createTestDb();
  call = makeClient(t);
  fixClock();
});
afterAll(async () => t.close());

type Step = { stepId: string; actionId: string; input: Record<string, unknown>; dependsOn?: string[] };

const threeOps = (planId: string): { planId: string; channel: 'agent'; steps: Step[] } => ({
  planId,
  channel: 'agent',
  steps: [
    { stepId: 'a1', actionId: 'transactions.create', input: { type: 'income', amount: '5000', categoryId: 'cat_salary', date: '2026-10-09' } },
    {
      stepId: 'a2',
      actionId: 'pending.create',
      input: { counterparty: 'Utsav', direction: 'owedToMe', kind: 'lent', amount: '300', purpose: 'Lent money', createdDate: '2026-10-10' },
    },
    {
      stepId: 'a3',
      actionId: 'transactions.create',
      input: { type: 'expense', amount: '5000', categoryId: 'cat_health', date: '2026-10-10', note: 'protein powder' },
    },
  ],
});

async function previewAll(user: AuthUser, plan: { planId: string; steps: Step[] }) {
  const res = await call(planPreviewRoute.POST, 'POST', '/api/v1/plans/preview', { user, body: { ...plan, channel: 'agent' } });
  expect(res.status).toBe(200);
  return res.body.data.steps as { stepId: string; status: string; preview?: { fingerprint: string; summary: string } }[];
}

async function execute(user: AuthUser, plan: { planId: string; steps: Step[] }, approved: string[], history: Record<string, unknown>) {
  return call(planExecuteRoute.POST, 'POST', '/api/v1/plans/execute', {
    user,
    body: { ...plan, channel: 'agent', approvedFingerprints: approved, stopOnFailure: false, history },
  });
}

async function countTransactions(user: AuthUser): Promise<number> {
  const rows = await t.db.selectFrom('transactions').select('id').where('user_id', '=', user.userId).execute();
  return rows.length;
}

const history = (user: AuthUser, query: Record<string, string | number | undefined> = {}) =>
  call(historyRoute.GET, 'GET', '/api/v1/agent/history', { user, query });

describe('agent history', () => {
  it('records the confirmed outcome of a multi-operation turn once, even when the call is retried', async () => {
    const user = await t.createUser('hist-a@example.com');
    const plan = threeOps('agent.c_hist_a');
    const steps = await previewAll(user, plan);
    expect(steps.map((s) => s.status)).toEqual(['ready', 'ready', 'ready']);
    const approved = steps.map((s) => s.preview!.fingerprint);
    const run = { runId: 'run_hist_a_1', request: 'got 5k salary yesterday, gave 300 to Utsav, protein powder 5000' };

    const first = await execute(user, plan, approved, run);
    expect(first.status).toBe(200);
    expect(first.body.data.steps.map((s: { status: string }) => s.status)).toEqual(['succeeded', 'succeeded', 'succeeded']);
    expect(first.body.data.history).toEqual({ id: 'run_hist_a_1', status: 'completed', summary: '3 of 3 saved' });

    // A lost reply is retried with the same plan: steps replay, nothing is written twice.
    const retry = await execute(user, plan, approved, run);
    expect(retry.body.data.steps.every((s: { replayed: boolean }) => s.replayed)).toBe(true);
    const txCount = await countTransactions(user);
    expect(txCount).toBe(2);

    const list = await history(user);
    expect(list.status).toBe(200);
    expect(list.body.data.items).toHaveLength(1);
    const entry = list.body.data.items[0];
    expect(entry).toMatchObject({ id: 'run_hist_a_1', request: run.request, status: 'completed', summary: '3 of 3 saved', notes: [] });
    expect(entry.operations.map((o: { ref: string; status: string }) => [o.ref, o.status])).toEqual([
      ['a1', 'alreadySaved'],
      ['a2', 'alreadySaved'],
      ['a3', 'alreadySaved'],
    ]);
    for (const op of entry.operations) expect(op.recordIds.length).toBe(1);
    // Summaries come from the server's own previews.
    expect(entry.operations[2].summary).toBe(steps[2].preview!.summary);
  });

  it('reports partial success, declined operations and app notes truthfully', async () => {
    const user = await t.createUser('hist-b@example.com');
    const plan = {
      planId: 'agent.c_hist_b',
      steps: [
        { stepId: 'b1', actionId: 'transactions.create', input: { type: 'expense', amount: '250', categoryId: 'cat_transport', date: '2026-10-10' } },
        // Settles a pending item that does not exist: fails at execution.
        { stepId: 'b2', actionId: 'pending.settle', input: { pendingId: 'pend_missing', amount: '100', date: '2026-10-10' } },
        { stepId: 'b3', actionId: 'transactions.create', input: { type: 'expense', amount: '90', categoryId: 'cat_food', date: '2026-10-10' } },
      ],
    };
    const steps = await previewAll(user, plan);
    expect(steps.map((s) => s.status)).toEqual(['ready', 'invalid', 'ready']);
    // b3 is declined by the user; b2 never had a preview, so it cannot be approved.
    const res = await execute(user, plan, [steps[0].preview!.fingerprint], {
      runId: 'run_hist_b_1',
      request: 'auto 250, settle with Ravi, chai 90',
      notes: ['No goal named "Japan trip".'],
      labels: { b3: 'Expense ₹90 · Food & Dining' },
    });
    expect(res.body.data.history.status).toBe('completed'); // every approved operation saved

    const entry = (await history(user)).body.data.items[0];
    expect(entry.operations.map((o: { status: string }) => o.status)).toEqual(['saved', 'declined', 'declined']);
    expect(entry.operations[2].summary).toBe('Expense ₹90 · Food & Dining');
    expect(entry.notes).toEqual(['No goal named "Japan trip".']);

    expect(runStatus([
      { ref: 'x', actionId: 'a', summary: '', status: 'saved', recordIds: [] },
      { ref: 'y', actionId: 'a', summary: '', status: 'failed', recordIds: [] },
    ])).toBe('partial');
    expect(runStatus([{ ref: 'x', actionId: 'a', summary: '', status: 'failed', recordIds: [] }])).toBe('failed');
    expect(runStatus([{ ref: 'x', actionId: 'a', summary: '', status: 'declined', recordIds: [] }])).toBe('declined');
  });

  it('marks a turn partial when a record changed after review and that step fails while another saves', async () => {
    const user = await t.createUser('hist-h@example.com');
    const pending = await act<{ id: string }>(user, 'pending.create', {
      counterparty: 'Neha',
      direction: 'owedToMe',
      kind: 'sharedExpense',
      amount: '850',
      purpose: 'Office lunch',
      createdDate: '2026-10-01',
    });
    const plan = {
      planId: 'agent.c_hist_h',
      steps: [
        { stepId: 'h1', actionId: 'transactions.create', input: { type: 'expense', amount: '250', categoryId: 'cat_transport', date: '2026-10-10' } },
        { stepId: 'h2', actionId: 'pending.settle', input: { pendingId: pending.id, amount: '850', date: '2026-10-10' } },
      ],
    };
    const steps = await previewAll(user, plan);
    // The item is settled elsewhere (another device) between review and approval.
    await act(user, 'pending.settle', { pendingId: pending.id, amount: '400', date: '2026-10-10' });
    const res = await execute(user, plan, steps.map((s) => s.preview!.fingerprint), { runId: 'run_hist_h_1', request: 'auto 250 and Neha paid back 850' });
    // The settlement no longer fits the outstanding amount: it fails, the expense still saves.
    expect(res.body.data.steps.map((s: { status: string }) => s.status)).toEqual(['succeeded', 'failed']);
    expect(res.body.data.history).toEqual({ id: 'run_hist_h_1', status: 'partial', summary: '1 of 2 saved, 1 not saved' });
    const op = (await history(user)).body.data.items[0].operations[1];
    expect(op).toMatchObject({ ref: 'h2', status: 'failed', recordIds: [] });
    expect(op.message.length).toBeGreaterThan(0);
  });

  it('records a fully declined turn without writing anything', async () => {
    const user = await t.createUser('hist-c@example.com');
    const plan = threeOps('agent.c_hist_c');
    await previewAll(user, plan);
    const res = await execute(user, plan, [], { runId: 'run_hist_c_1', request: 'never mind' });
    expect(res.body.data.steps.map((s: { status: string }) => s.status)).toEqual(['notApproved', 'notApproved', 'notApproved']);
    expect(res.body.data.history).toMatchObject({ status: 'declined', summary: '0 of 3 saved, 3 declined' });
    expect(await countTransactions(user)).toBe(0);
  });

  it('merges a second wave of the same turn into one entry', async () => {
    const user = await t.createUser('hist-d@example.com');
    const wave1 = {
      planId: 'agent.c_hist_d',
      steps: [{ stepId: 'd1', actionId: 'categories.create', input: { name: 'Pets', type: 'expense', iconKey: 'tag', colorIndex: 3 } }],
    };
    const p1 = await previewAll(user, wave1);
    const r1 = await execute(user, wave1, [p1[0].preview!.fingerprint], { runId: 'run_hist_d_1', request: 'category Pets and 500 dog food' });
    const categoryId = r1.body.data.steps[0].result.id as string;
    expect(recordIdsOf(r1.body.data.steps[0].result)).toEqual([categoryId]);

    const wave2 = {
      planId: 'agent.c_hist_d',
      steps: [{ stepId: 'd2', actionId: 'transactions.create', input: { type: 'expense', amount: '500', categoryId, date: '2026-10-10', note: 'dog food' } }],
    };
    const p2 = await previewAll(user, wave2);
    const r2 = await execute(user, wave2, [p2[0].preview!.fingerprint], { runId: 'run_hist_d_1', request: 'ignored on update' });
    expect(r2.body.data.history.summary).toBe('2 of 2 saved');

    const items = (await history(user)).body.data.items;
    expect(items).toHaveLength(1);
    expect(items[0].request).toBe('category Pets and 500 dog food');
    expect(items[0].operations.map((o: { ref: string }) => o.ref)).toEqual(['d1', 'd2']);
  });

  it('pages newest first, filters by status, isolates users and clears only the caller', async () => {
    const user = await t.createUser('hist-e@example.com');
    const other = await t.createUser('hist-f@example.com');
    for (let i = 0; i < 3; i++) {
      const plan = {
        planId: `agent.c_hist_e${i}`,
        steps: [{ stepId: 'e1', actionId: 'transactions.create', input: { type: 'expense', amount: `${10 + i}`, categoryId: 'cat_food', date: '2026-10-10' } }],
      };
      const p = await previewAll(user, plan);
      await execute(user, plan, i === 1 ? [] : [p[0].preview!.fingerprint], { runId: `run_hist_e_${i}`, request: `expense ${i}` });
    }
    const page1 = await history(user, { limit: 2 });
    expect(page1.body.data.items.map((x: { id: string }) => x.id)).toEqual(['run_hist_e_2', 'run_hist_e_1']);
    expect(page1.body.data.nextBefore).toMatch(/^\d+$/);
    const page2 = await history(user, { limit: 2, before: page1.body.data.nextBefore });
    expect(page2.body.data.items.map((x: { id: string }) => x.id)).toEqual(['run_hist_e_0']);
    expect(page2.body.data.nextBefore).toBeNull();

    const declined = await history(user, { status: 'declined' });
    expect(declined.body.data.items.map((x: { id: string }) => x.id)).toEqual(['run_hist_e_1']);
    expect((await history(user, { status: 'bogus' })).status).toBe(422);

    expect((await history(other)).body.data.items).toEqual([]);
    const cleared = await call(historyRoute.DELETE, 'DELETE', '/api/v1/agent/history', { user: other });
    expect(cleared.body.data).toEqual({ deleted: 0 });
    expect((await history(user)).body.data.items).toHaveLength(3);
    const mine = await call(historyRoute.DELETE, 'DELETE', '/api/v1/agent/history', { user });
    expect(mine.body.data).toEqual({ deleted: 3 });
    expect((await history(user)).body.data.items).toEqual([]);
  });

  it('requires authentication and validates the history payload', async () => {
    expect((await call(historyRoute.GET, 'GET', '/api/v1/agent/history')).status).toBe(401);
    const user = await t.createUser('hist-g@example.com');
    const plan = threeOps('agent.c_hist_g');
    const res = await execute(user, plan, [], { runId: 'bad id!', request: 'x' });
    expect(res.status).toBe(422);
    const empty = await execute(user, plan, [], { runId: 'run_hist_g_1', request: '   ' });
    expect(empty.status).toBe(422);
  });
});
