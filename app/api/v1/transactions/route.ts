import { parseWith, preflight, query, route } from '@/server/http/handler';
import { withUserTx } from '@/server/db/tx';
import { listQuerySchema, listTransactions } from '@/server/modules/transactions/service';

/**
 * GET /api/v1/transactions?from&to&type&categoryIds&accountIds&channels&origins&minPaise&maxPaise&q&sort&limit&cursor
 * Keyset-paginated; pass `nextCursor` back as `cursor`.
 */
export const GET = route(async (ctx) => {
  const q = parseWith(listQuerySchema, query(ctx.url));
  return withUserTx(ctx.user, (tx) => listTransactions(tx, ctx.user.userId, q));
});

export const OPTIONS = preflight();
