import { preflight, route } from '@/server/http/handler';
import { createContext } from '@/server/actions/dispatcher';
import { withUserTx } from '@/server/db/tx';
import { listSubscriptions } from '@/server/modules/subscriptions/service';

/** GET /api/v1/subscriptions: every subscription with monthly equivalent and due state, plus totals. */
export const GET = route(async (ctx) =>
  withUserTx(ctx.user, async (tx) => listSubscriptions((await createContext(tx, ctx.user, 'ui')).snapshot)),
);

export const OPTIONS = preflight();
