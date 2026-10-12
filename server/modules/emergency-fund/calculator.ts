// Emergency-fund status (lib/features/emergency_fund/domain/*). Pure: the
// essentials suggestion is computed by SQL in service.ts and passed in.

import { ratioBps, roundDiv, roundToRupee, scale, type Paise } from '../../core/money';
import type { IsoDate } from '../../core/dates';
import { signedMovement, type EmergencyPlan, type SavingsMovement } from '../../finance/models';

export type EmergencyFundLevel = 'notConfigured' | 'critical' | 'building' | 'funded';

/** Coverage below this many months is "critical". */
export const CRITICAL_MONTHS = 2;

export interface EmergencyFundStatus {
  plan: EmergencyPlan | null;
  saved: Paise;
  /** Emergency-fund movements dated up to today, newest first. */
  movements: SavingsMovement[];
  /** Months of essentials covered in tenths (24 = 2.4), rounded down; null when essentials are unknown. */
  coverageTenths: number | null;
  level: EmergencyFundLevel;
  suggestedEssentialMonthly: Paise | null;
  target: Paise;
  remaining: Paise;
  progressBps: number;
}

export const planTarget = (plan: EmergencyPlan | null): Paise =>
  plan === null ? 0 : (plan.targetOverridePaise ?? plan.essentialMonthlyPaise * plan.targetMonths);

/** Average of the 3-month essentials total: half-up to the paisa, then half-up to the rupee. */
export function suggestionFromTotal(totalPaise: Paise | null): Paise | null {
  if (totalPaise === null) return null;
  return roundToRupee(scale(totalPaise, 1, 3));
}

export function emergencyStatus(args: {
  plan: EmergencyPlan | null;
  movements: readonly SavingsMovement[];
  suggestion: Paise | null;
  today: IsoDate;
}): EmergencyFundStatus {
  const { plan, suggestion, today } = args;
  const own = args.movements
    .filter((m) => m.bucketType === 'emergencyFund' && m.date <= today)
    .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
  const saved = own.reduce((sum, m) => sum + signedMovement(m), 0);
  const target = planTarget(plan);

  let coverage: number | null = null;
  const essential = plan?.essentialMonthlyPaise ?? null;
  if (essential !== null && essential > 0) coverage = roundDiv(saved * 10, essential, 'down');

  let level: EmergencyFundLevel;
  if (plan === null || target <= 0) level = 'notConfigured';
  else if (saved >= target) level = 'funded';
  else if (coverage !== null && coverage < CRITICAL_MONTHS * 10) level = 'critical';
  else level = 'building';

  return {
    plan,
    saved,
    movements: own,
    coverageTenths: coverage,
    level,
    suggestedEssentialMonthly: suggestion,
    target,
    remaining: Math.max(target - saved, 0),
    progressBps: Math.min(Math.max(ratioBps(saved, target) ?? 0, 0), 10000),
  };
}

/** True when the suggestion differs from the planned essentials by 10% or more. */
export function suggestionDiffersFromPlan(s: EmergencyFundStatus): boolean {
  const sug = s.suggestedEssentialMonthly;
  const p = s.plan?.essentialMonthlyPaise;
  if (sug === null || p === undefined || p <= 0) return false;
  return Math.abs(sug - p) * 10 >= p;
}
