// Pure loan mathematics (lib/features/loans/domain/loan_calculator.dart and
// loan.dart in the Flutter app). Deterministic and integer-only (paise).
//
// Policies (docs/FINANCIAL_MODEL.md):
// * Periodic interest = outstanding × annual rate ÷ periods per year,
//   rounded half-up to the paisa. No daily accrual.
// * EMI = standard annuity formula computed exactly with bigint, rounded up
//   to the paisa and then up to the next whole rupee. The final instalment
//   absorbs the difference so the balance reaches exactly zero.
// * Payments apply to interest due first, then principal.

import { daysBetween, type IsoDate } from '../../core/dates';
import { AppFailure } from '../../core/failure';
import { FREQUENCY_INFO, nthOccurrence, type Frequency } from '../../core/frequency';
import { formatInr, ratioBps, roundDiv, roundDivBig, roundToRupee, sumPaise, toSafeNumber, type Paise } from '../../core/money';
import type { Loan, LoanPayment } from '../../finance/models';

export type LoanDirection = Loan['direction'];
export type LoanStructure = Loan['structure'];
export type PrepaymentStrategy = Loan['prepaymentStrategy'];
export type LoanPaymentKind = LoanPayment['kind'];

export const LOAN_DIRECTIONS = ['borrowed', 'lent'] as const;
export const LOAN_STRUCTURES = ['amortizing', 'interestOnly'] as const;
export const PREPAYMENT_STRATEGIES = ['reduceTenure', 'reduceEmi'] as const;
export const LOAN_PAYMENT_KINDS = ['installment', 'interest', 'principal'] as const;

export const DIRECTION_INFO: Record<LoanDirection, { label: string; phrase: string }> = {
  borrowed: { label: 'Borrowed', phrase: 'I borrowed' },
  lent: { label: 'Lent', phrase: 'I lent' },
};

export const STRUCTURE_INFO: Record<LoanStructure, { label: string; description: string }> = {
  amortizing: { label: 'EMI loan', description: 'Fixed instalments of interest + principal' },
  interestOnly: { label: 'Interest-only', description: 'Periodic interest, principal repaid separately' },
};

export const PAYMENT_KIND_LABELS: Record<LoanPaymentKind, string> = {
  installment: 'EMI instalment',
  interest: 'Interest payment',
  principal: 'Principal repayment',
};

/** `10.5%`, `9.25%`, `9%` (InterestRate.label). */
export function rateLabel(bps: number): string {
  const whole = Math.trunc(bps / 100);
  const frac = bps % 100;
  return frac === 0 ? `${whole}%` : `${whole}.${String(frac).padStart(2, '0').replace(/0$/, '')}%`;
}

/** Parses "10.5" / "10.50" / "9" into basis points (InterestRate.tryParse). */
export function parseRate(input: string): number | null {
  const m = /^\s*(\d{1,2})(?:\.(\d{1,2}))?\s*%?\s*$/.exec(input);
  if (!m) return null;
  return Number(m[1]) * 100 + Number((m[2] ?? '0').padEnd(2, '0'));
}

/** Indian money format exactly as MoneyFormatter.format (minus sign U+2212). */
export function fmtMoney(paise: Paise, sign: 'auto' | 'always' = 'auto'): string {
  return formatInr(paise, { sign });
}

const periodsPerYear = (f: Frequency) => FREQUENCY_INFO[f].periodsPerYear;

/** Loan terms the calculator needs (a Loan record satisfies it). */
export type LoanTerms = Pick<
  Loan,
  | 'id'
  | 'structure'
  | 'principalPaise'
  | 'rateBps'
  | 'startDate'
  | 'firstDueDate'
  | 'frequency'
  | 'tenureInstallments'
  | 'maturityDate'
  | 'prepaymentStrategy'
  | 'status'
>;

/** One row of a repayment schedule (projected, not yet paid). */
export interface ScheduleRow {
  number: number;
  dueDate: IsoDate;
  paymentPaise: Paise;
  interestPaise: Paise;
  principalPaise: Paise;
  balanceAfterPaise: Paise;
  isFinal: boolean;
}

