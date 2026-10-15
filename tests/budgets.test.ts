import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as listRoute from '@/app/api/v1/budgets/route';
import * as detailRoute from '@/app/api/v1/budgets/[id]/route';
import { createTestDb, type TestDb } from './support/db';
import { makeClient } from './support/http';
import { act, fixClock, read } from './support/actions';
import type { AuthUser } from '@/server/auth/verify';
import { withUserTx } from '@/server/db/tx';
import { DateRange, MonthKey } from '@/server/core/dates';
import type { Budget, Subscription, Transaction } from '@/server/finance/models';
import { limitFor, monthOf, monthlyPeriod, periodOf, usage } from '@/server/modules/budgets/calculator';
import { loadBudgetUsages } from '@/server/modules/budgets/service';

const TODAY = '2026-10-10';
const STAMP = '2026-01-01T00:00:00.000Z';
const range = (a: string, b: string) => new DateRange(a, b);
const M = (y: number, m: number) => new MonthKey(y, m);
const rs = (r: number) => r * 100;

let seq = 0;
const budget = (o: Partial<Budget> = {}): Budget => ({
  id: 'b1',
  categoryId: 'cat_food',
  limitPaise: rs(10000),
  previousLimits: [],
  status: 'active',
  warningThresholdBps: 8000,
  note: null,
  createdAt: STAMP,
  updatedAt: STAMP,
  version: 1,
  ...o,
});
const tx = (rupees: number, date: string, o: Partial<Transaction> = {}): Transaction => ({
  id: `tx_${seq++}`,
  type: 'expense',
  amountPaise: rs(rupees),
  categoryId: 'cat_food',
  date,
  accountId: 'acc_cash',
  channel: null,
  counterparty: null,
  note: null,
  origin: 'manual',
  originRefId: null,
  createdAt: STAMP,
  updatedAt: STAMP,
  version: 1,
  ...o,
});
const sub = (rupees: number, next: string, o: Partial<Subscription> = {}): Subscription => ({
  id: `sub_${seq++}`,
  name: 'Sub',
  amountPaise: rs(rupees),
  categoryId: 'cat_food',
  frequency: 'monthly',
  nextDueDate: next,
  startDate: null,
  status: 'active',
  autoRenews: true,
  accountId: null,
  note: null,
  createdAt: STAMP,
  updatedAt: STAMP,
  version: 1,
  ...o,
});
const use = (b: Budget, txs: Transaction[], o: { subs?: Subscription[]; startDay?: number; on?: string } = {}) =>
  usage({ budget: b, transactions: txs, subscriptions: o.subs ?? [], today: o.on ?? TODAY, monthStartDay: o.startDay ?? 1 });

