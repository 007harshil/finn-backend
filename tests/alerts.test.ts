// Alert engine (port of test/domain/alert_engine_test.dart, same keys,
// severities and copy) plus GET /api/v1/alerts merged with the inbox.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as alertsRoute from '@/app/api/v1/alerts/route';
import * as inboxRoute from '@/app/api/v1/alerts/inbox/route';
import { createTestDb, type TestDb } from './support/db';
import { makeClient } from './support/http';
import { act, fixClock } from './support/actions';
import type { AuthUser } from '@/server/auth/verify';
import { withUserTx } from '@/server/db/tx';
import { addDays, MonthKey } from '@/server/core/dates';
import type {
  Budget,
  EmergencyPlan,
  Goal,
  Loan,
  LoanPayment,
  PendingPayment,
  PendingSettlement,
  SavingsMovement,
  Subscription,
  Transaction,
} from '@/server/finance/models';
import { STANDARD_CATEGORIES } from '@/server/modules/account/standard-categories';
import { usage } from '@/server/modules/budgets/calculator';
import { emergencyStatus } from '@/server/modules/emergency-fund/calculator';
import { goalProgress } from '@/server/modules/goals/calculator';
import { loanState } from '@/server/modules/loans/calculator';
import { pendingViews } from '@/server/modules/pending/calculator';
import {
  ALERT_SEVERITIES,
  generateAlerts,
  type AlertEngineInput,
  type AlertSettings,
  type FinancialAlert,
} from '@/server/modules/alerts/engine';
import { dueIn, fmtWhole, formatBps } from '@/server/modules/alerts/format';

// ---------------------------------------------------------------------------
// Fixtures (test/domain/fixtures.dart)
// ---------------------------------------------------------------------------

const TODAY = '2026-10-10';
const STAMP = '2026-01-01T00:00:00.000Z';
const rs = (r: number) => r * 100;
let seq = 0;
const id = (p: string) => `${p}_${seq++}`;

const tx = (rupees: number, date: string, o: { income?: boolean; category?: string; id?: string } = {}): Transaction => ({
  id: o.id ?? id('tx'),
  type: o.income ? 'income' : 'expense',
  amountPaise: rs(rupees),
  categoryId: o.category ?? (o.income ? 'cat_salary' : 'cat_food'),
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
});

const emiLoan = (o: Partial<Loan> & { start?: string; firstDue?: string } = {}): Loan => {
  const direction = o.direction ?? 'borrowed';
  return {
    id: o.id ?? 'loan1',
    name: o.name ?? 'Car loan',
    counterparty: direction === 'borrowed' ? 'HDFC Bank' : 'Ravi',
    direction,
    structure: 'amortizing',
    principalPaise: o.principalPaise ?? rs(600000),
    rateBps: 950,
    startDate: o.start ?? '2026-01-01',
    firstDueDate: o.firstDue ?? '2026-02-05',
    frequency: 'monthly',
    tenureInstallments: 60,
    maturityDate: null,
    prepaymentStrategy: 'reduceTenure',
    status: o.status ?? 'active',
    disbursementTransactionId: null,
    note: null,
    createdAt: STAMP,
    updatedAt: STAMP,
    version: 1,
  };
};

const loanPayment = (loanId: string, date: string, interestPaise: number, principalPaise: number, period: number | null = null): LoanPayment => ({
  id: id('lp'),
  loanId,
  kind: period === null ? 'principal' : 'installment',
  date,
  interestPaise,
  principalPaise,
  periodNumber: period,
  transactionId: null,
  note: null,
  createdAt: STAMP,
});

const pendingPayment = (o: { id?: string; direction?: 'iOwe' | 'owedToMe'; amount?: number; created?: string; cancelled?: boolean; counterparty?: string } = {}): PendingPayment => ({
  id: o.id ?? id('pend'),
  counterparty: o.counterparty ?? 'Priya',
  direction: o.direction ?? 'iOwe',
  kind: 'other',
  originalPaise: rs(o.amount ?? 5000),
  purpose: 'Goa trip share',
  createdDate: o.created ?? '2026-09-01',
  notes: null,
  isCancelled: o.cancelled ?? false,
  createdAt: STAMP,
  updatedAt: STAMP,
  version: 1,
  link: null,
  split: null,
});

