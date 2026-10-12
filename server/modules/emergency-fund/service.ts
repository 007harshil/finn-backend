// Reusable emergency-fund loader (used by the endpoint, actions and, later, the dashboard and alerts).

import { sql } from 'kysely';
import { makeDate, parts } from '../../core/dates';
import { paiseFromDb } from '../../core/money';
import type { FinanceSnapshot } from '../../finance/snapshot';
import { emergencyPlanDto } from '../../finance/models';
import { SystemCategories } from '../account/standard-categories';
import { emergencyStatus, suggestionDiffersFromPlan, suggestionFromTotal, type EmergencyFundStatus } from './calculator';

/**
 * Total essential spending over the last three full calendar months: expenses
 * in essential categories plus the system EMI category (as the Flutter
 * calculator counts them). Null when no such transaction exists.
 */
export async function essentialTotalLastThreeMonths(snapshot: FinanceSnapshot): Promise<number | null> {
  const t = parts(snapshot.today);
  const start = makeDate(t.year, t.month - 3, 1);
  const end = makeDate(t.year, t.month, 0);
  const r = await sql<{ total: string | null; n: string }>`
    select sum(t.amount_paise) as total, count(*) as n
    from public.transactions t
    left join public.categories c on c.user_id = t.user_id and c.id = t.category_id
    where t.user_id = ${snapshot.userId} and t.type = 'expense'
      and t.date between ${start}::date and ${end}::date
      and (coalesce(c.is_essential, false) or t.category_id = ${SystemCategories.loanEmi})`.execute(snapshot.tx);
  const row = r.rows[0];
  if (!row || Number(row.n) === 0) return null;
  return paiseFromDb(row.total ?? 0);
}

export async function loadEmergencyStatus(snapshot: FinanceSnapshot, opts: { withSuggestion?: boolean } = {}): Promise<EmergencyFundStatus> {
  const [plan, movements] = await Promise.all([snapshot.emergencyPlan(), snapshot.movements()]);
  const total = opts.withSuggestion === false ? null : await essentialTotalLastThreeMonths(snapshot);
  return emergencyStatus({ plan, movements, suggestion: suggestionFromTotal(total), today: snapshot.today });
}

export function emergencyStatusDto(s: EmergencyFundStatus) {
  return {
    plan: emergencyPlanDto(s.plan),
    saved: s.saved,
    target: s.target,
    remaining: s.remaining,
    progressBps: s.progressBps,
    coverageTenths: s.coverageTenths,
    level: s.level,
    suggestedEssentialMonthly: s.suggestedEssentialMonthly,
    suggestionDiffersFromPlan: suggestionDiffersFromPlan(s),
    movements: s.movements,
  };
}
