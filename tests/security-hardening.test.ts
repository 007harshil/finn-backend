// Regression tests for the 2026-10-19 security audit fixes: global OTP send
// budget, durable agent budgets shared across instances, account recheck after
// deletion, cursor validation, and friend-only locking. Providers are stubbed.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { sql } from 'kysely';
import * as otpRoute from '@/app/api/v1/auth/otp/route';
import * as completionsRoute from '@/app/api/v1/agent/completions/route';
import * as transactionsRoute from '@/app/api/v1/transactions/route';
import * as friendRoute from '@/app/api/v1/friends/[userId]/route';
import * as meRoute from '@/app/api/v1/me/route';
import { limiters } from '@/server/auth/service';
import { resetAgentRateLimits } from '@/server/agent/rate-limit';
import { setMailSender, type MailMessage } from '@/server/mail/mailer';
import { createTestDb, type TestDb } from './support/db';
import { makeClient } from './support/http';

let t: TestDb;
let call: ReturnType<typeof makeClient>;
const outbox: MailMessage[] = [];

beforeAll(async () => {
  t = await createTestDb();
  call = makeClient(t);
  setMailSender(async (m) => {
    outbox.push(m);
  });
});
afterAll(async () => {
  setMailSender(null);
  await t.close();
});
beforeEach(async () => {
  outbox.length = 0;
  for (const l of Object.values(limiters)) l.reset();
  resetAgentRateLimits();
  await sql`delete from finn_auth.email_otps`.execute(t.db);
  await sql`delete from finn_auth.agent_usage`.execute(t.db);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('global OTP send budget', () => {
  it('stops mailing distinct addresses past the hourly cap, whatever the client IP', async () => {
    vi.stubEnv('AUTH_OTP_GLOBAL_HOURLY_LIMIT', '3');
    for (let i = 0; i < 3; i++) {
      const res = await call(otpRoute.POST, 'POST', '/api/v1/auth/otp', {
        body: { email: `anon${i}@example.com` },
        headers: { 'x-forwarded-for': `10.0.0.${i}` },
      });
      expect(res.status).toBe(200);
    }
    const res = await call(otpRoute.POST, 'POST', '/api/v1/auth/otp', {
      body: { email: 'anon9@example.com' },
      headers: { 'x-forwarded-for': '10.0.0.9' },
    });
    expect(res.status).toBe(503);
    expect(res.body.error?.code).toBe('unavailable');
    expect(outbox).toHaveLength(3);
  });

  it('never blocks existing accounts: a full budget only pauses new sign-ups', async () => {
    vi.stubEnv('AUTH_OTP_GLOBAL_HOURLY_LIMIT', '1');
    await t.createUser('known@example.com');
    expect((await call(otpRoute.POST, 'POST', '/api/v1/auth/otp', { body: { email: 'stranger1@example.com' } })).status).toBe(200);
    expect((await call(otpRoute.POST, 'POST', '/api/v1/auth/otp', { body: { email: 'stranger2@example.com' } })).status).toBe(503);
    expect((await call(otpRoute.POST, 'POST', '/api/v1/auth/otp', { body: { email: 'known@example.com' } })).status).toBe(200);
    expect(outbox.map((m) => m.to)).toEqual(['stranger1@example.com', 'known@example.com']);
  });

  it('also caps the rolling 24 hours', async () => {
    vi.stubEnv('AUTH_OTP_GLOBAL_DAILY_LIMIT', '1');
    expect((await call(otpRoute.POST, 'POST', '/api/v1/auth/otp', { body: { email: 'a@example.com' } })).status).toBe(200);
    // Older than an hour, so only the daily cap applies.
    await sql`update finn_auth.email_otps set created_at = now() - interval '3 hours'`.execute(t.db);
    expect((await call(otpRoute.POST, 'POST', '/api/v1/auth/otp', { body: { email: 'b@example.com' } })).status).toBe(503);
    expect(outbox).toHaveLength(1);
  });
});

describe('durable agent budgets', () => {
  const upstreamOk = {
    id: 'chatcmpl_1',
    choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'Your goals look fine.' } }],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  };
  const body = { messages: [{ role: 'user', content: 'How are my goals?' }] };

  beforeEach(() => {
    vi.stubEnv('OPENAI_API_KEY', 'sk-fake-test-key-123');
    vi.stubEnv('OPENAI_BASE_URL', 'https://openai.test/v1');
    vi.stubEnv('AGENT_MODERATION', 'off');
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(JSON.stringify(upstreamOk), { status: 200 }));
  });

  it('keeps the per-user daily limit when another instance (fresh in-memory limiter) serves the user', async () => {
    vi.stubEnv('AGENT_DAILY_REQUEST_LIMIT', '2');
    const u = await t.createUser();
    for (let i = 0; i < 2; i++) {
      expect((await call(completionsRoute.POST, 'POST', '/api/v1/agent/completions', { user: u, body })).status).toBe(200);
      resetAgentRateLimits(); // as if the next request landed on a new instance
    }
    const res = await call(completionsRoute.POST, 'POST', '/api/v1/agent/completions', { user: u, body });
    expect(res.status).toBe(503);
    expect(res.body.error?.details).toMatchObject({ reason: 'rateLimited', scope: 'user' });
    expect(globalThis.fetch).toHaveBeenCalledTimes(2);
  });

  it('caps all accounts together per day, so new accounts cannot multiply spend', async () => {
    vi.stubEnv('AGENT_GLOBAL_DAILY_REQUEST_LIMIT', '2');
    for (let i = 0; i < 2; i++) {
      const u = await t.createUser();
      expect((await call(completionsRoute.POST, 'POST', '/api/v1/agent/completions', { user: u, body })).status).toBe(200);
    }
    const res = await call(completionsRoute.POST, 'POST', '/api/v1/agent/completions', { user: await t.createUser(), body });
    expect(res.status).toBe(503);
    expect(res.body.error?.details).toMatchObject({ reason: 'rateLimited', scope: 'global' });
  });

  it('keeps throwaway accounts in their own pool, so established users keep working', async () => {
    vi.stubEnv('AGENT_NEW_ACCOUNT_DAILY_REQUEST_LIMIT', '2');
    const veteran = await t.createUser();
    await sql`update finn_auth.users set created_at = now() - interval '30 days' where id = ${veteran.userId}`.execute(t.db);
    for (let i = 0; i < 2; i++) {
      const fresh = await t.createUser();
      expect((await call(completionsRoute.POST, 'POST', '/api/v1/agent/completions', { user: fresh, body })).status).toBe(200);
    }
    const res = await call(completionsRoute.POST, 'POST', '/api/v1/agent/completions', { user: await t.createUser(), body });
    expect(res.status).toBe(503);
    expect(res.body.error?.details).toMatchObject({ reason: 'rateLimited', scope: 'newAccounts' });
    expect((await call(completionsRoute.POST, 'POST', '/api/v1/agent/completions', { user: veteran, body })).status).toBe(200);
  });

  it('does not count requests the input guardrail refuses', async () => {
    vi.stubEnv('AGENT_DAILY_REQUEST_LIMIT', '1');
    const u = await t.createUser();
    const offTopic = { messages: [{ role: 'user', content: 'Write a Python function that adds two numbers.' }] };
    expect((await call(completionsRoute.POST, 'POST', '/api/v1/agent/completions', { user: u, body: offTopic })).status).toBe(200);
    expect(globalThis.fetch).not.toHaveBeenCalled();
    resetAgentRateLimits();
    expect((await call(completionsRoute.POST, 'POST', '/api/v1/agent/completions', { user: u, body })).status).toBe(200);
  });

  it('budgets request bytes, not just request count', async () => {
    vi.stubEnv('AGENT_DAILY_INPUT_BYTES', '1000');
    const u = await t.createUser();
    const big = { messages: [{ role: 'user', content: 'How are my goals? '.repeat(80) }] };
    const res = await call(completionsRoute.POST, 'POST', '/api/v1/agent/completions', { user: u, body: big });
    expect(res.status).toBe(503);
    expect(res.body.error?.details).toMatchObject({ scope: 'user' });
    expect(globalThis.fetch).not.toHaveBeenCalled();
    // A refused request is not counted.
    const row = await sql<{ n: number }>`select count(*)::int as n from finn_auth.agent_usage`.execute(t.db);
    expect(row.rows[0].n).toBe(0);
  });
});

