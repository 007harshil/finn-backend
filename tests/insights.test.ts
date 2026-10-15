// Insights layer: analytics (port of test/domain/analytics_test.dart cases),
// dashboard consistency with the detail endpoints, an expense flowing through
// every read model exactly once, upcoming, net worth, timeline and export.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as dashboardRoute from '@/app/api/v1/dashboard/route';
import * as analyticsRoute from '@/app/api/v1/analytics/route';
import * as upcomingRoute from '@/app/api/v1/upcoming/route';
import * as netWorthRoute from '@/app/api/v1/net-worth/route';
import * as timelineRoute from '@/app/api/v1/timeline/route';
import * as exportRoute from '@/app/api/v1/export/route';
import * as alertsRoute from '@/app/api/v1/alerts/route';
import * as budgetsRoute from '@/app/api/v1/budgets/route';
import * as pendingRoute from '@/app/api/v1/pending/route';
import { createTestDb, type TestDb } from './support/db';
import { makeClient } from './support/http';
import { act, fixClock, read } from './support/actions';
import type { AuthUser } from '@/server/auth/verify';
import { withUserTx } from '@/server/db/tx';
import { DateRange, MonthKey } from '@/server/core/dates';
import type { Transaction } from '@/server/finance/models';
import { insertTransaction } from '@/server/modules/transactions/repo';
import { categoryBreakdown, compare, dailyBurn, discretionaryShareBps, insights, monthlyNarrative } from '@/server/modules/insights/analytics';
import { monthlyFlows } from '@/server/modules/insights/queries';
import { eventsFor } from '@/server/modules/insights/timeline';

const STAMP = '2026-01-01T00:00:00.000Z';
const rs = (r: number) => r * 100;
const oct = new MonthKey(2026, 10);
const sep = new MonthKey(2026, 9);
let seq = 0;

let t: TestDb;
let call: ReturnType<typeof makeClient>;

beforeAll(async () => {
  t = await createTestDb();
  call = makeClient(t);
  fixClock();
});
afterAll(async () => t.close());

/** Seeds transactions directly (fixtures may be future-dated or system-originated, which actions refuse). */
async function seed(user: AuthUser, txs: Array<[number, string, Partial<Transaction>?]>) {
  await withUserTx(
    user,
    async (tx) => {
      for (const [rupees, date, o] of txs) {
        const n = seq++;
        await insertTransaction(tx, user.userId, {
          id: `tx_seed_${n}`,
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
          // Distinct creation instants keep "newest first" deterministic.
          createdAt: new Date(Date.parse(STAMP) + n * 1000).toISOString(),
          updatedAt: STAMP,
          version: 1,
          ...o,
        });
      }
    },
    { write: true },
  );
}
const income = (o: Partial<Transaction> = {}): Partial<Transaction> => ({ type: 'income', categoryId: 'cat_salary', ...o });

// ---------------------------------------------------------------------------
// AnalyticsService (SQL-backed)
// ---------------------------------------------------------------------------

