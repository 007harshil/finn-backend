import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as listRoute from '@/app/api/v1/subscriptions/route';
import * as detailRoute from '@/app/api/v1/subscriptions/[id]/route';
import * as upcomingRoute from '@/app/api/v1/subscriptions/upcoming/route';
import { createTestDb, type TestDb } from './support/db';
import { makeClient, newKey } from './support/http';
import { act, fixClock, read } from './support/actions';
import { dispatch } from '@/server/actions/dispatcher';
import type { AuthUser } from '@/server/auth/verify';
import { ensureAccount } from '@/server/modules/account/bootstrap';
import { withUserTx } from '@/server/db/tx';
import { monthlyEquivalent } from '@/server/core/frequency';
import type { Subscription } from '@/server/finance/models';
import {
  dueState,
  monthlyCommitment,
  nextCycleAfterCurrent,
  occurrencesIn,
  projectCharges,
} from '@/server/modules/subscriptions/calculator';
import { DateRange } from '@/server/core/dates';
import { loadSubscriptionViews } from '@/server/modules/subscriptions/service';

let t: TestDb;
let call: ReturnType<typeof makeClient>;
let alice: AuthUser;
let bob: AuthUser;

beforeAll(async () => {
  t = await createTestDb();
  call = makeClient(t);
  fixClock();
  alice = await t.createUser('sub-alice@example.com');
  bob = await t.createUser('sub-bob@example.com');
  for (const u of [alice, bob]) await withUserTx(u, (tx) => ensureAccount(tx, u), { write: true });
});

afterAll(async () => t.close());

const sub = (over: Partial<Subscription> = {}): Subscription => ({
  id: 's1',
  name: 'Netflix',
  amountPaise: 49900,
  categoryId: 'cat_food',
  frequency: 'monthly',
  nextDueDate: '2026-10-15',
  startDate: null,
  status: 'active',
  autoRenews: true,
  paymentMethod: null,
  note: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  version: 1,
  ...over,
});

const input = (extra: Record<string, unknown> = {}) => ({
  name: 'Netflix',
  amount: '499',
  categoryId: 'cat_food',
  frequency: 'monthly',
  nextDueDate: '2026-10-08',
  ...extra,
});

describe('subscription calculator', () => {
  it('computes monthly equivalents half-up', () => {
    expect(monthlyEquivalent('monthly', 49900)).toBe(49900);
    expect(monthlyEquivalent('weekly', 1001)).toBe(4338); // 4337.67
    expect(monthlyEquivalent('weekly', 1005)).toBe(4355); // exact
    expect(monthlyEquivalent('quarterly', 1001)).toBe(334); // 333.67
    expect(monthlyEquivalent('halfYearly', 1005)).toBe(168); // 167.5 rounds up
    expect(monthlyEquivalent('yearly', 120000)).toBe(10000);
  });

  it('excludes paused and cancelled from the commitment', () => {
    const subs = [sub({ id: 'a' }), sub({ id: 'b', status: 'paused' }), sub({ id: 'c', status: 'cancelled' }), sub({ id: 'd', frequency: 'yearly', amountPaise: 120000 })];
    expect(monthlyCommitment(subs)).toBe(49900 + 10000);
  });

  it('classifies due states against the reminder window', () => {
    const today = '2026-10-10';
    expect(dueState({ nextDueDate: '2026-10-09' }, today, 3)).toBe('overdue');
    expect(dueState({ nextDueDate: '2026-10-10' }, today, 3)).toBe('dueToday');
    expect(dueState({ nextDueDate: '2026-10-13' }, today, 3)).toBe('dueSoon');
    expect(dueState({ nextDueDate: '2026-10-14' }, today, 3)).toBe('upcoming');
  });

  it('keeps the 31st anchor through February', () => {
    const s = sub({ nextDueDate: '2027-01-31', startDate: '2026-12-31' });
    const feb = nextCycleAfterCurrent(s);
    expect(feb).toBe('2027-02-28');
    expect(nextCycleAfterCurrent({ ...s, nextDueDate: feb })).toBe('2027-03-31');
    expect(occurrencesIn(s, new DateRange('2027-01-01', '2027-04-30'))).toEqual(['2027-01-31', '2027-02-28', '2027-03-31', '2027-04-30']);
  });

  it('projects charges only for active subscriptions inside the window', () => {
    const subs = [
      sub({ id: 'w', frequency: 'weekly', amountPaise: 1000, nextDueDate: '2026-10-11' }),
      sub({ id: 'p', status: 'paused', nextDueDate: '2026-10-12' }),
    ];
    const out = projectCharges(subs, '2026-10-10', '2026-10-31');
    expect(out.map((c) => c.date)).toEqual(['2026-10-11', '2026-10-18', '2026-10-25']);
    expect(out.every((c) => c.subscriptionId === 'w' && c.categoryId === 'cat_food' && c.amountPaise === 1000)).toBe(true);
  });
});

