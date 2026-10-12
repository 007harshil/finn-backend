// Insights screen read model: port of lib/features/analytics/domain/analytics.dart
// (AnalyticsService) and application/analytics_providers.dart (buildInsightsData).
// Cash-flow figures come from SQL aggregates (snapshot.summary, monthly and
// daily grouped queries); small collections (movements, loans, payments,
// subscriptions) come from the snapshot.

import { z } from 'zod';
import {
  DateRange,
  MonthKey,
  addDays,
  daysBetween,
  endOfMonth,
  formatDate,
  formatMonthYear,
  isIsoDate,
  maxDate,
  minDate,
  parts,
  toDayNumber,
  type IsoDate,
} from '../../core/dates';
import { ratioBps, roundDiv, scale, type Paise } from '../../core/money';
import type { PeriodSummary } from '../../finance/ledger';
import { PAYMENT_METHOD_LABELS, signedMovement, type Category, type Transaction } from '../../finance/models';
import type { FinanceSnapshot } from '../../finance/snapshot';
import type { PaymentMethod } from '../../actions/input';
import { fmtWhole, formatBps, MONTH_NAMES } from '../alerts/format';
import type { BudgetUsage } from '../budgets/calculator';
import { currentBudgetPeriod, usageDto } from '../budgets/service';
import { goalProgressDto } from '../goals/service';
import { outstandingOn } from '../loans/calculator';
import { loanSummary } from '../loans/service';
import { annualCommitment, monthlyCommitment, subscriptionMonthly } from '../subscriptions/calculator';
import { SCREEN_SOON_DAYS, toView } from '../subscriptions/service';
import { budgetUsagesOf, categoryMap, currentMonthOf, goalProgressOf, loanStatesOf } from './memo';
import { dailyExpenses, monthlyFlows, topExpenses, type MonthFlow } from './queries';

const f = fmtWhole;

// ---------------------------------------------------------------------------
// DTOs
// ---------------------------------------------------------------------------

export interface SummaryDto {
  range: { start: IsoDate; end: IsoDate };
  incomePaise: Paise;
  expensePaise: Paise;
  netPaise: Paise;
  savingsRateBps: number | null;
  transactionCount: number;
}

export const summaryDto = (p: PeriodSummary): SummaryDto => ({
  range: p.range,
  incomePaise: p.incomePaise,
  expensePaise: p.expensePaise,
  netPaise: p.netPaise,
  savingsRateBps: p.savingsRateBps,
  transactionCount: p.transactionCount,
});

const changeBps = (current: Paise, previous: Paise): number | null => (previous === 0 ? null : ratioBps(current - previous, previous));

// ---------------------------------------------------------------------------
// AnalyticsService
// ---------------------------------------------------------------------------

export interface CategorySlice {
  categoryId: string;
  name: string;
  iconKey: string | null;
  colorIndex: number | null;
  amountPaise: Paise;
  shareBps: number;
  /** Same category in the comparison period (null when not compared). */
  previousPaise: Paise | null;
  /** Change vs previous; null when previous is zero/unknown. */
  changeBps: number | null;
}

/** Expense per category in [range], largest first, compared with [compareTo] when given. */
export async function categoryBreakdown(s: FinanceSnapshot, range: DateRange, compareTo?: DateRange | null): Promise<CategorySlice[]> {
  const [current, prev, cats] = await Promise.all([s.summary(range), compareTo ? s.summary(compareTo) : Promise.resolve(null), categoryMap(s)]);
  const prevMap = new Map((prev?.byCategory ?? []).map((e) => [e.categoryId, e.amountPaise]));
  return current.byCategory.map((e) => {
    const c: Category | undefined = cats.get(e.categoryId);
    const previous = prev === null ? null : (prevMap.get(e.categoryId) ?? 0);
    return {
      categoryId: e.categoryId,
      name: c?.name ?? 'Uncategorised',
      iconKey: c?.iconKey ?? null,
      colorIndex: c?.colorIndex ?? null,
      amountPaise: e.amountPaise,
      shareBps: ratioBps(e.amountPaise, current.expensePaise) ?? 0,
      previousPaise: previous,
      changeBps: previous === null ? null : changeBps(e.amountPaise, previous),
    };
  });
}

