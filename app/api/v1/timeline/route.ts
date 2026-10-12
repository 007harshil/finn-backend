import { parseWith, preflight, query, route } from '@/server/http/handler';
import { withUserTx } from '@/server/db/tx';
import { createContext } from '@/server/actions/dispatcher';
import { timelinePage, timelineQuery } from '@/server/modules/insights/timeline';

/**
 * GET /api/v1/timeline?cursor=yyyy-MM&limit=3  (or ?month=yyyy-MM for one chapter)
 * — monthly story chapters, newest first: `{ months, chapters, nextCursor }`.
 */
export const GET = route(async (ctx) => {
  const q = parseWith(timelineQuery, query(ctx.url));
  return withUserTx(ctx.user, async (tx) => timelinePage((await createContext(tx, ctx.user, 'ui')).snapshot, q));
});

export const OPTIONS = preflight();
