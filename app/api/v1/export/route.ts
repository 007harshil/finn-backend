import { parseWith, preflight, query, route } from '@/server/http/handler';
import { withUserTx } from '@/server/db/tx';
import { createContext } from '@/server/actions/dispatcher';
import { buildJsonExport, exportQuery } from '@/server/modules/insights/export';

/**
 * GET /api/v1/export?from=yyyy-MM-dd&to=yyyy-MM-dd[&modules=transactions,budgets,...][&categoryIds=a,b]
 * — the app's JSON export document (≤ 3 years, ≤ 20,000 transactions). CSV/PDF are generated client-side.
 */
export const GET = route(async (ctx) => {
  const q = parseWith(exportQuery, query(ctx.url));
  return withUserTx(ctx.user, async (tx) => {
    const c = await createContext(tx, ctx.user, 'ui');
    return buildJsonExport(c.snapshot, q, c.now);
  });
});

export const OPTIONS = preflight();
