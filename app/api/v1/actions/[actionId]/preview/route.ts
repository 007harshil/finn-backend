import { z } from 'zod';
import { previewAction } from '@/server/actions/dispatcher';
import { CLIENT_CHANNELS } from '@/server/actions/policy';
import { param, parseWith, preflight, readJson, route } from '@/server/http/handler';

const body = z.object({
  input: z.record(z.string(), z.unknown()).default({}),
  channel: z.enum(CLIENT_CHANNELS).default('ui'),
});

/** POST /api/v1/actions/{actionId}/preview — validates and describes the effect; writes nothing. */
export const POST = route(async (ctx) => {
  const actionId = param(ctx, 'actionId');
  const b = parseWith(body, await readJson(ctx.request));
  return { preview: await previewAction(ctx.user, actionId, b.input, b.channel) };
});

export const OPTIONS = preflight();
