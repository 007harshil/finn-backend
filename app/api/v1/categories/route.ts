import { preflight, route } from '@/server/http/handler';
import { withUserTx } from '@/server/db/tx';
import { createContext } from '@/server/actions/dispatcher';

/** GET /api/v1/categories — every category (including archived and system ones). */
export const GET = route(async (ctx) =>
  withUserTx(ctx.user, async (tx) => {
    const c = await createContext(tx, ctx.user, 'ui');
    return { items: await c.snapshot.categories() };
  }),
);

export const OPTIONS = preflight();