/** Complete derived state of a loan at a given date. */
export interface LoanState<L extends LoanTerms = Loan> {
  loan: L;
  /** Recorded payments, newest first. */
  payments: LoanPayment[];
  outstandingPaise: Paise;
  principalRepaidPaise: Paise;
  interestPaidPaise: Paise;
  /** Instalments (amortizing) or interest periods (interest-only) paid. */
  periodsPaid: number;
  /** Current EMI (amortizing) or per-period interest (interest-only). */
  currentInstallmentPaise: Paise;
  /** Remaining projected schedule (interest-only: next 12 periods). */
  schedule: ScheduleRow[];
  /** Interest still expected over [schedule]. */
  projectedInterestPaise: Paise;
  today: IsoDate;
  /** Explains a condition such as negative amortisation. */
  warning: string | null;
  isClosed: boolean;
  nextDue: ScheduleRow | null;
  /** Unpaid rows whose due date is before today. */
  overdueCount: number;
  isOverdue: boolean;
  daysUntilNextDue: number | null;
  /** Interest paid plus interest still expected. */
  totalInterestCostPaise: Paise;
  repaidBps: number;
  remainingInstallments: number | null;
  projectedEndDate: IsoDate | null;
}

/** How a proposed payment will be applied. */
export interface LoanPaymentPreview {
  kind: LoanPaymentKind;
  amountPaise: Paise;
  interestPortionPaise: Paise;
  principalPortionPaise: Paise;
  outstandingBeforePaise: Paise;
  outstandingAfterPaise: Paise;
  periodNumber: number | null;
  dueDate: IsoDate | null;
  closesLoan: boolean;
  /** The amount exceeds the scheduled instalment; the excess reduces principal. */
  includesPrepayment: boolean;
}

export type CalcResult<T> = { ok: true; value: T } | { ok: false; failure: AppFailure };

const MAX_ROWS = 1200;

/** Interest for one period on [balance]. */
export function periodInterest(balance: Paise, rateBps: number, ppy: number): Paise {
  if (rateBps === 0 || balance <= 0) return 0;
  return toSafeNumber(roundDivBig(BigInt(balance) * BigInt(rateBps), BigInt(10000 * ppy), 'halfUp'));
}

/** Equated instalment for [principal] over [installments] periods. */
export function emi(principal: Paise, rateBps: number, installments: number, ppy: number): Paise {
  if (installments <= 0) throw new RangeError(`Invalid installments: ${installments}`);
  if (principal <= 0) return 0;
  if (rateBps === 0) return roundToRupee(roundDiv(principal, installments, 'up'), 'up');
  const d = BigInt(10000 * ppy);
  const r = BigInt(rateBps);
  const n = BigInt(installments);
  const growth = (d + r) ** n;
  const base = d ** n;
  const numerator = BigInt(principal) * r * growth;
  const denominator = d * (growth - base);
  const exactPaise = roundDivBig(numerator, denominator, 'up');
  return roundToRupee(toSafeNumber(exactPaise), 'up');
}

/** Projects instalments from [balance] using a fixed [installment]. */
export function projectAmortizing(a: {
  balance: Paise;
  rateBps: number;
  installment: Paise;
  periodsPerYear: number;
  firstNumber: number;
  dueDateOf: (n: number) => IsoDate;
  maxRows?: number;
}): ScheduleRow[] {
  const rows: ScheduleRow[] = [];
  let b = a.balance;
  let n = a.firstNumber;
  const limit = a.maxRows ?? MAX_ROWS;
  while (b > 0 && rows.length < limit) {
    const interest = periodInterest(b, a.rateBps, a.periodsPerYear);
    let principalPart = a.installment - interest;
    if (principalPart <= 0) break; // negative amortisation guard
    let payment = a.installment;
    let isFinal = false;
    if (principalPart >= b) {
      principalPart = b;
      payment = b + interest;
      isFinal = true;
    }
    b = b - principalPart;
    rows.push({
      number: n,
      dueDate: a.dueDateOf(n),
      paymentPaise: payment,
      interestPaise: interest,
      principalPaise: principalPart,
      balanceAfterPaise: b,
      isFinal: isFinal || b === 0,
    });
    n++;
  }
  return rows;
}

const dueDateOf = (loan: Pick<LoanTerms, 'frequency' | 'firstDueDate'>) => (k: number) =>
  nthOccurrence(loan.frequency, loan.firstDueDate, k - 1);

