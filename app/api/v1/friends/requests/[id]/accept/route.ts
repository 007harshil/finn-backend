import { param, preflight, route } from '@/server/http/handler';
import { withUserTx } from '@/server/db/tx';
import { acceptRequest } from '@/server/modules/friends/service';

/** POST /api/v1/friends/requests/{id}/accept -> { friend }. Only the person asked can accept. */
export const POST = route(async (ctx) => {
  const id = param(ctx, 'id');
  return withUserTx(ctx.user, (tx) => acceptRequest(tx, ctx.user.userId, id, new Date()));
});

export const OPTIONS = preflight();