const settlement = (pendingId: string, rupees: number, date: string): PendingSettlement => ({
  id: id('st'),
  pendingId,
  amountPaise: rs(rupees),
  date,
  accountId: null,
  channel: null,
  transactionId: null,
  note: null,
  createdAt: STAMP,
});

const subscription = (o: { id?: string; name?: string; amount?: number; nextDue?: string; status?: Subscription['status'] } = {}): Subscription => ({
  id: o.id ?? id('sub'),
  name: o.name ?? 'Netflix',
  amountPaise: rs(o.amount ?? 649),
  categoryId: 'cat_subscriptions',
  frequency: 'monthly',
  nextDueDate: o.nextDue ?? '2026-11-01',
  startDate: null,
  status: o.status ?? 'active',
  autoRenews: true,
  accountId: null,
  note: null,
  createdAt: STAMP,
  updatedAt: STAMP,
  version: 1,
});

const budget = (o: { id?: string; category?: string; limit?: number; status?: Budget['status'] } = {}): Budget => ({
  id: o.id ?? id('bud'),
  categoryId: o.category ?? 'cat_food',
  limitPaise: rs(o.limit ?? 10000),
  previousLimits: [],
  status: o.status ?? 'active',
  warningThresholdBps: 8000,
  note: null,
  createdAt: STAMP,
  updatedAt: STAMP,
  version: 1,
});

const movement = (bucketType: 'goal' | 'emergencyFund', rupees: number, date: string, bucketId: string): SavingsMovement => ({
  id: id('sv'),
  bucketType,
  bucketId,
  kind: 'contribution',
  amountPaise: rs(rupees),
  date,
  note: null,
  createdAt: STAMP,
});
const goalMove = (rupees: number, date: string, goalId = 'g1') => movement('goal', rupees, date, goalId);
const efMove = (rupees: number, date: string) => movement('emergencyFund', rupees, date, 'emergency_fund');

const savingsGoal = (o: { targetDate?: string; planned?: number; status?: Goal['status'] } = {}): Goal => ({
  id: 'g1',
  name: 'Japan trip',
  category: 'travel',
  targetPaise: rs(100000),
  targetDate: o.targetDate ?? null,
  plannedMonthlyPaise: o.planned === undefined ? null : rs(o.planned),
  colorIndex: 1,
  status: o.status ?? 'active',
  note: null,
  createdAt: STAMP,
  updatedAt: STAMP,
  version: 1,
});

const efPlan = (essentials = 40000, months = 6): EmergencyPlan => ({
  essentialMonthlyPaise: rs(essentials),
  targetMonths: months,
  targetOverridePaise: null,
  updatedAt: STAMP,
});

const categories = new Map(STANDARD_CATEGORIES.map((c) => [c.id, c]));

/** Engine input built with the real module calculators (FinanceSnapshot of the Dart fixtures). */
function snapshotOf(o: {
  transactions?: Transaction[];
  budgets?: Budget[];
  goals?: Goal[];
  movements?: SavingsMovement[];
  emergencyPlan?: EmergencyPlan;
  loans?: Loan[];
  loanPayments?: LoanPayment[];
  subscriptions?: Subscription[];
  pending?: PendingPayment[];
  settlements?: PendingSettlement[];
}): AlertEngineInput {
  const txs = o.transactions ?? [];
  const movements = o.movements ?? [];
  const oct = MonthKey.of(TODAY).range;
  const inMonth = txs.filter((t) => oct.contains(t.date));
  return {
    today: TODAY,
    isFreshUser: txs.length === 0 && (o.pending ?? []).length === 0 && (o.loans ?? []).length === 0 && (o.goals ?? []).length === 0,
    loans: (o.loans ?? []).map((l) => loanState(l, o.loanPayments ?? [], TODAY)),
    pending: pendingViews(o.pending ?? [], o.settlements ?? [], TODAY),
    subscriptions: o.subscriptions ?? [],
    budgets: (o.budgets ?? []).map((b) => usage({ budget: b, transactions: txs, subscriptions: o.subscriptions ?? [], today: TODAY, monthStartDay: 1 })),
    categories,
    emergency: emergencyStatus({ plan: o.emergencyPlan ?? null, movements, suggestion: null, today: TODAY }),
    goals: (o.goals ?? []).map((g) => goalProgress(g, movements, TODAY)),
    month: {
      id: '2026-10',
      incomePaise: inMonth.filter((t) => t.type === 'income').reduce((n, t) => n + t.amountPaise, 0),
      expensePaise: inMonth.filter((t) => t.type === 'expense').reduce((n, t) => n + t.amountPaise, 0),
    },
  };
}