export interface PeriodComparison {
  current: PeriodSummary;
  previous: PeriodSummary;
  incomeChangeBps: number | null;
  expenseChangeBps: number | null;
}

/** The range [range] is compared with: whole calendar months vs the previous calendar month, other ranges vs the equal-length range before. */
export function previousRangeOf(range: DateRange): DateRange {
  const isMonth = parts(range.start).day === 1 && range.end === endOfMonth(range.start);
  return isMonth ? MonthKey.of(range.start).previous.range : range.previous;
}

export async function compare(s: FinanceSnapshot, range: DateRange): Promise<PeriodComparison> {
  const [current, previous] = await Promise.all([s.summary(range), s.summary(previousRangeOf(range))]);
  return {
    current,
    previous,
    incomeChangeBps: changeBps(current.incomePaise, previous.incomePaise),
    expenseChangeBps: changeBps(current.expensePaise, previous.expensePaise),
  };
}

/** Average spend per elapsed day in [range] (up to today). */
export async function dailyBurn(s: FinanceSnapshot, range: DateRange): Promise<Paise> {
  const end = minDate(range.end, s.today);
  if (end < range.start) return 0;
  const days = daysBetween(range.start, end) + 1;
  return scale((await s.summary(range)).expensePaise, 1, days);
}

/** Share of spending in non-essential, non-system categories (bps); null without spending. */
export async function discretionaryShareBps(s: FinanceSnapshot, range: DateRange): Promise<number | null> {
  const [sum, cats] = await Promise.all([s.summary(range), categoryMap(s)]);
  if (sum.expensePaise === 0) return null;
  let discretionary = 0;
  for (const e of sum.byCategory) {
    const c = cats.get(e.categoryId);
    if (c && !c.isEssential && !c.isSystem) discretionary += e.amountPaise;
  }
  return ratioBps(discretionary, sum.expensePaise);
}

export interface TrendPoint {
  month: string;
  valuePaise: Paise;
}

const windowMonths = (last: MonthKey, count: number): MonthKey[] => Array.from({ length: count }, (_, i) => last.shift(-(count - 1 - i)));

/** Total earmarked savings (goals + emergency fund) at each month end. */
export async function savingsTrend(s: FinanceSnapshot, last: MonthKey, count: number): Promise<TrendPoint[]> {
  const movements = await s.movements();
  return windowMonths(last, count).map((m) => ({
    month: m.id,
    valuePaise: movements.filter((x) => x.date <= m.end).reduce((n, x) => n + signedMovement(x), 0),
  }));
}

/** Outstanding borrowed principal at each month end (today for a month still running). */
export async function debtTrend(s: FinanceSnapshot, last: MonthKey, count: number): Promise<TrendPoint[]> {
  const [loans, payments] = await Promise.all([s.loans(), s.loanPayments()]);
  const borrowed = loans.filter((l) => l.direction === 'borrowed');
  return windowMonths(last, count).map((m) => {
    const d = m.end > s.today ? s.today : m.end;
    return { month: m.id, valuePaise: borrowed.reduce((n, l) => n + outstandingOn(l, payments, d), 0) };
  });
}

export type InsightTone = 'positive' | 'neutral' | 'caution';
export interface Insight {
  title: string;
  body: string;
  tone: InsightTone;
}