describe('budget calculator', () => {
  it('monthlyPeriod honours the start day and wraps years', () => {
    expect(monthlyPeriod(TODAY, 1)).toEqual(range('2026-10-01', '2026-10-31'));
    expect(monthlyPeriod('2028-02-10', 1)).toEqual(range('2028-02-01', '2028-02-29'));
    expect(monthlyPeriod(TODAY, 25)).toEqual(range('2026-09-25', '2026-10-24'));
    expect(monthlyPeriod('2026-10-25', 25)).toEqual(range('2026-10-25', '2026-11-24'));
    expect(monthlyPeriod('2026-12-31', 25)).toEqual(range('2026-12-25', '2027-01-24'));
    expect(monthlyPeriod('2027-01-10', 25)).toEqual(range('2026-12-25', '2027-01-24'));
    expect(monthlyPeriod('2028-02-26', 25)).toEqual(range('2028-02-25', '2028-03-24'));
  });

  it('clamps start days above 28', () => {
    expect(monthlyPeriod('2026-03-01', 31)).toEqual(range('2026-02-28', '2026-03-27'));
    expect(monthlyPeriod('2026-03-28', 30)).toEqual(range('2026-03-28', '2026-04-27'));
  });

  it('consecutive periods tile without gaps or overlaps', () => {
    for (const startDay of [1, 5, 15, 25, 28]) {
      let p = monthlyPeriod('2026-01-15', startDay);
      for (let i = 0; i < 24; i++) {
        const next = monthlyPeriod(new Date(Date.parse(p.end) + 86_400_000).toISOString().slice(0, 10), startDay);
        expect(Date.parse(next.start) - Date.parse(p.end)).toBe(86_400_000);
        expect(Number(next.start.slice(8))).toBe(startDay);
        p = next;
      }
    }
  });

  it('periodOf and monthOf agree', () => {
    expect(periodOf(M(2026, 9), 25)).toEqual(range('2026-09-25', '2026-10-24'));
    expect(periodOf(M(2026, 12), 1)).toEqual(range('2026-12-01', '2026-12-31'));
    expect(monthOf(TODAY, 25).id).toBe('2026-09');
    expect(monthOf(TODAY, 1).id).toBe('2026-10');
  });

  it('each month uses the limit that applied then', () => {
    const b = budget({ previousLimits: [{ until: '2026-08', limitPaise: rs(6000) }] });
    expect(limitFor(b, M(2026, 7))).toBe(rs(6000));
    expect(limitFor(b, M(2026, 8))).toBe(rs(6000));
    expect(limitFor(b, M(2026, 9))).toBe(rs(10000));
    const u = usage({ budget: b, transactions: [], subscriptions: [], today: TODAY, monthStartDay: 1, period: periodOf(M(2026, 8), 1) });
    expect(u.limitPaise).toBe(rs(6000));
    expect(u.budget.limitPaise).toBe(rs(6000));
  });

  it('counts only expenses in the same category inside the period', () => {
    const txs = [
      tx(1000, '2026-10-01'),
      tx(2000, '2026-10-09'),
      tx(500, '2026-10-31'),
      tx(700, '2026-09-30'),
      tx(800, '2026-11-01'),
      tx(900, '2026-10-05', { categoryId: 'cat_travel' }),
      tx(5000, '2026-10-05', { type: 'income' }),
      tx(9000, '2026-10-05', { origin: 'loanDisbursement' }),
    ];
    const u = use(budget(), txs);
    expect(u.period).toEqual(range('2026-10-01', '2026-10-31'));
    expect(u.spentPaise).toBe(rs(3500));
    expect(u.transactionIds).toEqual([txs[0]!.id, txs[1]!.id, txs[2]!.id]);
    expect(u.remainingPaise).toBe(rs(6500));
    expect(u.utilizationBps).toBe(3500);
    expect(u.health).toBe('healthy');
  });

  it('linked subscription expenses still count; month start day honoured', () => {
    expect(use(budget(), [tx(1200, '2026-10-02', { origin: 'subscription' })]).spentPaise).toBe(rs(1200));
    const txs = [tx(1000, '2026-09-24'), tx(2000, '2026-09-25'), tx(3000, '2026-10-24'), tx(4000, '2026-10-25')];
    expect(use(budget(), txs, { startDay: 25 }).spentPaise).toBe(rs(5000));
    expect(use(budget(), txs, { startDay: 1 }).spentPaise).toBe(rs(7000));
  });

  it('warns exactly at the threshold and breaches only strictly over the limit', () => {
    const h = (b: Budget, paise: number) => use(b, [tx(0, '2026-10-02', { amountPaise: paise })]).health;
    const b = budget();
    expect(h(b, 799999)).toBe('healthy');
    expect(h(b, 800000)).toBe('warning');
    expect(h(b, 1000000)).toBe('warning');
    expect(h(b, 1000001)).toBe('breached');
    const b50 = budget({ warningThresholdBps: 5000 });
    expect(h(b50, 500000)).toBe('warning');
    expect(h(b50, 499999)).toBe('healthy');
  });

  it('over-limit, paused and zero-limit cases', () => {
    const over = use(budget({ limitPaise: rs(1000) }), [tx(1500, '2026-10-02')]);
    expect(over.remainingPaise).toBe(rs(-500));
    expect(over.utilizationBps).toBe(15000);
    expect(over.health).toBe('breached');
    const paused = use(budget({ status: 'paused', limitPaise: rs(100) }), [tx(1500, '2026-10-02')]);
    expect(paused.health).toBe('paused');
    expect(paused.spentPaise).toBe(rs(1500));
    const zero = use(budget({ limitPaise: 0 }), [tx(1, '2026-10-02')]);
    expect(zero.utilizationBps).toBe(0);
    expect(zero.health).toBe('breached');
  });

  it('committed = expected subscription charges from today to period end', () => {
    const subs = [
      sub(499, '2026-10-10'),
      sub(199, '2026-10-25'),
      sub(99, '2026-10-05'),
      sub(299, '2026-11-02'),
      sub(149, '2026-10-20', { categoryId: 'cat_travel' }),
      sub(999, '2026-10-20', { status: 'paused' }),
      sub(50, '2026-10-12', { frequency: 'weekly' }),
    ];
    const u = use(budget(), [tx(1000, '2026-10-02')], { subs });
    expect(u.committedPaise).toBe(rs(499 + 199 + 150));
    expect(u.spentPaise).toBe(rs(1000));
    expect(u.remainingAfterCommittedPaise).toBe(rs(10000 - 1000 - 848));
  });

  it('committed is zero for ended periods and starts at period start for future ones', () => {
    const subs = [sub(499, '2026-09-15'), sub(100, '2026-11-03')];
    const base = { budget: budget(), transactions: [], subscriptions: subs, today: TODAY, monthStartDay: 1 };
    expect(usage({ ...base, period: range('2026-09-01', '2026-09-30') }).committedPaise).toBe(0);
    expect(usage({ ...base, period: range('2026-11-01', '2026-11-30') }).committedPaise).toBe(rs(499 + 100));
  });

  it('elapsed share of the period', () => {
    expect(use(budget(), []).elapsedBps).toBe(Math.floor((10 * 10000) / 31));
    expect(use(budget(), [], { on: '2026-10-31' }).elapsedBps).toBe(10000);
    expect(use(budget(), [], { on: '2026-10-01' }).elapsedBps).toBe(Math.floor(10000 / 31));
  });

  it('recomputes from transactions (nothing stored)', () => {
    const a = tx(3000, '2026-10-02', { id: 'a' });
    const b = tx(4000, '2026-10-03', { id: 'b' });
    expect(use(budget(), [a, b]).spentPaise).toBe(rs(7000));
    expect(use(budget(), [{ ...a, amountPaise: rs(5000) }, b]).health).toBe('warning');
    expect(use(budget(), [a, { ...b, categoryId: 'cat_travel' }]).transactionIds).toEqual(['a']);
    expect(use(budget(), [{ ...a, date: '2026-09-30' }]).spentPaise).toBe(0);
    expect(use(budget({ limitPaise: rs(4000) }), [a, b]).health).toBe('breached');
  });
});

