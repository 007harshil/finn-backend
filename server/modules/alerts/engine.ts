// "What needs attention": port of lib/features/alerts/domain/alert_engine.dart
// and alert.dart. The engine is pure (generateAlerts); loadAlerts feeds it
// from the module services so every alert uses the same definitions as the
// detail endpoints.
//
// Alerts are derived on request: there is no scheduler, background job or
// push delivery on the server. Read/dismissed state lives in alert_inbox and
// survives regeneration because keys are deterministic (type + record + period).

import { MonthKey, daysBetween, formatMonthYear, type IsoDate } from '../../core/dates';
import type { Paise } from '../../core/money';
import type { Category, Loan, Preferences, Subscription } from '../../finance/models';
import type { FinanceSnapshot } from '../../finance/snapshot';
import { FREQUENCY_INFO } from '../../core/frequency';
import type { BudgetUsage } from '../budgets/calculator';
import type { EmergencyFundStatus } from '../emergency-fund/calculator';
import type { GoalProgress } from '../goals/calculator';
import type { LoanState } from '../loans/calculator';
import type { PendingState } from '../pending/calculator';
import { dueState } from '../subscriptions/calculator';
import {
  budgetUsagesOf,
  categoryMap,
  currentMonthOf,
  emergencyOf,
  goalProgressOf,
  loanStatesOf,
  memo,
  monthSummary,
  pendingStatesOf,
} from '../insights/memo';
import { dueIn, fmtWhole, formatBps, inDays } from './format';
import { loadInbox, type AlertInbox } from './inbox';

export const ALERT_TYPES = {
  emiDue: 'Upcoming EMI',
  emiOverdue: 'Overdue EMI',
  pendingOwed: 'Pending payment',
  collectOwed: 'Money to collect',
  subscriptionRenewal: 'Subscription renewal',
  subscriptionOverdue: 'Unpaid subscription',
  budgetNearLimit: 'Budget near limit',
  budgetBreached: 'Budget exceeded',
  emergencyFundLow: 'Low emergency fund',
  emergencyFundNotSet: 'Emergency fund not set',
  goalMilestone: 'Goal milestone',
  goalAtRisk: 'Goal behind schedule',
  monthlyDeficit: 'Spending above income',
} as const;
export type AlertType = keyof typeof ALERT_TYPES;

/** Lower rank = more urgent. */
export const ALERT_SEVERITIES = {
  critical: { rank: 0, label: 'Urgent' },
  warning: { rank: 1, label: 'Soon' },
  info: { rank: 2, label: 'FYI' },
  positive: { rank: 3, label: 'Good news' },
} as const;
export type AlertSeverity = keyof typeof ALERT_SEVERITIES;
export const SEVERITY_ORDER: AlertSeverity[] = ['critical', 'warning', 'info', 'positive'];

export type AlertTarget = 'loan' | 'pending' | 'subscription' | 'budget' | 'emergencyFund' | 'goal' | 'transactions';
export type DueParty = 'bank' | 'person' | 'service';

/** Numbers behind an alert so the app can draw it (AlertVisual subclasses, `kind` = class). */
export type AlertVisual =
  | { kind: 'due'; outgoing: boolean; party: DueParty; counterparty: string; daysUntil: number; recurring: boolean }
  | { kind: 'aged'; counterparty: string; daysOpen: number; outgoing: boolean }
  | { kind: 'budget'; category: string; spentPaise: Paise; limitPaise: Paise; daysLeft: number }
  | { kind: 'safetyNet'; savedPaise: Paise | null; targetPaise: Paise | null; coverageMonths: number | null; targetMonths: number | null }
  | {
      kind: 'goal';
      name: string;
      savedPaise: Paise;
      targetPaise: Paise;
      requiredMonthlyPaise: Paise | null;
      targetDate: IsoDate | null;
    }
  | { kind: 'cashFlow'; incomePaise: Paise; expensePaise: Paise };

export interface FinancialAlert {
  key: string;
  type: AlertType;
  typeLabel: string;
  severity: AlertSeverity;
  title: string;
  message: string;
  reason: string;
  actionLabel: string;
  target: AlertTarget;
  recordId: string | null;
  dueDate: IsoDate | null;
  amountPaise: Paise | null;
  dismissible: boolean;
  visual: AlertVisual | null;
}

