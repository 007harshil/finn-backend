// FiNN email-OTP sign-in.
//
// 1. requestOtp: emails a 6-digit code (nodemailer). Only its HMAC is stored;
//    a new code replaces any earlier unused one for that email.
// 2. verifyOtp: checks the code (5 attempts, then it is burned), creates the
//    account on first sign-in and opens a session.
// 3. refreshSession: rotates the refresh token. Presenting a token that was
//    already rotated revokes the whole session family (token theft).
// 4. signOut: revokes the session family.
//
// These run on the API's own connection (not as finn_api): the finn_auth
// schema is invisible to every client-facing role.

import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { z } from 'zod';
import { getDb } from '../db/client';
import type { Tx } from '../db/tx';
import { authEnv } from '../env';
import { AppFailure } from '../core/failure';
import { sendMail } from '../mail/mailer';
import { otpEmail } from '../mail/templates';
import { hashesEqual, keyedHash, newOtpCode, newRefreshToken, signAccessToken } from './tokens';
import { WindowLimiter } from './rate-limit';

/** Minimum gap between two codes for one email. */
export const OTP_RESEND_SECONDS = 60;
/** Codes per email per hour. */
export const OTP_HOURLY_LIMIT = 5;
/** Wrong guesses before a code is burned. */
export const OTP_MAX_ATTEMPTS = 5;

const INVALID_CODE = 'The code was invalid or has expired.';
const SESSION_EXPIRED = 'Your session has expired. Please sign in again.';

/** Per client IP, per instance. */
export const limiters = {
  otp: new WindowLimiter(10, 10 * 60_000),
  verify: new WindowLimiter(30, 10 * 60_000),
  refresh: new WindowLimiter(120, 10 * 60_000),
};

export interface Session {
  accessToken: string;
  refreshToken: string;
  tokenType: 'Bearer';
  /** Access token lifetime in seconds. */
  expiresIn: number;
  /** Access token expiry (ISO-8601). */
  expiresAt: string;
  user: { id: string; email: string };
}

const emailSchema = z.string().trim().toLowerCase().max(254).pipe(z.email());

export function normaliseEmail(value: unknown): string {
  const parsed = emailSchema.safeParse(value);
  if (!parsed.success) throw AppFailure.fields({ email: 'Invalid email address.' });
  return parsed.data;
}

function tooMany(retryAfterSeconds: number): AppFailure {
  return new AppFailure('unavailable', 'Too many attempts. Please wait a minute and try again.', {
    retryable: true,
    details: { retryAfterSeconds },
  });
}

function limit(limiter: WindowLimiter, ip: string): void {
  const decision = limiter.take(ip);
  if (!decision.allowed) throw tooMany(decision.retryAfterSeconds);
}

async function lockEmail(tx: Tx, email: string): Promise<void> {
  await sql`select pg_advisory_xact_lock(hashtextextended(${email}, 11))`.execute(tx);
}

export async function requestOtp(
  rawEmail: unknown,
  ip: string,
  now = new Date(),
): Promise<{ sent: true; expiresInSeconds: number; resendAfterSeconds: number }> {
  const email = normaliseEmail(rawEmail);
  limit(limiters.otp, ip);
  const ttl = authEnv().AUTH_OTP_TTL_SECONDS;
  const code = newOtpCode();

  const otpId = await getDb()
    .transaction()
    .execute(async (tx) => {
      await lockEmail(tx, email);
      const hourAgo = new Date(now.getTime() - 3_600_000);
      const recent = await tx
        .selectFrom('finn_auth.email_otps')
        .select('created_at')
        .where('email', '=', email)
        .where('created_at', '>', hourAgo)
        .orderBy('created_at', 'desc')
        .execute();
      if (recent.length > 0) {
        const wait = Math.ceil((new Date(recent[0].created_at).getTime() + OTP_RESEND_SECONDS * 1000 - now.getTime()) / 1000);
        if (wait > 0) throw tooMany(wait);
      }
      if (recent.length >= OTP_HOURLY_LIMIT) {
        const oldest = new Date(recent[OTP_HOURLY_LIMIT - 1].created_at).getTime();
        throw tooMany(Math.max(1, Math.ceil((oldest + 3_600_000 - now.getTime()) / 1000)));
      }
      // Only the newest code is valid.
      await tx
        .updateTable('finn_auth.email_otps')
        .set({ consumed_at: now })
        .where('email', '=', email)
        .where('consumed_at', 'is', null)
        .execute();
      // Housekeeping: codes older than a day are useless.
      await tx.deleteFrom('finn_auth.email_otps').where('created_at', '<', new Date(now.getTime() - 86_400_000)).execute();
      const row = await tx
        .insertInto('finn_auth.email_otps')
        .values({ email, code_hash: keyedHash('otp', `${email}:${code}`), expires_at: new Date(now.getTime() + ttl * 1000), created_at: now })
        .returning('id')
        .executeTakeFirstOrThrow();
      return row.id;
    });

  try {
    await sendMail(otpEmail(email, code, Math.round(ttl / 60)));
  } catch (err) {
    // Not delivered: drop the code so it neither works nor counts against the limit.
    await getDb().deleteFrom('finn_auth.email_otps').where('id', '=', otpId).execute().catch(() => undefined);
    throw err;
  }
  return { sent: true, expiresInSeconds: ttl, resendAfterSeconds: OTP_RESEND_SECONDS };
}

