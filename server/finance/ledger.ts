// Cash, earmarked and available (lib/finance/ledger.dart) and cash-flow
// summaries, computed with SQL aggregates so a balance never requires loading
// a user's whole history.
//
//   per account a (movements dated a.openingDate..today):
//     flow  = Σ income − Σ expense + Σ transfers in − Σ transfers out
//     asset account balance = opening + flow; credit card owed = opening − flow
//   cash       = Σ asset account balances (credit cards excluded)
//   creditOwed = Σ credit card owed
//   earmarked = Σ goal movements + Σ emergency-fund movements (dated up to today)
//   available = cash − earmarked

import { sql } from 'kysely';
import { ratioBps, type Paise } from '../core/money';
import type { DateRange, IsoDate } from '../core/dates';
import type { Tx } from '../db/tx';

export interface AccountBalance {
  accountId: string;
  /** Money in the account; for credit cards the amount owed. */
  balancePaise: Paise;
}

export interface BalanceSnapshot {
  /** Sum of opening balances of asset accounts. */
  openingBalancePaise: Paise;
  totalInflowPaise: Paise;
  totalOutflowPaise: Paise;
  earmarkedGoalsPaise: Paise;
  earmarkedEmergencyPaise: Paise;
  /** Total money: sum of asset account balances (credit cards excluded). */
  cashPaise: Paise;
  /** Sum owed on credit cards. */
  creditOwedPaise: Paise;
  earmarkedPaise: Paise;
  availablePaise: Paise;
  accounts: AccountBalance[];
}

/** Opening figures of one account replaced for a what-if (profile / balance-correction previews). */
export interface OpeningOverride {
  accountId: string;
  openingPaise: Paise;
  openingDate: IsoDate;
}

const num = (v: unknown): number => (v === null || v === undefined ? 0 : Number(v));

export async function loadBalance(tx: Tx, userId: string, asOf: IsoDate, override: OpeningOverride | null = null): Promise<BalanceSnapshot> {
  const ovId = override?.accountId ?? null;
  const ovPaise = override?.openingPaise ?? null;
  const ovDate = override?.openingDate ?? null;
  const rows = await sql<{ id: string; kind: string; opening: string; flow: string; inflow: string; outflow: string }>`
    select a.id, a.kind, a.opening, (a.inc - a.exp + a.tin - a.tout) as flow, a.inc as inflow, a.exp as outflow
    from (
      select m.id, m.kind, m.sort_order, m.created_at,
             case when m.id = ${ovId}::text then ${ovPaise}::bigint else m.opening_paise end as opening,
             coalesce(
               (select sum(t.amount_paise) from public.transactions t
                 where t.user_id = m.user_id and t.account_id = m.id and t.type = 'income'
                   and t.date <= ${asOf}::date and t.date >= (case when m.id = ${ovId}::text then ${ovDate}::date else m.opening_date end)), 0) as inc,
             coalesce(
               (select sum(t.amount_paise) from public.transactions t
                 where t.user_id = m.user_id and t.account_id = m.id and t.type = 'expense'
                   and t.date <= ${asOf}::date and t.date >= (case when m.id = ${ovId}::text then ${ovDate}::date else m.opening_date end)), 0) as exp,
             coalesce(
               (select sum(x.amount_paise) from public.transfers x
                 where x.user_id = m.user_id and x.to_account_id = m.id
                   and x.date <= ${asOf}::date and x.date >= (case when m.id = ${ovId}::text then ${ovDate}::date else m.opening_date end)), 0) as tin,
             coalesce(
               (select sum(x.amount_paise) from public.transfers x
                 where x.user_id = m.user_id and x.from_account_id = m.id
                   and x.date <= ${asOf}::date and x.date >= (case when m.id = ${ovId}::text then ${ovDate}::date else m.opening_date end)), 0) as tout
      from public.money_accounts m
      where m.user_id = ${userId}
    ) a
    order by a.sort_order, a.created_at, a.id`.execute(tx);
  const marks = await sql<{ goals: string | null; emergency: string | null }>`
    select sum(case when kind = 'contribution' then amount_paise else -amount_paise end) filter (where bucket_type = 'goal') as goals,
           sum(case when kind = 'contribution' then amount_paise else -amount_paise end) filter (where bucket_type = 'emergencyFund') as emergency
    from public.savings_movements
    where user_id = ${userId} and date <= ${asOf}::date`.execute(tx);
  let opening = 0;
  let cash = 0;
  let owed = 0;
  let inflow = 0;
  let outflow = 0;
  const accounts: AccountBalance[] = [];
  for (const r of rows.rows) {
    const liability = r.kind === 'creditCard';
    const flow = num(r.flow);
    const balance = liability ? num(r.opening) - flow : num(r.opening) + flow;
    accounts.push({ accountId: r.id, balancePaise: balance });
    if (liability) owed += balance;
    else {
      cash += balance;
      opening += num(r.opening);
    }
    inflow += num(r.inflow);
    outflow += num(r.outflow);
  }
  const goals = num(marks.rows[0]?.goals);
  const emergency = num(marks.rows[0]?.emergency);
  const earmarked = goals + emergency;
  return {
    openingBalancePaise: opening,
    totalInflowPaise: inflow,
    totalOutflowPaise: outflow,
    earmarkedGoalsPaise: goals,
    earmarkedEmergencyPaise: emergency,
    cashPaise: cash,
    creditOwedPaise: owed,
    earmarkedPaise: earmarked,
    availablePaise: cash - earmarked,
    accounts,
  };
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
  /** Expense per account, sorted descending. */
  byAccount: { accountId: string; amountPaise: Paise }[];
  /** Expense that has a channel, per channel, sorted descending. */
  byChannel: { channel: string; amountPaise: Paise }[];
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
  const accts = await sql<{ account_id: string; total: string }>`
    select account_id, sum(amount_paise) as total
    from public.transactions
    where user_id = ${userId} and type = 'expense' and origin <> 'loanDisbursement'
      and date between ${range.start}::date and ${range.end}::date
    group by account_id`.execute(tx);
  const channels = await sql<{ channel: string; total: string }>`
    select channel, sum(amount_paise) as total
    from public.transactions
    where user_id = ${userId} and type = 'expense' and origin <> 'loanDisbursement' and channel is not null
      and date between ${range.start}::date and ${range.end}::date
    group by channel`.execute(tx);
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
    byAccount: accts.rows.map((r) => ({ accountId: r.account_id, amountPaise: num(r.total) })).sort(byDesc((x) => x.accountId)),
    byChannel: channels.rows.map((r) => ({ channel: r.channel, amountPaise: num(r.total) })).sort(byDesc((x) => x.channel)),
    transactionCount: num(totals.rows[0]?.count),
  };
}