describe('account recheck after deletion on another instance', () => {
  it('rejects a leftover access token once the cached check is older than a minute', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const u = await t.createUser();
    expect((await call(meRoute.GET, 'GET', '/api/v1/me', { user: u })).status).toBe(200);
    // Deleted elsewhere: this instance never hears about it (no forgetBootstrap).
    await sql`delete from finn_auth.users where id = ${u.userId}`.execute(t.db);
    vi.setSystemTime(Date.now() + 61_000);
    expect((await call(meRoute.GET, 'GET', '/api/v1/me', { user: u })).status).toBe(401);
  });
});

describe('transactions cursor', () => {
  it('answers a forged cursor with a validation error, not a database error', async () => {
    const u = await t.createUser();
    for (const key of [
      { d: '2026-02-31', a: 1, c: '2026-01-01T00:00:00Z', i: 'x' },
      { d: '2026-01-01', a: 1, c: 'not-a-time', i: 'x' },
      { d: '2026-01-01', a: 1.5, c: '2026-01-01T00:00:00Z', i: 'x' },
    ]) {
      const cursor = Buffer.from(JSON.stringify(key)).toString('base64url');
      const res = await call(transactionsRoute.GET, 'GET', '/api/v1/transactions', { user: u, query: { cursor } });
      expect(res.status).toBe(422);
    }
  });
});

describe('removing a friend', () => {
  it('refuses a stranger id without taking their lock', async () => {
    const a = await t.createUser();
    const stranger = await t.createUser();
    const res = await call(friendRoute.DELETE, 'DELETE', `/api/v1/friends/${stranger.userId}`, {
      user: a,
      params: { userId: stranger.userId },
    });
    expect(res.status).toBe(404);
  });
});
