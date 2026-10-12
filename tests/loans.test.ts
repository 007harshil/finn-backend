// Port of finn/test/actions/loan_actions_test.dart plus routes.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as loansRoute from '@/app/api/v1/loans/route';
import * as loanRoute from '@/app/api/v1/loans/[id]/route';
import * as quoteRoute from '@/app/api/v1/loans/quote/route';
import * as paymentPreviewRoute from '@/app/api/v1/loans/[id]/payment-preview/route';
import { dispatch } from '@/server/actions/dispatcher';
import type { AuthUser } from '@/server/auth/verify';
import { withUserTx } from '@/server/db/tx';
import { ensureAccount } from '@/server/modules/account/bootstrap';
import { loadLoanState } from '@/server/modules/loans/service';
import { act, fixClock, read } from './support/actions';
import { createTestDb, type TestDb } from './support/db';
import { makeClient, newKey } from './support/http';

let t: TestDb;
let call: ReturnType<typeof makeClient>;
const users: AuthUser[] = [];
let u: AuthUser;

beforeAll(async () => {
  t = await createTestDb();
  call = makeClient(t);
  fixClock();
});
afterAll(async () => t.close());

/** A fresh user per test (the Flutter harness starts empty every test). */
async function freshUser(): Promise<AuthUser> {
  const user = await t.createUser();
  await withUserTx(user, (tx) => ensureAccount(tx, user), { write: true });
  users.push(user);
  return user;
}

const rs = (rupees: number) => rupees * 100;

function carLoan(o: {
  direction?: 'borrowed' | 'lent';
  recordDisbursement?: boolean;
  principal?: number;
  rateBps?: number;
  tenure?: number | null;
  start?: string;
  firstDue?: string;
  frequency?: string;
  structure?: 'amortizing' | 'interestOnly';
  name?: string;
  prepaymentStrategy?: 'reduceTenure' | 'reduceEmi';
} = {}) {
  const direction = o.direction ?? 'borrowed';
  return {
    name: o.name ?? 'Car loan',
    counterparty: direction === 'borrowed' ? 'HDFC Bank' : 'Ravi',
    direction,
    structure: o.structure ?? 'amortizing',
    principal: o.principal ?? 600000,
    rateBps: o.rateBps ?? 950,
    startDate: o.start ?? '2026-09-01',
    firstDueDate: o.firstDue ?? '2026-10-05',
    frequency: o.frequency ?? 'monthly',
    tenureInstallments: o.tenure === undefined ? 60 : o.tenure,
    maturityDate: null,
    prepaymentStrategy: o.prepaymentStrategy ?? 'reduceTenure',
    recordDisbursement: o.recordDisbursement ?? false,
    note: null,
  };
}

const pay = (loanId: string, rupees: number, o: { kind?: string; date?: string; cash?: boolean } = {}) => ({
  loanId,
  kind: o.kind ?? 'installment',
  amount: rupees,
  date: o.date ?? '2026-10-05',
  recordCashMovement: o.cash ?? true,
});

const cash = (user: AuthUser) => read(user, async (s) => (await s.balance()).cashPaise);
const txCount = (user: AuthUser) =>
  withUserTx(user, async (tx) => Number((await tx.selectFrom('transactions').select((eb) => eb.fn.countAll().as('n')).executeTakeFirstOrThrow()).n));
const paymentCount = (user: AuthUser) =>
  withUserTx(user, async (tx) => Number((await tx.selectFrom('loan_payments').select((eb) => eb.fn.countAll().as('n')).executeTakeFirstOrThrow()).n));
const state = (user: AuthUser, id: string) => read(user, (s) => loadLoanState(s, id));

async function reject(user: AuthUser, actionId: string, input: Record<string, unknown>) {
  try {
    await act(user, actionId, input);
  } catch (e) {
    return e as { code: string; message: string; fieldErrors: Record<string, string> };
  }
  throw new Error(`${actionId} unexpectedly succeeded`);
}

const lineMap = (preview: { lines: { label: string; value: string }[] }) => Object.fromEntries(preview.lines.map((l) => [l.label, l.value]));

