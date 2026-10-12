import { z } from 'zod';
import { parseWith, preflight, publicRoute, readJson } from '@/server/http/handler';
import { clientIp, requestOtp } from '@/server/auth/service';

/**
 * POST /api/v1/auth/otp { email } -> { sent: true, expiresInSeconds, resendAfterSeconds }
 * Emails a 6-digit sign-in code. Rate limited per email and per client.
 */
export const POST = publicRoute(async ({ request }) => {
  const body = parseWith(z.object({ email: z.unknown().optional() }), await readJson(request, 4_096));
  return requestOtp(body.email, clientIp(request));
});

export const OPTIONS = preflight();
