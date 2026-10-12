// Email-OTP sign-in: codes are mailed (captured here), verified once, and
// open sessions whose access tokens the API accepts and whose refresh tokens
// rotate with reuse detection.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'kysely';
import * as otpRoute from '@/app/api/v1/auth/otp/route';
import * as verifyRoute from '@/app/api/v1/auth/verify/route';
import * as refreshRoute from '@/app/api/v1/auth/refresh/route';
import * as logoutRoute from '@/app/api/v1/auth/logout/route';
import * as meRoute from '@/app/api/v1/me/route';
import { createTestDb, type TestDb } from './support/db';
import { makeClient } from './support/http';
import { setMailSender, type MailMessage } from '@/server/mail/mailer';
import { setTokenVerifier } from '@/server/auth/verify';
import { limiters, OTP_MAX_ATTEMPTS } from '@/server/auth/service';
import { AppFailure } from '@/server/core/failure';

let t: TestDb;
let call: ReturnType<typeof makeClient>;
const outbox: MailMessage[] = [];

beforeAll(async () => {
  t = await createTestDb();
  call = makeClient(t);
  setTokenVerifier(null); // the real FiNN JWT verifier
  setMailSender(async (m) => {
    outbox.push(m);
  });
});
afterAll(async () => {
  setMailSender(null);
  await t.close();
});
beforeEach(() => {
  outbox.length = 0;
  for (const l of Object.values(limiters)) l.reset();
});

const codeIn = (m: MailMessage) => /\b(\d{6})\b/.exec(m.text)![1];

async function expireResendWindow(email: string) {
  await sql`update finn_auth.email_otps set created_at = created_at - interval '2 minutes' where email = ${email}`.execute(t.db);
}

async function signIn(email: string) {
  const sent = await call(otpRoute.POST, 'POST', '/api/v1/auth/otp', { body: { email } });
  expect(sent.status).toBe(200);
  const code = codeIn(outbox.at(-1)!);
  const res = await call(verifyRoute.POST, 'POST', '/api/v1/auth/verify', { body: { email, code } });
  expect(res.status).toBe(200);
  return res.body.data;
}

const bearer = (token: string) => ({ headers: { authorization: `Bearer ${token}` } });

describe('POST /api/v1/auth/otp', () => {
  it('emails a 6-digit code and stores only its hash', async () => {
    const res = await call(otpRoute.POST, 'POST', '/api/v1/auth/otp', { body: { email: '  Asha@Example.com ' } });
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ sent: true, expiresInSeconds: 600, resendAfterSeconds: 60 });
    expect(outbox).toHaveLength(1);
    expect(outbox[0].to).toBe('asha@example.com');
    const code = codeIn(outbox[0]);
    expect(outbox[0].subject).toContain(code);
    const rows = await t.db.selectFrom('finn_auth.email_otps').selectAll().where('email', '=', 'asha@example.com').execute();
    expect(rows).toHaveLength(1);
    expect(rows[0].code_hash).not.toContain(code);
  });

  it('rejects an invalid email', async () => {
    const res = await call(otpRoute.POST, 'POST', '/api/v1/auth/otp', { body: { email: 'not-an-email' } });
    expect(res.status).toBe(422);
    expect(res.body.error?.fieldErrors).toEqual({ email: 'Invalid email address.' });
    expect(outbox).toHaveLength(0);
  });

  it('rejects a non-object body', async () => {
    const res = await call(otpRoute.POST, 'POST', '/api/v1/auth/otp', { body: null });
    expect(res.status).toBe(422);
  });

  it('enforces the resend gap and the hourly limit per email', async () => {
    const email = 'limit@example.com';
    expect((await call(otpRoute.POST, 'POST', '/api/v1/auth/otp', { body: { email } })).status).toBe(200);
    const again = await call(otpRoute.POST, 'POST', '/api/v1/auth/otp', { body: { email } });
    expect(again.status).toBe(503);
    expect(again.body.error?.retryable).toBe(true);
    expect((again.body.error?.details as { retryAfterSeconds: number }).retryAfterSeconds).toBeGreaterThan(0);
    for (let i = 0; i < 4; i++) {
      await expireResendWindow(email);
      expect((await call(otpRoute.POST, 'POST', '/api/v1/auth/otp', { body: { email } })).status).toBe(200);
    }
    await expireResendWindow(email);
    expect((await call(otpRoute.POST, 'POST', '/api/v1/auth/otp', { body: { email } })).status).toBe(503);
  });

  it('limits requests per client IP', async () => {
    const headers = { 'x-forwarded-for': '203.0.113.9' };
    for (let i = 0; i < 10; i++) {
      await call(otpRoute.POST, 'POST', '/api/v1/auth/otp', { body: { email: `ip${i}@example.com` }, headers });
    }
    const res = await call(otpRoute.POST, 'POST', '/api/v1/auth/otp', { body: { email: 'ip99@example.com' }, headers });
    expect(res.status).toBe(503);
  });

  it('drops the code when the mail cannot be sent', async () => {
    setMailSender(async () => {
      throw AppFailure.unavailable('We could not send the email. Please try again in a moment.');
    });
    try {
      const res = await call(otpRoute.POST, 'POST', '/api/v1/auth/otp', { body: { email: 'bounce@example.com' } });
      expect(res.status).toBe(503);
      const rows = await t.db.selectFrom('finn_auth.email_otps').select('id').where('email', '=', 'bounce@example.com').execute();
      expect(rows).toHaveLength(0);
    } finally {
      setMailSender(async (m) => {
        outbox.push(m);
      });
    }
  });
});