describe('loans.create', () => {
  it('an existing loan is added without touching cash and without a review step', async () => {
    u = await freshUser();
    const before = await cash(u);
    const out = await dispatch(u, 'loans.create', carLoan(), { idempotencyKey: newKey() });
    expect(out.status).toBe('completed');
    const lines = lineMap(out.preview);
    expect(lines['Monthly EMI']).toBe('₹12,602');
    expect(lines['Cash balance']).toBe('Unchanged (existing loan)');
    expect(lines['Interest']).toBe('9.5% p.a. · EMI loan');
    expect(out.preview.summary).toBe('I borrowed ₹6,00,000 from HDFC Bank');
    const loan = (out as { result: { disbursementTransactionId: string | null; id: string } }).result;
    expect(loan.disbursementTransactionId).toBeNull();
    expect(loan.id).toMatch(/^loan_/);
    expect(await txCount(u)).toBe(0);
    expect(await cash(u)).toBe(before);
  });

  it('recording a borrowed disbursement adds cash and creates exactly one linked transaction, after a review', async () => {
    u = await freshUser();
    const before = await cash(u);
    const asked = await dispatch(u, 'loans.create', carLoan({ recordDisbursement: true }), { idempotencyKey: newKey() });
    expect(asked.status).toBe('needsConfirmation');
    expect(lineMap(asked.preview)['Cash balance']).toBe('+₹6,00,000');
    const loan = await act(u, 'loans.create', carLoan({ recordDisbursement: true }));
    expect(await txCount(u)).toBe(1);
    const tx = (await read(u, (s) => s.transaction(loan.disbursementTransactionId)))!;
    expect(tx).toMatchObject({ type: 'income', origin: 'loanDisbursement', categoryId: 'cat_sys_loan_in', originRefId: loan.id, amountPaise: rs(600000) });
    expect(tx.note).toBe('Car loan · disbursement');
    expect(tx.paymentMethod).toBe('bankTransfer');
    expect(await cash(u)).toBe(before + rs(600000));
  });

  it('recording a lent disbursement takes cash out', async () => {
    u = await freshUser();
    const before = await cash(u);
    const loan = await act(u, 'loans.create', carLoan({ direction: 'lent', principal: 50000, recordDisbursement: true }));
    const tx = (await read(u, (s) => s.transaction(loan.disbursementTransactionId)))!;
    expect(tx.type).toBe('expense');
    expect(tx.categoryId).toBe('cat_sys_loan_out');
    expect(await cash(u)).toBe(before - rs(50000));
  });

  it('validation', async () => {
    u = await freshUser();
    const fields = async (i: Record<string, unknown>) => Object.keys((await reject(u, 'loans.create', i)).fieldErrors);
    expect(await fields(carLoan({ principal: 0 }))).toEqual(['principal']);
    expect(await fields(carLoan({ rateBps: 6001 }))).toEqual(['rate']);
    expect(await fields(carLoan({ frequency: 'weekly' }))).toEqual(['frequency']);
    expect(await fields(carLoan({ firstDue: '2026-08-31' }))).toEqual(['firstDueDate']);
    expect(await fields(carLoan({ tenure: 0 }))).toEqual(['tenureInstallments']);
    expect(await fields(carLoan({ tenure: 481 }))).toEqual(['tenureInstallments']);
    expect(await fields(carLoan({ tenure: null }))).toEqual(['tenureInstallments']);
    expect(await fields(carLoan({ name: ' ' }))).toEqual(['name']);
    expect(await fields(carLoan({ recordDisbursement: true, start: '2026-10-20', firstDue: '2026-11-20' }))).toEqual(['startDate']);
    const e = await reject(u, 'loans.create', carLoan({ firstDue: '2026-08-31' }));
    expect(e.message).toBe('The first due date must be after the start date.');
  });

  it('interest-only loans need no tenure', async () => {
    u = await freshUser();
    const loan = await act(u, 'loans.create', carLoan({ structure: 'interestOnly', tenure: null, principal: 100000, rateBps: 1200 }));
    expect(loan.tenureInstallments).toBeNull();
    expect((await state(u, loan.id))!.nextDue!.paymentPaise).toBe(rs(1000));
  });
});