const settings: AlertSettings = { emiReminderDays: 5, subscriptionReminderDays: 3, lowEmergencyCoverageMonths: 3, disabledAlertTypes: [] };
/** The "set up your emergency fund" nudge fires for any non-fresh user, so it is silenced unless a test is about it. */
const quiet: AlertSettings = { ...settings, disabledAlertTypes: ['emergencyFundNotSet'] };
const alertsFor = (s: AlertEngineInput, config: AlertSettings = quiet) => generateAlerts(s, config);
const single = (list: FinancialAlert[]) => {
  expect(list).toHaveLength(1);
  return list[0]!;
};
const activity = () => [tx(100, '2026-09-01')];

// ---------------------------------------------------------------------------

describe('format helpers', () => {
  it('match MoneyFormatter (decimals none), formatBps and DateFormats.dueIn', () => {
    expect(fmtWhole(500000)).toBe('₹5,000');
    expect(fmtWhole(1260250)).toBe('₹12,603');
    expect(fmtWhole(-12345678)).toBe('−₹1,23,457');
    expect(formatBps(8000, 0)).toBe('80%');
    expect(formatBps(1850)).toBe('18.5%');
    expect(formatBps(1800)).toBe('18%');
    expect(dueIn('2026-10-10', TODAY)).toBe('due today');
    expect(dueIn('2026-10-11', TODAY)).toBe('due tomorrow');
    expect(dueIn('2026-10-15', TODAY)).toBe('due in 5 days');
    expect(dueIn('2026-10-09', TODAY)).toBe('overdue by 1 day');
    expect(dueIn('2026-10-05', TODAY)).toBe('overdue by 5 days');
  });
});

describe('alert engine: loans', () => {
  it('an overdue borrowed EMI is critical and cannot be dismissed', () => {
    const a = single(alertsFor(snapshotOf({ loans: [emiLoan({ start: '2026-09-01', firstDue: '2026-10-05' })] })));
    expect(a.type).toBe('emiOverdue');
    expect(a.severity).toBe('critical');
    expect(a.key).toBe('loan_overdue:loan1:1');
    expect(a.dismissible).toBe(false);
    expect(a.target).toBe('loan');
    expect(a.recordId).toBe('loan1');
    expect(a.dueDate).toBe('2026-10-05');
    expect(a.amountPaise).toBe(rs(12602));
    expect(a.actionLabel).toBe('Record payment');
    expect(a.title).toBe('EMI of ₹12,602 is overdue');
    expect(a.message).toBe('Car loan · HDFC Bank — overdue by 5 days.');
    expect(a.visual).toEqual({ kind: 'due', outgoing: true, party: 'bank', counterparty: 'HDFC Bank', daysUntil: -5, recurring: false });
  });

  it('an overdue repayment on a lent loan is a warning', () => {
    const a = single(alertsFor(snapshotOf({ loans: [emiLoan({ start: '2026-09-01', firstDue: '2026-10-05', direction: 'lent' })] })));
    expect(a.type).toBe('emiOverdue');
    expect(a.severity).toBe('warning');
    expect(a.actionLabel).toBe('Record receipt');
    expect(a.title).toBe('Ravi has not paid ₹12,602');
  });

  it('upcoming EMI within the reminder window (inclusive)', () => {
    const due = (first: string, config = quiet) => alertsFor(snapshotOf({ loans: [emiLoan({ start: '2026-09-01', firstDue: first })] }), config);
    expect(single(due('2026-10-14')).type).toBe('emiDue');
    expect(single(due('2026-10-15')).key).toBe('loan_due:loan1:1');
    expect(single(due('2026-10-10')).severity).toBe('warning');
    expect(single(due('2026-10-10')).title).toBe('EMI of ₹12,602 due today');
    expect(due('2026-10-16')).toEqual([]);
    expect(single(due('2026-10-16', { ...quiet, emiReminderDays: 6 })).type).toBe('emiDue');
  });

  it('fully repaid loans raise nothing', () => {
    const s = snapshotOf({
      loans: [emiLoan({ principalPaise: rs(10000), start: '2026-09-01', firstDue: '2026-10-05' })],
      loanPayments: [loanPayment('loan1', '2026-09-20', 0, 1000000)],
    });
    expect(alertsFor(s)).toEqual([]);
  });
});