describe('analytics service', () => {
  it('cashFlow: monthly series ending with the last month, oldest first', async () => {
    const u = await t.createUser();
    await seed(u, [
      [50000, '2026-08-01', income()],
      [60000, '2026-09-01', income()],
      [20000, '2026-09-02'],
      [70000, '2026-10-01', income()],
    ]);
    const flow = await read(u, (s) => monthlyFlows(s, new MonthKey(2026, 8), oct));
    expect(flow.map((m) => m.month)).toEqual(['2026-08', '2026-09', '2026-10']);
    expect(flow.map((m) => m.incomePaise)).toEqual([rs(50000), rs(60000), rs(70000)]);
    expect(flow[1]!.expensePaise).toBe(rs(20000));
    expect(flow[1]!.netPaise).toBe(rs(40000));
    // Same figures as the per-month ledger summary.
    const sepSummary = await read(u, (s) => s.summary(sep.range));
    expect(flow[1]!.incomePaise).toBe(sepSummary.incomePaise);
    expect(flow[1]!.savingsRateBps).toBe(sepSummary.savingsRateBps);
  });

  it('categoryBreakdown: shares and comparison with the previous period', async () => {
    const u = await t.createUser();
    await seed(u, [
      [5000, '2026-09-03'],
      [6000, '2026-10-03'],
      [3000, '2026-10-04', { categoryId: 'cat_rent' }],
      [1000, '2026-10-05', { categoryId: 'cat_shopping' }],
    ]);
    const slices = await read(u, (s) => categoryBreakdown(s, oct.range, sep.range));
    expect(slices.map((x) => x.categoryId)).toEqual(['cat_food', 'cat_rent', 'cat_shopping']);
    expect(slices.map((x) => x.shareBps)).toEqual([6000, 3000, 1000]);
    expect(slices[0]!.name).toBe('Food & Dining');
    expect(slices[0]!.previousPaise).toBe(rs(5000));
    expect(slices[0]!.changeBps).toBe(2000);
    expect(slices[1]!.previousPaise).toBe(0);
    expect(slices[1]!.changeBps).toBeNull();
    const plain = await read(u, (s) => categoryBreakdown(s, oct.range));
    expect(plain.every((x) => x.previousPaise === null && x.changeBps === null)).toBe(true);
  });

  it('compare: a calendar month vs the previous calendar month; other ranges vs the same number of days before', async () => {
    const u = await t.createUser();
    await seed(u, [
      [900, '2026-08-31'],
      [1000, '2026-09-21'],
      [400, '2026-09-30'],
      [2000, '2026-10-05'],
    ]);
    const c = await read(u, (s) => compare(s, oct.range));
    expect(c.previous.range).toEqual({ start: '2026-09-01', end: '2026-09-30' });
    expect(c.previous.expensePaise).toBe(rs(1400));
    expect(c.current.expensePaise).toBe(rs(2000));
    expect(c.expenseChangeBps).toBe(4286);
    expect(c.incomeChangeBps).toBeNull();
    const d = await read(u, (s) => compare(s, new DateRange('2026-10-01', '2026-10-10')));
    expect(d.previous.range).toEqual({ start: '2026-09-21', end: '2026-09-30' });
    expect(d.previous.expensePaise).toBe(rs(1400));
  });

  it('dailyBurn divides by elapsed days only; discretionary share excludes essential and system categories', async () => {
    const u = await t.createUser();
    await seed(u, [
      [1000, '2026-10-03'],
      [3000, '2026-09-15'],
    ]);
    expect(await read(u, (s) => dailyBurn(s, oct.range))).toBe(rs(100));
    expect(await read(u, (s) => dailyBurn(s, sep.range))).toBe(rs(100));
    expect(await read(u, (s) => dailyBurn(s, new MonthKey(2026, 11).range))).toBe(0);

    const v = await t.createUser();
    await seed(v, [
      [600, '2026-10-01'],
      [300, '2026-10-01', { categoryId: 'cat_rent' }],
      [100, '2026-10-01', { categoryId: 'cat_sys_emi', origin: 'loanRepayment', originRefId: 'loan_x' }],
    ]);
    expect(await read(v, (s) => discretionaryShareBps(s, oct.range))).toBe(6000);
    expect(await read(u, (s) => discretionaryShareBps(s, new MonthKey(2026, 7).range))).toBeNull();
  });

  it('insights and narrative: savings rate, rising and falling categories, top category, subscriptions', async () => {
    const u = await t.createUser();
    await seed(u, [
      [100000, '2026-09-01', income()],
      [5000, '2026-09-03'],
      [4000, '2026-09-04', { categoryId: 'cat_shopping' }],
      [100000, '2026-10-01', income()],
      [8000, '2026-10-03'],
      [2000, '2026-10-04', { categoryId: 'cat_shopping' }],
      [20000, '2026-10-05', { categoryId: 'cat_rent' }],
    ]);
    await act(u, 'subscriptions.create', { name: 'Netflix', amount: '649', categoryId: 'cat_subscriptions', frequency: 'monthly', nextDueDate: '2026-11-01' });
    const list = await read(u, (s) => insights(s, oct));
    expect(list.slice(0, 4).map((i) => i.title)).toEqual([
      'You kept 70% of your income',
      'Food & Dining is up 60%',
      'Shopping is down 50%',
      'Top category: Rent & Housing',
    ]);
    expect(list[list.length - 1]!.title).toBe('Subscriptions take 0.7% of income');
    expect(list.map((i) => i.tone)).toEqual(['positive', 'caution', 'positive', 'neutral', 'neutral']);

    const lines = await read(u, (s) => monthlyNarrative(s, oct));
    expect(lines[0]).toMatch(/^So far this month you have spent/);
    expect(lines[0]).toContain('more than all of last month');
    expect(lines[1]).toMatch(/^Rent & Housing was your largest spend/);
    expect(await read(u, (s) => monthlyNarrative(s, new MonthKey(2026, 7)))).toEqual(['No transactions recorded for July 2026 yet.']);
    const past = await read(u, (s) => monthlyNarrative(s, sep));
    expect(past[0]).toMatch(/^You spent/);
    expect(past[0]).toContain('and received');

    const deficit = await t.createUser();
    await seed(deficit, [
      [1000, '2026-10-01', income()],
      [1500, '2026-10-02'],
    ]);
    const first = (await read(deficit, (s) => insights(s, oct)))[0]!;
    expect(first.title).toBe('Spending exceeded income');
    expect(first.tone).toBe('caution');
    expect(await read(await t.createUser(), (s) => insights(s, oct))).toEqual([]);
  });

  it('GET /analytics returns the Insights screen datasets and validates the period', async () => {
    const u = await t.createUser();
    const sbi = await act(u, 'accounts.create', { name: 'SBI', kind: 'bank', openingBalance: 0, openingDate: '2026-01-01' });
    await seed(u, [
      [100000, '2026-09-01', income()],
      [5000, '2026-09-03'],
      [100000, '2026-10-01', income()],
      [8000, '2026-10-03', { accountId: sbi.id, channel: 'UPI' }],
      [2000, '2026-10-05'],
      [700, '2026-10-20'], // future-dated: counted in the month total, not in daily patterns
    ]);
    const r = await call(analyticsRoute.GET, 'GET', '/api/v1/analytics', { user: u, query: { period: 'month' } });
    expect(r.status).toBe(200);
    const d = r.body.data;
    expect(d.range).toEqual({ start: '2026-10-01', end: '2026-10-10' });
    expect(d.previousRange).toEqual({ start: '2026-09-01', end: '2026-09-30' });
    expect(d.isPartial).toBe(true);
    expect(d.periodLabel).toBe('this month');
    expect(d.previousLabel).toBe('all of September');
    expect(d.current.expensePaise).toBe(rs(10000));
    expect(d.comparison.expenseChangeBps).toBe(10000);
    expect(d.months.map((m: { month: string }) => m.month)).toEqual(['2026-05', '2026-06', '2026-07', '2026-08', '2026-09', '2026-10']);
    expect(d.dailySpend).toHaveLength(31);
    expect(d.dailySpend[2]).toEqual({ date: '2026-10-03', amountPaise: rs(8000), isFuture: false });
    expect(d.dailySpend[19]).toEqual({ date: '2026-10-20', amountPaise: 0, isFuture: true });
    expect(d.baselines.elapsedDays).toBe(10);
    expect(d.baselines.noSpendDays).toBe(8);
    expect(d.baselines.peakDay.date).toBe('2026-10-03');
    expect(d.dailyBurnPaise).toBe(rs(1000));
    expect(d.baselines.projectedMonthSpendPaise).toBe(rs(31000));
    expect(d.accounts.map((m: { accountId: string }) => m.accountId)).toEqual([sbi.id, 'acc_cash']);
    expect(d.channels).toEqual([{ channel: 'UPI', amountPaise: rs(8000), shareBps: 8000 }]);
    expect(d.baselines.digitalShareBps).toBe(8000);
    expect(d.weekdayAverages).toHaveLength(7);
    expect(d.topExpenses.map((x: Transaction) => x.amountPaise)).toEqual([rs(8000), rs(2000)]);
    expect(d.headlines.spending).toBe('So far you have spent 100% more than all of September');
    expect(d.headlines.method).toBe('SBI carried 80% of your spending');
    expect(d.insights[0].title).toBe('You kept 89% of your income'); // insights read the whole month, the 20 Oct expense included

    const q = await call(analyticsRoute.GET, 'GET', '/api/v1/analytics', { user: u, query: { period: 'quarter' } });
    expect(q.body.data.range).toEqual({ start: '2026-08-01', end: '2026-10-10' });
    expect(q.body.data.previousRange).toEqual({ start: '2026-05-01', end: '2026-07-31' });
    expect(q.body.data.periodLabel).toBe('Aug – Oct 2026');
    expect(q.body.data.months).toHaveLength(3);
    expect(q.body.data.dailySpend).toEqual([]);

    const past = await call(analyticsRoute.GET, 'GET', '/api/v1/analytics', { user: u, query: { period: 'month', month: '2026-09' } });
    expect(past.body.data.range).toEqual({ start: '2026-09-01', end: '2026-09-30' });
    expect(past.body.data.isPartial).toBe(false);
    expect(past.body.data.periodLabel).toBe('September 2026');
    expect(past.body.data.previousLabel).toBe('August');

    const custom = await call(analyticsRoute.GET, 'GET', '/api/v1/analytics', { user: u, query: { from: '2026-10-01', to: '2026-10-05' } });
    expect(custom.body.data.previousRange).toEqual({ start: '2026-09-26', end: '2026-09-30' });
    expect(custom.body.data.current.expensePaise).toBe(rs(10000));

    expect((await call(analyticsRoute.GET, 'GET', '/api/v1/analytics', { user: u, query: { period: 'decade' } })).status).toBe(422);
    expect((await call(analyticsRoute.GET, 'GET', '/api/v1/analytics', { user: u, query: { from: '2026-10-01' } })).status).toBe(422);
    expect((await call(analyticsRoute.GET, 'GET', '/api/v1/analytics', { user: u, query: { from: '2024-01-01', to: '2026-01-01' } })).status).toBe(422);
  });
});

