// Home dashboard: one small payload built from the same services as the
// detail endpoints (lib/features/home/application/home_overview.dart,
// upcoming.dart and the home sections). Nothing here re-derives a rule:
// balance = ledger, budgets = budget usages, pending = pending totals,
// goals = goal progress, emergency = emergency status, debt = loan states,
// net worth = computeNetWorth, alerts = alert engine + inbox.

import { DateRange, MonthKey, makeDate, type IsoDate } from '../../core/dates';
import type { Paise } from '../../core/money';
import type { PeriodSummary } from '../../finance/ledger';
import type { FinanceSnapshot } from '../../finance/snapshot';
import { loadAlertList } from '../alerts/engine';
import { currentBudgetMonth, currentBudgetPeriod } from '../budgets/service';
import type { GoalProgress } from '../goals/calculator';
import { goalProgressDto } from '../goals/service';
import { pendingTotals, isActiveStatus, type PendingState } from '../pending/calculator';
import { toPendingDto } from '../pending/service';
import { monthlyCommitment } from '../subscriptions/calculator';
import { summaryDto } from './analytics';
import { budgetUsagesOf, currentMonthOf, emergencyOf, goalProgressOf, loanStatesOf, monthSummary, pendingStatesOf } from './memo';
import { loadNetWorth } from './net-worth';
import { loadUpcoming } from './upcoming';

/** Alerts shown in the home carousel (AttentionSection.maxShown). */
export const DASHBOARD_ALERTS = 6;
/** Long-pending items listed on the dashboard. */
export const DASHBOARD_LONG_PENDING = 3;

export const SETUP_STEPS = {
  profile: { title: 'Add your name and opening balance', description: 'So balances start from the right number.' },
  emergencyFund: { title: 'Plan your emergency fund', description: 'A safety net for 3–6 months of essentials.' },
  goal: { title: 'Create a savings goal', description: 'Set money aside for something that matters.' },
  budget: { title: 'Set a monthly budget', description: 'Stay comfortably within a spending limit.' },
} as const;
export type SetupStep = keyof typeof SETUP_STEPS;

export async function setupChecklist(s: FinanceSnapshot) {
  const [profile, plan, goals, budgets] = await Promise.all([s.profile(), s.emergencyPlan(), s.goals(), s.budgets()]);
  const done: Record<SetupStep, boolean> = {
    profile: profile !== null && profile.displayName.trim().length > 0,
    emergencyFund: plan !== null,
    goal: goals.length > 0,
    budget: budgets.length > 0,
  };
  const steps = (Object.keys(SETUP_STEPS) as SetupStep[]).map((id) => ({ id, ...SETUP_STEPS[id], done: done[id] }));
  return { steps, completed: steps.filter((x) => x.done).length, total: steps.length };
}

export type SavingsHealthLevel = 'noData' | 'strong' | 'steady' | 'thin' | 'deficit';
const HEALTH_LABELS: Record<SavingsHealthLevel, string> = {
  noData: 'Not enough data',
  strong: 'Healthy',
  steady: 'Steady',
  thin: 'Thin margin',
  deficit: 'Spending above income',
};

/** Classifies a month's savings rate: 20%+ healthy, 10–20% steady, 0–10% thin, below zero deficit. */
export function savingsHealth(summary: Pick<PeriodSummary, 'savingsRateBps'>) {
  const bps = summary.savingsRateBps;
  const out = (level: SavingsHealthLevel, explanation: string) => ({ level, label: HEALTH_LABELS[level], rateBps: bps, explanation });
  if (bps === null) return out('noData', 'No income recorded for this month yet, so a savings rate cannot be calculated.');
  if (bps >= 2000) return out('strong', 'You kept a healthy share of what you earned. 20% or more is a comfortable cushion.');
  if (bps >= 1000) return out('steady', 'You are saving steadily. Nudging this towards 20% builds a stronger cushion.');
  if (bps >= 0) return out('thin', 'Most of your income was spent. A little trimming would widen your margin.');
  return out('deficit', 'Spending was higher than income this month, so savings or earlier balances covered the gap.');
}

/** Active goals not yet reached, closest to completion first. */
export function topActiveGoals(all: readonly GoalProgress[], take = 3): GoalProgress[] {
  return all
    .filter((g) => g.goal.status === 'active' && !g.isAchieved)
    .sort((a, b) => b.progressBps - a.progressBps)
    .slice(0, take);
}

/** PendingOverview: totals plus long-pending items, oldest first. */
export function pendingOverview(states: readonly PendingState[]) {
  const totals = pendingTotals(states);
  const long = states.filter((p) => isActiveStatus(p.status) && p.isLongPending).sort((a, b) => b.daysOpen - a.daysOpen);
  return {
    toPayPaise: totals.toPayPaise,
    toCollectPaise: totals.toCollectPaise,
    payCount: totals.payCount,
    collectCount: totals.collectCount,
    activeCount: totals.payCount + totals.collectCount,
    netPaise: totals.netPaise,
    longCount: long.length,
    longPending: long.slice(0, DASHBOARD_LONG_PENDING).map(toPendingDto),
  };
}

