// Pure subscription projections (lib/features/subscriptions/domain/subscription.dart
// SubscriptionCalculator + SubscriptionSchedule). Projections are never transactions.

import { DateRange, daysBetween, formatDate, parts, daysInMonth, type IsoDate } from '../../core/dates';
import { annualized, FREQUENCY_INFO, monthlyEquivalent, nextOccurrence } from '../../core/frequency';
import { sumPaise, type Paise } from '../../core/money';
import type { Subscription, Transaction } from '../../finance/models';

export type DueState = 'overdue' | 'dueToday' | 'dueSoon' | 'upcoming';

export const subscriptionMonthly = (s: Subscription): Paise => monthlyEquivalent(s.frequency, s.amountPaise);
export const subscriptionAnnual = (s: Subscription): Paise => annualized(s.frequency, s.amountPaise);
export const isActive = (s: Subscription): boolean => s.status === 'active';

export function dueState(s: Pick<Subscription, 'nextDueDate'>, today: IsoDate, soonDays = 7): DueState {
  const d = daysBetween(today, s.nextDueDate);
  if (d < 0) return 'overdue';
  if (d === 0) return 'dueToday';
  if (d <= soonDays) return 'dueSoon';
  return 'upcoming';
}

/**
 * Day of month the schedule is anchored to. A due date clamped to a short
 * month (31 Jan -> 28 Feb) returns to the start date's day afterwards.
 */
export function anchorDay(s: Pick<Subscription, 'nextDueDate' | 'startDate'>): number {
  const due = parts(s.nextDueDate);
  if (s.startDate) {
    const start = parts(s.startDate);
    if (start.day > due.day && due.day === daysInMonth(due.year, due.month)) return start.day;
  }
  return due.day;
}

/** The due date one frequency step after the current nextDueDate. */
export function nextCycleAfterCurrent(s: Pick<Subscription, 'nextDueDate' | 'startDate' | 'frequency'>): IsoDate {
  return nextOccurrence(s.frequency, s.nextDueDate, anchorDay(s));
}

/** Note written on the payment transaction; identifies the cycle it paid. */
export const paymentNote = (s: Pick<Subscription, 'frequency'>, cycle: IsoDate): string =>
  `${FREQUENCY_INFO[s.frequency].label} renewal · for ${formatDate(cycle)}`;

/**
 * Whether a payment transaction already exists for the cycle due on [cycle].
 * Payments recorded by FiNN carry the cycle in their note; older entries
 * without a marker count when their date equals the cycle date.
 */
export function isCyclePaid(s: Pick<Subscription, 'id'>, cycle: IsoDate, linked: Iterable<Transaction>): boolean {
  const marker = `for ${formatDate(cycle)}`;
  for (const t of linked) {
    if (t.origin !== 'subscription' || t.originRefId !== s.id) continue;
    const note = t.note ?? '';
    if (note.includes(' · for ')) {
      if (note.endsWith(marker)) return true;
    } else if (t.date === cycle) {
      return true;
    }
  }
  return false;
}

/** Expected (unpaid) charge dates for [s] inside [range] (active subscriptions only). */
export function occurrencesIn(s: Subscription, range: DateRange): IsoDate[] {
  if (!isActive(s)) return [];
  const result: IsoDate[] = [];
  let date = s.nextDueDate;
  const anchor = anchorDay(s);
  let guard = 0;
  while (date <= range.end && guard < 500) {
    if (range.contains(date)) result.push(date);
    date = nextOccurrence(s.frequency, date, anchor);
    guard++;
  }
  return result;
}

export const monthlyCommitment = (subs: Iterable<Subscription>): Paise =>
  sumPaise([...subs].filter(isActive).map(subscriptionMonthly));

export const annualCommitment = (subs: Iterable<Subscription>): Paise =>
  sumPaise([...subs].filter(isActive).map(subscriptionAnnual));

export interface ProjectedCharge {
  date: IsoDate;
  amountPaise: Paise;
  subscriptionId: string;
  categoryId: string;
}

/** Expected charges of active subscriptions dated within [from, to], by date. Never transactions. */
export function projectCharges(subscriptions: Subscription[], from: IsoDate, to: IsoDate): ProjectedCharge[] {
  if (to < from) return [];
  const range = new DateRange(from, to);
  const out: ProjectedCharge[] = [];
  for (const s of subscriptions) {
    for (const date of occurrencesIn(s, range)) {
      out.push({ date, amountPaise: s.amountPaise, subscriptionId: s.id, categoryId: s.categoryId });
    }
  }
  return out.sort((a, b) => (a.date === b.date ? (a.subscriptionId < b.subscriptionId ? -1 : 1) : a.date < b.date ? -1 : 1));
}

/** The next [count] due dates starting at nextDueDate (empty unless active). */
export function nextRenewals(s: Subscription, count: number): IsoDate[] {
  if (!isActive(s)) return [];
  const out: IsoDate[] = [];
  let date = s.nextDueDate;
  const anchor = anchorDay(s);
  for (let i = 0; i < count; i++) {
    out.push(date);
    date = nextOccurrence(s.frequency, date, anchor);
  }
  return out;
}
