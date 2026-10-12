import { createContext } from '@/server/actions/dispatcher';
import { withUserTx } from '@/server/db/tx';
import { preflight, route } from '@/server/http/handler';
import { listLoans } from '@/server/modules/loans/api';

/**
 * GET /api/v1/loans
 * Every loan with its derived state: outstanding, EMI, next due {date, amountPaise, period},
 * overdue count, paid instalments, interest paid, closed.
 */
export const GET = route(async (ctx) =>
  withUserTx(ctx.user, async (tx) => listLoans(await createContext(tx, ctx.user, 'ui'))),
);

export const OPTIONS = preflight();
