import { parseWith, preflight, query, route } from '@/server/http/handler';
import { createContext } from '@/server/actions/dispatcher';
import { withUserTx } from '@/server/db/tx';
import { upcomingQuery, upcomingRenewals } from '@/server/modules/subscriptions/service';

/** GET /api/v1/subscriptions/upcoming?days=30 (1..366): projected renewals; never transactions. */
export const GET = route(async (ctx) => {
  const q = parseWith(upcomingQuery, query(ctx.url));
  return withUserTx(ctx.user, async (tx) => upcomingRenewals((await createContext(tx, ctx.user, 'ui')).snapshot, q.days));
});

export const OPTIONS = preflight();