describe('POST /api/v1/auth/verify', () => {
  it('creates the account and returns a session the API accepts', async () => {
    const session = await signIn('new.user@example.com');
    expect(session).toMatchObject({ tokenType: 'Bearer', expiresIn: 900, user: { email: 'new.user@example.com' } });
    expect(typeof session.refreshToken).toBe('string');
    const me = await call(meRoute.GET, 'GET', '/api/v1/me', bearer(session.accessToken));
    expect(me.status).toBe(200);
    expect(me.body.data.user.id).toBe(session.user.id);
    expect(me.body.data.user.email).toBe('new.user@example.com');
  });

  it('signs an existing account back in with the same id', async () => {
    const first = await signIn('again@example.com');
    await expireResendWindow('again@example.com');
    const second = await signIn('Again@Example.com');
    expect(second.user.id).toBe(first.user.id);
  });

  it('accepts a code only once', async () => {
    const email = 'once@example.com';
    await call(otpRoute.POST, 'POST', '/api/v1/auth/otp', { body: { email } });
    const code = codeIn(outbox.at(-1)!);
    expect((await call(verifyRoute.POST, 'POST', '/api/v1/auth/verify', { body: { email, code } })).status).toBe(200);
    const reuse = await call(verifyRoute.POST, 'POST', '/api/v1/auth/verify', { body: { email, code } });
    expect(reuse.status).toBe(401);
    expect(reuse.body.error?.message).toBe('The code was invalid or has expired.');
  });

  it('burns the code after too many wrong guesses', async () => {
    const email = 'guess@example.com';
    await call(otpRoute.POST, 'POST', '/api/v1/auth/otp', { body: { email } });
    const code = codeIn(outbox.at(-1)!);
    const wrong = code === '000000' ? '111111' : '000000';
    for (let i = 0; i < OTP_MAX_ATTEMPTS; i++) {
      expect((await call(verifyRoute.POST, 'POST', '/api/v1/auth/verify', { body: { email, code: wrong } })).status).toBe(401);
    }
    expect((await call(verifyRoute.POST, 'POST', '/api/v1/auth/verify', { body: { email, code } })).status).toBe(401);
  });

  it('rejects an expired code', async () => {
    const email = 'late@example.com';
    await call(otpRoute.POST, 'POST', '/api/v1/auth/otp', { body: { email } });
    const code = codeIn(outbox.at(-1)!);
    await sql`update finn_auth.email_otps set expires_at = now() - interval '1 second' where email = ${email}`.execute(t.db);
    expect((await call(verifyRoute.POST, 'POST', '/api/v1/auth/verify', { body: { email, code } })).status).toBe(401);
  });

  it('only the newest code works', async () => {
    const email = 'newest@example.com';
    await call(otpRoute.POST, 'POST', '/api/v1/auth/otp', { body: { email } });
    const old = codeIn(outbox.at(-1)!);
    await expireResendWindow(email);
    await call(otpRoute.POST, 'POST', '/api/v1/auth/otp', { body: { email } });
    const fresh = codeIn(outbox.at(-1)!);
    if (old !== fresh) {
      expect((await call(verifyRoute.POST, 'POST', '/api/v1/auth/verify', { body: { email, code: old } })).status).toBe(401);
    }
    expect((await call(verifyRoute.POST, 'POST', '/api/v1/auth/verify', { body: { email, code: fresh } })).status).toBe(200);
  });

  it('validates the code format', async () => {
    const res = await call(verifyRoute.POST, 'POST', '/api/v1/auth/verify', { body: { email: 'x@example.com', code: '12ab' } });
    expect(res.status).toBe(422);
    expect(res.body.error?.fieldErrors).toEqual({ code: 'Please enter the 6-digit code.' });
  });
});

