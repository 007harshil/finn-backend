import { param, preflight, route } from '@/server/http/handler';
import { withUserTx } from '@/server/db/tx';
import { getTransaction } from '@/server/modules/transactions/service';

/** GET /api/v1/transactions/{id} */
export const GET = route(async (ctx) => {
  const id = param(ctx, 'id');
  return withUserTx(ctx.user, (tx) => getTransaction(tx, ctx.user.userId, id));
});

export const OPTIONS = preflight();
