import { param, preflight, route } from '@/server/http/handler';
import { withUserTx } from '@/server/db/tx';
import { rejectRequest } from '@/server/modules/friends/service';

/** POST /api/v1/friends/requests/{id}/reject -> { ok }. The request is deleted; it can be sent again. */
export const POST = route(async (ctx) => {
  const id = param(ctx, 'id');
  return withUserTx(ctx.user, (tx) => rejectRequest(tx, ctx.user.userId, id));
});

export const OPTIONS = preflight();
