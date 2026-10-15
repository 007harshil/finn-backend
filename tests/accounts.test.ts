// Money accounts and transfers (docs: finn/docs/MONEY_ACCOUNTS.md).

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as syncRoute from '@/app/api/v1/sync/route';
import * as importRoute from '@/app/api/v1/import/route';
import { createTestDb, type TestDb } from './support/db';
import { makeClient, newKey } from './support/http';
import { act, fixClock, read } from './support/actions';
import { dispatch, previewAction } from '@/server/actions/dispatcher';
import type { AuthUser } from '@/server/auth/verify';
import { loadNetWorth } from '@/server/modules/insights/net-worth';
import { DateRange } from '@/server/core/dates';

let t: TestDb;
let call: ReturnType<typeof makeClient>;

beforeAll(async () => {
  t = await createTestDb();
  call = makeClient(t);
  fixClock(); // today = 2026-10-10
});
afterAll(async () => t.close());

const rs = (n: number) => n * 100;
const accountInput = (o: Record<string, unknown> = {}) => ({
  name: 'SBI',
  kind: 'bank',
  openingBalance: '10000',
  openingDate: '2026-10-01',
  ...o,
});
const expense = (amount: string, extra: Record<string, unknown> = {}) => ({
  type: 'expense',
  amount,
  categoryId: 'cat_food',
  date: '2026-10-05',
  ...extra,
});
const balances = async (u: AuthUser) => {
  const b = await read(u, (s) => s.balance());
  return { ...b, byId: Object.fromEntries(b.accounts.map((a) => [a.accountId, a.balancePaise])) };
};
const fieldErrors = async (u: AuthUser, id: string, input: Record<string, unknown>) => {
  try {
    await dispatch(u, id, input, { idempotencyKey: newKey() });
    return null;
  } catch (e: any) {
    return e.fieldErrors ?? e.details ?? e.message;
  }
};

