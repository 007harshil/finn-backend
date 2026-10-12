// Port of finn/test/domain/loan_calculator_test.dart (same expected numbers).

import { describe, expect, it } from 'vitest';
import { roundDivBig } from '@/server/core/money';
import type { Frequency } from '@/server/core/frequency';
import type { Loan, LoanPayment } from '@/server/finance/models';
import {
  emi,
  loanState,
  originalSchedule,
  outstandingOn,
  parseRate,
  periodInterest,
  previewPayment,
  quoteLoan,
  rateLabel,
  type CalcResult,
  type LoanPaymentKind,
} from '@/server/modules/loans/calculator';

const today = '2026-10-10';
const stamp = '2026-01-01T03:30:00.000Z';
const rs = (rupees: number) => rupees * 100;
const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

function amortizing(o: {
  id?: string;
  principal?: number;
  bps?: number;
  n?: number;
  firstDue?: string;
  frequency?: Frequency;
  strategy?: Loan['prepaymentStrategy'];
  status?: Loan['status'];
  direction?: Loan['direction'];
} = {}): Loan {
  return {
    id: o.id ?? 'loan_a',
    name: 'Car loan',
    counterparty: 'HDFC Bank',
    direction: o.direction ?? 'borrowed',
    structure: 'amortizing',
    principalPaise: o.principal ?? rs(600000),
    rateBps: o.bps ?? 950,
    startDate: '2025-12-05',
    firstDueDate: o.firstDue ?? '2026-11-05',
    frequency: o.frequency ?? 'monthly',
    tenureInstallments: o.n ?? 60,
    maturityDate: null,
    prepaymentStrategy: o.strategy ?? 'reduceTenure',
    status: o.status ?? 'active',
    disbursementTransactionId: null,
    note: null,
    createdAt: stamp,
    updatedAt: stamp,
    version: 1,
  };
}

function interestOnly(o: { id?: string; principal?: number; bps?: number; firstDue?: string; maturity?: string } = {}): Loan {
  return {
    id: o.id ?? 'loan_i',
    name: 'Family loan',
    counterparty: 'Ramesh Uncle',
    direction: 'borrowed',
    structure: 'interestOnly',
    principalPaise: o.principal ?? rs(200000),
    rateBps: o.bps ?? 1200,
    startDate: '2026-10-01',
    firstDueDate: o.firstDue ?? '2026-11-01',
    frequency: 'monthly',
    tenureInstallments: null,
    maturityDate: o.maturity ?? null,
    prepaymentStrategy: 'reduceTenure',
    status: 'active',
    disbursementTransactionId: null,
    note: null,
    createdAt: stamp,
    updatedAt: stamp,
    version: 1,
  };
}

let pid = 0;
function payment(loan: Loan, kind: LoanPaymentKind, date: string, interest: number, principal: number, period: number | null = null): LoanPayment {
  return {
    id: `lp_${pid++}`,
    loanId: loan.id,
    kind,
    date,
    interestPaise: interest,
    principalPaise: principal,
    periodNumber: period,
    transactionId: null,
    note: null,
    createdAt: `${date}T00:00:00.000Z`,
  };
}

/** Payments for the first [count] rows of the original schedule. */
function payInstallments(loan: Loan, count: number): LoanPayment[] {
  return originalSchedule(loan)
    .slice(0, count)
    .map((r) => payment(loan, 'installment', r.dueDate, r.interestPaise, r.principalPaise, r.number));
}

function ok<T>(r: CalcResult<T>): T {
  if (!r.ok) throw new Error(`Expected ok, got ${r.failure.message}`);
  return r.value;
}
function err<T>(r: CalcResult<T>) {
  if (r.ok) throw new Error('Expected an error');
  return r.failure;
}

