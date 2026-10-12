// Contract fixtures: runs every registered action through the real dispatcher
// plus the main HTTP routes, and (with WRITE_CONTRACT_FIXTURES=1) writes the
// real responses to docs/contract/fixtures.json so the Flutter client can
// verify it decodes them. Without the env var it is an end-to-end smoke test.

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as actionRoute from '@/app/api/v1/actions/[actionId]/route';
import * as actionsListRoute from '@/app/api/v1/actions/route';
import * as auditRoute from '@/app/api/v1/audit/route';
import * as inboxRoute from '@/app/api/v1/alerts/inbox/route';
import * as importRoute from '@/app/api/v1/import/route';
import * as meRoute from '@/app/api/v1/me/route';
import * as prefsRoute from '@/app/api/v1/preferences/route';
import * as searchRoute from '@/app/api/v1/users/search/route';
import * as syncRoute from '@/app/api/v1/sync/route';
import { describeActions } from '@/server/actions/registry';
import type { AuthUser } from '@/server/auth/verify';
import { createTestDb, type TestDb } from './support/db';
import { makeClient, newKey } from './support/http';
import { act, fixClock } from './support/actions';

let t: TestDb;
let call: ReturnType<typeof makeClient>;
let alice: AuthUser;
let bob: AuthUser;

const actions: { actionId: string; input: Record<string, unknown>; result: unknown }[] = [];
const http: Record<string, { status: number; body: unknown }> = {};

/** Runs an action through the dispatcher (confirming when asked) and records it. */
async function run<T = any>(user: AuthUser, actionId: string, input: Record<string, unknown>): Promise<T> {
  const result = await act<T>(user, actionId, input);
  actions.push({ actionId, input, result });
  return result;
}

async function capture(name: string, p: Promise<{ status: number; body: any }>, expectStatus = 200) {
  const res = await p;
  expect(res.status, `${name}: ${JSON.stringify(res.body)}`).toBe(expectStatus);
  http[name] = { status: res.status, body: res.body };
  return res;
}

beforeAll(async () => {
  t = await createTestDb();
  call = makeClient(t);
  fixClock();
  alice = await t.createUser('alice@example.com');
  bob = await t.createUser('bob@example.com');
});
afterAll(async () => t.close());

const carLoan = (o: Record<string, unknown> = {}) => ({
  name: 'Car loan',
  counterparty: 'HDFC Bank',
  direction: 'borrowed',
  structure: 'amortizing',
  principal: '600000',
  rateBps: 950,
  startDate: '2026-09-01',
  firstDueDate: '2026-10-05',
  frequency: 'monthly',
  tenureInstallments: 60,
  maturityDate: null,
  prepaymentStrategy: 'reduceTenure',
  recordDisbursement: false,
  note: null,
  ...o,
});
const sub = (o: Record<string, unknown> = {}) => ({
  name: 'Netflix',
  amount: '499',
  categoryId: 'cat_food',
  frequency: 'monthly',
  nextDueDate: '2026-10-08',
  ...o,
});
const goal = (o: Record<string, unknown> = {}) => ({ name: 'Japan trip', category: 'travel', target: '200000', colorIndex: 2, ...o });
const asset = (o: Record<string, unknown> = {}) => ({ name: 'Gold coins', type: 'gold', value: '80000.50', valuedOn: '2026-10-01', ...o });
const pending = (o: Record<string, unknown> = {}) => ({
  counterparty: 'Rahul Verma',
  direction: 'owedToMe',
  kind: 'lent',
  amount: '6500',
  purpose: 'Goa trip hotel share',
  createdDate: '2026-10-01',
  ...o,
});

