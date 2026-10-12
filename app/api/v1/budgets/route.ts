import { parseWith, preflight, query, route } from '@/server/http/handler';
import { withUserTx } from '@/server/db/tx';
import { createContext } from '@/server/actions/dispatcher';
import { MonthKey } from '@/server/core/dates';
import { budgetsOverview, monthQuerySchema } from '@/server/modules/budgets/service';

/** GET /api/v1/budgets?month=yyyy-MM  (default: the current budget month; later months clamp to it) */
export const GET = route(async (ctx) => {
  const q = parseWith(monthQuerySchema, query(ctx.url));
  return withUserTx(ctx.user, async (tx) => {
    const { snapshot } = await createContext(tx, ctx.user, 'ui');
    return budgetsOverview(snapshot, MonthKey.tryParse(q.month));
  });
});

export const OPTIONS = preflight();