describe('EMI', () => {
  it('₹6,00,000 @ 9.5% p.a. for 60 months = exact annuity rounded UP to the rupee (₹12,602)', () => {
    const p = 600000n;
    const num = 19n;
    const den = 2400n;
    const growthNum = (den + num) ** 60n;
    const growthDen = den ** 60n;
    const eNum = p * num * growthNum;
    const eDen = den * (growthNum - growthDen);
    const floorRupees = eNum / eDen;
    expect(floorRupees).toBe(12601n);
    expect(eNum % eDen === 0n).toBe(false);
    const r = 0.095 / 12;
    const g = Math.pow(1 + r, 60);
    expect(Math.abs((600000 * r * g) / (g - 1) - 12601.1168)).toBeLessThan(1e-3);
    const e = emi(rs(600000), 950, 60, 12);
    expect(e).toBe(Number(floorRupees + 1n) * 100);
    expect(e).toBe(rs(12602));
  });

  it('rounded-up EMI repays the loan within the tenure; one rupee less does not', () => {
    const finalBalanceNumerator = (emiRupees: number) => {
      let n = 600000n;
      let scale = 1n;
      for (let k = 0; k < 60; k++) {
        scale *= 2400n;
        n = n * 2419n - BigInt(emiRupees) * scale;
      }
      return n;
    };
    expect(finalBalanceNumerator(12602) < 0n).toBe(true);
    expect(finalBalanceNumerator(12601) < 0n).toBe(false);
  });

  it('zero-rate EMI is principal / n rounded up to the rupee', () => {
    expect(emi(rs(100000), 0, 12, 12)).toBe(rs(8334));
    expect(emi(rs(120000), 0, 12, 12)).toBe(rs(10000));
    expect(emi(0, 950, 12, 12)).toBe(0);
    expect(() => emi(rs(1000), 950, 0, 12)).toThrow(RangeError);
  });

  it('periodic interest = balance × rate ÷ periods, half-up to the paisa', () => {
    expect(periodInterest(rs(600000), 950, 12)).toBe(rs(4750));
    expect(periodInterest(12345, 1000, 12)).toBe(103); // 102.875
    expect(periodInterest(12300, 1000, 12)).toBe(103); // 102.5 → 103
    expect(periodInterest(rs(100000), 1200, 4)).toBe(rs(3000));
    expect(periodInterest(rs(100000), 0, 12)).toBe(0);
    expect(periodInterest(0, 950, 12)).toBe(0);
  });
});

describe('amortization schedule', () => {
  it('₹6L @ 9.5% × 60: principal sums exactly, ends at zero, final payment ≤ EMI', () => {
    const loan = amortizing();
    const rows = originalSchedule(loan);
    const e = rs(12602);
    expect(rows).toHaveLength(60);
    expect(sum(rows.map((r) => r.principalPaise))).toBe(loan.principalPaise);
    expect(rows.at(-1)!.balanceAfterPaise).toBe(0);
    expect(rows.at(-1)!.isFinal).toBe(true);
    expect(rows.filter((r) => r.isFinal)).toHaveLength(1);
    expect(rows.at(-1)!.paymentPaise).toBeLessThanOrEqual(e);
    expect(rows.slice(0, 59).every((r) => r.paymentPaise === e)).toBe(true);
    let balance = loan.principalPaise;
    for (const r of rows) {
      const expected = roundDivBig(BigInt(balance) * 950n, 120000n, 'halfUp');
      expect(r.interestPaise).toBe(Number(expected));
      expect(r.interestPaise + r.principalPaise).toBe(r.paymentPaise);
      balance -= r.principalPaise;
      expect(r.balanceAfterPaise).toBe(balance);
    }
    expect(rows[0]!.interestPaise).toBe(rs(4750));
    expect(rows[0]!.principalPaise).toBe(rs(7852));
    expect(rows.map((r) => r.number)).toEqual(Array.from({ length: 60 }, (_, i) => i + 1));
    expect(rows[0]!.dueDate).toBe('2026-11-05');
    expect(rows[3]!.dueDate).toBe('2027-02-05');
    expect(rows.at(-1)!.dueDate).toBe('2031-10-05');
  });

  it('due dates stay anchored to the 31st', () => {
    const rows = originalSchedule(amortizing({ firstDue: '2027-01-31', n: 4 }));
    expect(rows.map((r) => r.dueDate)).toEqual(['2027-01-31', '2027-02-28', '2027-03-31', '2027-04-30']);
  });

  it('invariants hold across many loans', () => {
    // Seeded PRNG (Dart's Random(2026) sequence cannot be reproduced; same ranges).
    let seed = 2026;
    const next = (max: number) => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed % max;
    };
    const freqs: Frequency[] = ['monthly', 'quarterly', 'yearly'];
    for (let i = 0; i < 150; i++) {
      const principal = (next(5000000) + 1000) * 100 + next(100);
      const bps = next(2400);
      const n = next(240) + 1;
      const freq = freqs[next(3)]!;
      const ppy = freq === 'monthly' ? 12 : freq === 'quarterly' ? 4 : 1;
      const e = emi(principal, bps, n, ppy);
      if (e <= periodInterest(principal, bps, ppy)) continue;
      const rows = originalSchedule(amortizing({ principal, bps, n, frequency: freq }));
      expect(e % 100).toBe(0);
      expect(sum(rows.map((r) => r.principalPaise))).toBe(principal);
      expect(rows.at(-1)!.balanceAfterPaise).toBe(0);
      expect(rows.at(-1)!.paymentPaise).toBeLessThanOrEqual(e);
      expect(rows.length).toBeLessThanOrEqual(n);
      expect(rows.every((r) => r.principalPaise >= 0 && r.interestPaise >= 0)).toBe(true);
    }
  });

  it('zero-rate loan: no interest, equal instalments, final instalment absorbs the remainder', () => {
    const loan = amortizing({ principal: rs(100000), bps: 0, n: 12 });
    const rows = originalSchedule(loan);
    expect(rows).toHaveLength(12);
    expect(rows.every((r) => r.interestPaise === 0)).toBe(true);
    expect(rows.slice(0, 11).every((r) => r.paymentPaise === rs(8334))).toBe(true);
    expect(rows.at(-1)!.paymentPaise).toBe(rs(8326));
    expect(sum(rows.map((r) => r.principalPaise))).toBe(rs(100000));
    const st = loanState(loan, [], today);
    expect(st.projectedInterestPaise).toBe(0);
    expect(st.currentInstallmentPaise).toBe(rs(8334));
  });
});

