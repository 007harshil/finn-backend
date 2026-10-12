// Goal progress (lib/features/goals/domain/goal_calculator.dart). Pure and
// deterministic: `today` is passed in, nothing touches the database.

import { addMonthsClamped, makeDate, parts, type IsoDate } from '../../core/dates';
import { ratioBps, roundDiv, scale, type Paise } from '../../core/money';
import { signedMovement, type Goal, type SavingsMovement } from '../../finance/models';

export interface GoalProgress {
  goal: Goal;
  saved: Paise;
  /** This goal's movements dated up to today, newest first. */
  movements: SavingsMovement[];
  /** Null when there is not enough information to estimate honestly. */
  estimatedCompletion: IsoDate | null;
  /** Monthly amount needed to reach the target by the target date. */
  requiredMonthly: Paise | null;
  /** Average net monthly contribution over the last 3 full months (null without history before this month). */
  averageMonthlyContribution: Paise | null;
  /** Null when unknown (no target date or no contribution data). */
  onTrack: boolean | null;
  remaining: Paise;
  isAchieved: boolean;
  progressBps: number;
}

/** Whole months from [from] to [to], counting a partial month as one. */
export function monthsBetween(from: IsoDate, to: IsoDate): number {
  const a = parts(from);
  const b = parts(to);
  const months = (b.year - a.year) * 12 + (b.month - a.month);
  return b.day > a.day ? months + 1 : months;
}

export function goalProgress(goal: Goal, all: readonly SavingsMovement[], today: IsoDate): GoalProgress {
  const movements = all
    .filter((m) => m.bucketType === 'goal' && m.bucketId === goal.id && m.date <= today)
    .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
  const saved = movements.reduce((sum, m) => sum + signedMovement(m), 0);
  const remaining = Math.max(goal.targetPaise - saved, 0);

  // Average net contribution over the last 3 full months.
  let average: Paise | null = null;
  const t = parts(today);
  const windowStart = makeDate(t.year, t.month - 3, 1);
  const windowEnd = makeDate(t.year, t.month, 0);
  if (movements.some((m) => m.date <= windowEnd)) {
    const inWindow = movements.filter((m) => m.date >= windowStart && m.date <= windowEnd);
    average = scale(
      inWindow.reduce((sum, m) => sum + signedMovement(m), 0),
      1,
      3,
    );
  }

  // Monthly amount needed to hit the target date (rounded up, never under-stated).
  let required: Paise | null = null;
  if (goal.targetDate !== null && remaining > 0) {
    const months = monthsBetween(today, goal.targetDate);
    required = months <= 0 ? remaining : scale(remaining, 1, months, 'up');
  }

  // Estimate: prefer the user's plan, else the recent average. Never estimate from zero or negative rates.
  let estimate: IsoDate | null = null;
  const rate = goal.plannedMonthlyPaise ?? average;
  if (remaining === 0) {
    estimate = movements.length === 0 ? null : movements[0]!.date;
  } else if (rate !== null && rate > 0) {
    const months = roundDiv(remaining, rate, 'up');
    if (months <= 600) estimate = addMonthsClamped(today, months);
  }

  let onTrack: boolean | null = null;
  if (goal.targetDate !== null && remaining > 0 && estimate !== null) {
    onTrack = estimate <= goal.targetDate;
  } else if (remaining === 0) {
    onTrack = true;
  }

  const bps = ratioBps(saved, goal.targetPaise) ?? 0;
  return {
    goal,
    saved,
    movements,
    estimatedCompletion: estimate,
    requiredMonthly: required,
    averageMonthlyContribution: average,
    onTrack,
    remaining,
    isAchieved: goal.targetPaise > 0 && saved >= goal.targetPaise,
    progressBps: Math.min(Math.max(bps, 0), 10000),
  };
}
