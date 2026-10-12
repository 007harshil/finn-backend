import { preflight, route } from '@/server/http/handler';
import { withUserTx } from '@/server/db/tx';
import { createContext } from '@/server/actions/dispatcher';
import { dashboard } from '@/server/modules/insights/dashboard';

/** GET /api/v1/dashboard — the home overview in one payload (same figures as the detail endpoints). */
export const GET = route(async (ctx) => withUserTx(ctx.user, async (tx) => dashboard((await createContext(tx, ctx.user, 'ui')).snapshot)));

export const OPTIONS = preflight();