/** Full original schedule for a new amortizing loan (no payments yet). */
export function originalSchedule(loan: LoanTerms): ScheduleRow[] {
  const n = loan.tenureInstallments ?? 1;
  const ppy = periodsPerYear(loan.frequency);
  return projectAmortizing({
    balance: loan.principalPaise,
    rateBps: loan.rateBps,
    installment: emi(loan.principalPaise, loan.rateBps, n, ppy),
    periodsPerYear: ppy,
    firstNumber: 1,
    dueDateOf: dueDateOf(loan),
  });
}

function finishState<L extends LoanTerms>(
  s: Omit<
    LoanState<L>,
    | 'isClosed'
    | 'nextDue'
    | 'overdueCount'
    | 'isOverdue'
    | 'daysUntilNextDue'
    | 'totalInterestCostPaise'
    | 'repaidBps'
    | 'remainingInstallments'
    | 'projectedEndDate'
  >,
): LoanState<L> {
  const isClosed = s.outstandingPaise === 0 || s.loan.status === 'closed';
  const nextDue = isClosed || s.schedule.length === 0 ? null : s.schedule[0]!;
  const overdueCount = isClosed ? 0 : s.schedule.filter((r) => r.dueDate < s.today).length;
  const amortizing = s.loan.structure === 'amortizing';
  const repaid = ratioBps(s.principalRepaidPaise, s.loan.principalPaise) ?? 0;
  return {
    ...s,
    isClosed,
    nextDue,
    overdueCount,
    isOverdue: overdueCount > 0,
    daysUntilNextDue: nextDue === null ? null : daysBetween(s.today, nextDue.dueDate),
    totalInterestCostPaise: s.interestPaidPaise + s.projectedInterestPaise,
    repaidBps: Math.min(Math.max(repaid, 0), 10000),
    remainingInstallments: amortizing ? s.schedule.length : null,
    projectedEndDate: amortizing ? (s.schedule.length === 0 ? null : s.schedule[s.schedule.length - 1]!.dueDate) : s.loan.maturityDate,
  };
}

/** Derived state of [loan] from its recorded payments (others in [allPayments] are ignored). */
export function loanState<L extends LoanTerms>(loan: L, allPayments: readonly LoanPayment[], today: IsoDate): LoanState<L> {
  const payments = allPayments
    .filter((p) => p.loanId === loan.id)
    .sort((a, b) => {
      const c = b.date.localeCompare(a.date);
      return c !== 0 ? c : b.createdAt.localeCompare(a.createdAt);
    });
  const principalRepaid = sumPaise(payments.map((p) => p.principalPaise));
  const interestPaid = sumPaise(payments.map((p) => p.interestPaise));
  const outstanding = Math.max(loan.principalPaise - principalRepaid, 0);
  const ppy = periodsPerYear(loan.frequency);

  if (loan.structure === 'amortizing') {
    const tenure = loan.tenureInstallments ?? 1;
    const paid = payments.filter((p) => p.kind === 'installment').length;
    const originalEmi = emi(loan.principalPaise, loan.rateBps, tenure, ppy);
    // A prepayment happened if more principal was repaid than the original
    // schedule would have repaid after the same number of instalments.
    const scheduledPrincipal = sumPaise(
      projectAmortizing({
        balance: loan.principalPaise,
        rateBps: loan.rateBps,
        installment: originalEmi,
        periodsPerYear: ppy,
        firstNumber: 1,
        dueDateOf: () => loan.firstDueDate,
        maxRows: paid,
      }).map((r) => r.principalPaise),
    );
    const hasPrepayment = principalRepaid > scheduledPrincipal;
    let installment = originalEmi;
    if (hasPrepayment && loan.prepaymentStrategy === 'reduceEmi') {
      const remaining = Math.min(Math.max(tenure - paid, 1), tenure);
      installment = emi(outstanding, loan.rateBps, remaining, ppy);
    }
    const schedule = projectAmortizing({
      balance: outstanding,
      rateBps: loan.rateBps,
      installment,
      periodsPerYear: ppy,
      firstNumber: paid + 1,
      dueDateOf: dueDateOf(loan),
    });
    const warning =
      outstanding > 0 && schedule.length === 0 ? 'The instalment does not cover the interest due. Review the rate and tenure.' : null;
    return finishState({
      loan,
      payments,
      outstandingPaise: outstanding,
      principalRepaidPaise: principalRepaid,
      interestPaidPaise: interestPaid,
      periodsPaid: paid,
      currentInstallmentPaise: installment,
      schedule,
      projectedInterestPaise: sumPaise(schedule.map((r) => r.interestPaise)),
      today,
      warning,
    });
  }

  // Interest-only.
  const paid = payments.filter((p) => p.kind === 'interest').length;
  const interest = periodInterest(outstanding, loan.rateBps, ppy);
  const schedule: ScheduleRow[] = [];
  if (outstanding > 0) {
    for (let i = 0; i < (interest === 0 ? 600 : 12) && schedule.length < 12; i++) {
      const number = paid + 1 + i;
      const due = nthOccurrence(loan.frequency, loan.firstDueDate, number - 1);
      const atMaturity = loan.maturityDate !== null && !(due < loan.maturityDate);
      // Interest-free loans have nothing due until maturity.
      if (interest === 0 && !atMaturity) continue;
      schedule.push({
        number,
        dueDate: due,
        paymentPaise: atMaturity ? interest + outstanding : interest,
        interestPaise: interest,
        principalPaise: atMaturity ? outstanding : 0,
        balanceAfterPaise: atMaturity ? 0 : outstanding,
        isFinal: atMaturity,
      });
      if (atMaturity) break;
    }
  }
  return finishState({
    loan,
    payments,
    outstandingPaise: outstanding,
    principalRepaidPaise: principalRepaid,
    interestPaidPaise: interestPaid,
    periodsPaid: paid,
    currentInstallmentPaise: interest,
    schedule,
    projectedInterestPaise: sumPaise(schedule.map((r) => r.interestPaise)),
    today,
    warning: null,
  });
}