export interface AlertSettings {
  emiReminderDays: number;
  subscriptionReminderDays: number;
  lowEmergencyCoverageMonths: number;
  disabledAlertTypes: readonly string[];
}

export const settingsFrom = (p: Preferences): AlertSettings => ({
  emiReminderDays: p.emiReminderDays,
  subscriptionReminderDays: p.subscriptionReminderDays,
  lowEmergencyCoverageMonths: p.lowEmergencyCoverageMonths,
  disabledAlertTypes: p.disabledAlertTypes,
});

/** Everything the engine reads (the FinanceSnapshot fields AlertEngine.generate uses). */
export interface AlertEngineInput {
  today: IsoDate;
  /** No transactions, pending items, loans or goals yet. */
  isFreshUser: boolean;
  loans: readonly LoanState<Loan>[];
  pending: readonly PendingState[];
  subscriptions: readonly Subscription[];
  /** Current budget period usages. */
  budgets: readonly BudgetUsage[];
  categories: ReadonlyMap<string, Pick<Category, 'name'>>;
  emergency: EmergencyFundStatus;
  goals: readonly GoalProgress[];
  /** Cash flow of the calendar month containing today. */
  month: { id: string; incomePaise: Paise; expensePaise: Paise };
}

type Draft = Omit<FinancialAlert, 'typeLabel' | 'recordId' | 'dueDate' | 'amountPaise' | 'dismissible' | 'visual'> &
  Partial<Pick<FinancialAlert, 'recordId' | 'dueDate' | 'amountPaise' | 'dismissible' | 'visual'>>;

/** Severity, then dated before undated, then due date, then key: a total order independent of input order. */
export function compareAlerts(a: FinancialAlert, b: FinancialAlert): number {
  const c = ALERT_SEVERITIES[a.severity].rank - ALERT_SEVERITIES[b.severity].rank;
  if (c !== 0) return c;
  const ad = a.dueDate;
  const bd = b.dueDate;
  if (ad !== null && bd !== null && ad !== bd) return ad < bd ? -1 : 1;
  if (ad !== null && bd === null) return -1;
  if (ad === null && bd !== null) return 1;
  return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
}