describe('bootstrap', () => {
  it('every new user starts with a default Cash account', async () => {
    const u = await t.createUser();
    const accounts = await read(u, (s) => s.moneyAccounts());
    expect(accounts).toHaveLength(1);
    expect(accounts[0]).toMatchObject({ id: 'acc_cash', name: 'Cash', kind: 'cash', openingPaise: 0, isDefault: true, isArchived: false, version: 1 });
    expect(accounts[0]!.openingDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    const b = await balances(u);
    expect(b).toMatchObject({ cashPaise: 0, creditOwedPaise: 0, openingBalancePaise: 0 });
    expect(b.accounts).toEqual([{ accountId: 'acc_cash', balancePaise: 0 }]);
  });

  it('profile.update sets the Cash opening balance and date', async () => {
    const u = await t.createUser();
    await act(u, 'profile.update', { displayName: 'A', openingBalance: '2500', openingDate: '2026-09-01' });
    const [cash] = await read(u, (s) => s.moneyAccounts());
    expect(cash).toMatchObject({ openingPaise: rs(2500), openingDate: '2026-09-01' });
    expect((await balances(u)).cashPaise).toBe(rs(2500));
  });
});

describe('accounts.* actions', () => {
  it('balance formula: SBI 10,000 + Axis 4,000 = 14,000; buying on SBI lowers both', async () => {
    const u = await t.createUser();
    const sbi = await act(u, 'accounts.create', accountInput());
    const axis = await act(u, 'accounts.create', accountInput({ name: 'Axis', openingBalance: '4000' }));
    expect(sbi.id).toMatch(/^acc_/);
    let b = await balances(u);
    expect(b.cashPaise).toBe(rs(14000));
    expect(b.openingBalancePaise).toBe(rs(14000));
    await act(u, 'transactions.create', expense('1000', { accountId: sbi.id, channel: '  UPI ' }));
    b = await balances(u);
    expect(b.byId[sbi.id]).toBe(rs(9000));
    expect(b.byId[axis.id]).toBe(rs(4000));
    expect(b.cashPaise).toBe(rs(13000));
    expect(b.availablePaise).toBe(rs(13000));
    const tx = (await read(u, (s) => s.transactionsIn(new DateRange('2026-10-01', '2026-10-31'))))[0]!;
    expect(tx).toMatchObject({ accountId: sbi.id, channel: 'UPI' });
    expect(tx).not.toHaveProperty('paymentMethod');
  });

  it('movements dated before an account opening date are ignored by that account', async () => {
    const u = await t.createUser();
    const sbi = await act(u, 'accounts.create', accountInput({ openingDate: '2026-10-08' }));
    // Recording earlier auto-extends the account (below); a direct earlier row is ignored by the ledger.
    await t.pglite.query(
      `insert into transactions (user_id, id, type, amount_paise, category_id, date, account_id) values ($1, 'tx_old', 'expense', 100000, 'cat_food', '2026-10-01', $2)`,
      [u.userId, sbi.id],
    );
    expect((await balances(u)).byId[sbi.id]).toBe(rs(10000));
  });

  it('credit cards track owed: spending raises it, a transfer pays it, and it is not cash', async () => {
    const u = await t.createUser();
    const sbi = await act(u, 'accounts.create', accountInput());
    const card = await act(u, 'accounts.create', {
      name: 'HDFC Millennia', kind: 'creditCard', last4: '1234', openingBalance: '500', openingDate: '2026-10-01', creditLimit: '100000',
    });
    expect(card).toMatchObject({ kind: 'creditCard', last4: '1234', creditLimitPaise: rs(100000), openingPaise: rs(500) });
    await act(u, 'transactions.create', expense('3000', { accountId: card.id }));
    let b = await balances(u);
    expect(b.byId[card.id]).toBe(rs(3500));
    expect(b.creditOwedPaise).toBe(rs(3500));
    expect(b.cashPaise).toBe(rs(10000));
    // Net worth subtracts credit owed.
    const nw = await read(u, (s) => loadNetWorth(s));
    expect(nw.cashPaise).toBe(rs(10000));
    expect(nw.liabilitiesPaise).toBe(rs(3500));
    expect(nw.netWorthPaise).toBe(rs(10000) - rs(3500));
    // Paying the bill is a transfer: asset down, owed down, spending unchanged.
    await act(u, 'transfers.create', { fromAccountId: sbi.id, toAccountId: card.id, amount: '2000', date: '2026-10-08', channel: 'Net banking' });
    b = await balances(u);
    expect(b.byId[sbi.id]).toBe(rs(8000));
    expect(b.byId[card.id]).toBe(rs(1500));
    expect(b.cashPaise).toBe(rs(8000));
    const summary = await read(u, (s) => s.summary(new DateRange('2026-10-01', '2026-10-31')));
    expect(summary.expensePaise).toBe(rs(3000));
    expect(summary.incomePaise).toBe(0);
  });

  it('validates fields and kind rules', async () => {
    const u = await t.createUser();
    expect(await fieldErrors(u, 'accounts.create', accountInput({ name: '  ' }))).toHaveProperty('name');
    expect(await fieldErrors(u, 'accounts.create', accountInput({ name: 'x'.repeat(41) }))).toHaveProperty('name');
    expect(await fieldErrors(u, 'accounts.create', accountInput({ last4: '1234' }))).toHaveProperty('last4');
    expect(await fieldErrors(u, 'accounts.create', accountInput({ kind: 'debitCard', last4: '12' }))).toHaveProperty('last4');
    expect(await fieldErrors(u, 'accounts.create', accountInput({ creditLimit: '5000' }))).toHaveProperty('creditLimit');
    expect(await fieldErrors(u, 'accounts.create', accountInput({ openingDate: '2026-12-01' }))).toHaveProperty('openingDate');
    const p = await previewAction(u, 'accounts.create', accountInput({ name: 'Cash', kind: 'cash' }));
    expect(p.warnings).toEqual(['You already have a cash called "Cash".']);
  });

  it('only one default; setDefault moves it; create with isDefault takes it over', async () => {
    const u = await t.createUser();
    const a = await act(u, 'accounts.create', accountInput({ isDefault: true }));
    let accts = await read(u, (s) => s.moneyAccounts());
    expect(accts.filter((x) => x.isDefault).map((x) => x.id)).toEqual([a.id]);
    await act(u, 'accounts.setDefault', { id: 'acc_cash' });
    accts = await read(u, (s) => s.moneyAccounts());
    expect(accts.filter((x) => x.isDefault).map((x) => x.id)).toEqual(['acc_cash']);
  });

  it('omitted accountId resolves to the default account; archived accounts are refused', async () => {
    const u = await t.createUser();
    const a = await act(u, 'accounts.create', accountInput());
    await act(u, 'accounts.setDefault', { id: a.id });
    const tx = await act(u, 'transactions.create', expense('10'));
    expect(tx.accountId).toBe(a.id);
    await act(u, 'accounts.setDefault', { id: 'acc_cash' });
    await act(u, 'accounts.archive', { id: a.id, archived: true });
    expect(await fieldErrors(u, 'transactions.create', expense('10', { accountId: a.id }))).toHaveProperty('accountId');
    expect(await fieldErrors(u, 'transactions.create', expense('10', { accountId: 'acc_nope' }))).toHaveProperty('accountId');
    // An old transaction on an archived account can still be edited in place.
    const edited = await act(u, 'transactions.update', {
      id: tx.id, expectedVersion: tx.version, ...expense('20'),
    });
    expect(edited).toMatchObject({ accountId: a.id, amountPaise: rs(20) });
    // Archived accounts keep counting towards cash.
    expect((await balances(u)).byId[a.id]).toBe(rs(10000 - 20));
  });

  it('archive rules: not the default, not the last active; delete rules', async () => {
    const u = await t.createUser();
    expect(await fieldErrors(u, 'accounts.archive', { id: 'acc_cash', archived: true })).toBeTruthy();
    const a = await act(u, 'accounts.create', accountInput());
    expect(await fieldErrors(u, 'accounts.archive', { id: 'acc_cash', archived: true })).toBeTruthy(); // default
    await act(u, 'accounts.setDefault', { id: a.id });
    await act(u, 'accounts.archive', { id: 'acc_cash', archived: true });
    expect(await fieldErrors(u, 'accounts.archive', { id: a.id, archived: true })).toBeTruthy(); // default
    await act(u, 'accounts.archive', { id: 'acc_cash', archived: false });
    // In use: cannot delete.
    await act(u, 'transactions.create', expense('10', { accountId: a.id }));
    expect(await fieldErrors(u, 'accounts.delete', { id: a.id })).toBeTruthy();
    // Unused account can be deleted; deleting the default hands the default over.
    const spare = await act(u, 'accounts.create', accountInput({ name: 'Spare' }));
    await act(u, 'accounts.delete', { id: spare.id });
    expect((await read(u, (s) => s.moneyAccounts())).map((x) => x.id)).toEqual(['acc_cash', a.id]);
    const solo = await t.createUser();
    expect(await fieldErrors(solo, 'accounts.delete', { id: 'acc_cash' })).toBeTruthy(); // last account
  });

  it('update: kind switch asset <-> credit card only without movements', async () => {
    const u = await t.createUser();
    const a = await act(u, 'accounts.create', accountInput());
    const asCard = { id: a.id, expectedVersion: a.version, ...accountInput({ kind: 'creditCard' }) };
    const ok = await act(u, 'accounts.update', asCard);
    expect(ok.kind).toBe('creditCard');
    await act(u, 'transactions.create', expense('10', { accountId: a.id }));
    expect(await fieldErrors(u, 'accounts.update', { id: a.id, expectedVersion: ok.version, ...accountInput({ kind: 'bank' }) })).toHaveProperty('kind');
    // A stale version is refused; "version" is accepted as an alias.
    expect(await fieldErrors(u, 'accounts.update', { id: a.id, expectedVersion: 1, ...accountInput({ kind: 'creditCard' }) })).toBeTruthy();
    const renamed = await act(u, 'accounts.update', { id: a.id, version: ok.version, ...accountInput({ kind: 'creditCard', name: 'Renamed' }) });
    expect(renamed.name).toBe('Renamed');
  });

  it('setBalance corrects the balance (and owed for credit cards) as of a date, with a preview', async () => {
    const u = await t.createUser();
    const a = await act(u, 'accounts.create', accountInput());
    await act(u, 'transactions.create', expense('1000', { accountId: a.id }));
    const preview = await previewAction(u, 'accounts.setBalance', { id: a.id, balance: '8000' });
    expect(preview.lines.find((l) => l.label === 'Balance')!.value).toBe('₹9,000 → ₹8,000');
    const fixed = await act(u, 'accounts.setBalance', { id: a.id, balance: '8000' });
    expect(fixed.openingPaise).toBe(rs(9000));
    expect((await balances(u)).byId[a.id]).toBe(rs(8000));
    const card = await act(u, 'accounts.create', accountInput({ name: 'Card', kind: 'creditCard', openingBalance: '0' }));
    await act(u, 'transactions.create', expense('300', { accountId: card.id }));
    await act(u, 'accounts.setBalance', { id: card.id, balance: '1000' });
    const b = await balances(u);
    expect(b.byId[card.id]).toBe(rs(1000));
    expect(b.creditOwedPaise).toBe(rs(1000));
    // A balance that needs a negative opening moves the opening date instead.
    const small = await act(u, 'accounts.create', accountInput({ name: 'Small', openingBalance: '0' }));
    await act(u, 'transactions.create', { type: 'income', amount: '500', categoryId: 'cat_salary', date: '2026-10-05', accountId: small.id });
    const re = await act(u, 'accounts.setBalance', { id: small.id, balance: '100' });
    expect(re).toMatchObject({ openingPaise: rs(100), openingDate: '2026-10-10' });
    expect((await balances(u)).byId[small.id]).toBe(rs(100));
  });
});

describe('transfers', () => {
  it('moves money between accounts without touching income or spending; update and delete reverse it', async () => {
    const u = await t.createUser();
    const sbi = await act(u, 'accounts.create', accountInput());
    const trf = await act(u, 'transfers.create', { fromAccountId: sbi.id, toAccountId: 'acc_cash', amount: '2000', date: '2026-10-02', channel: 'ATM' });
    expect(trf).toMatchObject({ amountPaise: rs(2000), channel: 'ATM', note: null, version: 1 });
    expect(trf.id).toMatch(/^trf_/);
    let b = await balances(u);
    expect(b.byId[sbi.id]).toBe(rs(8000));
    expect(b.byId.acc_cash).toBe(rs(2000));
    expect(b.cashPaise).toBe(rs(10000));
    const s = await read(u, (x) => x.summary(new DateRange('2026-10-01', '2026-10-31')));
    expect(s).toMatchObject({ incomePaise: 0, expensePaise: 0, transactionCount: 0 });
    const upd = await act(u, 'transfers.update', {
      id: trf.id, expectedVersion: trf.version, fromAccountId: sbi.id, toAccountId: 'acc_cash', amount: '500', date: '2026-10-02',
    });
    expect(upd).toMatchObject({ amountPaise: rs(500), channel: null, version: 2 });
    b = await balances(u);
    expect(b.byId.acc_cash).toBe(rs(500));
    await act(u, 'transfers.delete', { id: trf.id });
    b = await balances(u);
    expect(b.byId[sbi.id]).toBe(rs(10000));
    expect(b.byId.acc_cash).toBe(0);
  });

  it('validates accounts, amount, date and channel; warns on overdraw', async () => {
    const u = await t.createUser();
    const sbi = await act(u, 'accounts.create', accountInput());
    const ok = { fromAccountId: sbi.id, toAccountId: 'acc_cash', amount: '100', date: '2026-10-02' };
    expect(await fieldErrors(u, 'transfers.create', { ...ok, toAccountId: sbi.id })).toHaveProperty('toAccountId');
    expect(await fieldErrors(u, 'transfers.create', { ...ok, toAccountId: 'acc_nope' })).toHaveProperty('toAccountId');
    expect(await fieldErrors(u, 'transfers.create', { ...ok, amount: '0' })).toBeTruthy();
    expect(await fieldErrors(u, 'transfers.create', { ...ok, date: '2026-10-11' })).toHaveProperty('date');
    expect(await fieldErrors(u, 'transfers.create', { ...ok, channel: 'x'.repeat(31) })).toHaveProperty('channel');
    const p = await previewAction(u, 'transfers.create', { ...ok, amount: '20000' });
    expect(p.warnings[0]).toContain('more than');
    await act(u, 'accounts.setDefault', { id: sbi.id });
    await act(u, 'accounts.archive', { id: 'acc_cash', archived: true });
    expect(await fieldErrors(u, 'transfers.create', ok)).toHaveProperty('toAccountId');
  });

  it('a transfer dated before an account opening date moves that start back', async () => {
    const u = await t.createUser();
    const sbi = await act(u, 'accounts.create', accountInput({ openingDate: '2026-10-05' }));
    await act(u, 'transfers.create', { fromAccountId: sbi.id, toAccountId: 'acc_cash', amount: '1000', date: '2026-10-01' });
    const accts = await read(u, (s) => s.moneyAccounts());
    expect(accts.map((a) => a.openingDate)).toEqual(expect.arrayContaining(['2026-10-01']));
    expect(accts.find((a) => a.id === sbi.id)!.openingDate).toBe('2026-10-01');
    expect((await balances(u)).byId[sbi.id]).toBe(rs(9000));
  });
});

describe('transactions and linked movements', () => {
  it('an earlier transaction extends its account opening date (and profile tracking start)', async () => {
    const u = await t.createUser();
    await act(u, 'profile.update', { displayName: 'A', openingBalance: '1000', openingDate: '2026-10-05' });
    await act(u, 'transactions.create', expense('100', { date: '2026-10-01' }));
    const [cash] = await read(u, (s) => s.moneyAccounts());
    expect(cash!.openingDate).toBe('2026-10-01');
    expect((await balances(u)).cashPaise).toBe(rs(900));
  });

  it('subscriptions, loans and settlements carry accountId and channel onto their transaction', async () => {
    const u = await t.createUser();
    const sbi = await act(u, 'accounts.create', accountInput());
    const sub = await act(u, 'subscriptions.create', {
      name: 'Hotstar', amount: '100', categoryId: 'cat_food', frequency: 'monthly', nextDueDate: '2026-10-08', accountId: sbi.id,
    });
    expect(sub.accountId).toBe(sbi.id);
    const paid = await act(u, 'subscriptions.markPaid', { subscriptionId: sub.id });
    expect(paid.accountId).toBe(sbi.id);
    const sub2 = await act(u, 'subscriptions.create', {
      name: 'Gym', amount: '100', categoryId: 'cat_food', frequency: 'monthly', nextDueDate: '2026-10-08',
    });
    expect(sub2.accountId).toBeNull();
    const paid2 = await act(u, 'subscriptions.markPaid', { subscriptionId: sub2.id, accountId: 'acc_cash', channel: 'Cheque' });
    expect(paid2).toMatchObject({ accountId: 'acc_cash', channel: 'Cheque' });
    const loan = await act(u, 'loans.create', {
      name: 'Car', counterparty: 'HDFC', direction: 'borrowed', structure: 'amortizing', principal: 60000, rateBps: 950,
      startDate: '2026-09-01', firstDueDate: '2026-10-05', frequency: 'monthly', tenureInstallments: 12, maturityDate: null,
      prepaymentStrategy: 'reduceTenure', recordDisbursement: true, accountId: sbi.id, channel: 'NEFT', note: null,
    });
    const disb = (await read(u, (s) => s.transaction(loan.disbursementTransactionId)))!;
    expect(disb).toMatchObject({ accountId: sbi.id, channel: 'NEFT', type: 'income' });
    const pay = await act(u, 'loans.recordPayment', { loanId: loan.id, kind: 'installment', amount: 5000, date: '2026-10-05', accountId: sbi.id, channel: 'IMPS' });
    const ptx = (await read(u, (s) => s.transaction(pay.transactionId)))!;
    expect(ptx).toMatchObject({ accountId: sbi.id, channel: 'IMPS' });
    const p = await act(u, 'pending.create', { counterparty: 'Rahul', direction: 'owedToMe', kind: 'lent', amount: '1000', purpose: 'Trip', createdDate: '2026-10-01' });
    const st = await act(u, 'pending.settle', { pendingId: p.id, amount: '400', date: '2026-10-06', accountId: sbi.id, channel: 'UPI' });
    expect(st).toMatchObject({ accountId: sbi.id, channel: 'UPI' });
    expect(st).not.toHaveProperty('method');
    const stx = (await read(u, (s) => s.transaction(st.transactionId)))!;
    expect(stx).toMatchObject({ accountId: sbi.id, channel: 'UPI', type: 'income' });
    const noCash = await act(u, 'pending.settle', { pendingId: p.id, amount: '100', date: '2026-10-06', recordCashMovement: false });
    expect(noCash).toMatchObject({ accountId: null, channel: null, transactionId: null });
  });

  it('period summary reports expense by account and by channel', async () => {
    const u = await t.createUser();
    const sbi = await act(u, 'accounts.create', accountInput());
    await act(u, 'transactions.create', expense('300', { accountId: sbi.id, channel: 'UPI' }));
    await act(u, 'transactions.create', expense('200', { accountId: sbi.id, channel: 'UPI' }));
    await act(u, 'transactions.create', expense('100', { accountId: sbi.id, channel: 'Cheque' }));
    await act(u, 'transactions.create', expense('50'));
    const s = await read(u, (x) => x.summary(new DateRange('2026-10-01', '2026-10-31')));
    expect(s.byAccount).toEqual([
      { accountId: sbi.id, amountPaise: rs(600) },
      { accountId: 'acc_cash', amountPaise: rs(50) },
    ]);
    expect(s.byChannel).toEqual([
      { channel: 'UPI', amountPaise: rs(500) },
      { channel: 'Cheque', amountPaise: rs(100) },
    ]);
    expect(s).not.toHaveProperty('byMethod');
  });
});

describe('sync and import', () => {
  it('syncs moneyAccounts and transfers, with tombstones', async () => {
    const u = await t.createUser();
    const sbi = await act(u, 'accounts.create', accountInput());
    const trf = await act(u, 'transfers.create', { fromAccountId: sbi.id, toAccountId: 'acc_cash', amount: '100', date: '2026-10-02' });
    const full = await call(syncRoute.GET, 'GET', '/api/v1/sync', { user: u });
    const d = full.body.data;
    expect(d.collections.moneyAccounts.upserted.map((a: { id: string }) => a.id).sort()).toEqual(['acc_cash', sbi.id].sort());
    expect(d.collections.moneyAccounts.upserted.find((a: { id: string }) => a.id === sbi.id)).toEqual({
      id: sbi.id, name: 'SBI', kind: 'bank', institution: null, last4: null, openingPaise: rs(10000), openingDate: '2026-10-01',
      creditLimitPaise: null, isDefault: false, isArchived: false, sortOrder: 1, note: null,
      createdAt: expect.any(String), updatedAt: expect.any(String), version: 1,
    });
    expect(d.collections.transfers.upserted).toEqual([
      { id: trf.id, fromAccountId: sbi.id, toAccountId: 'acc_cash', amountPaise: rs(100), date: '2026-10-02', channel: null, note: null,
        createdAt: expect.any(String), updatedAt: expect.any(String), version: 1 },
    ]);
    await act(u, 'transfers.delete', { id: trf.id });
    const inc = await call(syncRoute.GET, 'GET', '/api/v1/sync', { user: u, query: { since: d.cursor } });
    expect(inc.body.data.collections.transfers.deleted).toEqual([trf.id]);
  });

  const at = '2026-09-01T10:00:00.000Z';
  const post = (user: AuthUser, body: unknown) =>
    call(importRoute.POST, 'POST', '/api/v1/import', { user, body, headers: { 'idempotency-key': newKey() } });

  it('imports device accounts and transfers, replacing the bootstrapped Cash account', async () => {
    const u = await t.createUser();
    const res = await post(u, {
      moneyAccounts: [
        { id: 'acc_cash', name: 'Cash', kind: 'cash', openingPaise: rs(1000), openingDate: '2026-09-01', isDefault: false, createdAt: at, updatedAt: at },
        { id: 'acc_sbi', name: 'SBI', kind: 'bank', openingPaise: rs(5000), openingDate: '2026-09-01', isDefault: true, sortOrder: 1, createdAt: at, updatedAt: at },
        { id: 'acc_cc', name: 'Card', kind: 'creditCard', last4: '4321', openingPaise: rs(200), openingDate: '2026-09-01', creditLimitPaise: rs(50000), sortOrder: 2, createdAt: at, updatedAt: at },
      ],
      transactions: [
        { id: 'tx_a', type: 'expense', amountPaise: rs(100), categoryId: 'cat_food', date: '2026-09-02', accountId: 'acc_cc', channel: 'UPI', createdAt: at, updatedAt: at },
        { id: 'tx_b', type: 'income', amountPaise: rs(300), categoryId: 'cat_salary', date: '2026-09-03', createdAt: at, updatedAt: at },
      ],
      transfers: [{ id: 'trf_a', fromAccountId: 'acc_sbi', toAccountId: 'acc_cash', amountPaise: rs(500), date: '2026-09-04', channel: 'ATM', createdAt: at, updatedAt: at }],
    });
    expect(res.status).toBe(200);
    const b = await balances(u);
    expect(b.byId).toEqual({ acc_cash: rs(1500), acc_sbi: rs(5000 - 500 + 300), acc_cc: rs(300) });
    expect(b.cashPaise).toBe(rs(1500 + 4800));
    expect(b.creditOwedPaise).toBe(rs(300));
    const accts = await read(u, (s) => s.moneyAccounts());
    expect(accts.filter((a) => a.isDefault).map((a) => a.id)).toEqual(['acc_sbi']);
    // tx_b had no accountId: it went to the default account.
    expect((await read(u, (s) => s.transaction('tx_b')))!.accountId).toBe('acc_sbi');
  });

  it('rejects references to unknown accounts and writes nothing', async () => {
    const u = await t.createUser();
    const res = await post(u, {
      transactions: [{ id: 'tx_a', type: 'expense', amountPaise: 100, categoryId: 'cat_food', date: '2026-09-02', accountId: 'acc_ghost', createdAt: at, updatedAt: at }],
    });
    expect(res.status).toBe(422);
    expect((await read(u, (s) => s.moneyAccounts())).map((a) => a.id)).toEqual(['acc_cash']);
  });
});