/** Validates and splits a proposed payment. */
export function previewPayment(state: LoanState<LoanTerms>, kind: LoanPaymentKind, amount: Paise): CalcResult<LoanPaymentPreview> {
  const err = (failure: AppFailure): CalcResult<LoanPaymentPreview> => ({ ok: false, failure });
  if (amount <= 0) {
    return err(AppFailure.validation('Enter an amount greater than zero.', { amount: 'Enter an amount greater than zero.' }));
  }
  if (state.isClosed) return err(AppFailure.validation('This loan is already fully repaid.'));
  const loan = state.loan;
  const outstanding = state.outstandingPaise;

  if (kind === 'principal') {
    if (amount > outstanding) {
      return err(
        AppFailure.validation(`Principal repayment cannot exceed the outstanding ${fmtMoney(outstanding)}.`, {
          amount: `Maximum ${fmtMoney(outstanding)}`,
        }),
      );
    }
    const after = outstanding - amount;
    return {
      ok: true,
      value: {
        kind,
        amountPaise: amount,
        interestPortionPaise: 0,
        principalPortionPaise: amount,
        outstandingBeforePaise: outstanding,
        outstandingAfterPaise: after,
        periodNumber: null,
        dueDate: null,
        closesLoan: after === 0,
        includesPrepayment: true,
      },
    };
  }

  const expectedKind: LoanPaymentKind = loan.structure === 'amortizing' ? 'installment' : 'interest';
  if (kind !== expectedKind) {
    return err(
      AppFailure.validation(`${PAYMENT_KIND_LABELS[kind]} is not applicable to a ${STRUCTURE_INFO[loan.structure].label.toLowerCase()}.`),
    );
  }
  const row = state.nextDue;
  if (row === null) {
    // E.g. an interest-free loan with no maturity date, or an instalment
    // that no longer covers the interest: nothing is scheduled.
    return err(AppFailure.validation('Nothing is scheduled on this loan right now. Record a principal repayment instead.'));
  }
  const interestDue = row.interestPaise;
  if (amount < interestDue) {
    return err(
      AppFailure.validation(`The payment must at least cover the interest due of ${fmtMoney(interestDue)}.`, {
        amount: `Minimum ${fmtMoney(interestDue)}`,
      }),
    );
  }
  const payoff = interestDue + outstanding;
  if (amount > payoff) {
    return err(
      AppFailure.validation(`This is more than the full payoff amount of ${fmtMoney(payoff)}.`, { amount: `Maximum ${fmtMoney(payoff)}` }),
    );
  }
  const principalPortion = amount - interestDue;
  const after = outstanding - principalPortion;
  return {
    ok: true,
    value: {
      kind,
      amountPaise: amount,
      interestPortionPaise: interestDue,
      principalPortionPaise: principalPortion,
      outstandingBeforePaise: outstanding,
      outstandingAfterPaise: after,
      periodNumber: row.number,
      dueDate: row.dueDate,
      closesLoan: after === 0,
      includesPrepayment: amount > row.paymentPaise,
    },
  };
}