describe('alert engine: pending', () => {
  it('items open over 21 days are informative, never late, and show the days passed', () => {
    const s = snapshotOf({
      pending: [
        pendingPayment({ id: 'owe', counterparty: 'Ramesh', created: '2026-08-31' }),
        pendingPayment({ id: 'collect', direction: 'owedToMe', created: '2026-09-01' }),
      ],
    });
    const byKey = new Map(alertsFor(s).map((a) => [a.key, a]));
    const owe = byKey.get('pending_aged:owe')!;
    expect(owe.type).toBe('pendingOwed');
    expect(owe.severity).toBe('info');
    expect(owe.title).toBe('You owe Ramesh ₹5,000');
    expect(owe.message).toContain('40 days have passed');
    expect(owe.dueDate).toBeNull();
    expect(owe.visual).toEqual({ kind: 'aged', counterparty: 'Ramesh', daysOpen: 40, outgoing: true });
    expect(byKey.get('pending_aged:collect')!.type).toBe('collectOwed');
    expect(byKey.get('pending_aged:collect')!.severity).toBe('info');
  });

  it('nothing shows until more than 21 days have passed', () => {
    const openFor = (days: number) => alertsFor(snapshotOf({ pending: [pendingPayment({ id: 'p', created: addDays(TODAY, -days) })] }));
    expect(openFor(21)).toEqual([]);
    expect(single(openFor(22)).key).toBe('pending_aged:p');
  });

  it('the alert amount is the outstanding balance after partial settlements', () => {
    const s = snapshotOf({ pending: [pendingPayment({ id: 'p', amount: 5000 })], settlements: [settlement('p', 2000, '2026-09-15')] });
    expect(single(alertsFor(s)).amountPaise).toBe(rs(3000));
  });

  it('recent, settled and cancelled obligations raise nothing, however old they are', () => {
    const s = snapshotOf({
      pending: [pendingPayment({ id: 'recent', created: '2026-09-25' }), pendingPayment({ id: 'done' }), pendingPayment({ id: 'x', cancelled: true })],
      settlements: [settlement('done', 5000, '2026-09-30')],
    });
    expect(alertsFor(s)).toEqual([]);
  });
});

describe('alert engine: subscriptions', () => {
  it('unpaid past cycle -> warning; renewal within the window -> info', () => {
    const s = snapshotOf({
      subscriptions: [
        subscription({ id: 'late', nextDue: '2026-10-08' }),
        subscription({ id: 'soon', name: 'Spotify', nextDue: '2026-10-12' }),
        subscription({ id: 'today', name: 'iCloud', nextDue: '2026-10-10' }),
        subscription({ id: 'later', nextDue: '2026-10-20' }),
        subscription({ id: 'paused', nextDue: '2026-10-01', status: 'paused' }),
      ],
    });
    const byKey = new Map(alertsFor(s).map((a) => [a.key, a]));
    expect(new Set(byKey.keys())).toEqual(new Set(['sub_overdue:late:2026-10-08', 'sub_due:soon:2026-10-12', 'sub_due:today:2026-10-10']));
    expect(byKey.get('sub_overdue:late:2026-10-08')!.severity).toBe('warning');
    expect(byKey.get('sub_overdue:late:2026-10-08')!.message).toBe('₹649 was overdue by 2 days.');
    expect(byKey.get('sub_due:soon:2026-10-12')!.title).toBe('Spotify renews in 2 days');
    expect(byKey.get('sub_due:soon:2026-10-12')!.message).toBe('₹649 · Monthly.');
    expect(byKey.get('sub_due:today:2026-10-10')!.title).toBe('iCloud renews today');
    expect(byKey.get('sub_due:soon:2026-10-12')!.severity).toBe('info');
  });
});

