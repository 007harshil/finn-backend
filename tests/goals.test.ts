import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as goalsRoute from '@/app/api/v1/goals/route';
import * as goalRoute from '@/app/api/v1/goals/[id]/route';
import { createTestDb, type TestDb } from './support/db';
import { makeClient } from './support/http';
import { act, fixClock, read } from './support/actions';
import type { AuthUser } from '@/server/auth/verify';
import { ensureAccount } from '@/server/modules/account/bootstrap';
import { withUserTx } from '@/server/db/tx';
import { goalProgress } from '@/server/modules/goals/calculator';
import { loadGoalProgress } from '@/server/modules/goals/service';
import { DateRange } from '@/server/core/dates';
import type { Goal, SavingsMovement } from '@/server/finance/models';

const TODAY = '2026-10-10';
const rs = (v: number) => v * 100;

function goal(over: Partial<Goal> = {}): Goal {
  return {
    id: 'g1',
    name: 'Japan trip',
    category: 'travel',
    targetPaise: rs(100000),
    targetDate: null,
    plannedMonthlyPaise: null,
    colorIndex: 1,
    status: 'active',
    note: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    version: 1,
    ...over,
  };
}

let n = 0;
function mv(rupees: number, date: string, o: { withdraw?: boolean; bucket?: string; type?: 'goal' | 'emergencyFund' } = {}): SavingsMovement {
  return {
    id: `sv_${n++}`,
    bucketType: o.type ?? 'goal',
    bucketId: o.bucket ?? 'g1',
    kind: o.withdraw ? 'withdrawal' : 'contribution',
    accountId: 'acc_cash',
    amountPaise: rs(rupees),
    date,
    note: null,
    createdAt: '2026-01-01T00:00:00.000Z',
  };
}

describe('GoalCalculator', () => {
  const history = [
    mv(30000, '2026-08-05'),
    mv(10000, '2026-09-05'),
    mv(5000, '2026-09-20', { withdraw: true }),
    mv(50000, '2026-10-20'), // future-dated: ignored
    mv(99999, '2026-09-01', { bucket: 'g2' }), // another goal
    mv(7777, '2026-09-01', { type: 'emergencyFund' }), // other bucket type
  ];

  it('derives saved and progress from this goal\'s movements up to today', () => {
    const g = goalProgress(goal(), history, TODAY);
    expect(g.saved).toBe(rs(35000));
    expect(g.remaining).toBe(rs(65000));
    expect(g.progressBps).toBe(3500);
    expect(g.isAchieved).toBe(false);
    expect(g.movements).toHaveLength(3);
    expect(g.movements[0]!.date).toBe('2026-09-20');
  });

  it('averages the last three full months, half-up', () => {
    const g = goalProgress(goal(), [...history, mv(1000, '2026-10-02'), mv(2000, '2026-06-30')], TODAY);
    expect(g.averageMonthlyContribution).toBe(1166667);
  });

  it('estimates from the recent average without a plan; the plan wins when present', () => {
    const g = goalProgress(goal(), history, TODAY);
    expect(g.estimatedCompletion).toBe('2027-04-10');
    expect(g.onTrack).toBeNull();
    expect(g.requiredMonthly).toBeNull();
    expect(goalProgress(goal({ plannedMonthlyPaise: rs(10000) }), history, TODAY).estimatedCompletion).toBe('2027-05-10');
  });

  it('requiredMonthly rounds up and counts a partial month as one', () => {
    expect(goalProgress(goal({ targetDate: '2027-04-10' }), history, TODAY).requiredMonthly).toBe(1083334);
    expect(goalProgress(goal({ targetDate: '2027-04-15' }), history, TODAY).requiredMonthly).toBe(928572);
    expect(goalProgress(goal({ targetDate: '2026-10-05' }), history, TODAY).requiredMonthly).toBe(rs(65000));
    expect(goalProgress(goal({ targetDate: '2026-10-25' }), history, TODAY).requiredMonthly).toBe(rs(65000));
  });

  it('onTrack compares the estimate with the target date', () => {
    const plan = { plannedMonthlyPaise: rs(10000) };
    expect(goalProgress(goal({ targetDate: '2027-04-10', ...plan }), history, TODAY).onTrack).toBe(false);
    expect(goalProgress(goal({ targetDate: '2027-06-01', ...plan }), history, TODAY).onTrack).toBe(true);
    expect(goalProgress(goal({ targetDate: '2027-05-10', ...plan }), history, TODAY).onTrack).toBe(true);
  });

  it('achieved goals', () => {
    const g = goalProgress(goal({ targetDate: '2027-01-01' }), [mv(100000, '2026-07-01'), mv(20000, '2026-09-09')], TODAY);
    expect(g.saved).toBe(rs(120000));
    expect(g.isAchieved).toBe(true);
    expect(g.progressBps).toBe(10000);
    expect(g.remaining).toBe(0);
    expect(g.onTrack).toBe(true);
    expect(g.requiredMonthly).toBeNull();
    expect(g.estimatedCompletion).toBe('2026-09-09');
  });

  it('gives no honest estimate without history, with a negative trend, or with idle history', () => {
    const only = goalProgress(goal({ targetDate: '2027-06-01' }), [mv(5000, '2026-10-02')], TODAY);
    expect(only.averageMonthlyContribution).toBeNull();
    expect(only.estimatedCompletion).toBeNull();
    expect(only.onTrack).toBeNull();
    expect(only.requiredMonthly).not.toBeNull();

    const shrinking = goalProgress(goal(), [mv(50000, '2026-06-01'), mv(30000, '2026-08-01', { withdraw: true })], TODAY);
    expect(shrinking.averageMonthlyContribution).toBe(rs(-10000));
    expect(shrinking.estimatedCompletion).toBeNull();

    const idle = goalProgress(goal(), [mv(50000, '2026-05-01')], TODAY);
    expect(idle.averageMonthlyContribution).toBe(0);
    expect(idle.estimatedCompletion).toBeNull();

    expect(goalProgress(goal(), [], TODAY).estimatedCompletion).toBeNull();
    expect(goalProgress(goal({ targetPaise: 0 }), [], TODAY).isAchieved).toBe(false);
  });

  it('refuses estimates beyond 600 months', () => {
    const g = goalProgress(goal({ targetPaise: rs(1000000), plannedMonthlyPaise: 100 }), [], TODAY);
    expect(g.estimatedCompletion).toBeNull();
  });
});