async function openSession(tx: Tx, user: { id: string; email: string }, familyId: string, now: Date): Promise<Session> {
  const refreshToken = newRefreshToken();
  await tx
    .insertInto('finn_auth.refresh_tokens')
    .values({
      user_id: user.id,
      family_id: familyId,
      token_hash: keyedHash('refresh', refreshToken),
      expires_at: new Date(now.getTime() + authEnv().AUTH_REFRESH_TTL_DAYS * 86_400_000),
      created_at: now,
    })
    .execute();
  const access = await signAccessToken(user, now);
  return {
    accessToken: access.token,
    refreshToken,
    tokenType: 'Bearer',
    expiresIn: Math.round((access.expiresAt.getTime() - now.getTime()) / 1000),
    expiresAt: access.expiresAt.toISOString(),
    user,
  };
}

export async function verifyOtp(rawEmail: unknown, rawCode: unknown, ip: string, now = new Date()): Promise<Session> {
  const email = normaliseEmail(rawEmail);
  const code = typeof rawCode === 'string' ? rawCode.trim() : '';
  if (!/^\d{6}$/.test(code)) throw AppFailure.fields({ code: 'Please enter the 6-digit code.' });
  limit(limiters.verify, ip);

  // A wrong guess must be committed before failing, so the transaction
  // returns an outcome instead of throwing.
  const outcome = await getDb()
    .transaction()
    .execute(async (tx): Promise<{ ok: true; session: Session } | { ok: false }> => {
      await lockEmail(tx, email);
      const otp = await tx
        .selectFrom('finn_auth.email_otps')
        .select(['id', 'code_hash', 'attempts'])
        .where('email', '=', email)
        .where('consumed_at', 'is', null)
        .where('expires_at', '>', now)
        .orderBy('created_at', 'desc')
        .limit(1)
        .executeTakeFirst();
      if (!otp) return { ok: false };
      if (!hashesEqual(otp.code_hash, keyedHash('otp', `${email}:${code}`))) {
        const attempts = otp.attempts + 1;
        await tx
          .updateTable('finn_auth.email_otps')
          .set({ attempts, ...(attempts >= OTP_MAX_ATTEMPTS ? { consumed_at: now } : {}) })
          .where('id', '=', otp.id)
          .execute();
        return { ok: false };
      }
      await tx.updateTable('finn_auth.email_otps').set({ consumed_at: now }).where('id', '=', otp.id).execute();
      const user = await tx
        .insertInto('finn_auth.users')
        .values({ email, last_sign_in_at: now, created_at: now })
        .onConflict((oc) => oc.column('email').doUpdateSet({ last_sign_in_at: now }))
        .returning(['id', 'email'])
        .executeTakeFirstOrThrow();
      await tx.deleteFrom('finn_auth.refresh_tokens').where('user_id', '=', user.id).where('expires_at', '<', now).execute();
      return { ok: true, session: await openSession(tx, user, randomUUID(), now) };
    });

  if (!outcome.ok) throw new AppFailure('unauthenticated', INVALID_CODE);
  return outcome.session;
}

function readRefreshToken(raw: unknown): string {
  if (typeof raw !== 'string' || raw.length < 20 || raw.length > 200) throw new AppFailure('unauthenticated', SESSION_EXPIRED);
  return raw;
}

export async function refreshSession(raw: unknown, ip: string, now = new Date()): Promise<Session> {
  const token = readRefreshToken(raw);
  limit(limiters.refresh, ip);
  const outcome = await getDb()
    .transaction()
    .execute(async (tx): Promise<Session | null> => {
      const row = await tx
        .selectFrom('finn_auth.refresh_tokens as r')
        .innerJoin('finn_auth.users as u', 'u.id', 'r.user_id')
        .select(['r.id', 'r.family_id', 'r.expires_at', 'r.rotated_at', 'r.revoked_at', 'u.id as user_id', 'u.email'])
        .where('r.token_hash', '=', keyedHash('refresh', token))
        .forUpdate()
        .executeTakeFirst();
      if (!row || row.revoked_at || new Date(row.expires_at) <= now) return null;
      if (row.rotated_at) {
        // Reuse of a rotated token: someone else may hold the session.
        await tx
          .updateTable('finn_auth.refresh_tokens')
          .set({ revoked_at: now })
          .where('family_id', '=', row.family_id)
          .where('revoked_at', 'is', null)
          .execute();
        return null;
      }
      await tx.updateTable('finn_auth.refresh_tokens').set({ rotated_at: now }).where('id', '=', row.id).execute();
      return openSession(tx, { id: row.user_id, email: row.email }, row.family_id, now);
    });
  if (!outcome) throw new AppFailure('unauthenticated', SESSION_EXPIRED);
  return outcome;
}

/** Always succeeds: an unknown token is already signed out. */
export async function signOut(raw: unknown, now = new Date()): Promise<{ signedOut: true }> {
  if (typeof raw === 'string' && raw.length >= 20 && raw.length <= 200) {
    const row = await getDb()
      .selectFrom('finn_auth.refresh_tokens')
      .select('family_id')
      .where('token_hash', '=', keyedHash('refresh', raw))
      .executeTakeFirst();
    if (row) {
      await getDb()
        .updateTable('finn_auth.refresh_tokens')
        .set({ revoked_at: now })
        .where('family_id', '=', row.family_id)
        .where('revoked_at', 'is', null)
        .execute();
    }
  }
  return { signedOut: true };
}

/** Client IP for rate limiting (first X-Forwarded-For hop set by the platform proxy). */
export function clientIp(request: Request): string {
  const forwarded = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim();
  return (forwarded || request.headers.get('x-real-ip') || 'unknown').slice(0, 64);
}
