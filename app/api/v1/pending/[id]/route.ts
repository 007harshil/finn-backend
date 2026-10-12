import { param, preflight, route } from '@/server/http/handler';
import { createContext } from '@/server/actions/dispatcher';
import { withUserTx } from '@/server/db/tx';
import { pendingDetail } from '@/server/modules/pending/service';

/** GET /api/v1/pending/{id} (own id or `mir_<sharedId>`): the item, its split, other open items with the same person. */
export const GET = route(async (ctx) => {
  const id = param(ctx, 'id');
  return withUserTx(ctx.user, async (tx) => pendingDetail((await createContext(tx, ctx.user, 'ui')).snapshot, id));
});

export const OPTIONS = preflight();
