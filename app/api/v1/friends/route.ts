import { preflight, route } from '@/server/http/handler';
import { withUserTx } from '@/server/db/tx';
import { listFriends } from '@/server/modules/friends/service';

/** GET /api/v1/friends -> { me, friends, incoming, outgoing } (finn/docs/FRIENDS.md). */
export const GET = route(async (ctx) => withUserTx(ctx.user, (tx) => listFriends(tx, ctx.user.userId)));

export const OPTIONS = preflight();