export function generateAlerts(s: AlertEngineInput, settings: AlertSettings): FinancialAlert[] {
  const out: FinancialAlert[] = [];
  const disabled = new Set(settings.disabledAlertTypes);
  const add = (a: Draft) => {
    if (disabled.has(a.type)) return;
    out.push({
      key: a.key,
      type: a.type,
      typeLabel: ALERT_TYPES[a.type],
      severity: a.severity,
      title: a.title,
      message: a.message,
      reason: a.reason,
      actionLabel: a.actionLabel,
      target: a.target,
      recordId: a.recordId ?? null,
      dueDate: a.dueDate ?? null,
      amountPaise: a.amountPaise ?? null,
      dismissible: a.dismissible ?? true,
      visual: a.visual ?? null,
    });
  };
  const today = s.today;
  const fmt = fmtWhole;
  const when = (d: IsoDate) => dueIn(d, today);

  // Loans: overdue and upcoming instalments.
  for (const l of s.loans) {
    const next = l.nextDue;
    if (next === null || l.loan.status === 'closed') continue;
    const days = daysBetween(today, next.dueDate);
    const borrowed = l.loan.direction === 'borrowed';
    const what = l.loan.structure === 'amortizing' ? 'EMI' : 'Interest';
    const visual: AlertVisual = {
      kind: 'due',
      outgoing: borrowed,
      party: borrowed ? 'bank' : 'person',
      counterparty: l.loan.counterparty,
      daysUntil: days,
      recurring: false,
    };
    if (days < 0) {
      add({
        key: `loan_overdue:${l.loan.id}:${next.number}`,
        type: 'emiOverdue',
        severity: borrowed ? 'critical' : 'warning',
        title: borrowed ? `${what} of ${fmt(next.paymentPaise)} is overdue` : `${l.loan.counterparty} has not paid ${fmt(next.paymentPaise)}`,
        message: `${l.loan.name} · ${l.loan.counterparty} — ${when(next.dueDate)}.`,
        reason: borrowed
          ? 'Late payments can attract penalties and affect your credit score.'
          : 'Following up early keeps the arrangement on track.',
        actionLabel: borrowed ? 'Record payment' : 'Record receipt',
        target: 'loan',
        recordId: l.loan.id,
        dueDate: next.dueDate,
        amountPaise: next.paymentPaise,
        dismissible: false,
        visual,
      });
    } else if (days <= settings.emiReminderDays) {
      add({
        key: `loan_due:${l.loan.id}:${next.number}`,
        type: 'emiDue',
        severity: 'warning',
        title: borrowed
          ? `${what} of ${fmt(next.paymentPaise)} ${when(next.dueDate)}`
          : `Repayment from ${l.loan.counterparty} ${when(next.dueDate)}`,
        message: `${l.loan.name} · ${l.loan.counterparty}. ${fmt(next.interestPaise)} interest + ${fmt(next.principalPaise)} principal.`,
        reason: borrowed
          ? `Keep ${fmt(next.paymentPaise)} available so the payment goes through.`
          : `Expect ${fmt(next.paymentPaise)} to come in.`,
        actionLabel: 'View loan',
        target: 'loan',
        recordId: l.loan.id,
        dueDate: next.dueDate,
        amountPaise: next.paymentPaise,
        visual,
      });
    }
  }

  // Pending obligations: informative only, never "late".
  for (const p of s.pending) {
    if (!p.isLongPending) continue;
    const owe = p.payment.direction === 'iOwe';
    const who = p.payment.counterparty;
    add({
      key: `pending_aged:${p.payment.id}`,
      type: owe ? 'pendingOwed' : 'collectOwed',
      severity: 'info',
      title: owe ? `You owe ${who} ${fmt(p.outstandingPaise)}` : `${who} owes you ${fmt(p.outstandingPaise)}`,
      message: owe
        ? `You have not paid ${who} back yet. ${p.daysOpen} days have passed · ${p.payment.purpose}.`
        : `${who} has not returned your money. ${p.daysOpen} days have passed · ${p.payment.purpose}.`,
      reason: owe
        ? 'There is no deadline. Settle it when you can.'
        : 'There is no deadline. The longest-waiting items are the ones to ask about first.',
      actionLabel: owe ? 'Settle now' : 'View details',
      target: 'pending',
      recordId: p.payment.id,
      amountPaise: p.outstandingPaise,
      visual: { kind: 'aged', counterparty: who, daysOpen: p.daysOpen, outgoing: owe },
    });
  }

  // Subscriptions: overdue (expected but not marked paid) and renewals.
  for (const sub of s.subscriptions) {
    if (sub.status !== 'active') continue;
    const state = dueState(sub, today, settings.subscriptionReminderDays);
    const days = daysBetween(today, sub.nextDueDate);
    const visual: AlertVisual = { kind: 'due', outgoing: true, party: 'service', counterparty: sub.name, daysUntil: days, recurring: true };
    if (state === 'overdue') {
      add({
        key: `sub_overdue:${sub.id}:${sub.nextDueDate}`,
        type: 'subscriptionOverdue',
        severity: 'warning',
        title: `${sub.name} payment not recorded`,
        message: `${fmt(sub.amountPaise)} was ${when(sub.nextDueDate)}.`,
        reason: 'Mark it paid if it was charged, or skip this cycle, so your balance stays accurate.',
        actionLabel: 'Review',
        target: 'subscription',
        recordId: sub.id,
        dueDate: sub.nextDueDate,
        amountPaise: sub.amountPaise,
        visual,
      });
    } else if (state === 'dueToday' || state === 'dueSoon') {
      add({
        key: `sub_due:${sub.id}:${sub.nextDueDate}`,
        type: 'subscriptionRenewal',
        severity: 'info',
        title: `${sub.name} renews ${inDays(days)}`,
        message: `${fmt(sub.amountPaise)} · ${FREQUENCY_INFO[sub.frequency].label}.`,
        reason: 'Still using it? Pause or cancel before it charges.',
        actionLabel: 'Manage',
        target: 'subscription',
        recordId: sub.id,
        dueDate: sub.nextDueDate,
        amountPaise: sub.amountPaise,
        visual,
      });
    }
  }

  // Budgets.
  for (const u of s.budgets) {
    if (u.health !== 'breached' && u.health !== 'warning') continue;
    if (u.period.end < today) continue;
    const name = s.categories.get(u.budget.categoryId)?.name ?? 'A budget';
    const breached = u.health === 'breached';
    const daysLeft = daysBetween(today, u.period.end) + 1;
    add({
      key: `budget:${u.budget.id}:${u.period.start}:${breached ? 'b' : 'w'}`,
      type: breached ? 'budgetBreached' : 'budgetNearLimit',
      severity: breached ? 'critical' : 'warning',
      title: breached
        ? `${name} is over budget by ${fmt(Math.abs(u.remainingPaise))}`
        : `${name} has used ${formatBps(u.utilizationBps, 0)} of its budget`,
      message: `${fmt(u.spentPaise)} of ${fmt(u.budget.limitPaise)} spent · ${daysLeft} days left in the period.`,
      reason: breached
        ? 'Further spending here eats into money meant for other plans.'
        : 'Slowing down now keeps the rest of the period comfortable.',
      actionLabel: 'View budget',
      target: 'budget',
      recordId: u.budget.id,
      dueDate: u.period.end,
      amountPaise: u.spentPaise,
      visual: { kind: 'budget', category: name, spentPaise: u.spentPaise, limitPaise: u.budget.limitPaise, daysLeft },
    });
  }

  // Emergency fund.
  const ef = s.emergency;
  if (ef.level === 'notConfigured') {
    if (!s.isFreshUser) {
      add({
        key: 'ef_not_set',
        type: 'emergencyFundNotSet',
        severity: 'info',
        title: 'Set up your emergency fund',
        message: 'Decide how many months of essential expenses you want protected.',
        reason: 'A safety buffer keeps a surprise bill from becoming debt.',
        actionLabel: 'Set up',
        target: 'emergencyFund',
        visual: { kind: 'safetyNet', savedPaise: null, targetPaise: null, coverageMonths: null, targetMonths: null },
      });
    }
  } else if (ef.coverageTenths !== null && ef.coverageTenths < settings.lowEmergencyCoverageMonths * 10) {
    const months = ef.coverageTenths / 10;
    const targetMonths = ef.plan?.targetMonths ?? 0;
    add({
      key: `ef_low:${MonthKey.of(today).id}`,
      type: 'emergencyFundLow',
      severity: ef.level === 'critical' ? 'warning' : 'info',
      title: `Emergency fund covers ${months.toFixed(1)} months`,
      message: `${fmt(ef.saved)} saved of ${fmt(ef.target)} target · ${fmt(ef.remaining)} to go.`,
      reason: `Your target is ${targetMonths} months of essentials. Small regular top-ups get you there.`,
      actionLabel: 'Add to fund',
      target: 'emergencyFund',
      visual: { kind: 'safetyNet', savedPaise: ef.saved, targetPaise: ef.target, coverageMonths: months, targetMonths },
    });
  }

  // Goals: milestones and schedule risk.
  for (const g of s.goals) {
    if (g.goal.status !== 'active') continue;
    const goalVisual = (extra: { requiredMonthlyPaise: Paise | null; targetDate: IsoDate | null }): AlertVisual => ({
      kind: 'goal',
      name: g.goal.name,
      savedPaise: g.saved,
      targetPaise: g.goal.targetPaise,
      ...extra,
    });
    if (g.isAchieved) {
      add({
        key: `goal_done:${g.goal.id}`,
        type: 'goalMilestone',
        severity: 'positive',
        title: `${g.goal.name} is fully funded`,
        message: `${fmt(g.saved)} saved — target reached.`,
        reason: 'Nice work. The money stays earmarked until you use or release it.',
        actionLabel: 'View goal',
        target: 'goal',
        recordId: g.goal.id,
        visual: goalVisual({ requiredMonthlyPaise: null, targetDate: null }),
      });
    } else if (
      g.onTrack === false &&
      g.goal.targetDate !== null &&
      g.requiredMonthly !== null &&
      daysBetween(today, g.goal.targetDate) <= 365
    ) {
      add({
        key: `goal_risk:${g.goal.id}:${MonthKey.of(today).id}`,
        type: 'goalAtRisk',
        severity: 'info',
        title: `${g.goal.name} may miss its date`,
        message: `About ${fmt(g.requiredMonthly)} a month is needed to finish by ${formatMonthYear(MonthKey.of(g.goal.targetDate))}.`,
        reason: 'Adjusting the amount or date now keeps the plan realistic.',
        actionLabel: 'Review goal',
        target: 'goal',
        recordId: g.goal.id,
        dueDate: g.goal.targetDate,
        visual: goalVisual({ requiredMonthlyPaise: g.requiredMonthly, targetDate: g.goal.targetDate }),
      });
    } else if (g.progressBps >= 7500) {
      add({
        key: `goal_75:${g.goal.id}`,
        type: 'goalMilestone',
        severity: 'positive',
        title: `${g.goal.name} is ${formatBps(g.progressBps, 0)} funded`,
        message: `${fmt(g.remaining)} left to reach ${fmt(g.goal.targetPaise)}.`,
        reason: 'You are in the final stretch.',
        actionLabel: 'Contribute',
        target: 'goal',
        recordId: g.goal.id,
        visual: goalVisual({ requiredMonthlyPaise: null, targetDate: null }),
      });
    }
  }

  // Month-to-date deficit.
  const m = s.month;
  if (m.incomePaise > 0 && m.expensePaise > m.incomePaise) {
    add({
      key: `deficit:${m.id}`,
      type: 'monthlyDeficit',
      severity: 'warning',
      title: `Spending is ${fmt(m.expensePaise - m.incomePaise)} above income this month`,
      message: `${fmt(m.expensePaise)} spent vs ${fmt(m.incomePaise)} received so far.`,
      reason: 'Running a deficit draws down your savings.',
      actionLabel: 'See spending',
      target: 'transactions',
      visual: { kind: 'cashFlow', incomePaise: m.incomePaise, expensePaise: m.expensePaise },
    });
  }

  return out.sort(compareAlerts);
}

