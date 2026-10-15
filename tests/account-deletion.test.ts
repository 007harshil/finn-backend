// Account deletion: confirmed by an emailed code that only works for deletion,
// it erases the account and every row that belongs to it, ends all sessions,
// and unlinks shared items from the other person without touching their data.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as otpRoute from '@/app/api/v1/auth/otp/route';
import * as verifyRoute from '@/app/api/v1/auth/verify/route';
import * as refreshRoute from '@/app/api/v1/auth/refresh/route';
import * as meRoute from '@/app/api/v1/me/route';
import * as deleteRoute from '@/app/api/v1/me/delete/route';
import * as deleteCodeRoute from '@/app/api/v1/me/delete/code/route';
import { createTestDb, type TestDb } from './support/db';
import { makeClient } from './support/http';
import { act, fixClock, read } from './support/actions';
import { setMailSender, type MailMessage } from '@/server/mail/mailer';
import { setTokenVerifier, type AuthUser } from '@/server/auth/verify';
import { limiters, OTP_MAX_ATTEMPTS } from '@/server/auth/service';
import { loadPendingViews } from '@/server/modules/pending/service';

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
  fixClock();
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
const bearer = (token: string) => ({ headers: { authorization: `Bearer ${token}` } });

interface Signed {
  user: AuthUser;
  accessToken: string;
  refreshToken: string;
}

async function signIn(email: string): Promise<Signed> {
  await t.pglite.query(`update finn_auth.email_otps set created_at = created_at - interval '2 minutes' where email = $1`, [email]);
  expect((await call(otpRoute.POST, 'POST', '/api/v1/auth/otp', { body: { email } })).status).toBe(200);
  const res = await call(verifyRoute.POST, 'POST', '/api/v1/auth/verify', { body: { email, code: codeIn(outbox.at(-1)!) } });
  expect(res.status).toBe(200);
  const s = res.body.data;
  // First authenticated request bootstraps the account.
  expect((await call(meRoute.GET, 'GET', '/api/v1/me', bearer(s.accessToken))).status).toBe(200);
  return {
    user: { userId: s.user.id, email: s.user.email, claims: { sub: s.user.id, role: 'authenticated', email: s.user.email } },
    accessToken: s.accessToken,
    refreshToken: s.refreshToken,
  };
}

async function requestCode(s: Signed): Promise<string> {
  await t.pglite.query(`update finn_auth.email_otps set created_at = created_at - interval '2 minutes' where email = $1`, [s.user.email]);
  const res = await call(deleteCodeRoute.POST, 'POST', '/api/v1/me/delete/code', bearer(s.accessToken));
  expect(res.status).toBe(200);
  expect(res.body.data).toEqual({ sent: true, expiresInSeconds: 600, resendAfterSeconds: 60 });
  return codeIn(outbox.at(-1)!);
}

const deleteWith = (s: Signed, code: unknown) => call(deleteRoute.POST, 'POST', '/api/v1/me/delete', { ...bearer(s.accessToken), body: { code } });

/** Rows per table in every table that references finn_auth.users, for [userId]. */
async function rowsOwnedBy(userId: string): Promise<Record<string, number>> {
  const fks = await t.pglite.query<{ tbl: string; col: string }>(`
    select con.conrelid::regclass::text as tbl, a.attname as col
    from pg_constraint con
    join pg_attribute a on a.attrelid = con.conrelid and a.attnum = con.conkey[1]
    where con.contype = 'f' and con.confrelid = 'finn_auth.users'::regclass`);
  const counts: Record<string, number> = {};
  for (const { tbl, col } of fks.rows) {
    const r = await t.pglite.query<{ n: number }>(`select count(*)::int as n from ${tbl} where ${col} = $1`, [userId]);
    counts[`${tbl}.${col}`] = r.rows[0].n;
  }
  return counts;
}

describe('POST /api/v1/me/delete/code', () => {
  it('emails a deletion code to the account address; it cannot be used to sign in', async () => {
    const s = await signIn('carol@example.com');
    const code = await requestCode(s);
    expect(outbox.at(-1)!.to).toBe('carol@example.com');
    expect(outbox.at(-1)!.subject).toBe(`${code} is your FiNN account deletion code`);
    const signInTry = await call(verifyRoute.POST, 'POST', '/api/v1/auth/verify', { body: { email: 'carol@example.com', code } });
    expect(signInTry.status).toBe(401);
  });

  it('requires a signed-in user', async () => {
    expect((await call(deleteCodeRoute.POST, 'POST', '/api/v1/me/delete/code')).status).toBe(401);
    expect((await call(deleteRoute.POST, 'POST', '/api/v1/me/delete', { body: { code: '123456' } })).status).toBe(401);
  });
});

