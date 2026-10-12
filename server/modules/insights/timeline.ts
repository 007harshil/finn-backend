// Financial story (lib/features/timeline/domain/timeline.dart): monthly
// chapters of meaningful events built from transactions, loan payments,
// savings movements and settlements. Paginated by month (keyset on the month
// key, newest first); each chapter reads one month of transactions plus a
// 3-month aggregate baseline, never the whole history.

import { z } from 'zod';
import { DateRange, MonthKey, makeDate, parts, type IsoDate } from '../../core/dates';
import { scale, type Paise } from '../../core/money';
import type { FinanceSnapshot } from '../../finance/snapshot';
import { fmtWhole } from '../alerts/format';
import { categoryMap, currentMonthOf } from './memo';
import { manualExpenseBaseline, transactionMonths } from './queries';

export const TIMELINE_KINDS = {
  income: 'Income received',
  majorExpense: 'Major expense',
  loanPayment: 'Loan payment',
  goalContribution: 'Goal contribution',
  goalWithdrawal: 'Goal withdrawal',
  emergencyContribution: 'Emergency fund',
  settlement: 'Payment settled',
  subscriptionPaid: 'Subscription paid',
} as const;
export type TimelineEventKind = keyof typeof TIMELINE_KINDS;

export type StoryTheme =
  | 'celebration'
  | 'success'
  | 'warning'
  | 'fun'
  | 'adventurous'
  | 'growth'
  | 'neutral'
  | 'vision'
  | 'victory'
  | 'asset'
  | 'freedom';

export interface TimelineEvent {
  id: string;
  kind: TimelineEventKind;
  kindLabel: string;
  date: IsoDate;
  title: string;
  description: string;
  emoji: string;
  theme: StoryTheme;
  amountPaise: Paise;
  /** Direction of the money from the user's perspective. */
  isInflow: boolean;
  /** Deep link (AppRoutes path conventions) to the underlying record. */
  route: string | null;
}

export interface StoryChapter {
  month: string;
  name: string;
  summary: string;
  theme: StoryTheme;
  /** Newest first. */
  events: TimelineEvent[];
}

const displayTitle = (t: { counterparty: string | null; note: string | null }): string | null => {
  if (t.counterparty !== null && t.counterparty.trim() !== '') return t.counterparty;
  if (t.note !== null && t.note.trim() !== '') return t.note;
  return null;
};

/** Events dated in [range] (TimelineService.eventsFor), newest first. */
export async function eventsFor(s: FinanceSnapshot, range: DateRange): Promise<TimelineEvent[]> {
  const f = fmtWhole;
  const today = s.today;
  const { year, month } = parts(range.start);
  const baseStart = makeDate(year, month - 3, 1);
  const [base, transactions, cats, payments, loans, movements, goals, settlements, pending] = await Promise.all([
    manualExpenseBaseline(s, baseStart, range.start),
    s.transactionsIn(range),
    categoryMap(s),
    s.loanPayments(),
    s.loans(),
    s.movements(),
    s.goals(),
    s.settlements(),
    s.pending(),
  ]);
  // "Major" expenses: 1.4× the average manual expense of the previous 3 months, and at least ₹5,000.
  const avg = base.count === 0 ? 100000 : scale(base.totalPaise, 1, base.count);
  const threshold = Math.max(scale(avg, 14, 10), 500000);
  const out: TimelineEvent[] = [];
  const ev = (e: Omit<TimelineEvent, 'kindLabel'>) => out.push({ ...e, kindLabel: TIMELINE_KINDS[e.kind] });

  // Newest first, like the Flutter snapshot's transaction list.
  for (const t of transactions) {
    if (t.date > today) continue;
    const cat = cats.get(t.categoryId)?.name ?? 'General';
    const title = displayTitle(t);
    if (t.origin === 'manual' && t.type === 'income') {
      const salary = cat.toLowerCase().includes('salary');
      ev({
        id: `tl_${t.id}`,
        kind: 'income',
        date: t.date,
        title: salary ? 'Hard work paid off' : 'Money came in',
        description: `${title ?? cat} · ${cat}`,
        emoji: salary ? '💰' : '💵',
        theme: 'success',
        amountPaise: t.amountPaise,
        isInflow: true,
        route: `/transactions/${t.id}`,
      });
    } else if (t.origin === 'manual' && t.type === 'expense' && t.amountPaise >= threshold) {
      const lc = cat.toLowerCase();
      const [emoji, theme, heading]: [string, StoryTheme, string] = lc.includes('travel')
        ? ['✈️', 'adventurous', 'Expanding horizons']
        : lc.includes('shopping')
          ? ['🛍️', 'fun', 'Personal upgrade']
          : lc.includes('food')
            ? ['🍔', 'fun', 'Fuelling up']
            : ['💳', 'neutral', `Notable ${cat}`];
      ev({
        id: `tl_${t.id}`,
        kind: 'majorExpense',
        date: t.date,
        title: heading,
        description: `${title ?? cat} — a larger-than-usual ${cat} spend.`,
        emoji,
        theme,
        amountPaise: t.amountPaise,
        isInflow: false,
        route: `/transactions/${t.id}`,
      });
    } else if (t.origin === 'subscription' && t.amountPaise >= 100000) {
      ev({
        id: `tl_${t.id}`,
        kind: 'subscriptionPaid',
        date: t.date,
        title: `${t.counterparty ?? 'Subscription'} renewed`,
        description: 'Recurring charge recorded.',
        emoji: '🔁',
        theme: 'neutral',
        amountPaise: t.amountPaise,
        isInflow: false,
        route: t.originRefId === null ? null : `/more/subscriptions/${t.originRefId}`,
      });
    }
  }

  const loanById = new Map(loans.map((l) => [l.id, l]));
  for (const p of payments) {
    if (!range.contains(p.date)) continue;
    const loan = loanById.get(p.loanId);
    if (!loan) continue;
    const borrowed = loan.direction === 'borrowed';
    const big = p.kind === 'principal';
    ev({
      id: `tl_${p.id}`,
      kind: 'loanPayment',
      date: p.date,
      title: borrowed ? (big ? `Power move on ${loan.name}` : `${loan.name} instalment`) : `${loan.counterparty} repaid you`,
      description: big ? `Principal reduced by ${f(p.principalPaise)}.` : `${f(p.interestPaise)} interest · ${f(p.principalPaise)} principal.`,
      emoji: big ? '💥' : '🏦',
      theme: big ? 'growth' : 'neutral',
      amountPaise: p.interestPaise + p.principalPaise,
      isInflow: !borrowed,
      route: `/more/loans/${loan.id}`,
    });
  }

  const goalById = new Map(goals.map((g) => [g.id, g]));
  for (const m of movements) {
    if (!range.contains(m.date)) continue;
    const isGoal = m.bucketType === 'goal';
    const goalName = (isGoal ? goalById.get(m.bucketId)?.name : undefined) ?? 'a goal';
    const contribution = m.kind === 'contribution';
    ev({
      id: `tl_${m.id}`,
      kind: isGoal ? (contribution ? 'goalContribution' : 'goalWithdrawal') : 'emergencyContribution',
      date: m.date,
      title: isGoal
        ? contribution
          ? `Closer to ${goalName}`
          : `Released from ${goalName}`
        : contribution
          ? 'Safety net strengthened'
          : 'Emergency fund used',
      description: m.note ?? (contribution ? 'Earmarked for later. Still your money.' : 'Moved back to available cash.'),
      emoji: isGoal ? (contribution ? '🔭' : '↩️') : '🛡️',
      theme: contribution ? (isGoal ? 'vision' : 'asset') : 'neutral',
      amountPaise: m.amountPaise,
      isInflow: !contribution,
      route: isGoal ? `/goals/${m.bucketId}` : '/goals/emergency-fund',
    });
  }

  const pendingById = new Map(pending.map((p) => [p.id, p]));
  for (const st of settlements) {
    if (!range.contains(st.date)) continue;
    const p = pendingById.get(st.pendingId);
    if (!p) continue;
    const owe = p.direction === 'iOwe';
    ev({
      id: `tl_${st.id}`,
      kind: 'settlement',
      date: st.date,
      title: owe ? `Squared away with ${p.counterparty}` : `${p.counterparty} paid you back`,
      description: p.purpose,
      emoji: '🤝',
      theme: 'growth',
      amountPaise: st.amountPaise,
      isInflow: !owe,
      route: `/more/pending/${p.id}`,
    });
  }

  // Stable: newest date first, insertion order within a day.
  return out.sort((a, b) => (a.date === b.date ? 0 : a.date < b.date ? 1 : -1));
}

