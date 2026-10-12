// FiNN session tokens: short-lived HS256 access JWTs (verified statelessly by
// any API instance) and opaque random refresh tokens stored only as HMACs.
// One-time codes are also stored as HMACs keyed by the same secret.

import { createHmac, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { SignJWT, jwtVerify, type JWTPayload } from 'jose';
import { authEnv } from '../env';

export const TOKEN_ISSUER = 'finn-api';
export const TOKEN_AUDIENCE = 'authenticated';

function secret(): string {
  return authEnv().AUTH_JWT_SECRET;
}

/** Keyed hash with a purpose label, so a code hash can never match a token hash. */
export function keyedHash(purpose: 'otp' | 'refresh', value: string): string {
  return createHmac('sha256', secret()).update(`${purpose}:${value}`).digest('base64url');
}

export function hashesEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** Six random digits (uniform, CSPRNG). */
export function newOtpCode(): string {
  return randomInt(0, 1_000_000).toString().padStart(6, '0');
}

export function newRefreshToken(): string {
  return randomBytes(32).toString('base64url');
}

export async function signAccessToken(user: { id: string; email: string }, now = new Date()): Promise<{ token: string; expiresAt: Date }> {
  const ttl = authEnv().AUTH_ACCESS_TTL_SECONDS;
  const iat = Math.floor(now.getTime() / 1000);
  const token = await new SignJWT({ email: user.email, role: 'authenticated' })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setSubject(user.id)
    .setIssuer(TOKEN_ISSUER)
    .setAudience(TOKEN_AUDIENCE)
    .setIssuedAt(iat)
    .setExpirationTime(iat + ttl)
    .sign(new TextEncoder().encode(secret()));
  return { token, expiresAt: new Date((iat + ttl) * 1000) };
}

export async function verifyAccessToken(token: string): Promise<JWTPayload> {
  const { payload } = await jwtVerify(token, new TextEncoder().encode(secret()), {
    issuer: TOKEN_ISSUER,
    audience: TOKEN_AUDIENCE,
    algorithms: ['HS256'],
  });
  return payload;
}
