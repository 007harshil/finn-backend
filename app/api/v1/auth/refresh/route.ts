import { z } from 'zod';
import { parseWith, preflight, publicRoute, readJson } from '@/server/http/handler';
import { clientIp, refreshSession } from '@/server/auth/service';

/**
 * POST /api/v1/auth/refresh { refreshToken } -> Session (with a NEW refresh token).
 * Reusing a rotated refresh token revokes the session.
 */
export const POST = publicRoute(async ({ request }) => {
  const body = parseWith(z.object({ refreshToken: z.unknown().optional() }), await readJson(request, 4_096));
  return refreshSession(body.refreshToken, clientIp(request));
});

export const OPTIONS = preflight();
