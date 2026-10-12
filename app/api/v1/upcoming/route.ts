import { z } from 'zod';
import { parseWith, preflight, query, route } from '@/server/http/handler';
import { withUserTx } from '@/server/db/tx';
import { createContext } from '@/server/actions/dispatcher';
import { MAX_UPCOMING_DAYS, UPCOMING_WINDOW_DAYS, loadUpcoming } from '@/server/modules/insights/upcoming';

const upcomingQuery = z.object({ days: z.coerce.number().int().min(1).max(MAX_UPCOMING_DAYS).default(UPCOMING_WINDOW_DAYS) });

/** GET /api/v1/upcoming?days=7 — EMIs, loan receipts and subscription renewals due in the window (overdue included). */
export const GET = route(async (ctx) => {
  const q = parseWith(upcomingQuery, query(ctx.url));
  return withUserTx(ctx.user, async (tx) => loadUpcoming((await createContext(tx, ctx.user, 'ui')).snapshot, q.days));
});

export const OPTIONS = preflight();