describe('POST /api/v1/me/delete', () => {
  it('a sign-in code cannot delete the account', async () => {
    const s = await signIn('dave@example.com');
    await t.pglite.query(`update finn_auth.email_otps set created_at = created_at - interval '2 minutes' where email = 'dave@example.com'`);
    await call(otpRoute.POST, 'POST', '/api/v1/auth/otp', { body: { email: 'dave@example.com' } });
    const res = await deleteWith(s, codeIn(outbox.at(-1)!));
    expect(res.status).toBe(422);
    expect((await call(meRoute.GET, 'GET', '/api/v1/me', bearer(s.accessToken))).status).toBe(200);
  });

  it('a wrong code is a field error, keeps the session, and burns the code after too many tries', async () => {
    const s = await signIn('erin@example.com');
    const code = await requestCode(s);
    const wrong = code === '000000' ? '111111' : '000000';
    const res = await deleteWith(s, wrong);
    expect(res.status).toBe(422);
    expect(res.body.error!.fieldErrors).toEqual({ code: 'The code was invalid or has expired.' });
    expect((await deleteWith(s, '12')).body.error!.fieldErrors).toEqual({ code: 'Please enter the 6-digit code.' });
    for (let i = 1; i < OTP_MAX_ATTEMPTS; i++) await deleteWith(s, wrong);
    expect((await deleteWith(s, code)).status).toBe(422);
    expect((await call(meRoute.GET, 'GET', '/api/v1/me', bearer(s.accessToken))).status).toBe(200);
    expect(Object.values(await rowsOwnedBy(s.user.userId)).some((n) => n > 0)).toBe(true);
  });

  it('erases the account and all of its data, ends its sessions and unlinks shared items', async () => {
    const alice = await signIn('alice@example.com');
    const bob = await signIn('bob@example.com');
    const a = alice.user;
    const b = bob.user;

    await act(a, 'transactions.create', { type: 'income', amount: '100000', categoryId: 'cat_salary', date: '2026-10-01' });
    const loan = await act(a, 'loans.create', {
      name: 'Car loan', counterparty: 'HDFC Bank', direction: 'borrowed', structure: 'amortizing', principal: 600000, rateBps: 950,
      startDate: '2026-09-01', firstDueDate: '2026-10-05', frequency: 'monthly', tenureInstallments: 60, maturityDate: null,
      prepaymentStrategy: 'reduceTenure', recordDisbursement: true, note: null,
    });
    await act(a, 'loans.recordPayment', { loanId: loan.id, kind: 'installment', amount: 12602, date: '2026-10-05' });
    const goal = await act(a, 'goals.create', { name: 'Japan trip', category: 'travel', target: '200000', colorIndex: 2 });
    await act(a, 'goals.contribute', { goalId: goal.id, amount: 3000, date: '2026-10-10' });
    await act(a, 'assets.create', { name: 'Gold coins', type: 'gold', value: 95000, valuedOn: '2026-10-01' });
    const shared = { counterparty: 'x', direction: 'iOwe', kind: 'borrowed', amount: '1000', purpose: 'Dinner', createdDate: '2026-10-01' };
    const mine = await act(a, 'pending.create', { ...shared, linkedUserId: b.userId });
    const bobs = await act(b, 'pending.create', { ...shared, amount: '500', purpose: 'Cab', linkedUserId: a.userId });
    await act(a, 'pending.settle', { pendingId: mine.id, amount: '200', date: '2026-10-10', channel: 'UPI' });
    const sbi = await act(a, 'accounts.create', { name: 'SBI', kind: 'bank', openingBalance: '5000', openingDate: '2026-01-01' });
    await act(a, 'transfers.create', { fromAccountId: sbi.id, toAccountId: 'acc_cash', amount: '1000', date: '2026-10-02', channel: 'ATM' });

    const before = await rowsOwnedBy(a.userId);
    expect(before['transactions.user_id']).toBeGreaterThan(0);
    expect(before['loan_payments.user_id']).toBe(1);
    expect(before['assets.user_id']).toBe(1);
    expect(before['money_accounts.user_id']).toBe(2);
    expect(before['transfers.user_id']).toBe(1);
    expect(before['pending_payments.shared_with_user_id']).toBe(1);

    const code = await requestCode(alice);
    outbox.length = 0;
    const res = await deleteWith(alice, code);
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ deleted: true });

    // Nothing of Alice is left anywhere, including her sign-in codes.
    expect(Object.values(await rowsOwnedBy(a.userId)).every((n) => n === 0)).toBe(true);
    expect((await t.pglite.query(`select 1 from finn_auth.users where id = $1`, [a.userId])).rows).toHaveLength(0);
    expect((await t.pglite.query(`select 1 from finn_auth.email_otps where email = 'alice@example.com'`)).rows).toHaveLength(0);

    // Sessions are over: refresh fails and the leftover access token is refused.
    expect((await call(refreshRoute.POST, 'POST', '/api/v1/auth/refresh', { body: { refreshToken: alice.refreshToken } })).status).toBe(401);
    expect((await call(meRoute.GET, 'GET', '/api/v1/me', bearer(alice.accessToken))).status).toBe(401);

    // A goodbye notice is mailed.
    expect(outbox).toHaveLength(1);
    expect(outbox[0]).toMatchObject({ to: 'alice@example.com', subject: 'Your FiNN account was deleted' });

    // Bob keeps his own item, now unlinked, and gets tombstones for Alice's.
    const bobItem = await t.pglite.query<{ shared_with_user_id: string | null }>(`select shared_with_user_id from pending_payments where user_id = $1 and id = $2`, [b.userId, bobs.id]);
    expect(bobItem.rows).toEqual([{ shared_with_user_id: null }]);
    const tombstones = await t.pglite.query<{ collection: string; record_id: string }>(
      `select collection, record_id from deleted_records where user_id = $1 order by collection`,
      [b.userId],
    );
    expect(tombstones.rows).toEqual(
      expect.arrayContaining([
        { collection: 'pending', record_id: `mir_${mine.link.sharedId}` },
        { collection: 'settlements', record_id: expect.stringMatching(/^mir_/) },
      ]),
    );
    const views = await read(b, (s) => loadPendingViews(s));
    expect(views.map((v) => v.id)).toEqual([bobs.id]);
    expect((await call(meRoute.GET, 'GET', '/api/v1/me', bearer(bob.accessToken))).status).toBe(200);

    // The same email can sign up again and starts with a new, empty account.
    const again = await signIn('alice@example.com');
    expect(again.user.userId).not.toBe(a.userId);
    const fresh = await rowsOwnedBy(again.user.userId);
    expect(fresh['transactions.user_id']).toBe(0);
    expect(fresh['profiles.user_id']).toBe(1);
  });
});