describe('access tokens', () => {
  it('rejects tampered and foreign tokens', async () => {
    const session = await signIn('tamper@example.com');
    const [h, p, s] = session.accessToken.split('.');
    const tampered = `${h}.${p}.${s.slice(0, -2)}${s.endsWith('AA') ? 'BB' : 'AA'}`;
    expect((await call(meRoute.GET, 'GET', '/api/v1/me', bearer(tampered))).status).toBe(401);
    expect((await call(meRoute.GET, 'GET', '/api/v1/me', bearer('not.a.jwt'))).status).toBe(401);
  });
});

describe('POST /api/v1/auth/refresh and /logout', () => {
  it('rotates the refresh token', async () => {
    const session = await signIn('rotate@example.com');
    const res = await call(refreshRoute.POST, 'POST', '/api/v1/auth/refresh', { body: { refreshToken: session.refreshToken } });
    expect(res.status).toBe(200);
    expect(res.body.data.refreshToken).not.toBe(session.refreshToken);
    expect(res.body.data.user).toEqual(session.user);
    expect((await call(meRoute.GET, 'GET', '/api/v1/me', bearer(res.body.data.accessToken))).status).toBe(200);
  });

  it('revokes the session when a rotated token is reused', async () => {
    const session = await signIn('reuse@example.com');
    const next = (await call(refreshRoute.POST, 'POST', '/api/v1/auth/refresh', { body: { refreshToken: session.refreshToken } })).body.data;
    const replay = await call(refreshRoute.POST, 'POST', '/api/v1/auth/refresh', { body: { refreshToken: session.refreshToken } });
    expect(replay.status).toBe(401);
    // The legitimate holder's newer token is revoked too.
    expect((await call(refreshRoute.POST, 'POST', '/api/v1/auth/refresh', { body: { refreshToken: next.refreshToken } })).status).toBe(401);
  });

  it('rejects unknown and expired refresh tokens', async () => {
    expect((await call(refreshRoute.POST, 'POST', '/api/v1/auth/refresh', { body: { refreshToken: 'x'.repeat(43) } })).status).toBe(401);
    expect((await call(refreshRoute.POST, 'POST', '/api/v1/auth/refresh', { body: {} })).status).toBe(401);
    const session = await signIn('expired@example.com');
    await sql`update finn_auth.refresh_tokens set expires_at = now() - interval '1 second' where user_id = ${session.user.id}`.execute(t.db);
    expect((await call(refreshRoute.POST, 'POST', '/api/v1/auth/refresh', { body: { refreshToken: session.refreshToken } })).status).toBe(401);
  });

  it('logout revokes the session and always succeeds', async () => {
    const session = await signIn('bye@example.com');
    const res = await call(logoutRoute.POST, 'POST', '/api/v1/auth/logout', { body: { refreshToken: session.refreshToken } });
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ signedOut: true });
    expect((await call(refreshRoute.POST, 'POST', '/api/v1/auth/refresh', { body: { refreshToken: session.refreshToken } })).status).toBe(401);
    expect((await call(logoutRoute.POST, 'POST', '/api/v1/auth/logout', { body: {} })).status).toBe(200);
  });
});

describe('finn_auth is private', () => {
  it('is not readable by finn_api, authenticated or anon', async () => {
    for (const role of ['finn_api', 'authenticated', 'anon']) {
      const exists = await sql<{ n: number }>`select count(*)::int as n from pg_roles where rolname = ${role}`.execute(t.db);
      if (exists.rows[0].n === 0) continue;
      await expect(
        t.db.transaction().execute(async (tx) => {
          await sql`select set_config('role', ${role}, true)`.execute(tx);
          await sql`select * from finn_auth.users`.execute(tx);
        }),
      ).rejects.toThrow(/permission denied/);
    }
  });
});