describe('goals actions', () => {
  let t: TestDb;
  let call: ReturnType<typeof makeClient>;
  let alice: AuthUser;
  let bob: AuthUser;
  let cash0: number;

  const japan = (over: Record<string, unknown> = {}) => ({ name: 'Japan trip', category: 'travel', target: '200000', colorIndex: 2, ...over });
  const move = (goalId: string, amount: number | string, over: Record<string, unknown> = {}) => ({ goalId, amount, date: TODAY, ...over });
  const bal = () => read(alice, (s) => s.balance());
  const goalCount = () =>
    withUserTx(alice, async (tx) => Number((await tx.selectFrom('goals').select((eb) => eb.fn.countAll().as('n')).executeTakeFirstOrThrow()).n));

  beforeAll(async () => {
    t = await createTestDb();
    call = makeClient(t);
    fixClock();
    alice = await t.createUser('alice@example.com');
    bob = await t.createUser('bob@example.com');
    for (const u of [alice, bob]) await withUserTx(u, (tx) => ensureAccount(tx, u), { write: true });
    await act(alice, 'transactions.create', { type: 'income', amount: '100000', categoryId: 'cat_salary', date: '2026-10-01' });
    cash0 = (await bal()).cashPaise;
  });
  afterAll(async () => t.close());

  it('creates a goal with no starting amount: no confirmation, nothing earmarked', async () => {
    const g = await act(alice, 'goals.create', japan(), { confirm: false });
    expect(g.name).toBe('Japan trip');
    expect(g.targetPaise).toBe(rs(200000));
    expect(g.version).toBe(1);
    expect((await bal()).earmarkedPaise).toBe(0);
  });

  it('a starting amount creates exactly one movement, needs review, and leaves cash unchanged', async () => {
    await expect(act(alice, 'goals.create', japan({ name: 'Laptop', initialAllocation: '20000' }), { confirm: false })).rejects.toThrow(/needsConfirmation/);
    const g = await act(alice, 'goals.create', japan({ name: 'Laptop', initialAllocation: '20000' }));
    const mvs = await read(alice, (s) => s.movements());
    const own = mvs.filter((m) => m.bucketId === g.id);
    expect(own).toHaveLength(1);
    expect(own[0]).toMatchObject({ kind: 'contribution', date: TODAY, note: 'Starting amount', amountPaise: rs(20000), bucketType: 'goal' });
    const b = await bal();
    expect(b.cashPaise).toBe(cash0);
    expect(b.earmarkedGoalsPaise).toBe(rs(20000));
    expect(b.availablePaise).toBe(cash0 - rs(20000));
    const txCount = await withUserTx(alice, async (tx) =>
      Number((await tx.selectFrom('transactions').select((eb) => eb.fn.countAll().as('n')).where('origin', '<>', 'manual').executeTakeFirstOrThrow()).n),
    );
    expect(txCount).toBe(0);
  });

  it('validates names, target, dates and starting amount against available cash', async () => {
    const fields = async (input: Record<string, unknown>) =>
      act(alice, 'goals.create', input).then(
        () => [],
        (e) => Object.keys(e.fieldErrors ?? {}),
      );
    expect(await fields(japan({ name: 'JAPAN TRIP' }))).toEqual(['name']);
    expect(await fields(japan({ name: ' ' }))).toEqual(['name']);
    expect(await fields(japan({ name: 'x'.repeat(51) }))).toEqual(['name']);
    expect(await fields(japan({ name: 'Car', target: 0 }))).toEqual(['target']);
    expect(await fields(japan({ name: 'Car', targetDate: TODAY }))).toEqual(['targetDate']);
    const b = await bal();
    expect(await fields(japan({ name: 'Car', initialAllocation: String(b.availablePaise / 100 + 1) }))).toEqual(['initialAllocation']);
  });

  describe('contributions and withdrawals', () => {
    let id: string;
    beforeAll(async () => {
      id = (await act(alice, 'goals.create', japan({ name: 'Bike', target: '50000' }))).id;
    });

    it('contribute earmarks available cash; withdraw releases it; no transactions or cash change', async () => {
      const before = await bal();
      const txBefore = await read(alice, (s) => s.summary(new DateRange('2026-01-01', TODAY)));
      await expect(act(alice, 'goals.contribute', move(id, 30000), { confirm: false })).rejects.toThrow(/Set aside ₹30,000 for Bike/);
      await act(alice, 'goals.contribute', move(id, 30000));
      await act(alice, 'goals.withdraw', move(id, 5000));
      const after = await bal();
      expect(after.cashPaise).toBe(before.cashPaise);
      expect(after.availablePaise).toBe(before.availablePaise - rs(25000));
      const p = (await read(alice, (s) => loadGoalProgress(s))).find((x) => x.goal.id === id)!;
      expect(p.saved).toBe(rs(25000));
      const txAfter = await read(alice, (s) => s.summary(new DateRange('2026-01-01', TODAY)));
      expect(txAfter.transactionCount).toBe(txBefore.transactionCount);
    });

    it('limits contributions to available and withdrawals to saved; checks date and amount', async () => {
      const b = await bal();
      const tooMuch = await act(alice, 'goals.contribute', move(id, (b.availablePaise + 100) / 100)).catch((e) => e);
      expect(tooMuch.fieldErrors.amount).toMatch(/^Only ₹.* in Cash is free to set aside.$/);
      const over = await act(alice, 'goals.withdraw', move(id, 25001)).catch((e) => e);
      expect(over.fieldErrors.amount).toBe('Only ₹25,000 is saved in this goal.');
      expect((await act(alice, 'goals.contribute', move(id, 0)).catch((e) => e)).fieldErrors.amount).toBeDefined();
      expect((await act(alice, 'goals.contribute', move(id, 1, { date: '2026-10-11' })).catch((e) => e)).fieldErrors.date).toBe(
        'The date cannot be in the future.',
      );
      await act(alice, 'goals.withdraw', move(id, 25000)); // exactly the saved amount is fine
    });

    it('a contribution that completes the goal warns', async () => {
      await expect(act(alice, 'goals.contribute', move(id, 50000), { confirm: false })).rejects.toThrow(/needsConfirmation/);
      const key = 'complete-key-0001';
      const { dispatch } = await import('@/server/actions/dispatcher');
      const out = await dispatch(alice, 'goals.contribute', move(id, 50000), { idempotencyKey: key });
      expect(out.status === 'needsConfirmation' && out.preview.warnings).toEqual(['This completes your goal!']);
    });

    it('archived goals accept no movements; restore bumps the version', async () => {
      const g = await act(alice, 'goals.create', japan({ name: 'Archive me' }));
      const archived = await act(alice, 'goals.toggleArchive', { id: g.id });
      expect(archived.status).toBe('archived');
      expect((await act(alice, 'goals.contribute', move(g.id, 10)).catch((e) => e)).message).toBe('This goal is archived.');
      await act(alice, 'goals.create', japan({ name: 'Archive me' })); // archived name can be reused
      const restored = await act(alice, 'goals.toggleArchive', { id: g.id });
      expect(restored.status).toBe('active');
      expect(restored.version).toBe(3);
    });
  });

  it('updates details without touching the saved amount; rejects stale versions', async () => {
    const g = await act(alice, 'goals.create', japan({ name: 'Camera', initialAllocation: '10000' }));
    const updated = await act(alice, 'goals.update', { id: g.id, expectedVersion: 1, ...japan({ name: 'Camera', target: '300000', initialAllocation: '99999999' }) });
    expect(updated.targetPaise).toBe(rs(300000));
    expect(updated.version).toBe(2);
    const p = (await read(alice, (s) => loadGoalProgress(s))).find((x) => x.goal.id === g.id)!;
    expect(p.saved).toBe(rs(10000));
    await expect(act(alice, 'goals.update', { id: g.id, expectedVersion: 1, ...japan({ name: 'Camera' }) })).rejects.toMatchObject({ code: 'staleData' });
  });

  it('delete removes every movement including future-dated ones and releases the earmark', async () => {
    const g = await act(alice, 'goals.create', japan({ name: 'Doomed', initialAllocation: '10000' }));
    await withUserTx(
      alice,
      (tx) =>
        tx
          .insertInto('savings_movements')
          .values({ user_id: alice.userId, id: 'sv_future', bucket_type: 'goal', bucket_id: g.id, kind: 'contribution', amount_paise: 50000, date: '2026-11-01', note: null, created_at: new Date().toISOString() })
          .execute(),
      { write: true },
    );
    const before = await bal();
    await expect(act(alice, 'goals.delete', { id: g.id }, { confirm: false })).rejects.toThrow(/needsConfirmation/);
    await act(alice, 'goals.delete', { id: g.id });
    const mvs = await read(alice, (s) => s.movements());
    expect(mvs.some((m) => m.bucketId === g.id)).toBe(false);
    const after = await bal();
    expect(after.availablePaise).toBe(before.availablePaise + rs(10000));
    expect(after.cashPaise).toBe(before.cashPaise);
    await expect(act(alice, 'goals.delete', { id: g.id })).rejects.toMatchObject({ code: 'notFound' });
  });

  it('replays a duplicate contribution instead of recording twice', async () => {
    const g = await act(alice, 'goals.create', japan({ name: 'Replay', target: '1000' }));
    const key = 'replay-key-000001';
    await act(alice, 'goals.contribute', move(g.id, 100), { key });
    await act(alice, 'goals.contribute', move(g.id, 100), { key });
    const p = (await read(alice, (s) => loadGoalProgress(s))).find((x) => x.goal.id === g.id)!;
    expect(p.saved).toBe(rs(100));
  });

  it('isolates users', async () => {
    const g = await act(alice, 'goals.create', japan({ name: 'Private' }));
    await expect(act(bob, 'goals.contribute', move(g.id, 1))).rejects.toMatchObject({ code: 'notFound' });
    await expect(act(bob, 'goals.delete', { id: g.id })).rejects.toMatchObject({ code: 'notFound' });
    const res = await call(goalsRoute.GET, 'GET', '/api/v1/goals', { user: bob });
    expect(res.body.data.items).toEqual([]);
    expect((await goalCount()) > 0).toBe(true);
  });

  it('GET /goals and /goals/{id} return progress and history newest first', async () => {
    const g = await act(alice, 'goals.create', japan({ name: 'Route goal', target: '1000', targetDate: '2027-04-10' }));
    await act(alice, 'goals.contribute', move(g.id, 100, { date: '2026-09-01' }));
    await act(alice, 'goals.contribute', move(g.id, 200, { date: '2026-09-15' }));
    const list = await call(goalsRoute.GET, 'GET', '/api/v1/goals', { user: alice });
    const item = list.body.data.items.find((i: { goal: { id: string } }) => i.goal.id === g.id);
    expect(item).toMatchObject({ saved: rs(300), progressBps: 3000, achieved: false });
    const one = await call(goalRoute.GET, 'GET', `/api/v1/goals/${g.id}`, { user: alice, params: { id: g.id } });
    expect(one.status).toBe(200);
    expect(one.body.data.movements.map((m: { date: string }) => m.date)).toEqual(['2026-09-15', '2026-09-01']);
    // 700 remaining over exactly 6 months, rounded up to the paisa.
    expect(one.body.data.requiredPerMonth).toBe(11667);
    expect(one.body.data.averageMonthly).toBe(10000);
    const missing = await call(goalRoute.GET, 'GET', '/api/v1/goals/nope', { user: alice, params: { id: 'nope' } });
    expect(missing.status).toBe(404);
    expect((await call(goalsRoute.GET, 'GET', '/api/v1/goals', {})).status).toBe(401);
  });
});
