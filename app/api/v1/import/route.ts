import { AppFailure } from '@/server/core/failure';
import { parseWith, preflight, readJson, route } from '@/server/http/handler';
import { importAccount, importSchema } from '@/server/modules/sync/import';

/**
 * POST /api/v1/import — one-time upload of on-device records into an empty account.
 * Header `Idempotency-Key` required. All or nothing. Returns the full sync payload.
 */
export const POST = route(async (ctx) => {
  const key = ctx.request.headers.get('idempotency-key') ?? '';
  if (!/^[A-Za-z0-9._:\-]{8,128}$/.test(key)) {
    throw AppFailure.validation('A valid Idempotency-Key (8-128 characters) is required.', { idempotencyKey: 'Required' });
  }
  const payload = parseWith(importSchema, await readJson(ctx.request, 25_000_000));
  return importAccount(ctx.user, payload, key);
});

export const OPTIONS = preflight();