/** The month's chapter (TimelineService.chapter). */
export async function chapter(s: FinanceSnapshot, month: MonthKey): Promise<StoryChapter> {
  const events = await eventsFor(s, month.range);
  const count = (k: TimelineEventKind) => events.filter((e) => e.kind === k).length;
  const loans = count('loanPayment');
  const goals = count('goalContribution');
  const incomes = count('income');
  const expenses = count('majorExpense');
  const [name, summary, theme]: [string, string, StoryTheme] =
    loans > 2
      ? ['The Debt Slayer', 'Steady action against liabilities.', 'adventurous']
      : goals > 1
        ? ['The Visionary Path', 'Your future self is thanking you for these choices.', 'vision']
        : incomes > expenses
          ? ['The Wealth Spring', 'More flowed in than flowed out.', 'success']
          : expenses > incomes * 1.5
            ? ['The Big Spend', 'Major purchases and lifestyle shifts happened.', 'fun']
            : ['The Steady Stream', 'A balanced chapter in your financial story.', 'neutral'];
  return { month: month.id, name, summary, theme, events };
}

/** Months with transactions plus the current month, newest first (TimelineService.availableMonths). */
export async function availableMonths(s: FinanceSnapshot): Promise<string[]> {
  const current = currentMonthOf(s);
  const months = new Set(await transactionMonths(s, current));
  months.add(current.id);
  return [...months].sort((a, b) => (a < b ? 1 : a > b ? -1 : 0));
}

export const MAX_TIMELINE_PAGE = 6;

export const timelineQuery = z.object({
  /** One chapter for this month. */
  month: z
    .string()
    .regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'Expected a month formatted yyyy-MM')
    .optional(),
  /** Keyset cursor: chapters strictly older than this month. */
  cursor: z
    .string()
    .regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'Expected a month formatted yyyy-MM')
    .optional(),
  limit: z.coerce.number().int().min(1).max(MAX_TIMELINE_PAGE).default(3),
});

/** GET /timeline: chapters newest first, `limit` per page, `nextCursor` while older months remain. */
export async function timelinePage(s: FinanceSnapshot, q: z.output<typeof timelineQuery>) {
  const months = await availableMonths(s);
  if (q.month) {
    const m = MonthKey.tryParse(q.month)!;
    return { months, chapters: [await chapter(s, m)], nextCursor: null };
  }
  const remaining = q.cursor ? months.filter((m) => m < q.cursor!) : months;
  const page = remaining.slice(0, q.limit);
  const chapters: StoryChapter[] = [];
  for (const m of page) chapters.push(await chapter(s, MonthKey.tryParse(m)!));
  return {
    months,
    chapters,
    nextCursor: remaining.length > page.length ? page[page.length - 1]! : null,
  };
}
