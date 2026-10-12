// Loan read models: derived state per loan (FinanceSnapshot.loanStates in the
// Flutter app) and the JSON shapes of the loan endpoints.

import type { IsoDate } from '../../core/dates';
import { nthOccurrence } from '../../core/frequency';
import type { FinanceSnapshot } from '../../finance/snapshot';
import type { Loan } from '../../finance/models';
import { loanState, type LoanState, type ScheduleRow } from './calculator';

/** Derived state of every loan of the snapshot's user, as of snapshot.today. */
export async function loadLoanStates(snapshot: FinanceSnapshot): Promise<LoanState<Loan>[]> {
  const [loans, payments] = await Promise.all([snapshot.loans(), snapshot.loanPayments()]);
  return loans.map((l) => loanState(l, payments, snapshot.today));
}

/** State of one loan (FinanceSnapshot.loan), or null when it does not exist. */
export async function loadLoanState(snapshot: FinanceSnapshot, id: string): Promise<LoanState<Loan> | null> {
  const loan = (await snapshot.loans()).find((l) => l.id === id);
  if (!loan) return null;
  return loanState(loan, await snapshot.loanPayments(), snapshot.today);
}

/** Compact state for lists and dashboards. */
export function loanSummary(s: LoanState<Loan>) {
  return {
    outstandingPaise: s.outstandingPaise,
    emiPaise: s.currentInstallmentPaise,
    nextDue: s.nextDue ? { date: s.nextDue.dueDate, amountPaise: s.nextDue.paymentPaise, period: s.nextDue.number } : null,
    daysUntilNextDue: s.daysUntilNextDue,
    overdueCount: s.overdueCount,
    paidInstallments: s.periodsPaid,
    principalRepaidPaise: s.principalRepaidPaise,
    totalInterestPaidPaise: s.interestPaidPaise,
    projectedInterestPaise: s.projectedInterestPaise,
    remainingInstallments: s.remainingInstallments,
    projectedEndDate: s.projectedEndDate,
    repaidBps: s.repaidBps,
    warning: s.warning,
    closed: s.isClosed,
  };
}

export type ScheduleStatus = 'paid' | 'due' | 'overdue' | 'upcoming';

export interface ScheduleRowView {
  number: number;
  dueDate: IsoDate;
  /** Date the row was paid (paid rows only). */
  paidOn: IsoDate | null;
  paymentPaise: number;
  interestPaise: number;
  principalPaise: number;
  balanceAfterPaise: number | null;
  isFinal: boolean;
  status: ScheduleStatus;
  /** Payment that settled the row (paid rows only). */
  paymentId: string | null;
}

/**
 * Recorded instalment/interest payments as `paid` rows (oldest first), then the
 * remaining projection: `overdue` when due before today, `due` for the first
 * row not yet overdue, `upcoming` after it.
 */
export function scheduleView(s: LoanState<Loan>): ScheduleRowView[] {
  const scheduledKind = s.loan.structure === 'amortizing' ? 'installment' : 'interest';
  const paid: ScheduleRowView[] = s.payments
    .filter((p) => p.kind === scheduledKind)
    .reverse()
    .map((p) => ({
      number: p.periodNumber ?? 0,
      dueDate: p.periodNumber ? nthOccurrence(s.loan.frequency, s.loan.firstDueDate, p.periodNumber - 1) : p.date,
      paidOn: p.date,
      paymentPaise: p.interestPaise + p.principalPaise,
      interestPaise: p.interestPaise,
      principalPaise: p.principalPaise,
      balanceAfterPaise: null,
      isFinal: false,
      status: 'paid' as const,
      paymentId: p.id,
    }));
  if (s.isClosed) return paid;
  let dueAssigned = false;
  const projected = s.schedule.map((r: ScheduleRow): ScheduleRowView => {
    let status: ScheduleStatus;
    if (r.dueDate < s.today) status = 'overdue';
    else if (!dueAssigned) {
      status = 'due';
      dueAssigned = true;
    } else status = 'upcoming';
    return {
      number: r.number,
      dueDate: r.dueDate,
      paidOn: null,
      paymentPaise: r.paymentPaise,
      interestPaise: r.interestPaise,
      principalPaise: r.principalPaise,
      balanceAfterPaise: r.balanceAfterPaise,
      isFinal: r.isFinal,
      status,
      paymentId: null,
    };
  });
  return [...paid, ...projected];
}