/** Plain-language observations for a month. Non-judgemental by design. */
export async function insights(s: FinanceSnapshot, month: MonthKey): Promise<Insight[]> {
  const out: Insight[] = [];
  const [cmp, slices, subs] = await Promise.all([compare(s, month.range), categoryBreakdown(s, month.range, month.previous.range), s.subscriptions()]);
  const cur = cmp.current;
  const rate = cur.savingsRateBps;
  if (rate !== null) {
    out.push(
      rate >= 2000
        ? { title: `You kept ${formatBps(rate, 0)} of your income`, body: `${f(cur.netPaise)} more came in than went out. A healthy cushion.`, tone: 'positive' }
        : rate >= 0
          ? { title: `Savings rate is ${formatBps(rate, 0)}`, body: `Income covered spending with ${f(cur.netPaise)} to spare.`, tone: 'neutral' }
          : { title: 'Spending exceeded income', body: `Outflows were ${f(Math.abs(cur.netPaise))} more than income for this period.`, tone: 'caution' },
    );
  }
  const rising = slices.find((x) => (x.changeBps ?? 0) >= 2000 && x.amountPaise >= 100000);
  if (rising) {
    out.push({
      title: `${rising.name} is up ${formatBps(rising.changeBps!, 0)}`,
      body: `${f(rising.amountPaise)} vs ${f(rising.previousPaise!)} last month.`,
      tone: 'caution',
    });
  }
  const falling = slices.find((x) => (x.changeBps ?? 0) <= -2000 && x.previousPaise! >= 100000);
  if (falling) {
    out.push({
      title: `${falling.name} is down ${formatBps(Math.abs(falling.changeBps!), 0)}`,
      body: `You spent ${f(falling.previousPaise! - falling.amountPaise)} less than last month.`,
      tone: 'positive',
    });
  }
  if (slices.length > 0) {
    const top = slices[0]!;
    out.push({ title: `Top category: ${top.name}`, body: `${formatBps(top.shareBps, 0)} of spending (${f(top.amountPaise)}).`, tone: 'neutral' });
  }
  const monthly = monthlyCommitment(subs);
  if (monthly > 0 && cur.incomePaise > 0) {
    const share = ratioBps(monthly, cur.incomePaise)!;
    out.push({
      title: `Subscriptions take ${formatBps(share)} of income`,
      body: `${f(monthly)} a month in recurring commitments.`,
      tone: share > 1000 ? 'caution' : 'neutral',
    });
  }
  return out;
}

/** A short human summary of the month (AnalyticsService.monthlyNarrative). */
export async function monthlyNarrative(s: FinanceSnapshot, month: MonthKey): Promise<string[]> {
  const [cmp, cats, movements, payments] = await Promise.all([compare(s, month.range), categoryMap(s), s.movements(), s.loanPayments()]);
  const cur = cmp.current;
  if (cur.transactionCount === 0) return [`No transactions recorded for ${formatMonthYear(month)} yet.`];
  const lines: string[] = [];
  const change = cmp.expenseChangeBps;
  const isCurrent = month.equals(currentMonthOf(s));
  const spentPhrase = isCurrent ? 'So far this month you have spent' : 'You spent';
  lines.push(
    change === null
      ? `${spentPhrase} ${f(cur.expensePaise)} and received ${f(cur.incomePaise)}.`
      : `${spentPhrase} ${f(cur.expensePaise)} — ${formatBps(Math.abs(change), 0)} ${change >= 0 ? 'more' : 'less'} than ${isCurrent ? 'all of' : ''} last month.`
          .split('  ')
          .join(' '),
  );
  const top = cur.byCategory[0];
  if (top) lines.push(`${cats.get(top.categoryId)?.name ?? 'One category'} was your largest spend at ${f(top.amountPaise)}.`);
  const saved = movements.filter((m) => month.contains(m.date)).reduce((n, m) => n + signedMovement(m), 0);
  if (saved > 0) lines.push(`You moved ${f(saved)} into goals and your emergency fund.`);
  const repaid = payments.filter((p) => month.contains(p.date)).reduce((n, p) => n + p.principalPaise, 0);
  if (repaid > 0) lines.push(`Loan principal went down by ${f(repaid)}.`);
  return lines;
}

// ---------------------------------------------------------------------------
// Insights screen (buildInsightsData)
// ---------------------------------------------------------------------------

export const INSIGHTS_PERIODS = {
  month: { label: 'This month', months: 1 },
  quarter: { label: '3 months', months: 3 },
  half: { label: '6 months', months: 6 },
  year: { label: '12 months', months: 12 },
} as const;
export type InsightsPeriod = keyof typeof INSIGHTS_PERIODS;

