// Per-request memoisation of the module loaders the insights layer combines.
// A FinanceSnapshot lives for one request (one transaction), so keying a
// WeakMap by the snapshot shares loans/pending/budgets/goals between the
// dashboard, alerts and net worth of the same request without loading any of
// them twice. Nothing outlives the request.

import { MonthKey } from '../../core/dates';
import type { Category, Loan } from '../../finance/models';
import type { PeriodSummary } from '../../finance/ledger';
import type { FinanceSnapshot } from '../../finance/snapshot';
import type { BudgetUsage } from '../budgets/calculator';
import { loadBudgetUsages } from '../budgets/service';
import type { EmergencyFundStatus } from '../emergency-fund/calculator';
import { loadEmergencyStatus } from '../emergency-fund/service';
import type { GoalProgress } from '../goals/calculator';
import { loadGoalProgress } from '../goals/service';
import type { LoanState } from '../loans/calculator';
import { loadLoanStates } from '../loans/service';
import type { PendingState } from '../pending/calculator';
import { loadPendingStates } from '../pending/service';

const memos = new WeakMap<FinanceSnapshot, Map<string, Promise<unknown>>>();

export function memo<T>(s: FinanceSnapshot, key: string, load: () => Promise<T>): Promise<T> {
  let m = memos.get(s);
  if (!m) {
    m = new Map();
    memos.set(s, m);
  }
  let p = m.get(key) as Promise<T> | undefined;
  if (!p) {
    p = load();
    m.set(key, p);
  }
  return p;
}

export const loanStatesOf = (s: FinanceSnapshot): Promise<LoanState<Loan>[]> => memo(s, 'loanStates', () => loadLoanStates(s));
export const pendingStatesOf = (s: FinanceSnapshot): Promise<PendingState[]> => memo(s, 'pendingStates', () => loadPendingStates(s));
/** Current budget month usages (FinanceSnapshot.budgetUsages). */
export const budgetUsagesOf = (s: FinanceSnapshot): Promise<BudgetUsage[]> => memo(s, 'budgetUsages', () => loadBudgetUsages(s));
export const goalProgressOf = (s: FinanceSnapshot): Promise<GoalProgress[]> => memo(s, 'goalProgress', () => loadGoalProgress(s));
/** Emergency status without the essentials suggestion (level, coverage and totals do not depend on it). */
export const emergencyOf = (s: FinanceSnapshot): Promise<EmergencyFundStatus> =>
  memo(s, 'emergency', () => loadEmergencyStatus(s, { withSuggestion: false }));

export async function categoryMap(s: FinanceSnapshot): Promise<Map<string, Category>> {
  return memo(s, 'categoryMap', async () => new Map((await s.categories()).map((c) => [c.id, c])));
}

/** The calendar month containing today (FinanceSnapshot.currentMonth). */
export const currentMonthOf = (s: FinanceSnapshot): MonthKey => MonthKey.of(s.today);

/** Cash-flow summary of a calendar month (FinanceSnapshot.monthSummary). */
export const monthSummary = (s: FinanceSnapshot, month: MonthKey): Promise<PeriodSummary> => s.summary(month.range);
