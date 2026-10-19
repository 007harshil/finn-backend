// Store-review sign-in: REVIEW_EMAIL gets the fixed REVIEW_CODE without an
// email, keeps the normal attempt limits, and starts with demo data.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as otpRoute from '@/app/api/v1/auth/otp/route';
import * as verifyRoute from '@/app/api/v1/auth/verify/route';
import { createTestDb, type TestDb } from './support/db';
import { makeClient } from './support/http';
import { setMailSender, type MailMessage } from '@/server/mail/mailer';
import { setTokenVerifier } from '@/server/auth/verify';
import { limiters, OTP_MAX_ATTEMPTS } from '@/server/auth/service';
import { demoPayload } from '@/server/auth/review-account';
import { importSchema } from '@/server/modules/sync/import';

let t: TestDb;
let call: ReturnType<typeof makeClient>;
const outbox: MailMessage[] = [];
const REVIEW = 'play-review@finn.test';
const CODE = '730514';

beforeAll(async () => {
  t = await createTestDb();
  call = makeClient(t);
  setTokenVerifier(null);
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
  process.env.REVIEW_EMAIL = REVIEW;
  process.env.REVIEW_CODE = CODE;
});
afterEach(() => {
  delete process.env.REVIEW_EMAIL;
  delete process.env.REVIEW_CODE;
});

const requestCode = (email: string) => call(otpRoute.POST, 'POST', '/api/v1/auth/otp', { body: { email } });
const verify = (email: string, code: string) => call(verifyRoute.POST, 'POST', '/api/v1/auth/verify', { body: { email, code } });

async function userIdOf(email: string) {
  return (await t.db.selectFrom('finn_auth.users').select('id').where('email', '=', email).executeTakeFirstOrThrow()).id;
}

describe('review sign-in', () => {
  it('signs in with the fixed code, sends no email, and seeds demo data once', async () => {
    expect((await requestCode('  Play-Review@FINN.test ')).status).toBe(200);
    expect(outbox).toHaveLength(0);
    const res = await verify(REVIEW, CODE);
    expect(res.status).toBe(200);

    const userId = await userIdOf(REVIEW);
    const count = async () =>
      Number((await t.db.selectFrom('transactions').select((eb) => eb.fn.countAll().as('n')).where('user_id', '=', userId).executeTakeFirstOrThrow()).n);
    const first = await count();
    expect(first).toBeGreaterThan(10);
    const goals = await t.db.selectFrom('goals').select('name').where('user_id', '=', userId).execute();
    expect(goals.map((g) => g.name)).toEqual(['Goa trip']);

    // A second sign-in does not seed again.
    await t.db.updateTable('finn_auth.email_otps').set({ created_at: new Date(Date.now() - 120_000) }).where('email', '=', REVIEW).execute();
    expect((await requestCode(REVIEW)).status).toBe(200);
    expect((await verify(REVIEW, CODE)).status).toBe(200);
    expect(await count()).toBe(first);
  });

  it('keeps the attempt limit: the code burns after too many wrong guesses', async () => {
    const email = 'review-burn@finn.test';
    process.env.REVIEW_EMAIL = email;
    await requestCode(email);
    for (let i = 0; i < OTP_MAX_ATTEMPTS; i++) expect((await verify(email, '000000')).status).toBe(401);
    expect((await verify(email, CODE)).status).toBe(401);
  });

  it('other addresses still get an emailed random code', async () => {
    await requestCode('someone@finn.test');
    expect(outbox).toHaveLength(1);
    expect((await verify('someone@finn.test', CODE)).status).toBe(401);
  });

  it('is off when REVIEW_CODE is not set', async () => {
    delete process.env.REVIEW_CODE;
    const email = 'review-off@finn.test';
    process.env.REVIEW_EMAIL = email;
    await requestCode(email);
    expect(outbox).toHaveLength(1);
    expect((await verify(email, CODE)).status).toBe(401);
  });

  it('demo payload passes import validation for any day of the month', () => {
    for (const day of ['2026-01-01', '2026-02-28', '2026-03-31', '2026-10-20']) {
      expect(() => importSchema.parse(demoPayload(day, new Date(`${day}T06:00:00Z`)))).not.toThrow();
    }
  });
});