describe('loan state', () => {
  it('fresh amortizing loan', () => {
    const loan = amortizing();
    const st = loanState(loan, [], today);
    expect(st.today).toBe(today);
    expect(st.outstandingPaise).toBe(loan.principalPaise);
    expect(st.periodsPaid).toBe(0);
    expect(st.currentInstallmentPaise).toBe(rs(12602));
    expect(st.schedule).toHaveLength(60);
    expect(st.remainingInstallments).toBe(60);
    expect(st.nextDue!.number).toBe(1);
    expect(st.daysUntilNextDue).toBe(26);
    expect(st.overdueCount).toBe(0);
    expect(st.projectedEndDate).toBe('2031-10-05');
    expect(st.totalInterestCostPaise).toBe(sum(originalSchedule(loan).map((r) => r.interestPaise)));
    expect(st.repaidBps).toBe(0);
    expect(st.warning).toBeNull();
  });

  it('payments reduce outstanding and advance the schedule', () => {
    const loan = amortizing();
    const pays = payInstallments(loan, 3);
    const st = loanState(loan, pays, today);
    const original = originalSchedule(loan);
    expect(st.periodsPaid).toBe(3);
    expect(st.outstandingPaise).toBe(original[2]!.balanceAfterPaise);
    expect(st.principalRepaidPaise).toBe(sum(original.slice(0, 3).map((r) => r.principalPaise)));
    expect(st.interestPaidPaise).toBe(sum(original.slice(0, 3).map((r) => r.interestPaise)));
    expect(st.schedule).toHaveLength(57);
    expect(st.schedule[0]!.number).toBe(4);
    expect(st.schedule[0]!.dueDate).toBe(original[3]!.dueDate);
    expect(st.currentInstallmentPaise).toBe(rs(12602));
    expect(sum(st.schedule.map((r) => r.principalPaise))).toBe(st.outstandingPaise);
    expect(st.payments[0]!.date > st.payments.at(-1)!.date).toBe(true);
    expect(loanState(amortizing({ id: 'other' }), pays, today).outstandingPaise).toBe(rs(600000));
  });

  it('overdueCount counts unpaid rows due before today', () => {
    const loan = amortizing({ firstDue: '2026-08-05' });
    const st = loanState(loan, [], today);
    expect(st.overdueCount).toBe(3);
    expect(st.isOverdue).toBe(true);
    expect(st.daysUntilNextDue).toBe(-66);
    expect(loanState(loan, payInstallments(loan, 1), today).overdueCount).toBe(2);
    const paidAll = loanState(loan, payInstallments(loan, 3), today);
    expect(paidAll.overdueCount).toBe(0);
    expect(paidAll.nextDue!.dueDate).toBe('2026-11-05');
    expect(loanState(loan, payInstallments(loan, 2), '2026-10-05').overdueCount).toBe(0);
    const closed = loanState(amortizing({ firstDue: '2026-08-05', status: 'closed' }), [], today);
    expect(closed.overdueCount).toBe(0);
    expect(closed.nextDue).toBeNull();
  });

  describe('prepayment strategies', () => {
    const withStrategy = (s: Loan['prepaymentStrategy']) => amortizing({ firstDue: '2026-01-05', strategy: s });
    const history = (loan: Loan) => [...payInstallments(loan, 3), payment(loan, 'principal', '2026-04-10', 0, rs(100000))];

    it('reduceTenure keeps the EMI and finishes earlier', () => {
      const loan = withStrategy('reduceTenure');
      const st = loanState(loan, history(loan), today);
      const original = originalSchedule(loan);
      expect(st.outstandingPaise).toBe(original[2]!.balanceAfterPaise - rs(100000));
      expect(st.currentInstallmentPaise).toBe(rs(12602));
      expect(st.schedule.length).toBeLessThan(57);
      expect(st.schedule[0]!.number).toBe(4);
      expect(st.schedule.slice(0, -1).every((r) => r.paymentPaise === rs(12602))).toBe(true);
      expect(sum(st.schedule.map((r) => r.principalPaise))).toBe(st.outstandingPaise);
      expect(st.schedule.at(-1)!.balanceAfterPaise).toBe(0);
    });

    it('reduceEmi lowers the EMI and keeps the remaining instalment count', () => {
      const loan = withStrategy('reduceEmi');
      const st = loanState(loan, history(loan), today);
      expect(st.currentInstallmentPaise).toBe(emi(st.outstandingPaise, loan.rateBps, 57, 12));
      expect(st.currentInstallmentPaise).toBeLessThan(rs(12602));
      expect(st.schedule).toHaveLength(57);
      expect(st.schedule.at(-1)!.dueDate).toBe('2030-12-05');
      expect(sum(st.schedule.map((r) => r.principalPaise))).toBe(st.outstandingPaise);
      expect(st.schedule.at(-1)!.balanceAfterPaise).toBe(0);
    });

    it('reduceEmi without a prepayment keeps the original EMI', () => {
      const loan = withStrategy('reduceEmi');
      const st = loanState(loan, payInstallments(loan, 3), today);
      expect(st.currentInstallmentPaise).toBe(rs(12602));
      expect(st.schedule).toHaveLength(57);
    });

    it('reduceTenure costs less total interest than reduceEmi', () => {
      const a = withStrategy('reduceTenure');
      const b = withStrategy('reduceEmi');
      expect(loanState(a, history(a), today).projectedInterestPaise).toBeLessThan(loanState(b, history(b), today).projectedInterestPaise);
    });
  });

  describe('interest-only', () => {
    it('periodic interest on the outstanding principal, no maturity: next 12 periods', () => {
      const st = loanState(interestOnly(), [], today);
      expect(st.currentInstallmentPaise).toBe(rs(2000));
      expect(st.schedule).toHaveLength(12);
      expect(st.schedule.every((r) => r.interestPaise === rs(2000) && r.principalPaise === 0 && r.balanceAfterPaise === rs(200000))).toBe(true);
      expect(st.schedule[0]!.dueDate).toBe('2026-11-01');
      expect(st.schedule.at(-1)!.dueDate).toBe('2027-10-01');
      expect(st.projectedInterestPaise).toBe(rs(24000));
      expect(st.remainingInstallments).toBeNull();
      expect(st.projectedEndDate).toBeNull();
    });

    it('interest recalculates after a principal prepayment', () => {
      const loan = interestOnly();
      const pays = [payment(loan, 'interest', '2026-10-01', rs(2000), 0, 1), payment(loan, 'principal', '2026-10-05', 0, rs(50000))];
      const st = loanState(loan, pays, today);
      expect(st.outstandingPaise).toBe(rs(150000));
      expect(st.currentInstallmentPaise).toBe(rs(1500));
      expect(st.schedule.every((r) => r.interestPaise === rs(1500))).toBe(true);
      expect(st.periodsPaid).toBe(1);
      expect(st.schedule[0]!.number).toBe(2);
      expect(st.schedule[0]!.dueDate).toBe('2026-12-01');
    });

    it('principal is due with the period that reaches maturity', () => {
      const st = loanState(interestOnly({ maturity: '2027-02-01' }), [], today);
      expect(st.schedule).toHaveLength(4);
      const last = st.schedule.at(-1)!;
      expect(last.dueDate).toBe('2027-02-01');
      expect(last.isFinal).toBe(true);
      expect(last.principalPaise).toBe(rs(200000));
      expect(last.paymentPaise).toBe(rs(202000));
      expect(last.balanceAfterPaise).toBe(0);
      expect(st.projectedEndDate).toBe('2027-02-01');
    });

    it('zero-interest loan has no periodic rows, only the maturity payoff', () => {
      const st = loanState(interestOnly({ bps: 0, maturity: '2027-03-01' }), [], today);
      expect(st.currentInstallmentPaise).toBe(0);
      expect(st.schedule).toHaveLength(1);
      expect(st.schedule[0]!.dueDate).toBe('2027-03-01');
      expect(st.schedule[0]!.interestPaise).toBe(0);
      expect(st.schedule[0]!.paymentPaise).toBe(rs(200000));
      expect(st.schedule[0]!.number).toBe(5);
      expect(st.projectedInterestPaise).toBe(0);
    });

    it('zero-interest loan without maturity has nothing scheduled', () => {
      const st = loanState(interestOnly({ bps: 0 }), [], today);
      expect(st.schedule).toEqual([]);
      expect(st.nextDue).toBeNull();
      expect(st.overdueCount).toBe(0);
      expect(err(previewPayment(st, 'interest', rs(100))).code).toBe('validation');
      expect(ok(previewPayment(st, 'principal', rs(200000))).closesLoan).toBe(true);
    });
  });
});

