import { parseWith, preflight, readJson, route } from '@/server/http/handler';
import { withUserTx } from '@/server/db/tx';
import { blockSchema, blockUser } from '@/server/modules/friends/service';

/**
 * POST /api/v1/friends/blocks { userId } -> { ok }. Removes the friendship and
 * any open request and stops new requests both ways. The list of blocked
 * people is in GET /api/v1/friends (`blocked`).
 */
export const POST = route(async (ctx) => {
  const { userId } = parseWith(blockSchema, await readJson(ctx.request, 4_096));
  return withUserTx(ctx.user, (tx) => blockUser(tx, ctx.user.userId, userId, new Date()));
});

export const OPTIONS = preflight();
