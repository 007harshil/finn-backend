import { parseWith, preflight, query, route } from '@/server/http/handler';
import { withUserTx } from '@/server/db/tx';
import { finnIdSchema, lookupUser } from '@/server/modules/friends/service';

/**
 * GET /api/v1/users/lookup?finnId= -> { user: { id, name, finnId, relation, requestId? } | null }.
 * Exact FiNN ID only: the one way to find someone who is not yet a friend.
 */
export const GET = route(async (ctx) => {
  const { finnId } = parseWith(finnIdSchema, query(ctx.url));
  return withUserTx(ctx.user, (tx) => lookupUser(tx, ctx.user.userId, finnId));
});

export const OPTIONS = preflight();