describe('loans.recordPayment', () => {
  let loan: { id: string; version: number };
  const setup = async () => {
    u = await freshUser();
    loan = await act(u, 'loans.create', carLoan());
  };

  it('an EMI pays interest due first, the rest reduces principal, with exactly one linked expense', async () => {
    await setup();
    const before = await cash(u);
    const asked = await dispatch(u, 'loans.recordPayment', pay(loan.id, 12602), { idempotencyKey: newKey() });
    expect(asked.status).toBe('needsConfirmation');
    const lines = lineMap(asked.preview);
    expect(lines['Towards interest']).toBe('₹4,750');
    expect(lines['Towards principal']).toBe('₹7,852');
    expect(lines['Instalment']).toBe('#1 · due 5 Oct 2026');
    expect(lines['Outstanding']).toBe('₹6,00,000 → ₹5,92,148');
    expect(lines['Cash balance']).toBe('−₹12,602');
    expect(asked.preview.title).toBe('Record emi instalment');

    const p = await act(u, 'loans.recordPayment', pay(loan.id, 12602));
    expect(p).toMatchObject({ interestPaise: rs(4750), principalPaise: rs(7852), periodNumber: 1, kind: 'installment' });
    expect(p.id).toMatch(/^lp_/);
    expect(await txCount(u)).toBe(1);
    expect(await paymentCount(u)).toBe(1);
    const tx = (await read(u, (s) => s.transaction(p.transactionId)))!;
    expect(tx).toMatchObject({ origin: 'loanRepayment', categoryId: 'cat_sys_emi', amountPaise: rs(12602), type: 'expense', originRefId: loan.id });
    expect(tx.note).toBe('Car loan · EMI instalment #1');
    const st = (await state(u, loan.id))!;
    expect(st.outstandingPaise).toBe(rs(600000 - 7852));
    expect(st.nextDue!.number).toBe(2);
    expect(await cash(u)).toBe(before - rs(12602));
  });

  it('without a cash movement only the loan changes', async () => {
    await setup();
    const p = await act(u, 'loans.recordPayment', pay(loan.id, 12602, { cash: false }));
    expect(p.transactionId).toBeNull();
    expect(await txCount(u)).toBe(0);
    expect((await state(u, loan.id))!.outstandingPaise).toBe(rs(592148));
  });

  it('a repayment received on a lent loan is cash in', async () => {
    await setup();
    const lent = await act(u, 'loans.create', carLoan({ direction: 'lent', principal: 12000, rateBps: 0, tenure: 12 }));
    const p = await act(u, 'loans.recordPayment', pay(lent.id, 1000));
    const tx = (await read(u, (s) => s.transaction(p.transactionId)))!;
    expect(tx.type).toBe('income');
    expect(tx.categoryId).toBe('cat_sys_loan_repay_in');
  });

  it('paying off the outstanding principal closes the loan', async () => {
    await setup();
    const small = await act(u, 'loans.create', carLoan({ principal: 10000, rateBps: 0, tenure: 2 }));
    const asked = await dispatch(u, 'loans.recordPayment', pay(small.id, 10000, { kind: 'principal' }), { idempotencyKey: newKey() });
    expect(asked.preview.warnings).toContain('This payment closes the loan.');
    await act(u, 'loans.recordPayment', pay(small.id, 10000, { kind: 'principal' }));
    const st = (await state(u, small.id))!;
    expect(st.loan.status).toBe('closed');
    expect(st.loan.version).toBe(2);
    expect(st.isClosed).toBe(true);
    const again = await reject(u, 'loans.recordPayment', pay(small.id, 1, { kind: 'principal' }));
    expect(again.code).toBe('validation');
    expect(again.message).toBe('This loan is already fully repaid.');
  });

  it('rejects future dates, dates before the start, too little and too much', async () => {
    await setup();
    const r = (i: Record<string, unknown>) => reject(u, 'loans.recordPayment', i);
    expect(Object.keys((await r(pay(loan.id, 12602, { date: '2026-10-11' }))).fieldErrors)).toEqual(['date']);
    expect(Object.keys((await r(pay(loan.id, 12602, { date: '2026-08-31' }))).fieldErrors)).toEqual(['date']);
    expect((await r(pay(loan.id, 4000))).message).toContain('interest due');
    expect((await r(pay(loan.id, 700000))).message).toContain('payoff');
    expect((await r(pay(loan.id, 1, { kind: 'interest' }))).code).toBe('validation');
    expect((await r(pay('nope', 1))).code).toBe('notFound');
    expect(await paymentCount(u)).toBe(0);
  });

  it('an approval is stale once another payment was recorded', async () => {
    await setup();
    const key = newKey();
    const input = pay(loan.id, 20000, { kind: 'principal' });
    const asked = await dispatch(u, 'loans.recordPayment', input, { idempotencyKey: key });
    expect(asked.status).toBe('needsConfirmation');
    await act(u, 'loans.recordPayment', pay(loan.id, 12602));
    const out = await dispatch(u, 'loans.recordPayment', input, { idempotencyKey: key, confirmation: { fingerprint: asked.preview.fingerprint } });
    expect(out.status).toBe('needsConfirmation');
    expect(await paymentCount(u)).toBe(1);
  });

  it('an idempotent replay does not record twice', async () => {
    await setup();
    const key = newKey();
    const first = await act(u, 'loans.recordPayment', pay(loan.id, 12602), { key });
    const again = await act(u, 'loans.recordPayment', pay(loan.id, 12602), { key });
    expect(again.id).toBe(first.id);
    expect(await paymentCount(u)).toBe(1);
    expect(await txCount(u)).toBe(1);
  });

  it('interest-only loan: interest payments, then principal repayment closes it', async () => {
    await setup();
    const io = await act(u, 'loans.create', carLoan({ structure: 'interestOnly', tenure: null, principal: 200000, rateBps: 1200, firstDue: '2026-09-15' }));
    const asked = await dispatch(u, 'loans.recordPayment', pay(io.id, 2000, { kind: 'interest' }), { idempotencyKey: newKey() });
    expect(lineMap(asked.preview)['Interest period']).toBe('#1 · due 15 Sep 2026');
    const p = await act(u, 'loans.recordPayment', pay(io.id, 2000, { kind: 'interest' }));
    expect(p).toMatchObject({ interestPaise: rs(2000), principalPaise: 0, periodNumber: 1 });
    expect((await reject(u, 'loans.recordPayment', pay(io.id, 2000)))!.message).toBe('EMI instalment is not applicable to a interest-only.');
    await act(u, 'loans.recordPayment', pay(io.id, 50000, { kind: 'principal' }));
    let st = (await state(u, io.id))!;
    expect(st.outstandingPaise).toBe(rs(150000));
    expect(st.currentInstallmentPaise).toBe(rs(1500));
    expect(st.nextDue!.number).toBe(2);
    await act(u, 'loans.recordPayment', pay(io.id, 150000, { kind: 'principal' }));
    st = (await state(u, io.id))!;
    expect(st.loan.status).toBe('closed');
  });

  it('partial principal repayment: reduceTenure keeps the EMI, reduceEmi lowers it', async () => {
    await setup();
    const results: Record<string, { emi: number; remaining: number | null }> = {};
    for (const strategy of ['reduceTenure', 'reduceEmi'] as const) {
      const l = await act(u, 'loans.create', carLoan({ prepaymentStrategy: strategy, firstDue: '2026-09-05' }));
      await act(u, 'loans.recordPayment', pay(l.id, 12602, { date: '2026-09-05' }));
      await act(u, 'loans.recordPayment', pay(l.id, 100000, { kind: 'principal', date: '2026-10-06' }));
      const st = (await state(u, l.id))!;
      results[strategy] = { emi: st.currentInstallmentPaise, remaining: st.remainingInstallments };
      expect(st.outstandingPaise).toBe(rs(600000 - 7852 - 100000));
    }
    expect(results.reduceTenure!.emi).toBe(rs(12602));
    expect(results.reduceTenure!.remaining!).toBeLessThan(59);
    expect(results.reduceEmi!.emi).toBeLessThan(rs(12602));
    expect(results.reduceEmi!.remaining).toBe(59);
  });
});

