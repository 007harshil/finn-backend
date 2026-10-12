// Read side of subscriptions: views with computed fields, totals, projections.

import { z } from 'zod';
import { addDays, daysBetween, type IsoDate } from '../../core/dates';
import type { Paise } from '../../core/money';
import type { Subscription, Transaction } from '../../finance/models';
import type { FinanceSnapshot } from '../../finance/snapshot';
import {
  annualCommitment,
  dueState,
  monthlyCommitment,
  nextRenewals,
  projectCharges,
  subscriptionAnnual,
  subscriptionMonthly,
  type DueState,
} from './calculator';

export { projectCharges } from './calculator';
export type { ProjectedCharge } from './calculator';

export interface SubscriptionView extends Subscription {
  monthlyEquivalentPaise: Paise;
  annualPaise: Paise;
  dueState: DueState;
  daysUntilDue: number;
}

/** Subscription screens use a fixed 7-day "due soon" window; alerts use preferences.subscriptionReminderDays. */
export const SCREEN_SOON_DAYS = 7;

export function toView(s: Subscription, today: IsoDate, soonDays: number): SubscriptionView {
  const daysUntilDue = daysBetween(today, s.nextDueDate);
  return {
    ...s,
    monthlyEquivalentPaise: subscriptionMonthly(s),
    annualPaise: subscriptionAnnual(s),
    dueState: dueState(s, today, soonDays),
    daysUntilDue,
  };
}

/** Every subscription with monthly equivalent, due state (reminder window) and days until due. */
export async function loadSubscriptionViews(snapshot: FinanceSnapshot): Promise<SubscriptionView[]> {
  const subs = await snapshot.subscriptions();
  return subs.map((s) => toView(s, snapshot.today, SCREEN_SOON_DAYS));
}

export async function listSubscriptions(snapshot: FinanceSnapshot) {
  const subs = await snapshot.subscriptions();
  const items = await loadSubscriptionViews(snapshot);
  const counts = { active: 0, paused: 0, cancelled: 0 };
  for (const s of subs) counts[s.status]++;
  return {
    items,
    totals: { monthlyCommitmentPaise: monthlyCommitment(subs), annualPaise: annualCommitment(subs), counts },
  };
}

export async function subscriptionDetail(snapshot: FinanceSnapshot, id: string) {
  const subs = await snapshot.subscriptions();
  const s = subs.find((x) => x.id === id);
  if (!s) return null;
  const linked: Transaction[] = (await snapshot.linkedTransactions(id))
    .filter((t) => t.origin === 'subscription')
    .sort((a, b) => (a.date === b.date ? (a.createdAt < b.createdAt ? 1 : -1) : a.date < b.date ? 1 : -1));
  return {
    subscription: toView(s, snapshot.today, SCREEN_SOON_DAYS),
    payments: linked,
    nextRenewals: nextRenewals(s, 6).map((date) => ({ date, amountPaise: s.amountPaise })),
  };
}

export const upcomingQuery = z.object({ days: z.coerce.number().int().min(1).max(366).default(30) });

export async function upcomingRenewals(snapshot: FinanceSnapshot, days: number) {
  const subs = await snapshot.subscriptions();
  const today = snapshot.today;
  const to = addDays(today, days);
  const byId = new Map(subs.map((s) => [s.id, s]));
  const items = projectCharges(subs, today, to).map((c) => {
    const s = byId.get(c.subscriptionId)!;
    return { ...c, name: s.name, frequency: s.frequency, daysUntil: daysBetween(today, c.date) };
  });
  const overdue = subs
    .filter((s) => s.status === 'active' && s.nextDueDate < today)
    .map((s) => ({ date: s.nextDueDate, amountPaise: s.amountPaise, subscriptionId: s.id, categoryId: s.categoryId, name: s.name, frequency: s.frequency, daysUntil: daysBetween(today, s.nextDueDate) }));
  return {
    from: today,
    to,
    items,
    overdue,
    totalPaise: items.reduce((n, i) => n + i.amountPaise, 0),
  };
}