describe('previewPayment', () => {
  const loan = amortizing();
  const st = loanState(loan, [], today);

  it('EMI splits into interest due then principal', () => {
    const p = ok(previewPayment(st, 'installment', rs(12602)));
    expect(p.interestPortionPaise).toBe(rs(4750));
    expect(p.principalPortionPaise).toBe(rs(7852));
    expect(p.outstandingAfterPaise).toBe(rs(600000 - 7852));
    expect(p.periodNumber).toBe(1);
    expect(p.dueDate).toBe('2026-11-05');
    expect(p.includesPrepayment).toBe(false);
    expect(p.closesLoan).toBe(false);
  });

  it('more than the EMI is flagged as a prepayment', () => {
    const p = ok(previewPayment(st, 'installment', rs(20000)));
    expect(p.principalPortionPaise).toBe(rs(15250));
    expect(p.includesPrepayment).toBe(true);
  });

  it('exact payoff closes the loan', () => {
    const p = ok(previewPayment(st, 'installment', rs(604750)));
    expect(p.closesLoan).toBe(true);
    expect(p.outstandingAfterPaise).toBe(0);
    const principalOnly = ok(previewPayment(st, 'principal', rs(600000)));
    expect(principalOnly.closesLoan).toBe(true);
    expect(principalOnly.interestPortionPaise).toBe(0);
  });

  it('rejects less than the interest due', () => {
    const f = err(previewPayment(st, 'installment', rs(4750) - 1));
    expect(f.code).toBe('validation');
    expect(Object.keys(f.fieldErrors)).toContain('amount');
    expect(f.message).toBe('The payment must at least cover the interest due of ₹4,750.');
    ok(previewPayment(st, 'installment', rs(4750)));
  });

  it('rejects more than the payoff amount', () => {
    const f = err(previewPayment(st, 'installment', rs(604750) + 1));
    expect(f.fieldErrors).toEqual({ amount: 'Maximum ₹6,04,750' });
    const g = err(previewPayment(st, 'principal', rs(600000) + 1));
    expect(g.message).toBe('Principal repayment cannot exceed the outstanding ₹6,00,000.');
  });

  it('rejects zero, wrong kind and closed loans', () => {
    expect(Object.keys(err(previewPayment(st, 'installment', 0)).fieldErrors)).toContain('amount');
    const wrong = err(previewPayment(st, 'interest', rs(5000)));
    expect(wrong.code).toBe('validation');
    expect(wrong.message).toBe('Interest payment is not applicable to a emi loan.');
    const closed = loanState(amortizing({ status: 'closed' }), [], today);
    expect(closed.isClosed).toBe(true);
    expect(err(previewPayment(closed, 'installment', rs(12602))).message).toBe('This loan is already fully repaid.');
    const repaid = loanState(loan, [payment(loan, 'principal', today, 0, rs(600000))], today);
    expect(repaid.isClosed).toBe(true);
    expect(repaid.schedule).toEqual([]);
    expect(err(previewPayment(repaid, 'principal', rs(1))).code).toBe('validation');
  });

  it('interest-only: minimum is the period interest, maximum the payoff', () => {
    const io = loanState(interestOnly(), [], today);
    expect(Object.keys(err(previewPayment(io, 'interest', rs(1999))).fieldErrors)).toContain('amount');
    const exact = ok(previewPayment(io, 'interest', rs(2000)));
    expect(exact.principalPortionPaise).toBe(0);
    expect(exact.includesPrepayment).toBe(false);
    const extra = ok(previewPayment(io, 'interest', rs(52000)));
    expect(extra.principalPortionPaise).toBe(rs(50000));
    expect(extra.includesPrepayment).toBe(true);
    expect(ok(previewPayment(io, 'interest', rs(202000))).closesLoan).toBe(true);
    expect(err(previewPayment(io, 'interest', rs(202000) + 1)).code).toBe('validation');
    expect(err(previewPayment(io, 'installment', rs(2000))).code).toBe('validation');
  });
});

