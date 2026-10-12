// Verifies FiNN access tokens sent by the Flutter app as
// `Authorization: Bearer <access_token>`. Tokens are HS256 JWTs issued by
// /api/v1/auth/verify and /api/v1/auth/refresh (see tokens.ts) and are checked
// locally with AUTH_JWT_SECRET. No session state is kept, so any number of API
// instances can verify tokens.

import type { JWTPayload } from 'jose';
import { verifyAccessToken } from './tokens';
import { authEnv } from '../env';
import { AppFailure } from '../core/failure';

export interface AuthUser {
  userId: string;
  email: string | null;
  /** Claims forwarded to Postgres (`request.jwt.claims`) so RLS sees the same identity. */
  claims: { sub: string; role: 'authenticated'; email?: string };
}

export type TokenVerifier = (token: string) => Promise<AuthUser>;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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

export const finnTokenVerifier: TokenVerifier = async (token) => {
  // A missing secret is a server fault (500, logged), not an expired session.
  authEnv();
  try {
    return toUser(await verifyAccessToken(token));
  } catch (err) {
    if (err instanceof AppFailure) throw err;
    throw unauthenticated();
  }
};

let verifier: TokenVerifier = finnTokenVerifier;

export function getTokenVerifier(): TokenVerifier {
  return verifier;
}

/** Test hook. */
export function setTokenVerifier(v: TokenVerifier | null): void {
  verifier = v ?? finnTokenVerifier;
}

export async function authenticate(request: Request): Promise<AuthUser> {
  const header = request.headers.get('authorization') ?? '';
  const match = /^Bearer\s+(\S+)$/i.exec(header);
  if (!match) throw new AppFailure('unauthenticated', 'Sign in to continue.');
  return getTokenVerifier()(match[1]);
}