/** How far back the month switcher goes. */
export const INSIGHTS_HISTORY_MONTHS = 24;
/** Longest custom range (from/to). */
export const MAX_CUSTOM_RANGE_DAYS = 366;
const TOP_EXPENSES = 5;

export const analyticsQuery = z
  .object({
    period: z.enum(['month', 'quarter', 'half', 'year']).default('month'),
    month: z
      .string()
      .regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'Expected a month formatted yyyy-MM')
      .optional(),
    from: z.string().refine(isIsoDate, 'Expected a date formatted yyyy-MM-dd').optional(),
    to: z.string().refine(isIsoDate, 'Expected a date formatted yyyy-MM-dd').optional(),
  })
  .superRefine((q, ctx) => {
    if ((q.from === undefined) !== (q.to === undefined)) {
      ctx.addIssue({ code: 'custom', path: [q.from === undefined ? 'from' : 'to'], message: 'Give both from and to.' });
    } else if (q.from !== undefined && q.to !== undefined) {
      if (q.to < q.from) ctx.addIssue({ code: 'custom', path: ['to'], message: 'The end date must be on or after the start date.' });
      else if (daysBetween(q.from, q.to) + 1 > MAX_CUSTOM_RANGE_DAYS) {
        ctx.addIssue({ code: 'custom', path: ['to'], message: `Choose a range of at most ${MAX_CUSTOM_RANGE_DAYS} days.` });
      }
    }
  });
export type AnalyticsQuery = z.output<typeof analyticsQuery>;

interface Resolved {
  period: InsightsPeriod | 'custom';
  month: MonthKey;
  anchor: MonthKey;
  range: DateRange;
  previousRange: DateRange;
  isPartial: boolean;
  periodLabel: string;
  previousLabel: string;
  windowFirst: MonthKey;
  windowCount: number;
  /** Days listed in dailySpend (the selected month, or the custom range). */
  dailyDays: DateRange | null;
}

const shortMonth = (m: MonthKey) => MONTH_NAMES[m.month - 1]!.slice(0, 3);

function resolve(s: FinanceSnapshot, q: AnalyticsQuery): Resolved {
  const today = s.today;
  const current = currentMonthOf(s);
  if (q.from !== undefined && q.to !== undefined) {
    const range = new DateRange(q.from, q.to);
    const previousRange = previousRangeOf(range);
    const anchor = MonthKey.of(range.end);
    const first = MonthKey.of(range.start);
    const isMonth = parts(range.start).day === 1 && range.end === endOfMonth(range.start);
    return {
      period: 'custom',
      month: anchor,
      anchor,
      range,
      previousRange,
      isPartial: range.end >= today,
      periodLabel: `${formatDate(range.start)} – ${formatDate(range.end)}`,
      previousLabel: isMonth ? MONTH_NAMES[parts(previousRange.start).month - 1]! : `the previous ${range.dayCount} days`,
      windowFirst: first,
      windowCount: anchor.compareTo(first) + 1,
      dailyDays: range,
    };
  }
  const n = INSIGHTS_PERIODS[q.period].months;
  let month = current;
  if (q.period === 'month') {
    const requested = MonthKey.tryParse(q.month) ?? current;
    const min = current.shift(-(INSIGHTS_HISTORY_MONTHS - 1));
    month = requested.compareTo(current) > 0 ? current : requested.compareTo(min) < 0 ? min : requested;
  }
  const anchor = q.period === 'month' ? month : current;
  const firstMonth = anchor.shift(-(n - 1));
  const fullEnd = anchor.end;
  const isPartial = !(fullEnd < today);
  const range = new DateRange(firstMonth.start, isPartial ? maxDate(today, firstMonth.start) : fullEnd);
  const prevFirst = firstMonth.shift(-n);
  const previousRange = new DateRange(prevFirst.start, addDays(firstMonth.start, -1));
  let periodLabel: string;
  let previousLabel: string;
  if (n === 1) {
    periodLabel = anchor.equals(current) ? 'this month' : `${MONTH_NAMES[anchor.month - 1]} ${anchor.year}`;
    previousLabel = isPartial ? `all of ${MONTH_NAMES[prevFirst.month - 1]}` : MONTH_NAMES[prevFirst.month - 1]!;
  } else {
    const sameYear = firstMonth.year === anchor.year;
    periodLabel = `${shortMonth(firstMonth)}${sameYear ? '' : ` ${firstMonth.year}`} – ${shortMonth(anchor)} ${anchor.year}`;
    previousLabel = `the previous ${n} months`;
  }
  const windowCount = n === 1 ? 6 : n;
  return {
    period: q.period,
    month: anchor,
    anchor,
    range,
    previousRange,
    isPartial,
    periodLabel,
    previousLabel,
    windowFirst: anchor.shift(-(windowCount - 1)),
    windowCount,
    dailyDays: n === 1 ? anchor.range : null,
  };
}

