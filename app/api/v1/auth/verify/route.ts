import { z } from 'zod';
import { parseWith, preflight, publicRoute, readJson } from '@/server/http/handler';
import { clientIp, verifyOtp } from '@/server/auth/service';

/**
 * POST /api/v1/auth/verify { email, code } -> Session
 * { accessToken, refreshToken, tokenType, expiresIn, expiresAt, user: { id, email } }.
 * Creates the account on first sign-in.
 */
export const POST = publicRoute(async ({ request }) => {
  const body = parseWith(z.object({ email: z.unknown().optional(), code: z.unknown().optional() }), await readJson(request, 4_096));
  return verifyOtp(body.email, body.code, clientIp(request));
});

export const OPTIONS = preflight();
