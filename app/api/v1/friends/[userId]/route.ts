import { param, preflight, route } from '@/server/http/handler';
import { withUserTx } from '@/server/db/tx';
import { removeFriend } from '@/server/modules/friends/service';

/** DELETE /api/v1/friends/{userId} -> { ok }. Shared items stay; new shares need a new friendship. */
export const DELETE = route(async (ctx) => {
  const userId = param(ctx, 'userId');
  return withUserTx(ctx.user, (tx) => removeFriend(tx, ctx.user.userId, userId));
});

export const OPTIONS = preflight();