export interface DaySpend {
  date: IsoDate;
  amountPaise: Paise;
  /** Day after today: nothing could have been spent yet. */
  isFuture: boolean;
}

/** Monday = 0 (Dart DateTime.weekday - 1). */
const weekdayIndex = (d: IsoDate) => (((toDayNumber(d) + 3) % 7) + 7) % 7; // 1970-01-01 was a Thursday (index 3)

async function spendPatterns(s: FinanceSnapshot, range: DateRange, dailyDays: DateRange | null) {
  const today = s.today;
  const last = minDate(range.end, today);
  // Expenses dated after today are left out (they could not have been spent yet).
  const counted = last >= range.start ? new DateRange(range.start, last) : null;
  const [perDay, top] = await Promise.all([
    counted ? dailyExpenses(s, counted) : Promise.resolve(new Map<IsoDate, Paise>()),
    counted ? topExpenses(s, counted, TOP_EXPENSES) : Promise.resolve([] as Transaction[]),
  ]);
  const daily: DaySpend[] = [];
  if (dailyDays) {
    for (let d = dailyDays.start; d <= dailyDays.end; d = addDays(d, 1)) {
      daily.push({ date: d, amountPaise: perDay.get(d) ?? 0, isFuture: d > today });
    }
  }
  const sums = new Array<number>(7).fill(0);
  const counts = new Array<number>(7).fill(0);
  if (counted) {
    for (let d = counted.start; d <= counted.end; d = addDays(d, 1)) {
      const w = weekdayIndex(d);
      counts[w]!++;
      sums[w]! += perDay.get(d) ?? 0;
    }
  }
  const weekday = sums.map((sum, i) => (counts[i] === 0 ? 0 : scale(sum, 1, counts[i]!)));
  return { daily, weekday, top };
}

const avg = (xs: Paise[]): Paise => (xs.length === 0 ? 0 : scale(xs.reduce((n, x) => n + x, 0), 1, xs.length));
const bpsRound = (part: number, whole: number) => roundDiv(part * 10000, whole, 'halfUp');

