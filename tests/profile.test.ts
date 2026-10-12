import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as meRoute from '@/app/api/v1/me/route';
import * as handleRoute from '@/app/api/v1/me/handle/route';
import * as prefsRoute from '@/app/api/v1/preferences/route';
import { createTestDb, type TestDb } from './support/db';
import { makeClient, newKey } from './support/http';
import { act, fixClock, read } from './support/actions';
import { dispatch, previewAction } from '@/server/actions/dispatcher';
import type { AuthUser } from '@/server/auth/verify';
import { ensureAccount } from '@/server/modules/account/bootstrap';
import { withUserTx } from '@/server/db/tx';

let t: TestDb;
let call: ReturnType<typeof makeClient>;
let alice: AuthUser;
let bob: AuthUser;

beforeAll(async () => {
  t = await createTestDb();
  call = makeClient(t);
  fixClock();
  alice = await t.createUser('alice@example.com');
  bob = await t.createUser('bob@example.com');
  for (const u of [alice, bob]) await withUserTx(u, (tx) => ensureAccount(tx, u), { write: true });
});

afterAll(async () => t.close());

const profile = (extra: Record<string, unknown> = {}) => ({
  displayName: 'Test',
  openingBalance: 100000,
  openingDate: '2026-01-01',
  ...extra,
});

describe('profile.update', () => {
  it('first profile (onboarding) needs no review and sets cash', async () => {
    const me0 = await call(meRoute.GET, 'GET', '/api/v1/me', { user: alice });
    expect(me0.body.data.profile).toEqual({ exists: false });
    const out = await dispatch(alice, 'profile.update', profile({ openingBalance: 25000 }), { idempotencyKey: newKey() });
    expect(out.status).toBe('completed');
    expect((await read(alice, (s) => s.balance())).cashPaise).toBe(2_500_000);
    const me = await call(meRoute.GET, 'GET', '/api/v1/me', { user: alice });
    expect(me.body.data.profile).toMatchObject({ exists: true, displayName: 'Test', openingPaise: 2_500_000, openingDate: '2026-01-01', monthlyIncomeEstimatePaise: null });
    expect(me.body.data.user).toMatchObject({ name: 'Test', email: 'alice@example.com' });
    expect(me.body.data.preferences.monthStartDay).toBe(1);
  });

  it('renaming does not need review and keeps balances', async () => {
    const before = await read(alice, (s) => s.balance());
    const out: any = await dispatch(alice, 'profile.update', profile({ displayName: '  Asha ', openingBalance: 25000, monthlyIncomeEstimate: 90000 }), {
      idempotencyKey: newKey(),
    });
    expect(out.status).toBe('completed');
    expect(out.preview.summary).toBe('Profile updated');
    expect(out.result).toMatchObject({ exists: true, displayName: 'Asha', monthlyIncomeEstimatePaise: 9_000_000 });
    expect((await read(alice, (s) => s.balance())).cashPaise).toBe(before.cashPaise);
  });

  it('changing the opening balance previews new cash and needs review', async () => {
    await act(alice, 'transactions.create', { type: 'expense', amount: 5000, categoryId: 'cat_rent', date: '2026-03-01' });
    // cash now 25,000 - 5,000 = 20,000
    const input = profile({ displayName: 'Asha', openingBalance: 45000 });
    const preview = await previewAction(alice, 'profile.update', input);
    expect(preview.requiresConfirmation).toBe(true);
    expect(preview.lines.find((l) => l.label === 'Cash balance')!.value).toBe('₹20,000 → ₹40,000');
    expect(preview.warnings[0]).toContain('+₹20,000 change to cash');
    await act(alice, 'profile.update', input);
    expect((await read(alice, (s) => s.balance())).cashPaise).toBe(4_000_000);
    const me = await call(meRoute.GET, 'GET', '/api/v1/me', { user: alice });
    expect(me.body.data.profile.openingPaise).toBe(4_500_000);
  });

  it('moving the start date later drops earlier transactions', async () => {
    const before = await read(alice, (s) => s.balance());
    await act(alice, 'profile.update', profile({ displayName: 'Asha', openingBalance: 45000, openingDate: '2026-04-01' }));
    const after = await read(alice, (s) => s.balance());
    expect(after.cashPaise - before.cashPaise).toBe(500_000);
  });

  it('warns when cash would fall below earmarked savings', async () => {
    await t.pglite.query(
      `insert into public.savings_movements (user_id, id, bucket_type, bucket_id, kind, amount_paise, date)
       values ($1, 'mv1', 'emergencyFund', 'emergency_fund', 'contribution', 6000000, '2026-05-01')`,
      [alice.userId],
    );
    const preview = await previewAction(alice, 'profile.update', profile({ displayName: 'Asha', openingBalance: 50000, openingDate: '2026-04-01' }));
    expect(preview.warnings.at(-1)).toMatch(/^Cash would be less than the ₹60,000 earmarked/);
    const unaffected = await previewAction(alice, 'profile.update', profile({ displayName: 'Asha', openingBalance: 450000, openingDate: '2026-04-01' }));
    expect(unaffected.warnings).toHaveLength(1);
  });

  it('validates fields', async () => {
    const fields = async (input: Record<string, unknown>) => {
      try {
        await previewAction(alice, 'profile.update', input);
        return [];
      } catch (e: any) {
        return Object.keys(e.fieldErrors ?? {});
      }
    };
    expect(await fields(profile({ displayName: ' ' }))).toEqual(['displayName']);
    expect(await fields(profile({ displayName: 'x'.repeat(41) }))).toEqual(['displayName']);
    expect(await fields(profile({ openingBalance: -1 }))).toEqual(['openingBalance']);
    expect(await fields(profile({ openingDate: '2026-10-11' }))).toEqual(['openingDate']);
    expect(await fields(profile({ monthlyIncomeEstimate: -1 }))).toEqual(['monthlyIncomeEstimate']);
    await act(alice, 'profile.update', profile({ displayName: 'Asha', openingBalance: 0, openingDate: '2026-10-10' }));
  });

  it("does not touch another user's profile", async () => {
    const me = await call(meRoute.GET, 'GET', '/api/v1/me', { user: bob });
    expect(me.body.data.profile).toEqual({ exists: false });
    expect(me.body.data.user.email).toBe('bob@example.com');
  });
});

