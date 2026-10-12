import { createContext } from '@/server/actions/dispatcher';
import { withUserTx } from '@/server/db/tx';
import { param, preflight, route } from '@/server/http/handler';
import { getLoan } from '@/server/modules/loans/api';

/** GET /api/v1/loans/{id} — loan, state, payments (newest first) and schedule rows (paid/overdue/due/upcoming). */
export const GET = route(async (ctx) => {
  const id = param(ctx, 'id');
  return withUserTx(ctx.user, async (tx) => getLoan(await createContext(tx, ctx.user, 'ui'), id));
});

export const OPTIONS = preflight();