describe('alert engine: budgets', () => {
  const food = (status: Budget['status'] = 'active') => budget({ id: 'food', limit: 10000, status });

  it('reaching the warning threshold exactly is a warning', () => {
    const a = single(alertsFor(snapshotOf({ budgets: [food()], transactions: [tx(8000, '2026-10-02')] })));
    expect(a.type).toBe('budgetNearLimit');
    expect(a.severity).toBe('warning');
    expect(a.key).toBe('budget:food:2026-10-01:w');
    expect(a.dueDate).toBe('2026-10-31');
    expect(a.title).toBe('Food & Dining has used 80% of its budget');
    expect(a.message).toBe('₹8,000 of ₹10,000 spent · 22 days left in the period.');
  });

  it('just below the threshold is quiet; over the limit is critical', () => {
    expect(alertsFor(snapshotOf({ budgets: [food()], transactions: [tx(7999, '2026-10-02')] }))).toEqual([]);
    const a = single(alertsFor(snapshotOf({ budgets: [food()], transactions: [tx(12000, '2026-10-02')] })));
    expect(a.type).toBe('budgetBreached');
    expect(a.severity).toBe('critical');
    expect(a.title).toContain('Food & Dining is over budget');
    expect(a.title).toBe('Food & Dining is over budget by ₹2,000');
    expect(a.amountPaise).toBe(rs(12000));
  });

  it("paused budgets and last month's spending raise nothing", () => {
    expect(alertsFor(snapshotOf({ budgets: [food('paused')], transactions: [tx(12000, '2026-10-02')] }))).toEqual([]);
    expect(alertsFor(snapshotOf({ budgets: [food()], transactions: [tx(12000, '2026-09-30')] }))).toEqual([]);
  });
});

describe('alert engine: emergency fund', () => {
  it('not set up: a nudge, but only once the user has activity', () => {
    expect(alertsFor(snapshotOf({}), settings)).toEqual([]);
    const a = single(alertsFor(snapshotOf({ transactions: activity() }), settings));
    expect(a.key).toBe('ef_not_set');
    expect(a.type).toBe('emergencyFundNotSet');
  });

  it('coverage below the setting: info while building, warning when critical', () => {
    const building = single(alertsFor(snapshotOf({ transactions: activity(), emergencyPlan: efPlan(), movements: [efMove(100000, '2026-07-01')] }), settings));
    expect(building.key).toBe('ef_low:2026-10');
    expect(building.severity).toBe('info');
    expect(building.title).toBe('Emergency fund covers 2.5 months');
    expect(building.message).toBe('₹1,00,000 saved of ₹2,40,000 target · ₹1,40,000 to go.');
    expect(building.reason).toBe('Your target is 6 months of essentials. Small regular top-ups get you there.');

    const critical = single(alertsFor(snapshotOf({ transactions: activity(), emergencyPlan: efPlan() }), settings));
    expect(critical.severity).toBe('warning');

    const enough = alertsFor(snapshotOf({ transactions: activity(), emergencyPlan: efPlan(), movements: [efMove(120000, '2026-07-01')] }), settings);
    expect(enough).toEqual([]);
  });
});

