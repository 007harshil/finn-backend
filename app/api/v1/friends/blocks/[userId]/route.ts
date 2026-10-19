import { param, preflight, route } from '@/server/http/handler';
import { withUserTx } from '@/server/db/tx';
import { unblockUser } from '@/server/modules/friends/service';

/** DELETE /api/v1/friends/blocks/{userId} -> { ok }. They can send requests again. */
export const DELETE = route(async (ctx) => {
  const userId = param(ctx, 'userId');
  return withUserTx(ctx.user, (tx) => unblockUser(tx, ctx.user.userId, userId));
});

export const OPTIONS = preflight();
