import { preflight, route } from '@/server/http/handler';
import { withUserTx } from '@/server/db/tx';
import { loadMe } from '@/server/modules/account/service';

/** GET /api/v1/me -> { user: {id,name,handle,phoneHint,email}, profile: {exists:false}|{exists:true,...}, preferences } */
export const GET = route(async (ctx) => withUserTx(ctx.user, (tx) => loadMe(tx, ctx.user)));

export const OPTIONS = preflight();
