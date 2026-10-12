import { param, parseWith, preflight, query, route } from '@/server/http/handler';
import { withUserTx } from '@/server/db/tx';
import { createContext } from '@/server/actions/dispatcher';
import { MonthKey } from '@/server/core/dates';
import { budgetDetail, monthQuerySchema } from '@/server/modules/budgets/service';

/** GET /api/v1/budgets/{id}?month=yyyy-MM  (default: current month) with the daily spend series. */
export const GET = route(async (ctx) => {
  const id = param(ctx, 'id');
  const q = parseWith(monthQuerySchema, query(ctx.url));
  return withUserTx(ctx.user, async (tx) => {
    const { snapshot } = await createContext(tx, ctx.user, 'ui');
    return budgetDetail(snapshot, id, MonthKey.tryParse(q.month));
  });
});

export const OPTIONS = preflight();
