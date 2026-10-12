import { createContext } from '@/server/actions/dispatcher';
import { withUserTx } from '@/server/db/tx';
import { param, parseWith, preflight, readJson, route } from '@/server/http/handler';
import { paymentPreview, paymentPreviewBody } from '@/server/modules/loans/api';

/**
 * POST /api/v1/loans/{id}/payment-preview  body {kind, amount, date?}
 * Interest/principal split of a proposed payment; writes nothing. Invalid amounts fail with 422 and the calculator message.
 */
export const POST = route(async (ctx) => {
  const id = param(ctx, 'id');
  const body = parseWith(paymentPreviewBody, await readJson(ctx.request));
  return withUserTx(ctx.user, async (tx) => paymentPreview(await createContext(tx, ctx.user, 'ui'), id, body));
});

export const OPTIONS = preflight();
