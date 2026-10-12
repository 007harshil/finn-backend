// Cash, earmarked and available (lib/finance/ledger.dart) and cash-flow
// summaries, computed with SQL aggregates so a balance never requires loading
// a user's whole history.
//
//   cash      = opening balance + Σ income − Σ expense
//               (transactions dated from the opening date up to today)
//   earmarked = Σ goal movements + Σ emergency-fund movements (dated up to today)
//   available = cash − earmarked

import { sql } from 'kysely';
import { ratioBps, type Paise } from '../core/money';
import type { DateRange, IsoDate } from '../core/dates';
import type { Tx } from '../db/tx';
import type { FinancialProfile } from './models';

export interface BalanceSnapshot {
  openingBalancePaise: Paise;
  totalInflowPaise: Paise;
  totalOutflowPaise: Paise;
  earmarkedGoalsPaise: Paise;
  earmarkedEmergencyPaise: Paise;
  cashPaise: Paise;
  earmarkedPaise: Paise;
  availablePaise: Paise;
}

export function makeBalance(parts: {
  openingBalancePaise: Paise;
  totalInflowPaise: Paise;
  totalOutflowPaise: Paise;
  earmarkedGoalsPaise: Paise;
  earmarkedEmergencyPaise: Paise;
}): BalanceSnapshot {
  const cash = parts.openingBalancePaise + parts.totalInflowPaise - parts.totalOutflowPaise;
  const earmarked = parts.earmarkedGoalsPaise + parts.earmarkedEmergencyPaise;
  return { ...parts, cashPaise: cash, earmarkedPaise: earmarked, availablePaise: cash - earmarked };
}

const num = (v: unknown): number => (v === null || v === undefined ? 0 : Number(v));

export async function loadBalance(tx: Tx, userId: string, profile: FinancialProfile | null, asOf: IsoDate): Promise<BalanceSnapshot> {
  const from = profile?.openingDate ?? null;
  const flows = await sql<{ inflow: string | null; outflow: string | null }>`
    select sum(amount_paise) filter (where type = 'income') as inflow,
           sum(amount_paise) filter (where type = 'expense') as outflow
    from public.transactions
    where user_id = ${userId} and date <= ${asOf}::date
      and (${from}::date is null or date >= ${from}::date)`.execute(tx);
  const marks = await sql<{ goals: string | null; emergency: string | null }>`
    select sum(case when kind = 'contribution' then amount_paise else -amount_paise end) filter (where bucket_type = 'goal') as goals,
           sum(case when kind = 'contribution' then amount_paise else -amount_paise end) filter (where bucket_type = 'emergencyFund') as emergency
    from public.savings_movements
    where user_id = ${userId} and date <= ${asOf}::date`.execute(tx);
  return makeBalance({
    openingBalancePaise: profile?.openingPaise ?? 0,
    totalInflowPaise: num(flows.rows[0]?.inflow),
    totalOutflowPaise: num(flows.rows[0]?.outflow),
    earmarkedGoalsPaise: num(marks.rows[0]?.goals),
    earmarkedEmergencyPaise: num(marks.rows[0]?.emergency),
  });
}

/** Income vs spending for an inclusive date range (CashFlowCalculator.summarize). */
export interface PeriodSummary {
  range: { start: IsoDate; end: IsoDate };
  /** Excludes loan disbursements (borrowing is not income). */
  incomePaise: Paise;
  /** Excludes money lent out; includes EMIs and settlements paid. */
  expensePaise: Paise;
  netPaise: Paise;
  /** Net ÷ income in basis points; null without income. */
  savingsRateBps: number | null;
  /** Expense per category, sorted descending. */
  byCategory: { categoryId: string; amountPaise: Paise }[];
  /** Expense per payment method (missing = other), sorted descending. */
  byMethod: { method: string; amountPaise: Paise }[];
  transactionCount: number;
}

export async function loadPeriodSummary(tx: Tx, userId: string, range: DateRange): Promise<PeriodSummary> {
  const totals = await sql<{ income: string | null; expense: string | null; count: string }>`
    select sum(amount_paise) filter (where type = 'income') as income,
           sum(amount_paise) filter (where type = 'expense') as expense,
           count(*) as count
    from public.transactions
    where user_id = ${userId} and date between ${range.start}::date and ${range.end}::date
      and origin <> 'loanDisbursement'`.execute(tx);
  const cats = await sql<{ category_id: string; total: string }>`
    select category_id, sum(amount_paise) as total
    from public.transactions
    where user_id = ${userId} and type = 'expense' and origin <> 'loanDisbursement'
      and date between ${range.start}::date and ${range.end}::date
    group by category_id`.execute(tx);
  const methods = await sql<{ method: string; total: string }>`
    select coalesce(payment_method, 'other') as method, sum(amount_paise) as total
    from public.transactions
    where user_id = ${userId} and type = 'expense' and origin <> 'loanDisbursement'
      and date between ${range.start}::date and ${range.end}::date
    group by 1`.execute(tx);
  const income = num(totals.rows[0]?.income);
  const expense = num(totals.rows[0]?.expense);
  // Descending by amount; ties broken by key so the order is deterministic.
  const byDesc = <T extends { amountPaise: number }>(key: (x: T) => string) => (a: T, b: T) =>
    b.amountPaise - a.amountPaise || key(a).localeCompare(key(b));
  return {
    range: { start: range.start, end: range.end },
    incomePaise: income,
    expensePaise: expense,
    netPaise: income - expense,
    savingsRateBps: ratioBps(income - expense, income),
    byCategory: cats.rows.map((r) => ({ categoryId: r.category_id, amountPaise: num(r.total) })).sort(byDesc((x) => x.categoryId)),
    byMethod: methods.rows.map((r) => ({ method: r.method, amountPaise: num(r.total) })).sort(byDesc((x) => x.method)),
    transactionCount: num(totals.rows[0]?.count),
  };
}
