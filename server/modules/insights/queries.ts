// Bounded SQL aggregates for the insights layer. Every query is limited to a
// date window and grouped in the database (by month, by day) so no endpoint
// ever loads a user's whole transaction history. Cash-flow filters match
// server/finance/ledger.ts loadPeriodSummary exactly (loan disbursements are
// not income and are excluded everywhere).

import { sql } from 'kysely';
import type { DateRange, IsoDate, MonthKey } from '../../core/dates';
import { ratioBps, type Paise } from '../../core/money';
import { transactionFromRow, type Transaction } from '../../finance/models';
import type { FinanceSnapshot } from '../../finance/snapshot';

const num = (v: unknown): number => (v === null || v === undefined ? 0 : Number(v));

export interface MonthFlow {
  month: string;
  incomePaise: Paise;
  expensePaise: Paise;
  netPaise: Paise;
  savingsRateBps: number | null;
  transactionCount: number;
}

/** Income and expense per calendar month for [first..last] (one grouped query); months without activity are zero. */
export async function monthlyFlows(s: FinanceSnapshot, first: MonthKey, last: MonthKey): Promise<MonthFlow[]> {
  const r = await sql<{ m: string; income: string | null; expense: string | null; n: string }>`
    select to_char(date, 'YYYY-MM') as m,
           sum(amount_paise) filter (where type = 'income') as income,
           sum(amount_paise) filter (where type = 'expense') as expense,
           count(*) as n
    from public.transactions
    where user_id = ${s.userId} and date between ${first.start}::date and ${last.end}::date
      and origin <> 'loanDisbursement'
    group by 1`.execute(s.tx);
  const byMonth = new Map(r.rows.map((x) => [x.m, x]));
  const out: MonthFlow[] = [];
  for (let m = first; m.compareTo(last) <= 0; m = m.next) {
    const row = byMonth.get(m.id);
    const income = num(row?.income);
    const expense = num(row?.expense);
    out.push({
      month: m.id,
      incomePaise: income,
      expensePaise: expense,
      netPaise: income - expense,
      savingsRateBps: ratioBps(income - expense, income),
      transactionCount: num(row?.n),
    });
  }
  return out;
}

/** Expense per day within [range] (cash-flow expenses only). */
export async function dailyExpenses(s: FinanceSnapshot, range: DateRange): Promise<Map<IsoDate, Paise>> {
  const r = await sql<{ d: string; total: string }>`
    select to_char(date, 'YYYY-MM-DD') as d, sum(amount_paise) as total
    from public.transactions
    where user_id = ${s.userId} and type = 'expense' and origin <> 'loanDisbursement'
      and date between ${range.start}::date and ${range.end}::date
    group by 1`.execute(s.tx);
  return new Map(r.rows.map((x) => [x.d, num(x.total)]));
}

/** Largest single cash-flow expenses in [range], biggest first (newest first on ties). */
export async function topExpenses(s: FinanceSnapshot, range: DateRange, limit: number): Promise<Transaction[]> {
  const rows = await s.tx
    .selectFrom('transactions')
    .selectAll()
    .where('user_id', '=', s.userId)
    .where('type', '=', 'expense')
    .where('origin', '<>', 'loanDisbursement')
    .where('date', '>=', range.start)
    .where('date', '<=', range.end)
    .orderBy('amount_paise', 'desc')
    .orderBy('date', 'desc')
    .orderBy('created_at', 'desc')
    .orderBy('id', 'desc')
    .limit(limit)
    .execute();
  return rows.map(transactionFromRow);
}

/** Sum and count of manual expenses dated in [from, before). */
export async function manualExpenseBaseline(s: FinanceSnapshot, from: IsoDate, before: IsoDate): Promise<{ totalPaise: Paise; count: number }> {
  const r = await sql<{ total: string | null; n: string }>`
    select sum(amount_paise) as total, count(*) as n
    from public.transactions
    where user_id = ${s.userId} and type = 'expense' and origin = 'manual'
      and date >= ${from}::date and date < ${before}::date`.execute(s.tx);
  return { totalPaise: num(r.rows[0]?.total), count: num(r.rows[0]?.n) };
}

/** Distinct calendar months (yyyy-MM) that have transactions, up to [last] inclusive. */
export async function transactionMonths(s: FinanceSnapshot, last: MonthKey): Promise<string[]> {
  const r = await sql<{ m: string }>`
    select distinct to_char(date, 'YYYY-MM') as m
    from public.transactions
    where user_id = ${s.userId} and date <= ${last.end}::date`.execute(s.tx);
  return r.rows.map((x) => x.m);
}

/** Transactions dated in [range], optionally restricted to categories. */
export async function countTransactions(s: FinanceSnapshot, range: DateRange, categoryIds: string[] | null): Promise<number> {
  if (categoryIds && categoryIds.length === 0) return 0;
  let q = s.tx
    .selectFrom('transactions')
    .select((eb) => eb.fn.countAll<string>().as('n'))
    .where('user_id', '=', s.userId)
    .where('date', '>=', range.start)
    .where('date', '<=', range.end);
  if (categoryIds) q = q.where('category_id', 'in', categoryIds);
  return num((await q.executeTakeFirst())?.n);
}

/** Transactions dated in [range], oldest first (export order). */
export async function transactionsOldestFirst(s: FinanceSnapshot, range: DateRange, categoryIds: string[] | null): Promise<Transaction[]> {
  if (categoryIds && categoryIds.length === 0) return [];
  let q = s.tx
    .selectFrom('transactions')
    .selectAll()
    .where('user_id', '=', s.userId)
    .where('date', '>=', range.start)
    .where('date', '<=', range.end);
  if (categoryIds) q = q.where('category_id', 'in', categoryIds);
  const rows = await q.orderBy('date', 'asc').orderBy('created_at', 'asc').orderBy('id', 'asc').execute();
  return rows.map(transactionFromRow);
}