describe('alert engine: goals', () => {
  it('fully funded -> positive milestone', () => {
    const a = single(alertsFor(snapshotOf({ goals: [savingsGoal()], movements: [goalMove(100000, '2026-08-01')] })));
    expect(a.key).toBe('goal_done:g1');
    expect(a.severity).toBe('positive');
  });

  it('75% funded -> milestone', () => {
    const list = alertsFor(snapshotOf({ goals: [savingsGoal()], movements: [goalMove(75000, '2026-08-01')] }));
    const a = single(list.filter((x) => x.type === 'goalMilestone'));
    expect(a.key).toBe('goal_75:g1');
    expect(a.title).toBe('Japan trip is 75% funded');
  });

  it('behind schedule within a year -> at risk; further out stays quiet', () => {
    const risk = single(alertsFor(snapshotOf({ goals: [savingsGoal({ targetDate: '2027-03-10', planned: 5000 })] })));
    expect(risk.type).toBe('goalAtRisk');
    expect(risk.key).toBe('goal_risk:g1:2026-10');
    expect(risk.dueDate).toBe('2027-03-10');
    expect(risk.message).toBe('About ₹20,000 a month is needed to finish by March 2027.');
    expect(alertsFor(snapshotOf({ goals: [savingsGoal({ targetDate: '2028-01-01', planned: 1000 })] }))).toEqual([]);
  });

  it('archived goals raise nothing', () => {
    expect(alertsFor(snapshotOf({ goals: [savingsGoal({ status: 'archived' })], movements: [goalMove(100000, '2026-08-01')] }))).toEqual([]);
  });
});

describe('alert engine: monthly deficit', () => {
  it('spending above income this month', () => {
    const a = single(
      alertsFor(
        snapshotOf({
          emergencyPlan: efPlan(1),
          movements: [efMove(100, '2026-01-01')],
          transactions: [tx(1000, '2026-10-01', { income: true }), tx(2000, '2026-10-02')],
        }),
      ),
    );
    expect(a.type).toBe('monthlyDeficit');
    expect(a.key).toBe('deficit:2026-10');
    expect(a.title).toBe('Spending is ₹1,000 above income this month');
  });

  it('no income this month -> no deficit alert', () => {
    const s = snapshotOf({ emergencyPlan: efPlan(1), movements: [efMove(100, '2026-01-01')], transactions: [tx(2000, '2026-10-02')] });
    expect(alertsFor(s).filter((a) => a.type === 'monthlyDeficit')).toEqual([]);
  });
});