// ---------------------------------------------------------------------------
// Dashboard consistency and the life of one expense
// ---------------------------------------------------------------------------

describe('dashboard', () => {
  let alice: AuthUser;

  beforeAll(async () => {
    alice = await t.createUser('dash@example.com');
    await act(alice, 'transactions.create', { type: 'income', amount: '100000', categoryId: 'cat_salary', date: '2026-10-01' });
    await act(alice, 'transactions.create', { type: 'expense', amount: '3000', categoryId: 'cat_food', date: '2026-09-05' });
    await act(alice, 'budgets.create', { categoryId: 'cat_food', limit: '10000' });
    await act(alice, 'budgets.create', { categoryId: 'cat_travel', limit: '5000' });
    await act(alice, 'pending.create', { counterparty: 'Rahul', direction: 'owedToMe', kind: 'lent', amount: '6500', purpose: 'Hotel', createdDate: '2026-08-01' });
    await act(alice, 'pending.create', { counterparty: 'Priya', direction: 'iOwe', kind: 'borrowed', amount: '1200', purpose: 'Cab', createdDate: '2026-10-02' });
    await act(alice, 'loans.create', {
      name: 'Car loan',
      counterparty: 'HDFC Bank',
      direction: 'borrowed',
      structure: 'amortizing',
      principal: 600000,
      rateBps: 950,
      startDate: '2026-09-01',
      firstDueDate: '2026-10-12',
      frequency: 'monthly',
      tenureInstallments: 60,
      maturityDate: null,
      prepaymentStrategy: 'reduceTenure',
      recordDisbursement: false,
      note: null,
    });
    await act(alice, 'subscriptions.create', { name: 'Netflix', amount: '499', categoryId: 'cat_subscriptions', frequency: 'monthly', nextDueDate: '2026-10-14' });
    const g = await act(alice, 'goals.create', { name: 'Japan trip', category: 'travel', target: '200000', colorIndex: 2 });
    await act(alice, 'goals.contribute', { goalId: g.goal?.id ?? g.id, amount: '20000', date: '2026-10-05' });
    await act(alice, 'assets.create', { name: 'Gold coins', type: 'gold', value: 80000, valuedOn: '2026-10-01' });
  });

  const get = async (handler: Parameters<typeof call>[0], path: string, query?: Record<string, string>) => {
    const r = await call(handler, 'GET', path, { user: alice, query });
    expect(r.status).toBe(200);
    return r.body.data;
  };

  it('uses the same figures as the detail endpoints', async () => {
    const dash = await get(dashboardRoute.GET, '/api/v1/dashboard');
    const budgets = await get(budgetsRoute.GET, '/api/v1/budgets');
    const pending = await get(pendingRoute.GET, '/api/v1/pending');
    const netWorth = await get(netWorthRoute.GET, '/api/v1/net-worth');
    const alerts = await get(alertsRoute.GET, '/api/v1/alerts');
    const upcoming = await get(upcomingRoute.GET, '/api/v1/upcoming');
    const balance = await read(alice, (s) => s.balance());

    expect(dash.isFreshUser).toBe(false);
    expect(dash.balance).toEqual(balance);
    expect(dash.balance.earmarkedPaise).toBe(rs(20000));
    expect(dash.budgets.limitPaise).toBe(budgets.totals.limitPaise);
    expect(dash.budgets.spentPaise).toBe(budgets.totals.spentPaise);
    expect(dash.budgets.committedPaise).toBe(budgets.totals.committedPaise);
    expect(dash.budgets.remainingPaise).toBe(budgets.totals.remainingPaise);
    expect(dash.budgets.month).toBe(budgets.month);
    expect(dash.pending.toPayPaise).toBe(pending.totals.toPayPaise);
    expect(dash.pending.toCollectPaise).toBe(pending.totals.toCollectPaise);
    expect(dash.pending.longPending.map((p: { id: string }) => p.id)).toEqual(pending.longPending);
    expect(dash.netWorth.netWorthPaise).toBe(netWorth.snapshot.netWorthPaise);
    expect(netWorth.snapshot.cashPaise).toBe(balance.cashPaise);
    expect(netWorth.snapshot.liabilitiesPaise).toBe(rs(600000) + rs(1200));
    expect(netWorth.snapshot.receivablesPaise).toBe(rs(6500));
    expect(netWorth.snapshot.assetsPaise).toBe(rs(80000));
    expect(dash.alerts.total).toBe(alerts.total);
    expect(dash.alerts.unreadCount).toBe(alerts.unreadCount);
    expect(dash.alerts.top).toEqual(alerts.items.slice(0, 6));
    expect(dash.upcoming).toEqual(upcoming);
    expect(dash.debt.totalOutstandingPaise).toBe(rs(600000));
    expect(dash.debt.nextDueDate).toBe('2026-10-12');
    expect(dash.goals.savedPaise).toBe(rs(20000));
    expect(dash.emergency.level).toBe('notConfigured');
    expect(dash.setup.steps.map((x: { id: string; done: boolean }) => [x.id, x.done])).toEqual([
      ['profile', expect.any(Boolean)],
      ['emergencyFund', false],
      ['goal', true],
      ['budget', true],
    ]);
    expect(dash.cashFlow.compareRange).toEqual({ start: '2026-09-01', end: '2026-09-10' });
    expect(dash.cashFlow.before.expensePaise).toBe(rs(3000));
    expect(dash.cashFlow.savingsHealth.level).toBe('strong');
  });

  it('upcoming: EMIs and subscriptions in the 7-day window, keep-ready total', async () => {
    const up = await get(upcomingRoute.GET, '/api/v1/upcoming', { days: '7' });
    expect(up.items.map((i: { kind: string; date: string }) => [i.kind, i.date])).toEqual([
      ['loanPayment', '2026-10-12'],
      ['subscription', '2026-10-14'],
    ]);
    expect(up.toArrangePaise).toBe(up.items[0].amountPaise + rs(499));
    expect(up.expectedInPaise).toBe(0);
    const short = await get(upcomingRoute.GET, '/api/v1/upcoming', { days: '2' });
    expect(short.items).toHaveLength(1);
    expect((await call(upcomingRoute.GET, 'GET', '/api/v1/upcoming', { user: alice, query: { days: '0' } })).status).toBe(422);
  });

  it('an expense appears exactly once in cash flow, budget spent and analytics; edits and deletes follow', async () => {
    const state = async () => {
      const dash = await get(dashboardRoute.GET, '/api/v1/dashboard');
      const budgets = await get(budgetsRoute.GET, '/api/v1/budgets');
      const an = await get(analyticsRoute.GET, '/api/v1/analytics', { period: 'month' });
      const food = budgets.items.find((b: { budget: { categoryId: string } }) => b.budget.categoryId === 'cat_food');
      const slice = an.categories.find((c: { categoryId: string }) => c.categoryId === 'cat_food');
      return {
        expense: dash.cashFlow.summary.expensePaise as number,
        count: dash.cashFlow.summary.transactionCount as number,
        budgetSpent: food.spentPaise as number,
        dashBudgetSpent: dash.budgets.spentPaise as number,
        category: (slice?.amountPaise ?? 0) as number,
        analyticsExpense: an.current.expensePaise as number,
      };
    };
    const before = await state();
    const created = await act(alice, 'transactions.create', { type: 'expense', amount: '1234.50', categoryId: 'cat_food', date: '2026-10-06' });
    const after = await state();
    expect(after.expense - before.expense).toBe(123450);
    expect(after.count - before.count).toBe(1);
    expect(after.budgetSpent - before.budgetSpent).toBe(123450);
    expect(after.dashBudgetSpent - before.dashBudgetSpent).toBe(123450);
    expect(after.category - before.category).toBe(123450);
    expect(after.analyticsExpense - before.analyticsExpense).toBe(123450);

    await act(alice, 'transactions.update', { id: created.id, expectedVersion: 1, type: 'expense', amount: '1000', categoryId: 'cat_food', date: '2026-10-06' });
    const edited = await state();
    expect(edited.expense - before.expense).toBe(100000);
    expect(edited.budgetSpent - before.budgetSpent).toBe(100000);
    expect(edited.category - before.category).toBe(100000);
    expect(edited.analyticsExpense - before.analyticsExpense).toBe(100000);

    await act(alice, 'transactions.delete', { id: created.id });
    expect(await state()).toEqual(before);
  });

  it('a fresh user gets an empty, well-formed dashboard', async () => {
    const fresh = await t.createUser();
    const r = await call(dashboardRoute.GET, 'GET', '/api/v1/dashboard', { user: fresh });
    expect(r.status).toBe(200);
    expect(r.body.data.isFreshUser).toBe(true);
    expect(r.body.data.alerts.total).toBe(0);
    expect(r.body.data.upcoming.items).toEqual([]);
    expect(r.body.data.cashFlow.savingsHealth.level).toBe('noData');
    expect((await call(dashboardRoute.GET, 'GET', '/api/v1/dashboard')).status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// Timeline and export
// ---------------------------------------------------------------------------

describe('timeline', () => {
  it('events: income stories, major expense threshold, future-dated left out', async () => {
    const u = await t.createUser();
    await seed(u, [
      [8000, '2026-07-01'],
      [12000, '2026-09-30'],
      [90000, '2026-06-30'],
      [100000, '2026-10-01', income({ id: 'sal' })],
      [5000, '2026-10-02', income({ categoryId: 'cat_freelance', id: 'fl' })],
      [13999, '2026-10-03', { categoryId: 'cat_shopping' }],
      [14000, '2026-10-04', { categoryId: 'cat_shopping', id: 'big' }],
      [100000, '2026-10-20', income()],
    ]);
    const events = await read(u, (s) => eventsFor(s, oct.range));
    expect(events.map((e) => e.id)).toEqual(['tl_big', 'tl_fl', 'tl_sal']);
    expect(events[0]!.title).toBe('Personal upgrade');
    expect(events[1]!.title).toBe('Money came in');
    expect(events[2]!.title).toBe('Hard work paid off');
    expect(events[2]!.route).toBe('/transactions/sal');
  });

  it('GET /timeline pages chapters newest first by month cursor', async () => {
    const u = await t.createUser();
    await seed(u, [
      [100000, '2026-10-01', income()],
      [100000, '2026-09-01', income()],
      [100000, '2026-07-01', income()],
    ]);
    const first = await call(timelineRoute.GET, 'GET', '/api/v1/timeline', { user: u, query: { limit: 2 } });
    expect(first.status).toBe(200);
    expect(first.body.data.months).toEqual(['2026-10', '2026-09', '2026-07']);
    expect(first.body.data.chapters.map((c: { month: string }) => c.month)).toEqual(['2026-10', '2026-09']);
    expect(first.body.data.chapters[0].name).toBe('The Wealth Spring');
    expect(first.body.data.nextCursor).toBe('2026-09');
    const second = await call(timelineRoute.GET, 'GET', '/api/v1/timeline', { user: u, query: { limit: 2, cursor: '2026-09' } });
    expect(second.body.data.chapters.map((c: { month: string }) => c.month)).toEqual(['2026-07']);
    expect(second.body.data.nextCursor).toBeNull();
    const one = await call(timelineRoute.GET, 'GET', '/api/v1/timeline', { user: u, query: { month: '2026-08' } });
    expect(one.body.data.chapters[0]).toMatchObject({ month: '2026-08', name: 'The Steady Stream', events: [] });
    expect((await call(timelineRoute.GET, 'GET', '/api/v1/timeline', { user: u, query: { limit: 50 } })).status).toBe(422);
  });
});

describe('export', () => {
  it('builds the JSON export document for the selected modules and range', async () => {
    const u = await t.createUser();
    await seed(u, [
      [100, '2026-08-31'],
      [200, '2026-09-01', { id: 'a' }],
      [300, '2026-09-30', { id: 'b', categoryId: 'cat_rent' }],
      [400, '2026-10-01'],
    ]);
    await act(u, 'assets.create', { name: 'Gold coins', type: 'gold', value: 80000, valuedOn: '2026-10-01' });
    const r = await call(exportRoute.GET, 'GET', '/api/v1/export', {
      user: u,
      query: { from: '2026-09-01', to: '2026-09-30', modules: 'transactions,assets,emergencyFund' },
    });
    expect(r.status).toBe(200);
    const { fileName, recordCount, document } = r.body.data;
    expect(fileName).toBe('finn_export_2026-09-01_to_2026-09-30.json');
    expect(recordCount).toBe(3);
    expect(document).toMatchObject({
      app: 'FiNN',
      version: 1,
      range: { start: '2026-09-01', end: '2026-09-30' },
      modules: ['transactions', 'emergencyFund', 'assets'],
      conventions: { money: 'integer paise (₹1 = 100 paise)', dates: 'yyyy-MM-dd' },
    });
    expect(document.data.transactions.map((x: Transaction) => x.id)).toEqual(['a', 'b']);
    expect(document.data.categories.map((c: { id: string }) => c.id)).toEqual(['cat_food', 'cat_rent']);
    expect(document.data.emergencyFund).toEqual({ plan: { configured: false }, movements: [] });
    expect(document.data.assets).toHaveLength(1);
    expect(document.exportedAt).toBe('2026-10-10T03:30:00.000Z');

    const filtered = await call(exportRoute.GET, 'GET', '/api/v1/export', {
      user: u,
      query: { from: '2026-09-01', to: '2026-09-30', modules: 'transactions', categoryIds: 'cat_rent' },
    });
    expect(filtered.body.data.document.categoryIds).toEqual(['cat_rent']);
    expect(filtered.body.data.document.data.transactions.map((x: Transaction) => x.id)).toEqual(['b']);
  });

  it('bounds the range and validates modules', async () => {
    const u = await t.createUser();
    const bad = async (query: Record<string, string>) => (await call(exportRoute.GET, 'GET', '/api/v1/export', { user: u, query })).body.error;
    expect((await bad({ from: '2023-01-01', to: '2026-01-01' }))?.fieldErrors?.to).toBe('Export at most 3 years at a time.');
    expect((await bad({ from: '2026-10-01', to: '2026-09-01' }))?.code).toBe('validation');
    expect((await bad({ from: '2026-09-01', to: '2026-09-30', modules: 'everything' }))?.code).toBe('validation');
    expect((await bad({ to: '2026-09-30' }))?.code).toBe('validation');
    const ok = await call(exportRoute.GET, 'GET', '/api/v1/export', { user: u, query: { from: '2023-10-11', to: '2026-10-10' } });
    expect(ok.status).toBe(200);
    expect(ok.body.data.document.modules).toHaveLength(8);
  });
});