// ---------------------------------------------------------------------------
// Loading from a snapshot
// ---------------------------------------------------------------------------

export async function loadAlertInput(s: FinanceSnapshot): Promise<AlertEngineInput> {
  const current = currentMonthOf(s);
  const [loans, pending, subscriptions, budgets, categories, emergency, goals, hasActivity, month] = await Promise.all([
    loanStatesOf(s),
    pendingStatesOf(s),
    s.subscriptions(),
    budgetUsagesOf(s),
    categoryMap(s),
    emergencyOf(s),
    goalProgressOf(s),
    s.hasActivity(),
    monthSummary(s, current),
  ]);
  return {
    today: s.today,
    isFreshUser: !hasActivity,
    loans,
    pending,
    subscriptions,
    budgets,
    categories,
    emergency,
    goals,
    month: { id: current.id, incomePaise: month.incomePaise, expensePaise: month.expensePaise },
  };
}

/** Every alert for the snapshot's user (dismissed ones included), sorted. Memoised per request. */
export function loadAlerts(s: FinanceSnapshot): Promise<FinancialAlert[]> {
  return memo(s, 'alerts', async () => generateAlerts(await loadAlertInput(s), settingsFrom(s.prefs)));
}

export interface AlertListItem extends FinancialAlert {
  read: boolean;
}

