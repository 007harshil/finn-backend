import { preflight, route } from '@/server/http/handler';
import { withUserTx } from '@/server/db/tx';
import { createContext } from '@/server/actions/dispatcher';
import { netWorthView } from '@/server/modules/insights/net-worth';

/** GET /api/v1/net-worth — net worth snapshot with lines, asset rows, slices and debt ratio. */
export const GET = route(async (ctx) => withUserTx(ctx.user, async (tx) => netWorthView((await createContext(tx, ctx.user, 'ui')).snapshot)));

export const OPTIONS = preflight();
