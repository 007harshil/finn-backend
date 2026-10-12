import { z } from 'zod';
import { dispatch } from '@/server/actions/dispatcher';
import { CLIENT_CHANNELS } from '@/server/actions/policy';
import { param, parseWith, preflight, readJson, route } from '@/server/http/handler';

const body = z.object({
  input: z.record(z.string(), z.unknown()).default({}),
  confirmation: z.object({ fingerprint: z.string().min(1).max(200), confirmedBy: z.string().max(60).optional() }).nullish(),
  channel: z.enum(CLIENT_CHANNELS).default('ui'),
});

/**
 * POST /api/v1/actions/{actionId}
 * Header `Idempotency-Key` (required). Returns `completed` (with the changed
 * records) or `needsConfirmation` with a preview whose fingerprint must be
 * sent back as `confirmation.fingerprint`.
 */
export const POST = route(async (ctx) => {
  const actionId = param(ctx, 'actionId');
  const b = parseWith(body, await readJson(ctx.request));
  return dispatch(ctx.user, actionId, b.input, {
    idempotencyKey: ctx.request.headers.get('idempotency-key') ?? '',
    confirmation: b.confirmation ?? null,
    channel: b.channel,
  });
});

export const OPTIONS = preflight();
