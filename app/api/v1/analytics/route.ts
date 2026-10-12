import { parseWith, preflight, query, route } from '@/server/http/handler';
import { withUserTx } from '@/server/db/tx';
import { createContext } from '@/server/actions/dispatcher';
import { analytics, analyticsQuery } from '@/server/modules/insights/analytics';

/**
 * GET /api/v1/analytics?period=month|quarter|half|year[&month=yyyy-MM]  or  ?from=yyyy-MM-dd&to=yyyy-MM-dd (≤ 366 days)
 * — everything the Insights screen shows for the period.
 */
export const GET = route(async (ctx) => {
  const q = parseWith(analyticsQuery, query(ctx.url));
  return withUserTx(ctx.user, async (tx) => analytics((await createContext(tx, ctx.user, 'ui')).snapshot, q));
});

export const OPTIONS = preflight();