/** Same days of the previous month for a month in progress (period_overview.dart). */
export function comparisonRange(today: IsoDate): DateRange {
  const prev = MonthKey.of(today).previous;
  const day = Math.min(Number(today.slice(8, 10)), prev.dayCount);
  return new DateRange(prev.start, makeDate(prev.year, prev.month, day));
}

/** GET /dashboard. */
export async function dashboard(s: FinanceSnapshot) {
  const month = currentMonthOf(s);
  const compareRange = comparisonRange(s.today);
  const [hasActivity, balance, summary, before, upcoming, alerts, budgets, pending, goals, emergency, loans, netWorth, subs, setup] =
    await Promise.all([
      s.hasActivity(),
      s.balance(),
      monthSummary(s, month),
      s.summary(compareRange),
      loadUpcoming(s),
      loadAlertList(s),
      budgetUsagesOf(s),
      pendingStatesOf(s),
      goalProgressOf(s),
      emergencyOf(s),
      loanStatesOf(s),
      loadNetWorth(s),
      s.subscriptions(),
      setupChecklist(s),
    ]);

  // Budgets pulse: totals of active (not paused) budgets, as GET /budgets.
  let limit = 0;
  let spent = 0;
  let committed = 0;
  const counts = { active: 0, paused: 0, warning: 0, breached: 0 };
  for (const u of budgets) {
    if (u.budget.status === 'paused') {
      counts.paused++;
      continue;
    }
    counts.active++;
    if (u.health === 'warning') counts.warning++;
    if (u.health === 'breached') counts.breached++;
    limit += u.limitPaise;
    spent += u.spentPaise;
    committed += u.committedPaise;
  }
  const period = currentBudgetPeriod(s);

  // Debt overview: borrowed, open loans.
  const borrowed = loans.filter((l) => l.loan.direction === 'borrowed' && !l.isClosed);
  const next = borrowed.filter((l) => l.nextDue !== null).sort((a, b) => (a.nextDue!.dueDate < b.nextDue!.dueDate ? -1 : a.nextDue!.dueDate > b.nextDue!.dueDate ? 1 : 0))[0];
  const totalDebt: Paise = borrowed.reduce((n, l) => n + l.outstandingPaise, 0);

  const activeGoals = goals.filter((g) => g.goal.status === 'active');

  return {
    today: s.today,
    isFreshUser: !hasActivity,
    balance,
    cashFlow: {
      month: month.id,
      summary: summaryDto(summary),
      compareRange: { start: compareRange.start, end: compareRange.end },
      before: summaryDto(before),
      savingsHealth: savingsHealth(summary),
    },
    upcoming,
    alerts: {
      top: alerts.items.slice(0, DASHBOARD_ALERTS),
      total: alerts.total,
      unreadCount: alerts.unreadCount,
      counts: alerts.counts,
      breakdown: alerts.breakdown,
    },
    budgets: {
      month: currentBudgetMonth(s).id,
      period: { start: period.start, end: period.end },
      limitPaise: limit,
      spentPaise: spent,
      committedPaise: committed,
      remainingPaise: limit - spent,
      ...counts,
    },
    pending: pendingOverview(pending),
    goals: {
      activeCount: activeGoals.length,
      achievedCount: activeGoals.filter((g) => g.isAchieved).length,
      savedPaise: activeGoals.reduce((n, g) => n + g.saved, 0),
      targetPaise: activeGoals.reduce((n, g) => n + g.goal.targetPaise, 0),
      top: topActiveGoals(goals).map(goalProgressDto),
    },
    emergency: {
      level: emergency.level,
      coverageTenths: emergency.coverageTenths,
      savedPaise: emergency.saved,
      targetPaise: emergency.target,
      remainingPaise: emergency.remaining,
      progressBps: emergency.progressBps,
      targetMonths: emergency.plan?.targetMonths ?? null,
    },
    debt: {
      totalOutstandingPaise: totalDebt,
      activeLoans: borrowed.length,
      nextLoanId: next?.loan.id ?? null,
      nextLoanName: next?.loan.name ?? null,
      nextDueDate: next?.nextDue?.dueDate ?? null,
      nextAmountPaise: next?.nextDue?.paymentPaise ?? null,
      overdueCount: borrowed.reduce((n, l) => n + l.overdueCount, 0),
    },
    subscriptions: {
      monthlyCommitmentPaise: monthlyCommitment(subs),
      activeCount: subs.filter((x) => x.status === 'active').length,
    },
    netWorth: {
      netWorthPaise: netWorth.netWorthPaise,
      totalAssetsPaise: netWorth.totalAssetsPaise,
      liabilitiesPaise: netWorth.liabilitiesPaise,
    },
    setup,
  };
}
