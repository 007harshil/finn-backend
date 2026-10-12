import { AppFailure } from '@/server/core/failure';
import { param, preflight, route } from '@/server/http/handler';
import { createContext } from '@/server/actions/dispatcher';
import { withUserTx } from '@/server/db/tx';
import { subscriptionDetail } from '@/server/modules/subscriptions/service';

/** GET /api/v1/subscriptions/{id}: subscription, linked payments (newest first), next renewals. */
export const GET = route(async (ctx) => {
  const id = param(ctx, 'id');
  return withUserTx(ctx.user, async (tx) => {
    const d = await subscriptionDetail((await createContext(tx, ctx.user, 'ui')).snapshot, id);
    if (!d) throw AppFailure.notFound('This subscription no longer exists.');
    return d;
  });
});

export const OPTIONS = preflight();
