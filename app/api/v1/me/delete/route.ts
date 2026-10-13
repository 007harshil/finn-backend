import { z } from 'zod';
import { forgetBootstrap, parseWith, preflight, readJson, route } from '@/server/http/handler';
import { clientIp } from '@/server/auth/service';
import { deleteAccount } from '@/server/auth/account-deletion';

/**
 * POST /api/v1/me/delete { code } -> { deleted: true }. Permanently deletes the
 * account and all of its data. 422 (fieldErrors.code) for a wrong or expired code.
 */
export const POST = route(async (ctx) => {
  const body = parseWith(z.object({ code: z.unknown() }), await readJson(ctx.request, 4_096));
  const result = await deleteAccount(ctx.user.userId, body.code, clientIp(ctx.request));
  forgetBootstrap(ctx.user.userId);
  return result;
});

export const OPTIONS = preflight();