/** The most a payment of [kind] can be right now (payoff), or null when none is possible. */
export function payoffFor(state: LoanState<LoanTerms>, kind: LoanPaymentKind): Paise | null {
  if (state.isClosed) return null;
  if (kind === 'principal') return state.outstandingPaise;
  return state.nextDue === null ? null : state.nextDue.interestPaise + state.outstandingPaise;
}

/** Outstanding principal at the end of [date], from recorded payments. */
export function outstandingOn(loan: LoanTerms, payments: readonly LoanPayment[], date: IsoDate): Paise {
  if (date < loan.startDate) return 0;
  const repaid = sumPaise(payments.filter((p) => p.loanId === loan.id && !(p.date > date)).map((p) => p.principalPaise));
  return Math.max(loan.principalPaise - repaid, 0);
}

// ---------------------------------------------------------------------------
// Live quote while the loan form is filled in (application/loan_quote.dart).

/** Upper bound for live quotes (keeps bigint work bounded while typing): ₹1,00,00,00,00,000. */
export const MAX_LOAN_QUOTE_PRINCIPAL_PAISE = 100_000_000_000 * 100;

export interface LoanQuoteInput {
  structure: LoanStructure;
  principalPaise: Paise;
  rateBps: number;
  startDate: IsoDate;
  firstDueDate: IsoDate;
  frequency: Frequency;
  tenureInstallments: number | null;
  maturityDate: IsoDate | null;
  prepaymentStrategy?: PrepaymentStrategy;
}

export interface LoanQuote {
  structure: LoanStructure;
  /** EMI (amortizing) or interest per period (interest-only). */
  installmentPaise: Paise;
  installments: number | null;
  /** Interest over the full original schedule (amortizing only). */
  totalInterestPaise: Paise | null;
  /** Principal + total interest (amortizing only). */
  totalPayablePaise: Paise | null;
  lastDueDate: IsoDate | null;
  /** The instalment never covers the interest (negative amortisation). */
  neverRepays: boolean;
}

/** Loan terms as LoanInput.toLoan builds them (tenure only for EMI loans, maturity only for interest-only). */
export function termsOf(i: LoanQuoteInput, id: string): LoanTerms {
  return {
    id,
    structure: i.structure,
    principalPaise: i.principalPaise,
    rateBps: i.rateBps,
    startDate: i.startDate,
    firstDueDate: i.firstDueDate,
    frequency: i.frequency,
    tenureInstallments: i.structure === 'amortizing' ? i.tenureInstallments : null,
    maturityDate: i.structure === 'interestOnly' ? i.maturityDate : null,
    prepaymentStrategy: i.prepaymentStrategy ?? 'reduceTenure',
    status: 'active',
  };
}

/** Null while the inputs are incomplete or out of range (LoanQuote.of). */
export function quoteLoan(i: LoanQuoteInput): LoanQuote | null {
  if (i.principalPaise <= 0 || i.principalPaise > MAX_LOAN_QUOTE_PRINCIPAL_PAISE) return null;
  if (i.rateBps < 0 || i.rateBps > 6000) return null;
  const ppy = periodsPerYear(i.frequency);
  const base = { installments: null, totalInterestPaise: null, totalPayablePaise: null, lastDueDate: null, neverRepays: false };
  if (i.structure === 'interestOnly') {
    return { ...base, structure: i.structure, installmentPaise: periodInterest(i.principalPaise, i.rateBps, ppy) };
  }
  const n = i.tenureInstallments;
  if (n === null || n < 1 || n > 480) return null;
  const e = emi(i.principalPaise, i.rateBps, n, ppy);
  if (e <= periodInterest(i.principalPaise, i.rateBps, ppy)) {
    return { ...base, structure: i.structure, installmentPaise: e, installments: n, neverRepays: true };
  }
  const schedule = originalSchedule(termsOf(i, 'quote'));
  if (schedule.length === 0) return null;
  const interest = sumPaise(schedule.map((r) => r.interestPaise));
  return {
    structure: i.structure,
    installmentPaise: e,
    installments: schedule.length,
    totalInterestPaise: interest,
    totalPayablePaise: i.principalPaise + interest,
    lastDueDate: schedule[schedule.length - 1]!.dueDate,
    neverRepays: false,
  };
}
