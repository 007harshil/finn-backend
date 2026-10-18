import { param, preflight, route } from '@/server/http/handler';
import { withUserTx } from '@/server/db/tx';
import { cancelRequest } from '@/server/modules/friends/service';

/** DELETE /api/v1/friends/requests/{id} -> { ok }. Cancels a request you sent. */
export const DELETE = route(async (ctx) => {
  const id = param(ctx, 'id');
  return withUserTx(ctx.user, (tx) => cancelRequest(tx, ctx.user.userId, id));
});

export const OPTIONS = preflight();