describe('contract fixtures', () => {
  it('exercises every action and the main HTTP routes', async () => {
    // --- profile & transactions -------------------------------------------
    await run(alice, 'profile.update', { displayName: 'Alice', openingBalance: '20000', openingDate: '2026-01-01' });
    await run(bob, 'profile.update', { displayName: 'Bob', openingBalance: '5000', openingDate: '2026-01-01' });
    await run(alice, 'transactions.create', { type: 'income', amount: '100000', categoryId: 'cat_salary', date: '2026-10-01', paymentMethod: 'bankTransfer', counterparty: 'Acme Corp' });
    const tx = await run(alice, 'transactions.create', { type: 'expense', amount: '1250.50', categoryId: 'cat_food', date: '2026-10-05', paymentMethod: 'upi', counterparty: 'Swiggy', note: 'Dinner' });
    const tx2 = await run(alice, 'transactions.update', { id: tx.id, expectedVersion: tx.version, type: 'expense', amount: '1300.25', categoryId: 'cat_food', date: '2026-10-05', paymentMethod: 'upi', counterparty: 'Swiggy', note: 'Dinner + tip' });
    const tx3 = await run(alice, 'transactions.create', { type: 'expense', amount: '99', categoryId: 'cat_food', date: '2026-10-06' });
    await run(alice, 'transactions.delete', { id: tx3.id });

    // --- categories ---------------------------------------------------------
    const cat = await run(alice, 'categories.create', { name: 'Pets', type: 'expense', iconKey: 'dog', colorIndex: 3, description: 'Pet care', isEssential: false });
    await run(alice, 'categories.update', { id: cat.id, expectedVersion: cat.version, name: 'Pets & vets', type: 'expense', iconKey: 'dog', colorIndex: 4, description: 'Pet care', isEssential: true });
    await run(alice, 'categories.toggleArchive', { id: cat.id });
    await run(alice, 'categories.toggleArchive', { id: cat.id });
    const tmp = await run(alice, 'categories.create', { name: 'Temp', type: 'expense', iconKey: 'tag', colorIndex: 1 });
    await run(alice, 'categories.delete', { id: tmp.id });

    // --- budgets --------------------------------------------------------------
    const b = await run(alice, 'budgets.create', { categoryId: 'cat_food', limit: '8000', warningThresholdBps: 8000 });
    await run(alice, 'budgets.update', { id: b.id, expectedVersion: b.version, categoryId: 'cat_food', limit: '9000', warningThresholdBps: 8500 });
    await run(alice, 'budgets.setPaused', { id: b.id, paused: true });
    await run(alice, 'budgets.setPaused', { id: b.id, paused: false });
    const bTmp = await run(alice, 'budgets.create', { categoryId: 'cat_travel', limit: '1000' });
    await run(alice, 'budgets.delete', { id: bTmp.id });

    // --- pending (private) ----------------------------------------------------
    const p1 = await run(alice, 'pending.create', pending());
    await run(alice, 'pending.update', { id: p1.id, expectedVersion: p1.version, ...pending({ amount: '7000', purpose: 'Goa trip hotel share (updated)' }) });
    await run(alice, 'pending.settle', { pendingId: p1.id, amount: '1200', date: '2026-10-05', method: 'upi', recordCashMovement: true, note: 'Part payment' });
    await run(alice, 'pending.settle', { pendingId: p1.id, amount: '300', date: '2026-10-06', recordCashMovement: false });
    const p2 = await run(alice, 'pending.create', pending({ counterparty: 'Meera', amount: '800', purpose: 'Cab' }));
    await run(alice, 'pending.cancel', { id: p2.id });
    const p3 = await run(alice, 'pending.create', pending({ counterparty: 'Dev', amount: '150', purpose: 'Coffee', direction: 'iOwe', kind: 'borrowed' }));
    await run(alice, 'pending.delete', { id: p3.id });
    await run(alice, 'pending.split', {
      direction: 'owedToMe',
      total: '3000',
      purpose: 'Weekend cabin',
      createdDate: '2026-10-10',
      method: 'equally',
      includeMe: true,
      people: [{ counterparty: 'Asha' }, { counterparty: 'Bina' }],
    });

    // --- pending (shared Alice -> Bob) ----------------------------------------
    const shared = await run(alice, 'pending.create', pending({ counterparty: 'x', direction: 'iOwe', kind: 'borrowed', amount: '1000', purpose: 'Dinner', linkedUserId: bob.userId }));
    const mirId = `mir_${shared.link.sharedId}`;
    await run(alice, 'pending.settle', { pendingId: shared.id, amount: '300', date: '2026-10-09', method: 'upi' });
    await run(bob, 'pending.settle', { pendingId: mirId, amount: '400', date: '2026-10-10', method: 'upi' });

    // --- loans ------------------------------------------------------------------
    const loan = await run(alice, 'loans.create', carLoan({ recordDisbursement: true }));
    await run(alice, 'loans.update', { id: loan.id, expectedVersion: loan.version, ...carLoan({ name: 'Swift car loan' }) });
    await run(alice, 'loans.recordPayment', { loanId: loan.id, kind: 'installment', amount: '12602', date: '2026-10-05', recordCashMovement: true });
    const lent = await run(alice, 'loans.create', carLoan({ name: 'Lent to Ravi', direction: 'lent', counterparty: 'Ravi', principal: '12000', rateBps: 0, tenureInstallments: 12 }));
    await run(alice, 'loans.delete', { id: lent.id });

    // --- subscriptions ----------------------------------------------------------
    const s = await run(alice, 'subscriptions.create', sub());
    await run(alice, 'subscriptions.update', { id: s.id, expectedVersion: s.version, ...sub({ amount: '649', paymentMethod: 'upi' }) });
    await run(alice, 'subscriptions.markPaid', { subscriptionId: s.id });
    await run(alice, 'subscriptions.skipCycle', { subscriptionId: s.id });
    await run(alice, 'subscriptions.setStatus', { id: s.id, status: 'paused' });
    await run(alice, 'subscriptions.setStatus', { id: s.id, status: 'active' });
    const sDel = await run(alice, 'subscriptions.create', sub({ name: 'Old gym', nextDueDate: '2026-10-20' }));
    await run(alice, 'subscriptions.delete', { id: sDel.id });

    // --- goals -----------------------------------------------------------------
    const g = await run(alice, 'goals.create', goal({ initialAllocation: '10000' }));
    await run(alice, 'goals.update', { id: g.id, expectedVersion: g.version, ...goal({ name: 'Japan trip 2027', targetDate: '2027-04-10' }) });
    await run(alice, 'goals.contribute', { goalId: g.id, amount: '5000', date: '2026-10-10' });
    await run(alice, 'goals.withdraw', { goalId: g.id, amount: '1000', date: '2026-10-10' });
    await run(alice, 'goals.toggleArchive', { id: g.id });
    await run(alice, 'goals.toggleArchive', { id: g.id });
    const gDel = await run(alice, 'goals.create', goal({ name: 'Doomed' }));
    await run(alice, 'goals.delete', { id: gDel.id });

    // --- emergency fund ---------------------------------------------------------
    await run(alice, 'emergencyFund.configure', { essentialMonthlyExpenses: '40000', targetMonths: 6 });
    await run(alice, 'emergencyFund.contribute', { amount: '3000', date: '2026-10-10' });
    await run(alice, 'emergencyFund.withdraw', { amount: '500', date: '2026-10-10' });

    // --- assets -----------------------------------------------------------------
    const a = await run(alice, 'assets.create', asset());
    await run(alice, 'assets.update', { id: a.id, expectedVersion: a.version, ...asset({ value: '82000', valuedOn: '2026-10-09' }) });
    const aDel = await run(alice, 'assets.create', asset({ name: 'Old bike', type: 'vehicle' }));
    await run(alice, 'assets.delete', { id: aDel.id });

    // --- every registered action must be exercised --------------------------------
    const done = new Set(actions.map((x) => x.actionId));
    const missing = describeActions().map((d) => d.id).filter((id) => !done.has(id));
    expect(missing, `actions not exercised: ${missing.join(', ')}`).toEqual([]);

    // --- HTTP ---------------------------------------------------------------------
    const post = (user: AuthUser, id: string, body: unknown) =>
      call(actionRoute.POST, 'POST', `/api/v1/actions/${id}`, { user, params: { actionId: id }, body, headers: { 'idempotency-key': newKey() } });
    const confirmRes = await capture('actionNeedsConfirmation', post(alice, 'transactions.delete', { input: { id: tx2.id } }));
    expect(confirmRes.body.data.status).toBe('needsConfirmation');
    const doneRes = await capture(
      'actionCompleted',
      post(alice, 'transactions.create', { input: { type: 'expense', amount: '42.75', categoryId: 'cat_food', date: '2026-10-07', paymentMethod: 'cash' } }),
    );
    expect(doneRes.body.data.status).toBe('completed');
    await capture('actionValidationError', post(alice, 'transactions.create', { input: { type: 'expense', amount: '0', categoryId: 'cat_food', date: '2026-10-07' } }), 422);

    await capture('syncAlice', call(syncRoute.GET, 'GET', '/api/v1/sync', { user: alice }));
    const syncBob = await capture('syncBob', call(syncRoute.GET, 'GET', '/api/v1/sync', { user: bob }));
    const bobSync = JSON.stringify(syncBob.body);
    expect(bobSync).toContain(`"${mirId}"`);
    expect(bobSync).toContain('"id":"mir_set_');
    await capture('actionsList', call(actionsListRoute.GET, 'GET', '/api/v1/actions', { user: alice }));
    await capture('audit', call(auditRoute.GET, 'GET', '/api/v1/audit', { user: alice }));
    await capture('usersSearch', call(searchRoute.GET, 'GET', '/api/v1/users/search', { user: alice, query: { q: 'bo' } }));
    await capture('me', call(meRoute.GET, 'GET', '/api/v1/me', { user: alice }));
    await capture('preferences', call(prefsRoute.GET, 'GET', '/api/v1/preferences', { user: alice }));
    await capture('alertsInbox', call(inboxRoute.GET, 'GET', '/api/v1/alerts/inbox', { user: alice }));

    const at = '2026-09-01T10:00:00.000Z';
    const fresh = await t.createUser('device@example.com');
    await capture(
      'import',
      call(importRoute.POST, 'POST', '/api/v1/import', {
        user: fresh,
        headers: { 'idempotency-key': newKey() },
        body: {
          categories: [{ id: 'cat_custom_1', name: 'Pets', type: 'expense', iconKey: 'dog', colorIndex: 3, version: 1 }],
          transactions: [
            { id: 'tx_a', type: 'income', amountPaise: 5_000_000, categoryId: 'cat_salary', date: '2026-09-01', origin: 'manual', createdAt: at, updatedAt: at, version: 1 },
            { id: 'tx_b', type: 'expense', amountPaise: 120_000, categoryId: 'cat_custom_1', date: '2026-09-03', paymentMethod: 'upi', createdAt: at, updatedAt: at, version: 1 },
          ],
          profile: { exists: true, displayName: 'Aarav', openingPaise: 1_000_000, openingDate: '2026-09-01' },
        },
      }),
    );

    // --- write ----------------------------------------------------------------------
    if (process.env.WRITE_CONTRACT_FIXTURES === '1') {
      // Replace random user UUIDs so regenerated files diff cleanly.
      const ids: [string, string][] = [
        [alice.userId, '00000000-0000-4000-8000-00000000000a'],
        [bob.userId, '00000000-0000-4000-8000-00000000000b'],
        [fresh.userId, '00000000-0000-4000-8000-00000000000c'],
      ];
      const out = {
        generatedAt: new Date().toISOString(),
        actions,
        http: Object.fromEntries(Object.entries(http).sort(([x], [y]) => x.localeCompare(y))),
      };
      let text = JSON.stringify(out, null, 2) + '\n';
      for (const [from, to] of ids) text = text.split(from).join(to);
      const file = join(__dirname, '..', 'docs', 'contract', 'fixtures.json');
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, text);
    }
  }, 120_000);
});
