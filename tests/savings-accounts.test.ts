import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb, type TestDb } from './support/db';
import { act, fixClock, read } from './support/actions';
import type { AuthUser } from '@/server/auth/verify';

let t: TestDb;

beforeAll(async () => {
  t = await createTestDb();
  fixClock(); // today = 2026-10-10
});
afterAll(async () => t.close());

const rs = (n: number) => n * 100;

const rows = async (u: AuthUser) => {
  const b = await read(u, (s) => s.balance());
  return { b, by: Object.fromEntries(b.accounts.map((a) => [a.accountId, a])) };
};

/** Two accounts: SBI 10,000 and HDFC 4,000, plus the empty Cash account. */
async function setup() {
  const u = await t.createUser();
  const sbi = await act<{ id: string }>(u, 'accounts.create', { name: 'SBI', kind: 'bank', openingBalance: '10000', openingDate: '2026-10-01' });
  const hdfc = await act<{ id: string }>(u, 'accounts.create', { name: 'HDFC', kind: 'bank', openingBalance: '4000', openingDate: '2026-10-01' });
  return { u, sbi: sbi.id, hdfc: hdfc.id };
}

describe('set aside on an account', () => {
  it('a contribution lowers available (account and total) but never the balance', async () => {
    const { u, sbi, hdfc } = await setup();
    const goal = await act<{ id: string }>(u, 'goals.create', { name: 'Trip', target: '50000' });
    await act(u, 'goals.contribute', { goalId: goal.id, amount: '3000', accountId: sbi, date: '2026-10-05' });
    await act(u, 'emergencyFund.contribute', { amount: '1000', accountId: sbi, date: '2026-10-05' });
    const { b, by } = await rows(u);
    expect(by[sbi]).toMatchObject({ balancePaise: rs(10000), earmarkedPaise: rs(4000), availablePaise: rs(6000) });
    expect(by[hdfc]).toMatchObject({ balancePaise: rs(4000), earmarkedPaise: 0, availablePaise: rs(4000) });
    expect(b).toMatchObject({ cashPaise: rs(14000), earmarkedPaise: rs(4000), availablePaise: rs(10000), earmarkedUnassignedPaise: 0 });
  });

  it('cannot set aside more than the account has free, even if other accounts do', async () => {
    const { u, sbi, hdfc } = await setup();
    const err = await act(u, 'emergencyFund.contribute', { amount: '5000', accountId: hdfc, date: '2026-10-05' }).catch((e) => e);
    expect(err.fieldErrors.amount).toBe('Only ₹4,000 in HDFC is free to set aside.');
    await act(u, 'emergencyFund.contribute', { amount: '9000', accountId: sbi, date: '2026-10-05' });
    const again = await act(u, 'emergencyFund.contribute', { amount: '1500', accountId: sbi, date: '2026-10-05' }).catch((e) => e);
    expect(again.fieldErrors.amount).toBe('Only ₹1,000 in SBI is free to set aside.');
  });

  it('spending from an account leaves the set-aside amount untouched', async () => {
    const { u, sbi } = await setup();
    await act(u, 'emergencyFund.contribute', { amount: '8000', accountId: sbi, date: '2026-10-05' });
    await act(u, 'transactions.create', { type: 'expense', amount: '500', categoryId: 'cat_food', date: '2026-10-06', accountId: sbi });
    const { by } = await rows(u);
    expect(by[sbi]).toMatchObject({ balancePaise: rs(9500), earmarkedPaise: rs(8000), availablePaise: rs(1500) });
  });

  it('omitting accountId uses the default account; credit cards are refused', async () => {
    const u = await t.createUser();
    await act(u, 'profile.update', { displayName: 'A', openingBalance: '2000', openingDate: '2026-10-01' });
    await act(u, 'emergencyFund.contribute', { amount: '500', date: '2026-10-05' });
    expect((await rows(u)).by['acc_cash']).toMatchObject({ earmarkedPaise: rs(500), availablePaise: rs(1500) });
    const card = await act<{ id: string }>(u, 'accounts.create', { name: 'Visa', kind: 'creditCard', openingBalance: '0', openingDate: '2026-10-01' });
    const err = await act(u, 'emergencyFund.contribute', { amount: '100', accountId: card.id, date: '2026-10-05' }).catch((e) => e);
    expect(err.fieldErrors.accountId).toBe('A credit card cannot hold savings.');
  });

  it('goal starting amount is set aside on the chosen account', async () => {
    const { u, sbi } = await setup();
    await act(u, 'goals.create', { name: 'Bike', target: '20000', initialAllocation: '2500', accountId: sbi });
    expect((await rows(u)).by[sbi]).toMatchObject({ earmarkedPaise: rs(2500) });
    const err = await act(u, 'goals.create', { name: 'Car', target: '20000', initialAllocation: '9000', accountId: sbi }).catch((e) => e);
    expect(err.fieldErrors.initialAllocation).toBe('Only ₹7,500 in SBI is free to set aside.');
  });
});

