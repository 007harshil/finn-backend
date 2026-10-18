import { parseWith, preflight, readJson, route } from '@/server/http/handler';
import { withUserTx } from '@/server/db/tx';
import { finnIdSchema, sendRequest } from '@/server/modules/friends/service';

/**
 * POST /api/v1/friends/requests { finnId } -> { request } or, when they had
 * already asked you, { friend }. Both users are locked inside the service.
 */
export const POST = route(async (ctx) => {
  const { finnId } = parseWith(finnIdSchema, await readJson(ctx.request, 4_096));
  return withUserTx(ctx.user, (tx) => sendRequest(tx, ctx.user.userId, finnId, new Date()));
});

export const OPTIONS = preflight();
