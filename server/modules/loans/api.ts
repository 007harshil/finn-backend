// Read endpoints of the loans screens (list, detail, live quote, payment split).
// Nothing here writes.

import { z } from 'zod';
import { zDate, zDateOpt, zEnum, zEnumOpt, zInt, zIntOpt, zMoney } from '../../actions/input';
import type { ActionContext } from '../../actions/types';
import { AppFailure } from '../../core/failure';
import { FREQUENCIES } from '../../core/frequency';
import { LOAN_PAYMENT_KINDS, LOAN_STRUCTURES, PREPAYMENT_STRATEGIES, loanState, originalSchedule, payoffFor, quoteLoan, termsOf } from './calculator';
import { splitPayment } from './actions';
import { loadLoanState, loadLoanStates, loanSummary, scheduleView } from './service';

/** GET /api/v1/loans */
export async function listLoans(ctx: ActionContext) {
  const states = await loadLoanStates(ctx.snapshot);
  return { today: ctx.today, items: states.map((s) => ({ loan: s.loan, state: loanSummary(s) })) };
}

/** GET /api/v1/loans/{id} */
export async function getLoan(ctx: ActionContext, id: string) {
  const s = await loadLoanState(ctx.snapshot, id);
  if (!s) throw AppFailure.notFound('This loan no longer exists.');
  return {
    today: ctx.today,
    loan: s.loan,
    state: { ...loanSummary(s), totalInterestCostPaise: s.totalInterestCostPaise, currentInstallmentPaise: s.currentInstallmentPaise },
    payments: s.payments,
    schedule: scheduleView(s),
  };
}

export const quoteBody = z.object({
  structure: zEnum(LOAN_STRUCTURES),
  principal: zMoney,
  rateBps: zInt,
  startDate: zDate,
  firstDueDate: zDate,
  frequency: zEnum(FREQUENCIES),
  tenureInstallments: zIntOpt,
  maturityDate: zDateOpt,
  prepaymentStrategy: zEnumOpt(PREPAYMENT_STRATEGIES),
});

/** POST /api/v1/loans/quote: LoanQuote.of plus the projected schedule (null quote while incomplete). */
export function quote(body: z.output<typeof quoteBody>, today: string) {
  const terms = {
    structure: body.structure,
    principalPaise: body.principal,
    rateBps: body.rateBps,
    startDate: body.startDate,
    firstDueDate: body.firstDueDate,
    frequency: body.frequency,
    tenureInstallments: body.tenureInstallments,
    maturityDate: body.maturityDate,
    prepaymentStrategy: body.prepaymentStrategy ?? undefined,
  };
  const q = quoteLoan(terms);
  if (!q || q.neverRepays) return { quote: q, schedule: [] };
  const loan = termsOf(terms, 'quote');
  const schedule = body.structure === 'amortizing' ? originalSchedule(loan) : loanState(loan, [], today).schedule;
  return { quote: q, schedule };
}

export const paymentPreviewBody = z.object({
  kind: zEnum(LOAN_PAYMENT_KINDS),
  amount: zMoney,
  date: zDate.optional(),
});

/** POST /api/v1/loans/{id}/payment-preview: how a payment would be split (RecordLoanPaymentAction.split). */
export async function paymentPreview(ctx: ActionContext, loanId: string, body: z.output<typeof paymentPreviewBody>) {
  const { state, preview } = await splitPayment({ loanId, kind: body.kind, amount: body.amount, date: body.date ?? ctx.today }, ctx);
  return { ...preview, payoffPaise: payoffFor(state, body.kind) };
}