/** GET /analytics: everything the Insights screen shows for a period. */
export async function analytics(s: FinanceSnapshot, q: AnalyticsQuery) {
  const r = resolve(s, q);
  const today = s.today;
  const [current, previous, burn, months, categories, spend, budgets, savings, debt, subs, goals, loanStates, list, narrative] = await Promise.all([
    s.summary(r.range),
    s.summary(r.previousRange),
    dailyBurn(s, r.range),
    monthlyFlows(s, r.windowFirst, r.anchor),
    categoryBreakdown(s, r.range, r.previousRange),
    spendPatterns(s, r.range, r.dailyDays),
    budgetUsagesOf(s),
    savingsTrend(s, r.anchor, r.windowCount),
    debtTrend(s, r.anchor, r.windowCount),
    s.subscriptions(),
    goalProgressOf(s),
    loanStatesOf(s),
    insights(s, r.anchor),
    monthlyNarrative(s, r.anchor),
  ]);

  // ---- derived figures (InsightsData getters) ----
  const hasActivity = current.transactionCount > 0;
  const expenseChangeBps = changeBps(current.expensePaise, previous.expensePaise);
  const rate = current.savingsRateBps;
  const savingsRateBps = rate === null ? null : Math.min(Math.max(rate, -10000), 10000);
  const active = months.filter((m) => m.incomePaise > 0 || m.expensePaise > 0);
  const windowNet = months.reduce((n, m) => n + m.netPaise, 0);

  let peakDay: DaySpend | null = null;
  for (const d of spend.daily) if (d.amountPaise > 0 && (peakDay === null || d.amountPaise > peakDay.amountPaise)) peakDay = d;
  const elapsedDays = spend.daily.filter((d) => !d.isFuture).length;
  const noSpendDays = spend.daily.filter((d) => !d.isFuture && d.amountPaise === 0).length;
  const projectedMonthSpend = r.period === 'month' && r.isPartial && spend.daily.length > 0 ? burn * spend.daily.length : null;
  let busiest = -1;
  spend.weekday.forEach((v, i) => {
    if (v > 0 && (busiest < 0 || v > spend.weekday[busiest]!)) busiest = i;
  });
  let quietest: number | null = null;
  if (busiest >= 0) {
    quietest = 0;
    for (let i = 1; i < spend.weekday.length; i++) if (spend.weekday[i]! < spend.weekday[quietest]!) quietest = i;
  }
  const methods = current.byMethod.map((m) => ({
    method: m.method,
    label: PAYMENT_METHOD_LABELS[m.method as PaymentMethod] ?? m.method,
    amountPaise: m.amountPaise,
    shareBps: ratioBps(m.amountPaise, current.expensePaise) ?? 0,
  }));
  const cash = methods.filter((m) => m.method === 'cash').reduce((n, m) => n + m.amountPaise, 0);
  const digitalShareBps = current.expensePaise === 0 ? null : ratioBps(current.expensePaise - cash, current.expensePaise);

  // Budgets (current budget period).
  const budgetPeriod = currentBudgetPeriod(s);
  const activeBudgets = budgets.filter((b) => b.health !== 'paused');
  const budgetLimitTotal = activeBudgets.reduce((n, b) => n + b.budget.limitPaise, 0);
  const budgetSpentTotal = activeBudgets.reduce((n, b) => n + b.spentPaise, 0);
  const doneEnd = minDate(today, budgetPeriod.end);
  const done = doneEnd < budgetPeriod.start ? 0 : daysBetween(budgetPeriod.start, doneEnd) + 1;
  const budgetElapsedBps = Math.min(Math.max(bpsRound(done, budgetPeriod.dayCount), 0), 10000);
  const budgetDaysLeft = today > budgetPeriod.end ? 0 : daysBetween(maxDate(today, budgetPeriod.start), budgetPeriod.end) + 1;
  const left = budgetLimitTotal - budgetSpentTotal;
  const budgetSafeDaily = budgetLimitTotal === 0 || budgetDaysLeft === 0 ? null : left < 0 ? 0 : scale(left, 1, budgetDaysLeft);
  const budgetsOver = budgets.filter((b) => b.health === 'breached').length;

  // Savings and debt.
  const savingsChange = savings.length === 0 ? 0 : savings[savings.length - 1]!.valuePaise - savings[0]!.valuePaise;
  const avgMonthlySavingsChange = savings.length < 2 ? 0 : scale(savingsChange, 1, savings.length - 1);
  const debtRepaid = debt.length === 0 ? 0 : debt[0]!.valuePaise - debt[debt.length - 1]!.valuePaise;
  const avgMonthlyDebtRepaid = debt.length < 2 ? 0 : scale(debtRepaid, 1, debt.length - 1);
  const lastDebt = debt.length === 0 ? 0 : debt[debt.length - 1]!.valuePaise;
  const monthsToDebtFree = debt.length === 0 || avgMonthlyDebtRepaid <= 0 || lastDebt === 0 ? null : Math.ceil(lastDebt / avgMonthlyDebtRepaid);

  // Subscriptions.
  const activeSubs = subs.filter((x) => x.status === 'active').sort((a, b) => subscriptionMonthly(b) - subscriptionMonthly(a));
  const subscriptionsMonthly = monthlyCommitment(subs);

  return {
    period: r.period,
    periodInfo: r.period === 'custom' ? { label: 'Custom', months: r.windowCount } : INSIGHTS_PERIODS[r.period],
    month: r.month.id,
    currentMonth: currentMonthOf(s).id,
    minMonth: currentMonthOf(s).shift(-(INSIGHTS_HISTORY_MONTHS - 1)).id,
    today,
    range: { start: r.range.start, end: r.range.end },
    previousRange: { start: r.previousRange.start, end: r.previousRange.end },
    isPartial: r.isPartial,
    periodLabel: r.periodLabel,
    previousLabel: r.previousLabel,
    hasActivity,
    current: summaryDto(current),
    previous: summaryDto(previous),
    comparison: { incomeChangeBps: changeBps(current.incomePaise, previous.incomePaise), expenseChangeBps },
    savingsRateBps,
    dailyBurnPaise: burn,
    months,
    categories,
    methods,
    dailySpend: spend.daily,
    weekdayAverages: spend.weekday,
    topExpenses: spend.top,
    budgets: {
      period: { start: budgetPeriod.start, end: budgetPeriod.end },
      items: budgets.map(budgetItem),
      limitTotalPaise: budgetLimitTotal,
      spentTotalPaise: budgetSpentTotal,
      elapsedBps: budgetElapsedBps,
      daysLeft: budgetDaysLeft,
      safeDailyPaise: budgetSafeDaily,
      over: budgetsOver,
      active: activeBudgets.length,
    },
    savings: { trend: savings, changePaise: savingsChange, avgMonthlyChangePaise: avgMonthlySavingsChange },
    debt: { trend: debt, repaidPaise: debtRepaid, avgMonthlyRepaidPaise: avgMonthlyDebtRepaid, monthsToDebtFree },
    subscriptions: {
      monthlyPaise: subscriptionsMonthly,
      annualPaise: annualCommitment(subs),
      activeCount: activeSubs.length,
      top: activeSubs.slice(0, 5).map((x) => toView(x, today, SCREEN_SOON_DAYS)),
    },
    goals: goals.map(goalProgressDto),
    loans: loanStates
      .filter((l) => l.loan.direction === 'borrowed' && !l.isClosed)
      .map((l) => ({ id: l.loan.id, name: l.loan.name, counterparty: l.loan.counterparty, ...loanSummary(l) })),
    baselines: {
      avgMonthlyIncomePaise: avg(active.map((m) => m.incomePaise)),
      avgMonthlyExpensePaise: avg(active.map((m) => m.expensePaise)),
      avgMonthlyNetPaise: avg(active.map((m) => m.netPaise)),
      windowNetPaise: windowNet,
      peakDay,
      noSpendDays,
      elapsedDays,
      projectedMonthSpendPaise: projectedMonthSpend,
      busiestWeekday: busiest < 0 ? null : busiest,
      quietestWeekday: quietest,
      digitalShareBps,
    },
    insights: list,
    narrative,
    headlines: headlines({
      hasActivity,
      expenseChangeBps,
      isPartial: r.isPartial,
      periodLabel: r.periodLabel,
      previousLabel: r.previousLabel,
      current,
      months,
      windowNet,
      categories,
      methods,
      budgets,
      savings,
      debt,
      activeSubscriptionCount: activeSubs.length,
      subscriptionsMonthly,
    }),
  };
}

