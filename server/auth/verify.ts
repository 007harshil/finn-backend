// Verifies Supabase Auth access tokens sent by the Flutter app as
// `Authorization: Bearer <access_token>`. Tokens are verified locally against
// the project's JWKS (asymmetric signing keys) or, for projects still on the
// legacy shared secret, with SUPABASE_JWT_SECRET. No session state is kept,
// so any number of API instances can verify tokens.

import { createRemoteJWKSet, decodeProtectedHeader, jwtVerify, type JWTPayload } from 'jose';
import { env } from '../env';
import { AppFailure } from '../core/failure';

export interface AuthUser {
  userId: string;
  email: string | null;
  /** Claims forwarded to Postgres (`request.jwt.claims`) so RLS sees the same identity. */
  claims: { sub: string; role: 'authenticated'; email?: string };
}

export type TokenVerifier = (token: string) => Promise<AuthUser>;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

let jwks: ReturnType<typeof createRemoteJWKSet> | null = null;

function toUser(payload: JWTPayload): AuthUser {
  const sub = payload.sub;
  if (typeof sub !== 'string' || !UUID_RE.test(sub)) throw unauthenticated();
  if (payload.role !== 'authenticated') throw unauthenticated();
  const email = typeof payload.email === 'string' ? payload.email : null;
  return { userId: sub, email, claims: { sub, role: 'authenticated', ...(email ? { email } : {}) } };
}

function unauthenticated(): AppFailure {
  return new AppFailure('unauthenticated', 'Your session has expired. Please sign in again.');
}

export const supabaseTokenVerifier: TokenVerifier = async (token) => {
  const e = env();
  const issuer = `${e.SUPABASE_URL.replace(/\/$/, '')}/auth/v1`;
  try {
    const { alg } = decodeProtectedHeader(token);
    if (alg === 'HS256') {
      if (!e.SUPABASE_JWT_SECRET) return await verifyWithAuthServer(token, issuer);
      const { payload } = await jwtVerify(token, new TextEncoder().encode(e.SUPABASE_JWT_SECRET), {
        issuer,
        audience: 'authenticated',
        algorithms: ['HS256'],
      });
      return toUser(payload);
    }
    jwks ??= createRemoteJWKSet(new URL(`${issuer}/.well-known/jwks.json`), { cacheMaxAge: 10 * 60_000 });
    const { payload } = await jwtVerify(token, jwks, { issuer, audience: 'authenticated', algorithms: ['ES256', 'RS256'] });
    return toUser(payload);
  } catch (err) {
    if (err instanceof AppFailure) throw err;
    throw unauthenticated();
  }
};

// Projects on the legacy shared JWT secret can verify locally only with
// SUPABASE_JWT_SECRET. Without it, ask Supabase Auth (GET /auth/v1/user) and
// cache the answer briefly, keyed by a hash of the token (never the token).
const authServerCache = new Map<string, { user: AuthUser; until: number }>();

async function verifyWithAuthServer(token: string, issuer: string): Promise<AuthUser> {
  const apiKey = process.env.SUPABASE_PUBLISHABLE_KEY;
  if (!apiKey) throw unauthenticated();
  const { createHash } = await import('node:crypto');
  const key = createHash('sha256').update(token).digest('base64url');
  const hit = authServerCache.get(key);
  if (hit && hit.until > Date.now()) return hit.user;
  const res = await fetch(`${issuer}/user`, {
    headers: { authorization: `Bearer ${token}`, apikey: apiKey },
    signal: AbortSignal.timeout(5_000),
  }).catch(() => null);
  if (!res) throw AppFailure.unavailable('Could not verify your session. Please try again.');
  if (!res.ok) throw unauthenticated();
  const body = (await res.json()) as { id?: string; email?: string; role?: string };
  const user = toUser({ sub: body.id, email: body.email, role: body.role ?? 'authenticated' });
  if (authServerCache.size > 10_000) authServerCache.clear();
  authServerCache.set(key, { user, until: Date.now() + 60_000 });
  return user;
}

let verifier: TokenVerifier = supabaseTokenVerifier;

export function getTokenVerifier(): TokenVerifier {
  return verifier;
}

/** Test hook. */
export function setTokenVerifier(v: TokenVerifier | null): void {
  verifier = v ?? supabaseTokenVerifier;
}

export async function authenticate(request: Request): Promise<AuthUser> {
  const header = request.headers.get('authorization') ?? '';
  const match = /^Bearer\s+(\S+)$/i.exec(header);
  if (!match) throw new AppFailure('unauthenticated', 'Sign in to continue.');
  return getTokenVerifier()(match[1]);
}
