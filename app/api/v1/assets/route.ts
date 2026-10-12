import { preflight, route } from '@/server/http/handler';
import { withUserTx } from '@/server/db/tx';
import { createContext } from '@/server/actions/dispatcher';

/** GET /api/v1/assets -> { assets: Asset[], totalPaise } */
export const GET = route(async (ctx) =>
  withUserTx(ctx.user, async (tx) => {
    const assets = await (await createContext(tx, ctx.user, 'ui')).snapshot.assets();
    return { assets, totalPaise: assets.reduce((t, a) => t + a.valuePaise, 0) };
  }),
);

export const OPTIONS = preflight();