function budgetItem(u: BudgetUsage) {
  // Transaction ids (up to 500 per budget) are left out: the budget detail endpoint lists them.
  const { transactionIds, ...rest } = usageDto(u);
  void transactionIds;
  return rest;
}

/** Takeaway headlines (InsightsData.*Headline), with amounts formatted like the app's default MoneyText. */
function headlines(d: {
  hasActivity: boolean;
  expenseChangeBps: number | null;
  isPartial: boolean;
  periodLabel: string;
  previousLabel: string;
  current: PeriodSummary;
  months: MonthFlow[];
  windowNet: Paise;
  categories: CategorySlice[];
  methods: { label: string; amountPaise: Paise }[];
  budgets: BudgetUsage[];
  savings: TrendPoint[];
  debt: TrendPoint[];
  activeSubscriptionCount: number;
  subscriptionsMonthly: Paise;
}) {
  const spending = (() => {
    if (!d.hasActivity) return `No spending recorded for ${d.periodLabel}`;
    const c = d.expenseChangeBps;
    if (c === null) return `You spent ${f(d.current.expensePaise)} in ${d.periodLabel}`;
    if (Math.abs(c) < 100) return `Spending is level with ${d.previousLabel}`;
    const verb = d.isPartial ? 'So far you have spent' : 'You spent';
    return `${verb} ${formatBps(Math.abs(c), 0)} ${c < 0 ? 'less' : 'more'} than ${d.previousLabel}`;
  })();
  const active = d.months.filter((m) => m.incomePaise > 0 || m.expensePaise > 0);
  const incomeVsExpense = (() => {
    if (active.length === 0) return 'No income or spending recorded yet';
    const covered = active.filter((m) => m.incomePaise >= m.expensePaise).length;
    if (covered === active.length) return active.length === 1 ? 'Income covered spending' : 'Income covered spending in every month';
    return `Income covered spending in ${covered} of ${active.length} months`;
  })();
  const net = (() => {
    if (active.length === 0) return 'No cash flow to show yet';
    const span = d.months.length === 1 ? 'this month' : `over ${d.months.length} months`;
    if (d.windowNet === 0) return `You broke even ${span}`;
    return d.windowNet > 0 ? `You kept ${f(d.windowNet)} ${span}` : `Spending exceeded income by ${f(Math.abs(d.windowNet))} ${span}`;
  })();
  const category = d.categories.length === 0 ? 'No spending by category yet' : `${d.categories[0]!.name} was your biggest spend at ${formatBps(d.categories[0]!.shareBps, 0)}`;
  const method =
    d.methods.length === 0
      ? 'No payments recorded yet'
      : `${d.methods[0]!.label} carried ${formatBps(ratioBps(d.methods[0]!.amountPaise, d.current.expensePaise) ?? 0, 0)} of your spending`;
  const budget = (() => {
    const activeCount = d.budgets.filter((b) => b.health !== 'paused').length;
    if (activeCount === 0) return d.budgets.length === 0 ? 'No budgets set yet' : 'All budgets are paused';
    const over = d.budgets.filter((b) => b.health === 'breached').length;
    if (over === 0) return activeCount === 1 ? 'Your budget is on track' : `All ${activeCount} budgets are within their limits`;
    return over === 1 ? `1 of ${activeCount} budgets is over its limit` : `${over} of ${activeCount} budgets are over their limits`;
  })();
  const trendHeadline = (points: TrendPoint[], empty: string, kind: 'savings' | 'debt') => {
    if (points.length === 0 || points.every((p) => p.valuePaise === 0)) return empty;
    const last = points[points.length - 1]!.valuePaise;
    const change = last - points[0]!.valuePaise;
    const span = `${points.length} months`;
    if (kind === 'savings') {
      if (change === 0) return `Savings held steady at ${f(last)}`;
      return change > 0 ? `Savings grew ${f(change)} in ${span}` : `Savings dipped ${f(Math.abs(change))} in ${span}`;
    }
    if (change === 0) return `Debt is unchanged at ${f(last)}`;
    return change < 0 ? `Debt is down ${f(Math.abs(change))} in ${span}` : `Debt is up ${f(change)} in ${span}`;
  };
  return {
    spending,
    incomeVsExpense,
    net,
    category,
    method,
    budget,
    savings: trendHeadline(d.savings, 'No savings earmarked yet', 'savings'),
    debt: trendHeadline(d.debt, 'No outstanding borrowed loans', 'debt'),
    subscription: d.activeSubscriptionCount === 0 ? 'No active subscriptions' : `${f(d.subscriptionsMonthly)} a month in subscriptions`,
  };
}
