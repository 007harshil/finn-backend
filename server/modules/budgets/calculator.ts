// Budget usage derivation (lib/features/budgets/domain/budget_calculator.dart).
// Pure and deterministic: no database, `today` is always passed in.

import { occurrencesIn } from '../subscriptions/calculator';
import { DateRange, MonthKey, daysBetween, makeDate, maxDate, parts, todayIn, type IsoDate } from '../../core/dates';
import { ratioBps, type Paise } from '../../core/money';
import type { Budget, Subscription, Transaction } from '../../finance/models';

export const DEFAULT_BUDGET_WARNING_BPS = 8000;
export const MIN_BUDGET_WARNING_BPS = 5000;
export const MAX_BUDGET_WARNING_BPS = 9500;
/** Largest budget limit accepted (₹10 crore) in paise. */
export const MAX_BUDGET_LIMIT_PAISE = 100_000_000 * 100;
/** Transaction ids returned per usage. */
export const MAX_USAGE_TRANSACTION_IDS = 500;

export type BudgetHealth = 'healthy' | 'warning' | 'breached' | 'paused';

export interface BudgetUsage {
  /** The budget with the limit (and, for past months, the status) that applied in the period. */
  budget: Budget;
  period: DateRange;
  spentPaise: Paise;
  /** Expected, not yet recorded subscription charges (never added to spent). */
  committedPaise: Paise;
  limitPaise: Paise;
  transactionIds: string[];
  health: BudgetHealth;
  elapsedBps: number;
  remainingPaise: Paise;
  remainingAfterCommittedPaise: Paise;
  utilizationBps: number;
}

const clampDay = (d: number) => Math.min(Math.max(d, 1), 28);

/** The monthly period containing [reference]; start days above 28 clamp to 28. */
export function monthlyPeriod(reference: IsoDate, monthStartDay: number): DateRange {
  const day = clampDay(monthStartDay);
  const r = parts(reference);
  const start = r.day >= day ? makeDate(r.year, r.month, day) : makeDate(r.year, r.month - 1, day);
  const s = parts(start);
  return new DateRange(start, makeDate(s.year, s.month + 1, day - 1));
}

/** The budget period that starts in [month]. */
export function periodOf(month: MonthKey, monthStartDay: number): DateRange {
  return monthlyPeriod(makeDate(month.year, month.month, clampDay(monthStartDay)), monthStartDay);
}

/** The budget month (month its period starts in) containing [date]. */
export function monthOf(date: IsoDate, monthStartDay: number): MonthKey {
  return MonthKey.of(monthlyPeriod(date, monthStartDay).start);
}

/** Budget month a budget was created in (createdAt is an instant; the calendar date is the user's local one). */
export function budgetStartMonth(b: Pick<Budget, 'createdAt'>, monthStartDay: number, timeZone: string): MonthKey {
  return monthOf(todayIn(timeZone, new Date(b.createdAt)), monthStartDay);
}

/** The limit that applied in budget [month]. */
export function limitFor(b: Pick<Budget, 'limitPaise' | 'previousLimits'>, month: MonthKey): Paise {
  for (const c of b.previousLimits) {
    const until = MonthKey.tryParse(c.until);
    if (until && month.compareTo(until) <= 0) return c.limitPaise;
  }
  return b.limitPaise;
}

/** Expected (unpaid) charge dates; one shared projection rule (subscriptions calculator). */
export const subscriptionOccurrencesIn = occurrencesIn;

/** Share of the period elapsed in basis points (0..10000). */
export function elapsedBpsOf(range: DateRange, today: IsoDate): number {
  const elapsedDays = daysBetween(range.start, today) + 1;
  return Math.min(Math.max(Math.floor((elapsedDays * 10000) / range.dayCount), 0), 10000);
}

export interface UsageInput {
  budget: Budget;
  transactions: Transaction[];
  subscriptions: Subscription[];
  today: IsoDate;
  monthStartDay: number;
  period?: DateRange;
}

export function usage(input: UsageInput): BudgetUsage {
  const { subscriptions, today, monthStartDay } = input;
  const range = input.period ?? monthlyPeriod(today, monthStartDay);
  const limit = limitFor(input.budget, MonthKey.of(range.start));
  const budget: Budget = limit === input.budget.limitPaise ? input.budget : { ...input.budget, limitPaise: limit };

  let spent = 0;
  const ids: string[] = [];
  for (const t of input.transactions) {
    if (t.type === 'expense' && t.categoryId === budget.categoryId && t.origin !== 'loanDisbursement' && range.contains(t.date)) {
      spent += t.amountPaise;
      if (ids.length < MAX_USAGE_TRANSACTION_IDS) ids.push(t.id);
    }
  }

  // Committed: expected subscription charges in this category for the rest of the period.
  let committed = 0;
  if (range.end >= today) {
    const rest = new DateRange(maxDate(range.start, today), range.end);
    for (const s of subscriptions) {
      if (s.categoryId !== budget.categoryId) continue;
      committed += s.amountPaise * subscriptionOccurrencesIn(s, rest).length;
    }
  }

  // Exact comparison (spent / limit >= threshold), not the rounded utilisation.
  const reachedWarning = limit > 0 && BigInt(spent) * 10000n >= BigInt(limit) * BigInt(budget.warningThresholdBps);
  let health: BudgetHealth;
  if (budget.status === 'paused') health = 'paused';
  else if (spent > limit) health = 'breached';
  else if (reachedWarning) health = 'warning';
  else health = 'healthy';

  return {
    budget,
    period: range,
    spentPaise: spent,
    committedPaise: committed,
    limitPaise: limit,
    transactionIds: ids,
    health,
    elapsedBps: elapsedBpsOf(range, today),
    remainingPaise: limit - spent,
    remainingAfterCommittedPaise: limit - spent - committed,
    utilizationBps: ratioBps(spent, limit) ?? 0,
  };
}
