// Reusable goal loaders (used by the goals endpoints, actions and, later, the dashboard and alerts).

import type { FinanceSnapshot } from '../../finance/snapshot';
import type { SavingsMovement } from '../../finance/models';
import { goalProgress, type GoalProgress } from './calculator';

/** Progress of every goal (active and archived), in creation order. */
export async function loadGoalProgress(snapshot: FinanceSnapshot): Promise<GoalProgress[]> {
  const [goals, movements] = await Promise.all([snapshot.goals(), snapshot.movements()]);
  const byGoal = new Map<string, SavingsMovement[]>();
  for (const m of movements) {
    if (m.bucketType !== 'goal') continue;
    const list = byGoal.get(m.bucketId) ?? [];
    list.push(m);
    byGoal.set(m.bucketId, list);
  }
  return goals.map((g) => goalProgress(g, byGoal.get(g.id) ?? [], snapshot.today));
}

export async function loadOneGoalProgress(snapshot: FinanceSnapshot, id: string): Promise<GoalProgress | null> {
  const goal = (await snapshot.goals()).find((g) => g.id === id);
  if (!goal) return null;
  return goalProgress(goal, await snapshot.movements(), snapshot.today);
}

/** JSON for a goal with its derived progress. */
export function goalProgressDto(p: GoalProgress) {
  return {
    goal: p.goal,
    saved: p.saved,
    remaining: p.remaining,
    progressBps: p.progressBps,
    achieved: p.isAchieved,
    averageMonthly: p.averageMonthlyContribution,
    requiredPerMonth: p.requiredMonthly,
    estimatedCompletion: p.estimatedCompletion,
    onTrack: p.onTrack,
  };
}