it('outstandingOn uses payments up to the date', () => {
  const loan = amortizing({ firstDue: '2026-01-05' });
  const pays = payInstallments(loan, 3);
  const rows = originalSchedule(loan);
  expect(outstandingOn(loan, pays, '2025-12-01')).toBe(0);
  expect(outstandingOn(loan, pays, '2026-01-04')).toBe(rs(600000));
  expect(outstandingOn(loan, pays, '2026-02-05')).toBe(rows[1]!.balanceAfterPaise);
  expect(outstandingOn(loan, pays, today)).toBe(rows[2]!.balanceAfterPaise);
});

it('InterestRate parse and label', () => {
  expect(parseRate('10.5')).toBe(1050);
  expect(parseRate('9.25%')).toBe(925);
  expect(parseRate('9')).toBe(900);
  expect(parseRate('abc')).toBeNull();
  expect(parseRate('9.125')).toBeNull();
  expect(rateLabel(1050)).toBe('10.5%');
  expect(rateLabel(925)).toBe('9.25%');
  expect(rateLabel(900)).toBe('9%');
});

describe('quote (LoanQuote.of)', () => {
  const base = {
    structure: 'amortizing' as const,
    principalPaise: rs(600000),
    rateBps: 950,
    startDate: '2026-10-01',
    firstDueDate: '2026-11-05',
    frequency: 'monthly' as const,
    tenureInstallments: 60,
    maturityDate: null,
  };

  it('EMI, total interest and last due date of the original schedule', () => {
    const q = quoteLoan(base)!;
    const rows = originalSchedule({ ...amortizing(), firstDueDate: '2026-11-05' });
    expect(q.installmentPaise).toBe(rs(12602));
    expect(q.installments).toBe(60);
    expect(q.totalInterestPaise).toBe(sum(rows.map((r) => r.interestPaise)));
    expect(q.totalPayablePaise).toBe(rs(600000) + q.totalInterestPaise!);
    expect(q.lastDueDate).toBe('2031-10-05');
    expect(q.neverRepays).toBe(false);
  });

  it('null while incomplete; interest-only gives the period interest', () => {
    expect(quoteLoan({ ...base, principalPaise: 0 })).toBeNull();
    expect(quoteLoan({ ...base, rateBps: 6001 })).toBeNull();
    expect(quoteLoan({ ...base, tenureInstallments: null })).toBeNull();
    expect(quoteLoan({ ...base, tenureInstallments: 481 })).toBeNull();
    expect(quoteLoan({ ...base, structure: 'interestOnly', principalPaise: rs(100000), rateBps: 1200 })!.installmentPaise).toBe(rs(1000));
  });
});