describe('loans.update and loans.delete', () => {
  let loan: { id: string; version: number; disbursementTransactionId: string };
  const setup = async () => {
    u = await freshUser();
    loan = await act(u, 'loans.create', carLoan({ recordDisbursement: true }));
  };

  it('terms can change until the first payment; then only descriptive fields', async () => {
    await setup();
    const changed = await act(u, 'loans.update', { id: loan.id, expectedVersion: 1, ...carLoan({ rateBps: 900, recordDisbursement: true }) });
    expect(changed.version).toBe(2);
    expect(changed.rateBps).toBe(900);
    expect(changed.disbursementTransactionId).toBe(loan.disbursementTransactionId);
    const next = (await state(u, loan.id))!.nextDue!;
    await act(u, 'loans.recordPayment', pay(loan.id, Math.trunc(next.paymentPaise / 100)));

    const locked = await reject(u, 'loans.update', { id: loan.id, expectedVersion: 2, ...carLoan({ rateBps: 800 }) });
    expect(locked.code).toBe('notPermitted');
    const renamed = await act(u, 'loans.update', { id: loan.id, expectedVersion: 2, ...carLoan({ rateBps: 900, name: 'Swift loan' }) });
    expect(renamed.name).toBe('Swift loan');
    expect(renamed.version).toBe(3);
    const stale = await reject(u, 'loans.update', { id: loan.id, expectedVersion: 2, ...carLoan({ rateBps: 900, name: 'Again' }) });
    expect(stale.code).toBe('staleData');
    // Payments are never rewritten.
    expect(await paymentCount(u)).toBe(1);
  });

  it('deleting a loan without payments also removes its disbursement', async () => {
    await setup();
    const before = await cash(u);
    const asked = await dispatch(u, 'loans.delete', { id: loan.id }, { idempotencyKey: newKey() });
    expect(asked.status).toBe('needsConfirmation');
    expect(asked.preview.warnings).toEqual(['The recorded disbursement transaction will also be removed.', 'This cannot be undone.']);
    await act(u, 'loans.delete', { id: loan.id });
    expect(await read(u, (s) => s.loans())).toEqual([]);
    expect(await txCount(u)).toBe(0);
    expect(await cash(u)).toBe(before - rs(600000));
  });

  it('a loan with payments is kept for history', async () => {
    await setup();
    await act(u, 'loans.recordPayment', pay(loan.id, 12602));
    const e = await reject(u, 'loans.delete', { id: loan.id });
    expect(e.code).toBe('notPermitted');
    expect(e.message).toBe('This loan has payments recorded, so it is kept for your history.');
  });

  it('another user cannot see or change the loan', async () => {
    await setup();
    const other = await freshUser();
    expect((await reject(other, 'loans.recordPayment', pay(loan.id, 12602))).code).toBe('notFound');
    expect((await reject(other, 'loans.delete', { id: loan.id })).code).toBe('notFound');
  });
});

