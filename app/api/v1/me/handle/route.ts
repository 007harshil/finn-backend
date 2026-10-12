import { parseWith, preflight, readJson, route } from '@/server/http/handler';
import { withUserTx } from '@/server/db/tx';
import { changeHandle, handleSchema } from '@/server/modules/account/service';

/** PATCH /api/v1/me/handle { handle: "@name" } -> { handle }. 409 conflict when taken (case-insensitive). */
export const PATCH = route(async (ctx) => {
  const { handle } = parseWith(handleSchema, await readJson(ctx.request));
  return withUserTx(ctx.user, async (tx) => ({ handle: await changeHandle(tx, ctx.user.userId, handle, new Date()) }), { write: true });
});

export const OPTIONS = preflight();
