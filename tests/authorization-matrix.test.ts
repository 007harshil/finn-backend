// OWASP API1 (BOLA) matrix: a signed-in user who knows another user's record
// ids must not read, change, preview or reference those records through any
// route or action. Bob is not Alice's friend here, so nothing is shared.
//
// Invariants checked:
// - every GET/POST-by-id route answers 404 for Alice's ids when Bob calls it;
// - every action that takes a record id fails for Bob (never completes, never
//   returns a preview built from Alice's data);
// - Alice's complete sync payload is identical before and after the attacks;
// - nothing Bob receives contains Alice's private text.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as budgetRoute from '@/app/api/v1/budgets/[id]/route';
import * as goalRoute from '@/app/api/v1/goals/[id]/route';
import * as loanRoute from '@/app/api/v1/loans/[id]/route';
import * as loanPreviewRoute from '@/app/api/v1/loans/[id]/payment-preview/route';
import * as pendingRoute from '@/app/api/v1/pending/[id]/route';
import * as subscriptionRoute from '@/app/api/v1/subscriptions/[id]/route';
import * as syncRoute from '@/app/api/v1/sync/route';
import * as transactionRoute from '@/app/api/v1/transactions/[id]/route';
import * as friendRoute from '@/app/api/v1/friends/[userId]/route';
import * as friendRequestRoute from '@/app/api/v1/friends/requests/[id]/route';
import * as acceptRoute from '@/app/api/v1/friends/requests/[id]/accept/route';
import * as rejectRoute from '@/app/api/v1/friends/requests/[id]/reject/route';
import { dispatch } from '@/server/actions/dispatcher';
import { preparePlan } from '@/server/actions/plans';
import { describeActions } from '@/server/actions/registry';
import type { AuthUser } from '@/server/auth/verify';
import { AppFailure } from '@/server/core/failure';
import { act, fixClock } from './support/actions';
import { createTestDb, type TestDb } from './support/db';
import { makeClient, newKey } from './support/http';

let t: TestDb;
let call: ReturnType<typeof makeClient>;
let alice: AuthUser;
let bob: AuthUser;

const SECRET_NOTE = 'alice-private-note-7f3a';

beforeAll(async () => {
  t = await createTestDb();
  call = makeClient(t);
  fixClock();
  alice = await t.createUser('alice@example.com');
  bob = await t.createUser('bob@example.com');
  await t.fund(alice, 100_000);
  await t.fund(bob, 100_000);
});
afterAll(async () => t.close());

const loanIn = (o: Record<string, unknown> = {}) => ({
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
  note: SECRET_NOTE,
  ...o,
});
const subIn = (o: Record<string, unknown> = {}) => ({ name: 'Netflix', amount: '499', categoryId: 'cat_food', frequency: 'monthly', nextDueDate: '2026-10-20', ...o });
const goalIn = (o: Record<string, unknown> = {}) => ({ name: 'Japan trip', category: 'travel', target: '200000', colorIndex: 2, ...o });
const assetIn = (o: Record<string, unknown> = {}) => ({ name: 'Gold coins', type: 'gold', value: '80000', valuedOn: '2026-10-01', ...o });
const pendingIn = (o: Record<string, unknown> = {}) => ({
  counterparty: 'Rahul',
  direction: 'owedToMe',
  kind: 'lent',
  amount: '6500',
  purpose: SECRET_NOTE,
  createdDate: '2026-10-01',
  ...o,
});