describe('loan routes', () => {
  it('lists loans with state, shows detail with schedule statuses, quotes and previews payments', async () => {
    u = await freshUser();
    const loan = await act(u, 'loans.create', carLoan({ firstDue: '2026-09-05' }));
    await act(u, 'loans.recordPayment', pay(loan.id, 12602, { date: '2026-09-05' }));

    const list = await call(loansRoute.GET, 'GET', '/api/v1/loans', { user: u });
    expect(list.status).toBe(200);
    const item = list.body.data.items[0];
    expect(item.loan.id).toBe(loan.id);
    expect(item.state).toMatchObject({
      outstandingPaise: rs(592148),
      emiPaise: rs(12602),
      nextDue: { date: '2026-10-05', period: 2 },
      overdueCount: 1,
      paidInstallments: 1,
      totalInterestPaidPaise: rs(4750),
      closed: false,
    });

    const detail = await call(loanRoute.GET, 'GET', `/api/v1/loans/${loan.id}`, { user: u, params: { id: loan.id } });
    const rows = detail.body.data.schedule as { status: string; number: number }[];
    expect(rows.slice(0, 3).map((r) => [r.number, r.status])).toEqual([
      [1, 'paid'],
      [2, 'overdue'],
      [3, 'due'],
    ]);
    expect(rows[3]!.status).toBe('upcoming');
    expect(detail.body.data.payments).toHaveLength(1);
    const missing = await call(loanRoute.GET, 'GET', '/api/v1/loans/nope', { user: u, params: { id: 'nope' } });
    expect(missing.status).toBe(404);

    const q = await call(quoteRoute.POST, 'POST', '/api/v1/loans/quote', { user: u, body: carLoan() });
    expect(q.body.data.quote).toMatchObject({ installmentPaise: rs(12602), installments: 60, neverRepays: false });
    expect(q.body.data.schedule).toHaveLength(60);

    const pp = await call(paymentPreviewRoute.POST, 'POST', `/api/v1/loans/${loan.id}/payment-preview`, {
      user: u,
      params: { id: loan.id },
      body: { kind: 'installment', amount: 20000 },
    });
    expect(pp.body.data).toMatchObject({ periodNumber: 2, includesPrepayment: true, closesLoan: false });
    expect(pp.body.data.interestPortionPaise + pp.body.data.principalPortionPaise).toBe(rs(20000));
    const bad = await call(paymentPreviewRoute.POST, 'POST', `/api/v1/loans/${loan.id}/payment-preview`, {
      user: u,
      params: { id: loan.id },
      body: { kind: 'installment', amount: 100 },
    });
    expect(bad.status).toBe(422);
    expect(bad.body.error?.fieldErrors?.amount).toMatch(/^Minimum /);
    expect(await paymentCount(u)).toBe(1);

    const other = await freshUser();
    const theirs = await call(loansRoute.GET, 'GET', '/api/v1/loans', { user: other });
    expect(theirs.body.data.items).toEqual([]);
  });
});