describe('preferences', () => {
  it('returns defaults and applies partial updates', async () => {
    const got = await call(prefsRoute.GET, 'GET', '/api/v1/preferences', { user: bob });
    expect(got.body.data).toEqual({
      monthStartDay: 1,
      emiReminderDays: 5,
      subscriptionReminderDays: 3,
      lowEmergencyCoverageMonths: 3,
      defaultBudgetWarningBps: 8000,
      disabledAlertTypes: [],
      timeZone: 'Asia/Kolkata',
    });
    const res = await call(prefsRoute.PATCH, 'PATCH', '/api/v1/preferences', {
      user: bob,
      body: { monthStartDay: 5, disabledAlertTypes: ['emiDue', 'goalMilestone', 'emiDue'], timeZone: 'Asia/Dubai' },
    });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ monthStartDay: 5, emiReminderDays: 5, disabledAlertTypes: ['emiDue', 'goalMilestone'], timeZone: 'Asia/Dubai' });
    // persisted, and isolated from alice
    expect((await call(prefsRoute.GET, 'GET', '/api/v1/preferences', { user: bob })).body.data.monthStartDay).toBe(5);
    expect((await call(prefsRoute.GET, 'GET', '/api/v1/preferences', { user: alice })).body.data.monthStartDay).toBe(1);
  });

  it('validates ranges, alert types and time zone', async () => {
    const bad = async (body: Record<string, unknown>) => {
      const r = await call(prefsRoute.PATCH, 'PATCH', '/api/v1/preferences', { user: alice, body });
      expect(r.status).toBe(422);
      return Object.keys(r.body.error!.fieldErrors ?? {});
    };
    expect(await bad({ monthStartDay: 0 })).toEqual(['monthStartDay']);
    expect(await bad({ monthStartDay: 29 })).toEqual(['monthStartDay']);
    expect(await bad({ emiReminderDays: 31 })).toEqual(['emiReminderDays']);
    expect(await bad({ lowEmergencyCoverageMonths: 0 })).toEqual(['lowEmergencyCoverageMonths']);
    expect(await bad({ defaultBudgetWarningBps: 4999 })).toEqual(['defaultBudgetWarningBps']);
    expect(await bad({ defaultBudgetWarningBps: 9501 })).toEqual(['defaultBudgetWarningBps']);
    expect(await bad({ disabledAlertTypes: ['nope'] })).toEqual(['disabledAlertTypes.0']);
    expect(await bad({ timeZone: 'Mars/Olympus' })).toEqual(['timeZone']);
    expect(await bad({ unknownKey: 1 })).toHaveLength(1);
  });

  it('time zone change shifts "today"', async () => {
    await call(prefsRoute.PATCH, 'PATCH', '/api/v1/preferences', { user: alice, body: { timeZone: 'Pacific/Kiritimati' } });
    const today = await read(alice, async (s) => s.today);
    expect(today).toBe('2026-10-10');
    await call(prefsRoute.PATCH, 'PATCH', '/api/v1/preferences', { user: alice, body: { timeZone: 'Asia/Kolkata' } });
  });
});

describe('handle', () => {
  it('changes the handle, normalising case', async () => {
    const r = await call(handleRoute.PATCH, 'PATCH', '/api/v1/me/handle', { user: alice, body: { handle: ' @Alice.Fin ' } });
    expect(r.status).toBe(200);
    expect(r.body.data).toEqual({ handle: '@alice.fin' });
    expect((await call(meRoute.GET, 'GET', '/api/v1/me', { user: alice })).body.data.user.handle).toBe('@alice.fin');
  });

  it('rejects bad formats', async () => {
    for (const handle of ['alice', '@ab', '@has space', `@${'a'.repeat(31)}`, '@bad-dash']) {
      const r = await call(handleRoute.PATCH, 'PATCH', '/api/v1/me/handle', { user: alice, body: { handle } });
      expect(r.status).toBe(422);
    }
  });

  it('409 when taken by another user, case-insensitively; own handle is fine', async () => {
    const r = await call(handleRoute.PATCH, 'PATCH', '/api/v1/me/handle', { user: bob, body: { handle: '@ALICE.fin' } });
    expect(r.status).toBe(409);
    expect(r.body.error!.code).toBe('conflict');
    expect(r.body.error!.message).toBe('That handle is already taken. Try another.');
    const same = await call(handleRoute.PATCH, 'PATCH', '/api/v1/me/handle', { user: alice, body: { handle: '@alice.fin' } });
    expect(same.status).toBe(200);
  });
});