describe('cross-user access (BOLA)', () => {
  it('never lets one user read, change or reference another user’s records', async () => {
    // --- Alice's records ---------------------------------------------------------
    const sbi = await act(alice, 'accounts.create', { name: 'SBI', kind: 'bank', institution: 'SBI', openingBalance: '10000', openingDate: '2026-01-01' });
    const card = await act(alice, 'accounts.create', { name: 'Axis', kind: 'creditCard', openingBalance: '0', openingDate: '2026-01-01', creditLimit: '50000' });
    const trf = await act(alice, 'transfers.create', { fromAccountId: sbi.id, toAccountId: 'acc_cash', amount: '200', date: '2026-10-02', note: SECRET_NOTE });
    const tx = await act(alice, 'transactions.create', { type: 'expense', amount: '120', categoryId: 'cat_food', date: '2026-10-05', accountId: sbi.id, note: SECRET_NOTE });
    const cat = await act(alice, 'categories.create', { name: 'Pets', type: 'expense', iconKey: 'dog', colorIndex: 3, description: SECRET_NOTE });
    const budget = await act(alice, 'budgets.create', { categoryId: cat.id, limit: '8000', note: SECRET_NOTE });
    const spare = await act(alice, 'categories.create', { name: 'Hobbies', type: 'expense', iconKey: 'tag', colorIndex: 1 });
    const pending = await act(alice, 'pending.create', pendingIn());
    const loan = await act(alice, 'loans.create', loanIn());
    const sub = await act(alice, 'subscriptions.create', subIn({ accountId: sbi.id }));
    const goal = await act(alice, 'goals.create', goalIn({ initialAllocation: '1000', note: SECRET_NOTE }));
    const asset = await act(alice, 'assets.create', assetIn({ note: SECRET_NOTE }));
    const before = await call(syncRoute.GET, 'GET', '/api/v1/sync', { user: alice });
    expect(before.status).toBe(200);

    // --- reads by id ---------------------------------------------------------------
    const reads: [string, Parameters<typeof call>[0], string, string][] = [
      ['transaction', transactionRoute.GET, 'GET', tx.id],
      ['budget', budgetRoute.GET, 'GET', budget.id],
      ['goal', goalRoute.GET, 'GET', goal.id],
      ['loan', loanRoute.GET, 'GET', loan.id],
      ['pending', pendingRoute.GET, 'GET', pending.id],
      ['subscription', subscriptionRoute.GET, 'GET', sub.id],
    ];
    const leaked: string[] = [];
    for (const [name, handler, method, id] of reads) {
      const own = await call(handler, method, `/x/${id}`, { user: alice, params: { id } });
      expect(own.status, `alice reads own ${name}`).toBe(200);
      const res = await call(handler, method, `/x/${id}`, { user: bob, params: { id } });
      expect(res.status, `bob reads alice's ${name}`).toBe(404);
      if (JSON.stringify(res.body).includes(SECRET_NOTE)) leaked.push(name);
    }
    const preview = await call(loanPreviewRoute.POST, 'POST', `/x/${loan.id}/payment-preview`, {
      user: bob,
      params: { id: loan.id },
      body: { kind: 'installment', amount: '100', date: '2026-10-05' },
    });
    expect([404, 422], `bob previews alice's loan payment: ${JSON.stringify(preview.body)}`).toContain(preview.status);
    expect(JSON.stringify(preview.body)).not.toContain('HDFC');

    // --- friend routes with someone else's ids --------------------------------------
    for (const [handler, method, path] of [
      [friendRoute.DELETE, 'DELETE', `/x/${alice.userId}`],
      [friendRequestRoute.DELETE, 'DELETE', '/x/fr_unknown'],
      [acceptRoute.POST, 'POST', '/x/fr_unknown/accept'],
      [rejectRoute.POST, 'POST', '/x/fr_unknown/reject'],
    ] as const) {
      const res = await call(handler, method, path, { user: bob, params: { userId: alice.userId, id: 'fr_unknown' } });
      expect(res.status, `${method} ${path}`).toBeGreaterThanOrEqual(400);
    }

    // --- every id-taking action, aimed at Alice's records ---------------------------
    const attacks: [string, Record<string, unknown>][] = [
      ['accounts.update', { id: sbi.id, expectedVersion: 1, name: 'Mine', kind: 'bank', openingBalance: '0', openingDate: '2026-01-01' }],
      ['accounts.setBalance', { id: sbi.id, balance: '5000', asOf: '2026-10-01' }],
      ['accounts.setDefault', { id: sbi.id }],
      ['accounts.archive', { id: sbi.id, archived: true }],
      ['accounts.delete', { id: card.id }],
      ['transfers.create', { fromAccountId: sbi.id, toAccountId: 'acc_cash', amount: '10', date: '2026-10-02' }],
      ['transfers.update', { id: trf.id, expectedVersion: 1, fromAccountId: 'acc_cash', toAccountId: 'acc_cash', amount: '1', date: '2026-10-02' }],
      ['transfers.delete', { id: trf.id }],
      ['transactions.create', { type: 'expense', amount: '1', categoryId: 'cat_food', date: '2026-10-05', accountId: sbi.id }],
      ['transactions.create', { type: 'expense', amount: '1', categoryId: cat.id, date: '2026-10-05' }],
      ['transactions.update', { id: tx.id, expectedVersion: 1, type: 'expense', amount: '1', categoryId: 'cat_food', date: '2026-10-05' }],
      ['transactions.delete', { id: tx.id }],
      ['categories.update', { id: cat.id, expectedVersion: 1, name: 'Mine', type: 'expense', iconKey: 'dog', colorIndex: 1 }],
      ['categories.toggleArchive', { id: cat.id }],
      ['categories.delete', { id: spare.id }],
      ['budgets.create', { categoryId: spare.id, limit: '1' }],
      ['budgets.update', { id: budget.id, expectedVersion: 1, categoryId: 'cat_food', limit: '1' }],
      ['budgets.setPaused', { id: budget.id, paused: true }],
      ['budgets.delete', { id: budget.id }],
      ['pending.update', { id: pending.id, expectedVersion: 1, ...pendingIn({ amount: '1' }) }],
      ['pending.settle', { pendingId: pending.id, amount: '1', date: '2026-10-05', recordCashMovement: false }],
      ['pending.cancel', { id: pending.id }],
      ['pending.delete', { id: pending.id }],
      ['pending.create', pendingIn({ linkedUserId: alice.userId })],
      ['loans.update', { id: loan.id, expectedVersion: 1, ...loanIn({ name: 'Mine' }) }],
      ['loans.recordPayment', { loanId: loan.id, kind: 'installment', amount: '5000', date: '2026-10-05', recordCashMovement: false }],
      ['loans.delete', { id: loan.id }],
      ['subscriptions.create', subIn({ accountId: sbi.id })],
      ['subscriptions.update', { id: sub.id, expectedVersion: 1, ...subIn() }],
      ['subscriptions.markPaid', { subscriptionId: sub.id }],
      ['subscriptions.skipCycle', { subscriptionId: sub.id }],
      ['subscriptions.setStatus', { id: sub.id, status: 'paused' }],
      ['subscriptions.delete', { id: sub.id }],
      ['goals.update', { id: goal.id, expectedVersion: 1, ...goalIn({ name: 'Mine' }) }],
      ['goals.contribute', { goalId: goal.id, amount: '1', date: '2026-10-10' }],
      ['goals.withdraw', { goalId: goal.id, amount: '1', date: '2026-10-10' }],
      ['goals.toggleArchive', { id: goal.id }],
      ['goals.delete', { id: goal.id }],
      ['assets.update', { id: asset.id, expectedVersion: 1, ...assetIn({ value: '1' }) }],
      ['assets.delete', { id: asset.id }],
    ];

    // Coverage: every registered action with a record-id field is attacked.
    const attacked = new Set(attacks.map(([id]) => id));
    const idActions = describeActions()
      .filter((d) => d.fields.some((f) => f.name === 'id' || /^(pending|loan|goal|subscription)Id$/.test(f.name)))
      .map((d) => d.id);
    expect(idActions.filter((id) => !attacked.has(id)), 'id-taking actions not attacked').toEqual([]);

    const completed: string[] = [];
    for (const [actionId, input] of attacks) {
      for (const confirm of [false, true]) {
        let outcome;
        try {
          outcome = await dispatch(bob, actionId, input, {
            idempotencyKey: newKey(),
            ...(confirm ? { confirmation: { fingerprint: 'forged-fingerprint' } } : {}),
          });
        } catch (err) {
          expect(err, `${actionId}: ${String(err)}`).toBeInstanceOf(AppFailure);
          expect(['notFound', 'validation', 'conflict', 'forbidden'], `${actionId}: ${(err as AppFailure).code}`).toContain((err as AppFailure).code);
          if (JSON.stringify((err as AppFailure).toJSON()).includes(SECRET_NOTE)) leaked.push(actionId);
          continue;
        }
        // A preview or completion means Bob's request was accepted against Alice's id.
        completed.push(`${actionId} -> ${outcome.status}`);
        if (JSON.stringify(outcome).includes(SECRET_NOTE)) leaked.push(actionId);
      }
    }
    expect(completed).toEqual([]);
    expect(leaked).toEqual([]);

    // --- Alice's data is untouched ---------------------------------------------------
    const after = await call(syncRoute.GET, 'GET', '/api/v1/sync', { user: alice });
    expect(after.body).toEqual(before.body);

    // --- control: the same inputs are valid for Alice (preview only, no writes) ------
    // Proves Bob was refused because the records are not his, not because the
    // attack inputs were malformed. Two inputs are invalid for anyone by design.
    const invalidForAnyone = new Set(['transfers.update', 'pending.create']);
    const steps = attacks.map(([actionId, input], i) => ({ stepId: `s${i}`, actionId, input, dependsOn: [] }));
    const own = await preparePlan(alice, { planId: 'bola-control-plan', channel: 'ui', steps });
    const notReady = own.filter((r, i) => r.status !== 'ready' && !invalidForAnyone.has(attacks[i][0])).map((r) => `${r.actionId}: ${JSON.stringify(r.failure)}`);
    expect(notReady).toEqual([]);
    const theirs = await preparePlan(bob, { planId: 'bola-attack-plan', channel: 'ui', steps });
    expect(theirs.filter((r) => r.status === 'ready').map((r) => r.actionId)).toEqual([]);
    expect(JSON.stringify(theirs)).not.toContain(SECRET_NOTE);
    expect(idActions.length).toBeGreaterThan(25);
  }, 120_000);
});
