import { z } from 'zod';
import { parseWith, preflight, publicRoute, readJson } from '@/server/http/handler';
import { signOut } from '@/server/auth/service';

/** POST /api/v1/auth/logout { refreshToken } -> { signedOut: true }. Revokes the session. */
export const POST = publicRoute(async ({ request }) => {
  const body = parseWith(z.object({ refreshToken: z.unknown().optional() }), await readJson(request, 4_096));
  return signOut(body.refreshToken);
});

export const OPTIONS = preflight();
