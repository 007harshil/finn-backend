// Budget read side: usages per budget month and the single-budget detail
// (FinanceSnapshot.budgetUsages/budgetUsagesFor, buildBudgetsPulse and
// buildBudgetBurn in the Flutter app). Only the period's expense transactions
// for budgeted categories are loaded, never the whole history.

import { z } from 'zod';
import { DateRange, MonthKey, addDays, daysBetween, type IsoDate } from '../../core/dates';
import { AppFailure } from '../../core/failure';
import type { Budget, Transaction } from '../../finance/models';
import type { FinanceSnapshot } from '../../finance/snapshot';
import { budgetStartMonth, monthlyPeriod, periodOf, usage, type BudgetUsage } from './calculator';

export const monthQuerySchema = z.object({
  month: z
    .string()
    .regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'Expected a month formatted yyyy-MM')
    .optional(),
});

export function currentBudgetPeriod(s: FinanceSnapshot): DateRange {
  return monthlyPeriod(s.today, s.monthStartDay);
}

export function currentBudgetMonth(s: FinanceSnapshot): MonthKey {
  return MonthKey.of(currentBudgetPeriod(s).start);
}

/** Month shown for a requested month: never later than the current budget month. */
export function resolveMonth(s: FinanceSnapshot, month?: MonthKey | null): MonthKey {
  const current = currentBudgetMonth(s);
  return !month || month.compareTo(current) > 0 ? current : month;
}

interface Loaded {
  month: MonthKey;
  period: DateRange;
  usages: BudgetUsage[];
  transactions: Transaction[];
}

async function load(s: FinanceSnapshot, requested?: MonthKey | null, only?: (b: Budget) => boolean): Promise<Loaded> {
  const current = currentBudgetMonth(s);
  const month = resolveMonth(s, requested);
  const isCurrent = month.compareTo(current) === 0;
  const period = isCurrent ? currentBudgetPeriod(s) : periodOf(month, s.monthStartDay);
  let budgets = await s.budgets();
  if (!isCurrent) {
    // Past month: read-only history of every budget that existed then (pausing only affects the current month).
    budgets = budgets
      .filter((b) => budgetStartMonth(b, s.monthStartDay, s.prefs.timeZone).compareTo(month) <= 0)
      .map((b) => (b.status === 'paused' ? { ...b, status: 'active' as const } : b));
  }
  if (only) budgets = budgets.filter(only);
  if (budgets.length === 0) return { month, period, usages: [], transactions: [] };
  const [transactions, subscriptions] = await Promise.all([
    s.transactionsIn(period, {
      type: 'expense',
      categoryIds: [...new Set(budgets.map((b) => b.categoryId))],
      excludeOrigins: ['loanDisbursement'],
    }),
    s.subscriptions(),
  ]);
  const usages = budgets.map((budget) =>
    usage({ budget, transactions, subscriptions, today: s.today, monthStartDay: s.monthStartDay, period }),
  );
  return { month, period, usages, transactions };
}

/** Usages of every budget in budget [month] (default: the current month). Reusable by dashboard/alerts. */
export async function loadBudgetUsages(s: FinanceSnapshot, month?: MonthKey | null): Promise<BudgetUsage[]> {
  return (await load(s, month)).usages;
}

export function usageDto(u: BudgetUsage) {
  return {
    budget: u.budget,
    period: { start: u.period.start, end: u.period.end },
    spentPaise: u.spentPaise,
    committedPaise: u.committedPaise,
    limitPaise: u.limitPaise,
    health: u.health,
    elapsedBps: u.elapsedBps,
    utilizationBps: u.utilizationBps,
    remainingPaise: u.remainingPaise,
    remainingAfterCommittedPaise: u.remainingAfterCommittedPaise,
    transactionIds: u.transactionIds,
  };
}

async function firstBudgetMonth(s: FinanceSnapshot, current: MonthKey): Promise<MonthKey> {
  const budgets = await s.budgets();
  let first: MonthKey | null = null;
  for (const b of budgets) {
    const m = budgetStartMonth(b, s.monthStartDay, s.prefs.timeZone);
    if (!first || m.compareTo(first) < 0) first = m;
  }
  return !first || first.compareTo(current) > 0 ? current : first;
}

/** GET /budgets: usages for a budget month plus totals of the active budgets. */
export async function budgetsOverview(s: FinanceSnapshot, requested?: MonthKey | null) {
  const { month, period, usages } = await load(s, requested);
  const current = currentBudgetMonth(s);
  let limit = 0;
  let spent = 0;
  let committed = 0;
  for (const u of usages) {
    if (u.budget.status === 'paused') continue;
    limit += u.limitPaise;
    spent += u.spentPaise;
    committed += u.committedPaise;
  }
  return {
    month: month.id,
    currentMonth: current.id,
    firstMonth: (await firstBudgetMonth(s, current)).id,
    isPast: month.compareTo(current) < 0,
    period: { start: period.start, end: period.end },
    items: usages.map(usageDto),
    totals: { limitPaise: limit, spentPaise: spent, committedPaise: committed, remainingPaise: limit - spent },
  };
}

/** GET /budgets/{id}: one budget's usage with its day-by-day spending. */
export async function budgetDetail(s: FinanceSnapshot, id: string, requested?: MonthKey | null) {
  const { month, period, usages, transactions } = await load(s, requested, (b) => b.id === id);
  const u = usages[0];
  if (!u) throw AppFailure.notFound('This budget no longer exists.');
  const perDay = new Map<IsoDate, number>();
  for (const t of transactions) {
    if (t.categoryId === u.budget.categoryId) perDay.set(t.date, (perDay.get(t.date) ?? 0) + t.amountPaise);
  }
  const daily = Array.from({ length: period.dayCount }, (_, i) => {
    const date = addDays(period.start, i);
    return { date, amountPaise: perDay.get(date) ?? 0 };
  });
  return {
    ...usageDto(u),
    month: month.id,
    todayIndex: Math.min(Math.max(daysBetween(period.start, s.today), -1), period.dayCount),
    daily,
  };
}