export type SeverityCounts = Record<AlertSeverity, number>;

export interface AlertList {
  items: AlertListItem[];
  /** Active (not dismissed) alerts not yet read. */
  unreadCount: number;
  total: number;
  counts: SeverityCounts;
  /** "2 urgent · 1 soon" (AttentionSection.breakdown). */
  breakdown: string;
}

export function severityCounts(items: readonly Pick<FinancialAlert, 'severity'>[]): SeverityCounts {
  const counts: SeverityCounts = { critical: 0, warning: 0, info: 0, positive: 0 };
  for (const a of items) counts[a.severity]++;
  return counts;
}

export function breakdownOf(counts: SeverityCounts): string {
  return SEVERITY_ORDER.filter((s) => counts[s] > 0)
    .map((s) => `${counts[s]} ${ALERT_SEVERITIES[s].label.toLowerCase()}`)
    .join(' · ');
}

/** Active alerts (dismissed keys removed) with their read flag. */
export function mergeInbox(alerts: readonly FinancialAlert[], inbox: AlertInbox): AlertList {
  const dismissed = new Set(inbox.dismissed);
  const read = new Set(inbox.read);
  const items = alerts.filter((a) => !dismissed.has(a.key)).map((a) => ({ ...a, read: read.has(a.key) }));
  const counts = severityCounts(items);
  return {
    items,
    unreadCount: items.filter((a) => !a.read).length,
    total: items.length,
    counts,
    breakdown: breakdownOf(counts),
  };
}

/** GET /alerts: active alerts merged with the inbox. */
export async function loadAlertList(s: FinanceSnapshot): Promise<AlertList> {
  const [alerts, inbox] = await Promise.all([loadAlerts(s), loadInbox(s.tx, s.userId)]);
  return mergeInbox(alerts, inbox);
}
