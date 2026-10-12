// "Coming up" (lib/features/home/application/upcoming.dart): scheduled
// commitments (EMIs, loan repayments due to the user, subscriptions) due
// within a window, overdue included, soonest first. Everything is a
// projection: nothing has moved yet. Pending payments are left out on
// purpose: they are never late, they surface by age (alerts) instead.

import { DateRange, addDays, daysBetween, minDate, type IsoDate } from '../../core/dates';
import type { Paise } from '../../core/money';
import type { Loan, Subscription } from '../../finance/models';
import type { FinanceSnapshot } from '../../finance/snapshot';
import type { LoanState } from '../loans/calculator';
import { occurrencesIn } from '../subscriptions/calculator';
import { loanStatesOf } from './memo';

/** How far ahead the home dashboard looks. */
export const UPCOMING_WINDOW_DAYS = 7;
export const MAX_UPCOMING_DAYS = 90;

export const UPCOMING_KINDS = {
  loanPayment: 'EMI',
  loanReceipt: 'Repayment due to you',
  subscription: 'Subscription',
} as const;
export type UpcomingKind = keyof typeof UPCOMING_KINDS;

export interface UpcomingItem {
  kind: UpcomingKind;
  kindLabel: string;
  /** Loan or subscription id. */
  recordId: string;
  title: string;
  date: IsoDate;
  amountPaise: Paise;
  /** Negative when overdue. */
  daysUntil: number;
  /** Money expected to come in (lent loans). */
  isInflow: boolean;
  isOverdue: boolean;
}

export interface UpcomingOverview {
  from: IsoDate;
  horizon: IsoDate;
  days: number;
  /** Soonest first; overdue items lead. */
  items: UpcomingItem[];
  /** Total going out in the window, overdue included: what to keep ready. */
  toArrangePaise: Paise;
  /** Total expected to come in over the same window. */
  expectedInPaise: Paise;
  outflowCount: number;
}

export function upcomingCommitments(
  loans: readonly LoanState<Loan>[],
  subscriptions: readonly Subscription[],
  today: IsoDate,
  horizonDays = UPCOMING_WINDOW_DAYS,
): UpcomingItem[] {
  const horizon = addDays(today, horizonDays);
  const out: UpcomingItem[] = [];
  const item = (kind: UpcomingKind, recordId: string, title: string, date: IsoDate, amountPaise: Paise): UpcomingItem => {
    const daysUntil = daysBetween(today, date);
    return { kind, kindLabel: UPCOMING_KINDS[kind], recordId, title, date, amountPaise, daysUntil, isInflow: kind === 'loanReceipt', isOverdue: daysUntil < 0 };
  };

  for (const l of loans) {
    const next = l.nextDue;
    if (next === null || next.dueDate > horizon) continue;
    const borrowed = l.loan.direction === 'borrowed';
    out.push(
      item(borrowed ? 'loanPayment' : 'loanReceipt', l.loan.id, borrowed ? l.loan.name : `${l.loan.counterparty} · ${l.loan.name}`, next.dueDate, next.paymentPaise),
    );
  }

  for (const sub of subscriptions) {
    if (sub.status !== 'active') continue;
    const due = sub.nextDueDate;
    if (due > horizon) continue;
    for (const d of occurrencesIn(sub, new DateRange(minDate(due, today), horizon))) {
      out.push(item('subscription', sub.id, sub.name, d, sub.amountPaise));
    }
  }

  // Stable sort: date, then title (code-unit order like Dart's String.compareTo).
  return out.sort((a, b) => (a.date !== b.date ? (a.date < b.date ? -1 : 1) : a.title < b.title ? -1 : a.title > b.title ? 1 : 0));
}

export function upcomingOverviewOf(items: UpcomingItem[], today: IsoDate, days: number): UpcomingOverview {
  let out = 0;
  let inflow = 0;
  for (const i of items) {
    if (i.isInflow) inflow += i.amountPaise;
    else out += i.amountPaise;
  }
  return {
    from: today,
    horizon: addDays(today, days),
    days,
    items,
    toArrangePaise: out,
    expectedInPaise: inflow,
    outflowCount: items.filter((i) => !i.isInflow).length,
  };
}

/** GET /upcoming and the dashboard's "Coming up" card. */
export async function loadUpcoming(s: FinanceSnapshot, days = UPCOMING_WINDOW_DAYS): Promise<UpcomingOverview> {
  const [loans, subscriptions] = await Promise.all([loanStatesOf(s), s.subscriptions()]);
  return upcomingOverviewOf(upcomingCommitments(loans, subscriptions, s.today, days), s.today, days);
}