describe('subscription actions', () => {
  it('creates, validates, edits with optimistic concurrency', async () => {
    const created = await act(alice, 'subscriptions.create', input());
    expect(created.id).toMatch(/^sub_/);
    expect(created.amountPaise).toBe(49900);
    expect(created.version).toBe(1);
    await expect(act(alice, 'subscriptions.create', input({ name: '  ' }))).rejects.toMatchObject({
      code: 'validation',
      fieldErrors: { name: 'Enter the service name.' },
    });
    await expect(act(alice, 'subscriptions.create', input({ categoryId: 'cat_salary' }))).rejects.toMatchObject({ code: 'validation' });
    await expect(act(alice, 'subscriptions.create', input({ startDate: '2026-11-01' }))).rejects.toMatchObject({
      fieldErrors: { startDate: 'The start date must be on or before the next due date.' },
    });
    const updated = await act(alice, 'subscriptions.update', { id: created.id, expectedVersion: 1, ...input({ amount: '599' }) });
    expect(updated.version).toBe(2);
    expect(updated.amountPaise).toBe(59900);
    await expect(act(alice, 'subscriptions.update', { id: created.id, expectedVersion: 1, ...input() })).rejects.toMatchObject({ code: 'staleData' });
  });

  it('pauses and resumes; no-op status change is rejected', async () => {
    const s = await act(alice, 'subscriptions.create', input({ name: 'Spotify' }));
    const paused = await act(alice, 'subscriptions.setStatus', { id: s.id, status: 'paused' });
    expect(paused.status).toBe('paused');
    await expect(act(alice, 'subscriptions.setStatus', { id: s.id, status: 'paused' })).rejects.toMatchObject({
      code: 'validation',
      message: 'Spotify is already paused.',
    });
    await expect(act(alice, 'subscriptions.markPaid', { subscriptionId: s.id })).rejects.toMatchObject({ code: 'validation' });
    const resumed = await act(alice, 'subscriptions.setStatus', { id: s.id, status: 'active' });
    expect(resumed.status).toBe('active');
  });

  it('mark paid records exactly one linked expense and advances one cycle', async () => {
    const s = await act(alice, 'subscriptions.create', input({ name: 'Hotstar', nextDueDate: '2026-10-08', paymentMethod: 'upi' }));
    const before = await read(alice, (x) => x.balance());
    const tx = await act(alice, 'subscriptions.markPaid', { subscriptionId: s.id });
    expect(tx.origin).toBe('subscription');
    expect(tx.originRefId).toBe(s.id);
    expect(tx.type).toBe('expense');
    expect(tx.categoryId).toBe('cat_food');
    expect(tx.date).toBe('2026-10-08');
    expect(tx.paymentMethod).toBe('upi');
    expect(tx.note).toBe('Monthly renewal · for 8 Oct 2026');
    const after = await read(alice, (x) => x.balance());
    expect(after.cashPaise - before.cashPaise).toBe(-49900);
    const subs = await read(alice, (x) => x.subscriptions());
    expect(subs.find((x) => x.id === s.id)).toMatchObject({ nextDueDate: '2026-11-08', version: 2 });
    expect(await read(alice, (x) => x.linkedTransactions(s.id))).toHaveLength(1);
  });

  it('defaults the payment date to today when the due date is ahead', async () => {
    const s = await act(alice, 'subscriptions.create', input({ name: 'Prime', nextDueDate: '2026-10-20' }));
    const tx = await act(alice, 'subscriptions.markPaid', { subscriptionId: s.id });
    expect(tx.date).toBe('2026-10-10');
    await expect(act(alice, 'subscriptions.markPaid', { subscriptionId: s.id, date: '2026-10-11' })).rejects.toMatchObject({ code: 'validation' });
  });

  it('a replayed mark paid does not pay twice', async () => {
    const s = await act(alice, 'subscriptions.create', input({ name: 'Zee5' }));
    const key = newKey();
    const first = await act(alice, 'subscriptions.markPaid', { subscriptionId: s.id }, { key });
    const second = await act(alice, 'subscriptions.markPaid', { subscriptionId: s.id }, { key });
    expect(second.id).toBe(first.id);
    expect(await read(alice, (x) => x.linkedTransactions(s.id))).toHaveLength(1);
  });

  it('rejects a second payment of an already paid cycle (stale screen) as Dart does', async () => {
    const s = await act(alice, 'subscriptions.create', input({ name: 'Audible', nextDueDate: '2026-10-08' }));
    await act(alice, 'subscriptions.markPaid', { subscriptionId: s.id, cycleDate: '2026-10-08' });
    await expect(act(alice, 'subscriptions.markPaid', { subscriptionId: s.id, cycleDate: '2026-10-08' })).rejects.toMatchObject({
      code: 'duplicate',
      message: 'The renewal due 8 Oct 2026 is already settled.',
    });
    await expect(act(alice, 'subscriptions.markPaid', { subscriptionId: s.id, cycleDate: '2026-12-08' })).rejects.toMatchObject({
      code: 'staleData',
    });
    expect(await read(alice, (x) => x.linkedTransactions(s.id))).toHaveLength(1);
  });

  it('refuses a cycle that already has a payment even when the date was edited back', async () => {
    const s = await act(alice, 'subscriptions.create', input({ name: 'Kindle', nextDueDate: '2026-10-08' }));
    await act(alice, 'subscriptions.markPaid', { subscriptionId: s.id });
    const cur = await read(alice, async (x) => (await x.subscriptions()).find((q) => q.id === s.id)!);
    await act(alice, 'subscriptions.update', { id: s.id, expectedVersion: cur.version, ...input({ name: 'Kindle', nextDueDate: '2026-10-08' }) });
    await expect(act(alice, 'subscriptions.markPaid', { subscriptionId: s.id })).rejects.toMatchObject({
      code: 'duplicate',
      message: 'A payment for the renewal due 8 Oct 2026 is already recorded.',
    });
  });

  it('invalidates a stale approval when the subscription changed after the preview', async () => {
    const s = await act(alice, 'subscriptions.create', input({ name: 'Hulu' }));
    const body = { subscriptionId: s.id };
    const first = await dispatch(alice, 'subscriptions.markPaid', body, { idempotencyKey: newKey() });
    expect(first.status).toBe('needsConfirmation');
    if (first.status !== 'needsConfirmation') return;
    await act(alice, 'subscriptions.skipCycle', { subscriptionId: s.id });
    const second = await dispatch(alice, 'subscriptions.markPaid', body, {
      idempotencyKey: newKey(),
      confirmation: { fingerprint: first.preview.fingerprint },
    });
    expect(second.status).toBe('needsConfirmation');
    expect(await read(alice, (x) => x.linkedTransactions(s.id))).toHaveLength(0);
  });

  it('skip advances without a transaction', async () => {
    const s = await act(alice, 'subscriptions.create', input({ name: 'Gym', nextDueDate: '2026-10-08' }));
    const skipped = await act(alice, 'subscriptions.skipCycle', { subscriptionId: s.id });
    expect(skipped.nextDueDate).toBe('2026-11-08');
    expect(skipped.version).toBe(2);
    expect(await read(alice, (x) => x.linkedTransactions(s.id))).toHaveLength(0);
    await expect(act(alice, 'subscriptions.skipCycle', { subscriptionId: s.id, cycleDate: '2026-10-08' })).rejects.toMatchObject({ code: 'staleData' });
  });

  it('delete keeps recorded payments', async () => {
    const s = await act(alice, 'subscriptions.create', input({ name: 'Temp' }));
    const paid = await act(alice, 'subscriptions.markPaid', { subscriptionId: s.id });
    await expect(act(alice, 'subscriptions.delete', { id: s.id }, { confirm: false })).rejects.toThrow(/needsConfirmation/);
    await act(alice, 'subscriptions.delete', { id: s.id });
    expect((await read(alice, (x) => x.subscriptions())).find((x) => x.id === s.id)).toBeUndefined();
    expect(await read(alice, (x) => x.transaction(paid.id))).not.toBeNull();
  });

  it('isolates users', async () => {
    const mine = await act(alice, 'subscriptions.create', input({ name: 'Private' }));
    await expect(act(bob, 'subscriptions.setStatus', { id: mine.id, status: 'paused' })).rejects.toMatchObject({ code: 'notFound' });
    await expect(act(bob, 'subscriptions.markPaid', { subscriptionId: mine.id })).rejects.toMatchObject({ code: 'notFound' });
    expect(await read(bob, (x) => x.subscriptions())).toHaveLength(0);
  });
});