describe('release', () => {
  it('withdrawing from a named account frees only that account; too much there is refused', async () => {
    const { u, sbi, hdfc } = await setup();
    await act(u, 'emergencyFund.contribute', { amount: '3000', accountId: sbi, date: '2026-10-05' });
    await act(u, 'emergencyFund.contribute', { amount: '2000', accountId: hdfc, date: '2026-10-05' });
    const err = await act(u, 'emergencyFund.withdraw', { amount: '2500', accountId: hdfc, date: '2026-10-06' }).catch((e) => e);
    expect(err.fieldErrors.amount).toBe('Only ₹2,000 is set aside on HDFC.');
    await act(u, 'emergencyFund.withdraw', { amount: '1000', accountId: sbi, date: '2026-10-06' });
    const { by } = await rows(u);
    expect(by[sbi]).toMatchObject({ earmarkedPaise: rs(2000) });
    expect(by[hdfc]).toMatchObject({ earmarkedPaise: rs(2000) });
  });

  it('withdrawing without an account releases from the largest holdings first', async () => {
    const { u, sbi, hdfc } = await setup();
    await act(u, 'emergencyFund.contribute', { amount: '3000', accountId: sbi, date: '2026-10-05' });
    await act(u, 'emergencyFund.contribute', { amount: '2000', accountId: hdfc, date: '2026-10-05' });
    await act(u, 'emergencyFund.withdraw', { amount: '4000', date: '2026-10-06' });
    const { by, b } = await rows(u);
    expect(by[sbi]).toMatchObject({ earmarkedPaise: 0 });
    expect(by[hdfc]).toMatchObject({ earmarkedPaise: rs(1000) });
    expect(b.earmarkedPaise).toBe(rs(1000));
  });

  it('deleting a goal releases its set-aside money on every account', async () => {
    const { u, sbi } = await setup();
    const goal = await act<{ id: string }>(u, 'goals.create', { name: 'Trip', target: '9000', initialAllocation: '1000', accountId: sbi });
    await act(u, 'goals.delete', { id: goal.id });
    expect((await rows(u)).by[sbi]).toMatchObject({ earmarkedPaise: 0, availablePaise: rs(10000) });
  });
});

describe('accounts with savings', () => {
  it('cannot be deleted while money is set aside on them; archiving is allowed', async () => {
    const { u, sbi } = await setup();
    await act(u, 'emergencyFund.contribute', { amount: '100', accountId: sbi, date: '2026-10-05' });
    const err = await act(u, 'accounts.delete', { id: sbi }).catch((e) => e);
    expect(err.message).toMatch(/Archive it instead/);
    await act(u, 'accounts.archive', { id: sbi, archived: true });
  });

  it('old allocations were moved to the Cash account by the migration', async () => {
    const u = await t.createUser();
    const r = await t.pglite.query<{ n: number }>('select count(*)::int as n from public.savings_movements where user_id = $1 and account_id is null', [u.userId]);
    expect(r.rows[0]!.n).toBe(0);
  });
});
