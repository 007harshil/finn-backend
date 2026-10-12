import { preflight, route } from '@/server/http/handler';
import { withUserTx } from '@/server/db/tx';
import { createContext } from '@/server/actions/dispatcher';
import { goalProgressDto, loadGoalProgress } from '@/server/modules/goals/service';

/** GET /api/v1/goals: every goal with derived progress (saved, progressBps, achieved, averageMonthly, requiredPerMonth, estimatedCompletion, onTrack). */
export const GET = route(async (ctx) =>
  withUserTx(ctx.user, async (tx) => {
    const { snapshot } = await createContext(tx, ctx.user, 'ui');
    return { items: (await loadGoalProgress(snapshot)).map(goalProgressDto) };
  }),
);

export const OPTIONS = preflight();