describe('alert engine: settings and ordering', () => {
  it('disabled alert types are filtered out', () => {
    const s = snapshotOf({ budgets: [budget({ id: 'food' })], transactions: [tx(12000, '2026-10-02')] });
    expect(alertsFor(s, settings)).toHaveLength(2);
    expect(alertsFor(s, { ...settings, disabledAlertTypes: ['budgetBreached', 'emergencyFundNotSet'] })).toEqual([]);
  });

  const busy = (reversed = false) => {
    const o = <T>(l: T[]) => (reversed ? [...l].reverse() : l);
    return snapshotOf({
      transactions: o([tx(12000, '2026-10-02'), tx(1000, '2026-10-01', { income: true })]),
      budgets: o([budget({ id: 'food' }), budget({ id: 'travel', category: 'cat_travel' })]),
      loans: o([
        emiLoan({ id: 'a', start: '2026-09-01', firstDue: '2026-10-05' }),
        emiLoan({ id: 'b', start: '2026-09-01', firstDue: '2026-10-12' }),
        emiLoan({ id: 'c', start: '2026-09-01', firstDue: '2026-10-12' }),
      ]),
      pending: o([pendingPayment({ id: 'p1' }), pendingPayment({ id: 'p2', direction: 'owedToMe', created: '2026-07-01' })]),
      subscriptions: o([subscription({ id: 's1', nextDue: '2026-10-11' })]),
      goals: o([savingsGoal()]),
      movements: o([goalMove(100000, '2026-08-01')]),
    });
  };

  it('sorted by severity, then due date (dated first), then key', () => {
    const list = alertsFor(busy());
    expect(list.length).toBeGreaterThan(6);
    for (let i = 1; i < list.length; i++) {
      const a = list[i - 1]!;
      const b = list[i]!;
      expect(ALERT_SEVERITIES[a.severity].rank <= ALERT_SEVERITIES[b.severity].rank).toBe(true);
      if (a.severity === b.severity) {
        if (a.dueDate === null) expect(b.dueDate).toBeNull();
        if (a.dueDate !== null && b.dueDate !== null) {
          expect(a.dueDate <= b.dueDate).toBe(true);
          if (a.dueDate === b.dueDate) expect(a.key < b.key).toBe(true);
        }
      }
    }
    expect(list[0]!.severity).toBe('critical');
    expect(list[list.length - 1]!.severity).toBe('positive');
  });

  it('deterministic regardless of record order; keys are unique', () => {
    const keys = alertsFor(busy()).map((a) => a.key);
    expect(alertsFor(busy(true)).map((a) => a.key)).toEqual(keys);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

// ---------------------------------------------------------------------------
// GET /api/v1/alerts
// ---------------------------------------------------------------------------

describe('GET /api/v1/alerts', () => {
  let t: TestDb;
  let call: ReturnType<typeof makeClient>;
  let alice: AuthUser;
  let bob: AuthUser;
  let overspendId = '';

  beforeAll(async () => {
    t = await createTestDb();
    call = makeClient(t);
    fixClock();
    alice = await t.createUser('alice@example.com');
    bob = await t.createUser('bob@example.com');
  });
  afterAll(async () => t.close());

  it('a fresh user has no alerts; auth is required', async () => {
    const r = await call(alertsRoute.GET, 'GET', '/api/v1/alerts', { user: bob });
    expect(r.status).toBe(200);
    expect(r.body.data).toEqual({ items: [], unreadCount: 0, total: 0, counts: { critical: 0, warning: 0, info: 0, positive: 0 }, breakdown: '' });
    expect((await call(alertsRoute.GET, 'GET', '/api/v1/alerts')).status).toBe(401);
  });

  it('derives alerts from current data, merges read/dismissed state and honours disabled types', async () => {
    await act(alice, 'transactions.create', { type: 'income', amount: '1000', categoryId: 'cat_salary', date: '2026-10-01' });
    await act(alice, 'budgets.create', { categoryId: 'cat_food', limit: '1000' });
    overspendId = (await act(alice, 'transactions.create', { type: 'expense', amount: '1500', categoryId: 'cat_food', date: '2026-10-02' })).id;

    const r = await call(alertsRoute.GET, 'GET', '/api/v1/alerts', { user: alice });
    const keys = r.body.data.items.map((a: FinancialAlert) => a.key);
    const budgetKey = keys.find((k: string) => k.startsWith('budget:'))!;
    expect(budgetKey).toMatch(/^budget:.+:2026-10-01:b$/);
    expect(keys).toContain('deficit:2026-10');
    expect(keys).toContain('ef_not_set');
    expect(r.body.data.items[0].severity).toBe('critical');
    expect(r.body.data.items.every((a: { read: boolean }) => a.read === false)).toBe(true);
    expect(r.body.data.unreadCount).toBe(3);
    expect(r.body.data.counts).toEqual({ critical: 1, warning: 1, info: 1, positive: 0 });
    expect(r.body.data.breakdown).toBe('1 urgent · 1 soon · 1 fyi');

    await call(inboxRoute.PUT, 'PUT', '/api/v1/alerts/inbox', { user: alice, body: { read: [budgetKey], dismissed: ['ef_not_set'] } });
    const after = (await call(alertsRoute.GET, 'GET', '/api/v1/alerts', { user: alice })).body.data;
    expect(after.items.map((a: FinancialAlert) => a.key)).not.toContain('ef_not_set');
    expect(after.items.find((a: { key: string }) => a.key === budgetKey).read).toBe(true);
    expect(after.unreadCount).toBe(1);
    expect(after.total).toBe(2);

    await withUserTx(alice, (tx) =>
      tx.updateTable('user_preferences').set({ disabled_alert_types: ['monthlyDeficit'] }).where('user_id', '=', alice.userId).execute(),
    );
    const filtered = (await call(alertsRoute.GET, 'GET', '/api/v1/alerts', { user: alice })).body.data;
    expect(filtered.items.map((a: FinancialAlert) => a.key)).toEqual([budgetKey]);

    // Other users never see these alerts.
    expect((await call(alertsRoute.GET, 'GET', '/api/v1/alerts', { user: bob })).body.data.total).toBe(0);
  });

  it('alerts follow the data: deleting the overspend clears the budget alert', async () => {
    await act(alice, 'transactions.delete', { id: overspendId });
    const r = (await call(alertsRoute.GET, 'GET', '/api/v1/alerts', { user: alice })).body.data;
    expect(r.items.some((a: FinancialAlert) => a.key.startsWith('budget:'))).toBe(false);
    expect(r.total).toBe(0);
  });
});
