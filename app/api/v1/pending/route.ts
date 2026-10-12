import { preflight, route } from '@/server/http/handler';
import { createContext } from '@/server/actions/dispatcher';
import { withUserTx } from '@/server/db/tx';
import { listPending } from '@/server/modules/pending/service';

/**
 * GET /api/v1/pending: every visible item (own and shared, in the caller's perspective) with
 * outstanding/settled/status/ageDays and settlements (newest first), totals (toPay/toCollect, long
 * pending, counts per tab), long-pending ids (oldest first), splits and active items grouped by person.
 */
export const GET = route(async (ctx) =>
  withUserTx(ctx.user, async (tx) => listPending((await createContext(tx, ctx.user, 'ui')).snapshot)),
);

export const OPTIONS = preflight();