describe('subscription endpoints', () => {
  it('lists with totals, serves detail and upcoming', async () => {
    const s = await act(bob, 'subscriptions.create', input({ name: 'Weekly mag', frequency: 'weekly', amount: '10.01', nextDueDate: '2026-10-12' }));
    await act(bob, 'subscriptions.create', input({ name: 'Old', nextDueDate: '2026-10-01' }));
    const p = await act(bob, 'subscriptions.create', input({ name: 'Paused', nextDueDate: '2026-10-20' }));
    await act(bob, 'subscriptions.setStatus', { id: p.id, status: 'paused' });
    await act(bob, 'subscriptions.markPaid', { subscriptionId: s.id });

    const list = await call(listRoute.GET, 'GET', '/api/v1/subscriptions', { user: bob });
    expect(list.status).toBe(200);
    const items = list.body.data.items;
    expect(items).toHaveLength(3);
    const weekly = items.find((i: { id: string }) => i.id === s.id);
    expect(weekly).toMatchObject({ monthlyEquivalentPaise: 4338, dueState: 'upcoming', daysUntilDue: 9 });
    expect(items.find((i: { name: string }) => i.name === 'Old')).toMatchObject({ dueState: 'overdue', daysUntilDue: -9 });
    expect(list.body.data.totals).toEqual({
      monthlyCommitmentPaise: 4338 + 49900,
      annualPaise: 1001 * 52 + 49900 * 12,
      counts: { active: 2, paused: 1, cancelled: 0 },
    });
    const views = await read(bob, (x) => loadSubscriptionViews(x));
    expect(views).toHaveLength(3);

    const detail = await call(detailRoute.GET, 'GET', `/api/v1/subscriptions/${s.id}`, { user: bob, params: { id: s.id } });
    expect(detail.body.data.payments).toHaveLength(1);
    expect(detail.body.data.payments[0].originRefId).toBe(s.id);
    expect(detail.body.data.nextRenewals[0].date).toBe('2026-10-19');
    const missing = await call(detailRoute.GET, 'GET', '/api/v1/subscriptions/nope', { user: bob, params: { id: 'nope' } });
    expect(missing.status).toBe(404);

    const up = await call(upcomingRoute.GET, 'GET', '/api/v1/subscriptions/upcoming', { user: bob, query: { days: 14 } });
    expect(up.status).toBe(200);
    expect(up.body.data.items.map((i: { date: string }) => i.date)).toEqual(['2026-10-19']);
    expect(up.body.data.overdue.map((i: { name: string }) => i.name)).toEqual(['Old']);
    const bad = await call(upcomingRoute.GET, 'GET', '/api/v1/subscriptions/upcoming', { user: bob, query: { days: 400 } });
    expect(bad.status).toBe(422);
    const unauth = await call(listRoute.GET, 'GET', '/api/v1/subscriptions', {});
    expect(unauth.status).toBe(401);
  });
});
