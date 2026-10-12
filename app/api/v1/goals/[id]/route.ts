import { param, preflight, route } from '@/server/http/handler';
import { withUserTx } from '@/server/db/tx';
import { createContext } from '@/server/actions/dispatcher';
import { AppFailure } from '@/server/core/failure';
import { goalProgressDto, loadOneGoalProgress } from '@/server/modules/goals/service';

/** GET /api/v1/goals/{id}: progress plus movement history (up to today, newest first). */
export const GET = route(async (ctx) => {
  const id = param(ctx, 'id');
  return withUserTx(ctx.user, async (tx) => {
    const { snapshot } = await createContext(tx, ctx.user, 'ui');
    const p = await loadOneGoalProgress(snapshot, id);
    if (!p) throw AppFailure.notFound('This goal no longer exists.');
    return { ...goalProgressDto(p), movements: p.movements };
  });
});

export const OPTIONS = preflight();