describe('budget actions and endpoints', () => {
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
  });
  afterAll(async () => t.close());

  const budgetIn = (limit: string | number, extra: Record<string, unknown> = {}) => ({ categoryId: 'cat_food', limit, ...extra });
  const spend = (amount: number, date: string, categoryId = 'cat_food') =>
    act(alice, 'transactions.create', { type: 'expense', amount, categoryId, date });

  it('creates a budget with defaults and validates with the Dart messages', async () => {
    const b = await act(alice, 'budgets.create', budgetIn(8000));
    expect(b).toMatchObject({ categoryId: 'cat_food', limitPaise: rs(8000), warningThresholdBps: 8000, status: 'active', version: 1, previousLimits: [] });
    await expect(act(alice, 'budgets.create', budgetIn(9000))).rejects.toMatchObject({
      code: 'validation',
      fieldErrors: { categoryId: 'Food & Dining already has a monthly budget. Edit that one instead.' },
    });
    const fieldOf = async (input: Record<string, unknown>): Promise<string[]> =>
      act(alice, 'budgets.create', input).then(
        () => [],
        (e) => Object.keys(e.fieldErrors),
      );
    expect(await fieldOf(budgetIn(0, { categoryId: 'cat_groceries' }))).toEqual(['limit']);
    expect(await fieldOf(budgetIn(100000001, { categoryId: 'cat_groceries' }))).toEqual(['limit']);
    expect(await fieldOf(budgetIn(100, { categoryId: 'cat_salary' }))).toEqual(['categoryId']);
    expect(await fieldOf(budgetIn(100, { categoryId: 'nope' }))).toEqual(['categoryId']);
    expect(await fieldOf(budgetIn(100, { categoryId: 'cat_groceries', warningThresholdBps: 4999 }))).toEqual(['warningThresholdBps']);
    expect(await fieldOf(budgetIn(100, { categoryId: 'cat_groceries', warningThresholdBps: 9501 }))).toEqual(['warningThresholdBps']);
    const ok = await act(alice, 'budgets.create', budgetIn(100, { categoryId: 'cat_groceries', warningThresholdBps: 9500 }));
    expect(ok.warningThresholdBps).toBe(9500);
  });

  it('spending is derived from transactions and covers the whole month', async () => {
    await spend(400, '2026-10-03', 'cat_shopping');
    const b = await act(alice, 'budgets.create', budgetIn(5000, { categoryId: 'cat_shopping' }));
    const usages = await read(alice, (s) => loadBudgetUsages(s));
    const u = usages.find((x) => x.budget.id === b.id)!;
    expect(u.period).toEqual(range('2026-10-01', '2026-10-31'));
    expect(u.spentPaise).toBe(rs(400));
    expect(u.health).toBe('healthy');
  });

  it('update bumps version, keeps own category, rejects stale versions', async () => {
    const b = await act(alice, 'budgets.create', budgetIn(1000, { categoryId: 'cat_health' }));
    const u = await act(alice, 'budgets.update', { id: b.id, expectedVersion: 1, ...budgetIn(1200, { categoryId: 'cat_health' }) });
    expect(u.version).toBe(2);
    expect(u.limitPaise).toBe(rs(1200));
    expect(u.warningThresholdBps).toBe(8000);
    expect(u.previousLimits).toEqual([]);
    await expect(act(alice, 'budgets.update', { id: b.id, expectedVersion: 1, ...budgetIn(1, { categoryId: 'cat_health' }) })).rejects.toMatchObject({
      code: 'staleData',
    });
  });

  it('a new limit applies from this month; earlier months keep theirs', async () => {
    await withUserTx(
      alice,
      (txn) =>
        txn
          .insertInto('budgets')
          .values({
            user_id: alice.userId,
            id: 'bud_old',
            category_id: 'cat_transport',
            limit_paise: rs(5000),
            status: 'active',
            warning_threshold_bps: 8000,
            note: null,
            version: 1,
            created_at: '2026-08-20T00:00:00Z',
            updated_at: '2026-08-20T00:00:00Z',
          })
          .execute(),
      { write: true },
    );
    await spend(400, '2026-09-12', 'cat_transport');
    const u1 = await act(alice, 'budgets.update', { id: 'bud_old', expectedVersion: 1, ...budgetIn(7000, { categoryId: 'cat_transport' }) });
    expect(u1.previousLimits).toEqual([{ until: '2026-09', limitPaise: rs(5000) }]);
    const u2 = await act(alice, 'budgets.update', { id: 'bud_old', expectedVersion: 2, ...budgetIn(8000, { categoryId: 'cat_transport' }) });
    expect(u2.previousLimits).toEqual(u1.previousLimits);

    const sept = (await read(alice, (s) => loadBudgetUsages(s, M(2026, 9)))).find((x) => x.budget.id === 'bud_old')!;
    expect(sept.limitPaise).toBe(rs(5000));
    expect(sept.spentPaise).toBe(rs(400));
    const now = (await read(alice, (s) => loadBudgetUsages(s))).find((x) => x.budget.id === 'bud_old')!;
    expect(now.limitPaise).toBe(rs(8000));
    expect((await read(alice, (s) => loadBudgetUsages(s, M(2026, 7)))).find((x) => x.budget.id === 'bud_old')).toBeUndefined();
  });

  it('pausing frees the category; resuming then conflicts; pausing again is a no-op', async () => {
    const food = (await read(alice, (s) => s.budgets())).find((b) => b.categoryId === 'cat_food')!;
    const paused = await act(alice, 'budgets.setPaused', { id: food.id, paused: true });
    expect(paused.status).toBe('paused');
    const again = await act(alice, 'budgets.setPaused', { id: food.id, paused: true });
    expect(again.version).toBe(paused.version);
    const dup = await act(alice, 'budgets.create', budgetIn(5000));
    await expect(act(alice, 'budgets.setPaused', { id: food.id, paused: false })).rejects.toMatchObject({ code: 'conflict' });
    await act(alice, 'budgets.delete', { id: dup.id });
  });

  it('delete needs confirmation, leaves transactions alone, then reports notFound', async () => {
    const b = await act(alice, 'budgets.create', budgetIn(900, { categoryId: 'cat_travel' }));
    await spend(100, '2026-10-03', 'cat_travel');
    await expect(act(alice, 'budgets.delete', { id: b.id }, { confirm: false })).rejects.toThrow(/needsConfirmation/);
    await act(alice, 'budgets.delete', { id: b.id });
    expect((await read(alice, (s) => s.budgets())).some((x) => x.id === b.id)).toBe(false);
    expect((await read(alice, (s) => s.transactionsIn(range('2026-10-03', '2026-10-03'), { categoryIds: ['cat_travel'] }))).length).toBe(1);
    await expect(act(alice, 'budgets.delete', { id: b.id })).rejects.toMatchObject({ code: 'notFound' });
  });

  it('isolates users', async () => {
    const mine = (await read(alice, (s) => s.budgets()))[0]!;
    await expect(act(bob, 'budgets.update', { id: mine.id, expectedVersion: mine.version, ...budgetIn(1, { categoryId: 'cat_health' }) })).rejects.toMatchObject({
      code: 'notFound',
    });
    expect((await read(bob, (s) => s.budgets())).length).toBe(0);
    const res = await call(listRoute.GET, 'GET', '/api/v1/budgets', { user: bob });
    expect(res.body.data.items).toEqual([]);
  });

  it('GET /budgets returns usages and totals; past months are history; detail has a daily series', async () => {
    await withUserTx(
      alice,
      (txn) =>
        txn
          .insertInto('subscriptions')
          .values({
            user_id: alice.userId,
            id: 'sub_t',
            name: 'Gym',
            amount_paise: rs(499),
            category_id: 'cat_shopping',
            frequency: 'monthly',
            next_due_date: '2026-10-25',
            start_date: null,
            status: 'active',
            auto_renews: true,
            payment_method: null,
            note: null,
            version: 1,
            created_at: STAMP,
            updated_at: STAMP,
          })
          .execute(),
      { write: true },
    );
    await spend(150, '2026-10-03', 'cat_shopping');
    const res = await call(listRoute.GET, 'GET', '/api/v1/budgets', { user: alice });
    expect(res.status).toBe(200);
    const d = res.body.data;
    expect(d).toMatchObject({ month: '2026-10', currentMonth: '2026-10', isPast: false, period: { start: '2026-10-01', end: '2026-10-31' } });
    const shop = d.items.find((i: any) => i.budget.categoryId === 'cat_shopping');
    expect(shop).toMatchObject({ spentPaise: rs(550), committedPaise: rs(499), limitPaise: rs(5000), health: 'healthy', remainingPaise: rs(4450) });
    expect(shop.transactionIds).toHaveLength(2);
    const active = d.items.filter((i: any) => i.budget.status === 'active');
    expect(d.totals.limitPaise).toBe(active.reduce((n: number, i: any) => n + i.limitPaise, 0));

    const past = await call(listRoute.GET, 'GET', '/api/v1/budgets', { user: alice, query: { month: '2026-09' } });
    expect(past.body.data).toMatchObject({ month: '2026-09', isPast: true, period: { start: '2026-09-01', end: '2026-09-30' } });
    const pastIds = past.body.data.items.map((i: any) => i.budget.id);
    expect(pastIds).toContain('bud_old');
    expect(pastIds).not.toContain(shop.budget.id);
    expect((await call(listRoute.GET, 'GET', '/api/v1/budgets', { user: alice, query: { month: 'garbage' } })).status).toBe(422);

    const det = await call(detailRoute.GET, 'GET', `/api/v1/budgets/${shop.budget.id}`, { user: alice, params: { id: shop.budget.id } });
    expect(det.body.data.daily).toHaveLength(31);
    expect(det.body.data.daily[2]).toEqual({ date: '2026-10-03', amountPaise: rs(550) });
    expect(det.body.data.todayIndex).toBe(9);
    expect((await call(detailRoute.GET, 'GET', '/api/v1/budgets/nope', { user: alice, params: { id: 'nope' } })).status).toBe(404);
    expect((await call(detailRoute.GET, 'GET', `/api/v1/budgets/${shop.budget.id}`, { user: bob, params: { id: shop.budget.id } })).status).toBe(404);
  });
});
