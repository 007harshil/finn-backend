// loans.create / update / recordPayment / delete
// (lib/features/loans/application/loan_actions.dart).

import { z } from 'zod';
import {
  zBool,
  zDate,
  zDateOpt,
  zEnum,
  zEnumOpt,
  zId,
  zInt,
  zIntOpt,
  zMoney,
  zText,
  zTextOpt,
  zVersion,
} from '../../actions/input';
import { defineAction, type ActionContext, type AnyAction, type FieldSpec, type PreviewLine } from '../../actions/types';
import { formatDate } from '../../core/dates';
import { AppFailure } from '../../core/failure';
import { FREQUENCIES, FREQUENCY_INFO } from '../../core/frequency';
import { sumPaise } from '../../core/money';
import { loanFromRow, loanPaymentFromRow, type Loan, type LoanPayment } from '../../finance/models';
import { SystemCategories } from '../account/standard-categories';
import { MAX_TRANSACTION_PAISE } from '../transactions/actions';
import { channelError, resolveAccountId } from '../accounts/resolve';
import { buildLinkedTransaction, deleteTransaction, insertTransaction, updateTransaction } from '../transactions/repo';
import {
  DIRECTION_INFO,
  LOAN_DIRECTIONS,
  LOAN_PAYMENT_KINDS,
  LOAN_STRUCTURES,
  PAYMENT_KIND_LABELS,
  PREPAYMENT_STRATEGIES,
  STRUCTURE_INFO,
  emi,
  fmtMoney,
  originalSchedule,
  periodInterest,
  previewPayment,
  rateLabel,
  termsOf,
  type LoanPaymentPreview,
} from './calculator';
import { loadLoanState } from './service';

// ---------------------------------------------------------------------------
// Input (LoanInput.toJson)

const loanShape = {
  name: zText,
  counterparty: zText,
  direction: zEnum(LOAN_DIRECTIONS),
  structure: zEnum(LOAN_STRUCTURES),
  principal: zMoney,
  rateBps: zInt,
  startDate: zDate,
  firstDueDate: zDate,
  frequency: zEnum(FREQUENCIES),
  tenureInstallments: zIntOpt,
  maturityDate: zDateOpt,
  prepaymentStrategy: zEnumOpt(PREPAYMENT_STRATEGIES).transform((v) => v ?? 'reduceTenure'),
  recordDisbursement: zBool(false),
  /** Account the disbursement moved through (defaults to the default account). */
  accountId: zId.nullish().transform((v) => v ?? null),
  channel: zTextOpt,
  note: zTextOpt,
};
export const loanInput = z.object(loanShape);
export type LoanInput = z.output<typeof loanInput>;

const quoteTerms = (i: LoanInput) => ({
  structure: i.structure,
  principalPaise: i.principal,
  rateBps: i.rateBps,
  startDate: i.startDate,
  firstDueDate: i.firstDueDate,
  frequency: i.frequency,
  tenureInstallments: i.tenureInstallments,
  maturityDate: i.maturityDate,
  prepaymentStrategy: i.prepaymentStrategy,
});

/** LoanInput.toLoan: the record the input describes. */
function toLoan(
  i: LoanInput,
  id: string,
  now: string,
  extra: { disbursementTransactionId?: string | null; version?: number; createdAt?: string; status?: Loan['status'] } = {},
): Loan {
  return {
    ...termsOf(quoteTerms(i), id),
    name: i.name.trim(),
    counterparty: i.counterparty.trim(),
    direction: i.direction,
    status: extra.status ?? 'active',
    disbursementTransactionId: extra.disbursementTransactionId ?? null,
    note: i.note,
    createdAt: extra.createdAt ?? now,
    updatedAt: now,
    version: extra.version ?? 1,
  };
}

function loanToRow(userId: string, l: Loan) {
  return {
    user_id: userId,
    id: l.id,
    name: l.name,
    counterparty: l.counterparty,
    direction: l.direction,
    structure: l.structure,
    principal_paise: l.principalPaise,
    rate_bps: l.rateBps,
    start_date: l.startDate,
    first_due_date: l.firstDueDate,
    frequency: l.frequency,
    tenure_installments: l.tenureInstallments,
    maturity_date: l.maturityDate,
    prepayment_strategy: l.prepaymentStrategy,
    status: l.status,
    disbursement_transaction_id: l.disbursementTransactionId,
    note: l.note,
    version: l.version,
    created_at: l.createdAt,
    updated_at: l.updatedAt,
  };
}

/** validateLoan: field errors in Dart's order. */
export function validateLoan(i: LoanInput, today: string): Record<string, string> {
  const e: Record<string, string> = {};
  if (i.name.trim() === '') e.name = 'Give this loan a name.';
  if (i.counterparty.trim() === '') e.counterparty = i.direction === 'borrowed' ? 'Who lent you the money?' : 'Who did you lend to?';
  if (i.principal <= 0) e.principal = 'Enter the loan amount.';
  if (i.principal > MAX_TRANSACTION_PAISE) e.principal = 'That amount looks too large. Please check it.';
  if (i.rateBps < 0 || i.rateBps > 6000) e.rate = 'Enter an annual rate between 0% and 60%.';
  if (i.frequency === 'weekly') e.frequency = 'Weekly repayment is not supported.';
  if (i.firstDueDate < i.startDate) e.firstDueDate = 'The first due date must be after the start date.';
  if (i.recordDisbursement && i.startDate > today) e.startDate = 'A future disbursement cannot be recorded as cash yet.';
  const ce = channelError(i.channel);
  if (ce) e.channel = ce;
  if (i.structure === 'amortizing') {
    const n = i.tenureInstallments;
    if (n === null || n < 1 || n > 480) {
      e.tenureInstallments = 'Enter between 1 and 480 instalments.';
    } else if (i.principal > 0 && i.rateBps >= 0) {
      const ppy = FREQUENCY_INFO[i.frequency].periodsPerYear;
      if (emi(i.principal, i.rateBps, n, ppy) <= periodInterest(i.principal, i.rateBps, ppy)) {
        e.tenureInstallments = 'This tenure never repays the principal.';
      }
    }
  } else if (i.maturityDate !== null && i.maturityDate < i.firstDueDate) {
    e.maturityDate = 'Maturity must be after the first due date.';
  }
  return e;
}

const fail = (e: Record<string, string>) => {
  if (Object.keys(e).length > 0) throw AppFailure.validation(Object.values(e)[0]!, e);
};

async function existingState(ctx: ActionContext, id: string) {
  const st = await loadLoanState(ctx.snapshot, id);
  if (!st) throw AppFailure.notFound('This loan no longer exists.');
  return st;
}

// ---------------------------------------------------------------------------

const createFields: FieldSpec[] = [
  { name: 'name', kind: 'string', description: 'Label, e.g. "Car loan"', required: true },
  { name: 'counterparty', kind: 'string', description: 'Bank or person', required: true },
  { name: 'direction', kind: 'enumeration', description: 'borrowed or lent', required: true, allowedValues: ['borrowed', 'lent'] },
  {
    name: 'structure',
    kind: 'enumeration',
    description: 'amortizing (EMI) or interestOnly',
    required: true,
    allowedValues: ['amortizing', 'interestOnly'],
  },
  { name: 'principal', kind: 'money', description: 'Loan amount', required: true },
  { name: 'rateBps', kind: 'rate', description: 'Annual interest in basis points (10.5% = 1050)', required: true },
  { name: 'startDate', kind: 'date', description: 'Disbursement date', required: true },
  { name: 'firstDueDate', kind: 'date', description: 'First instalment/interest due date', required: true },
  {
    name: 'frequency',
    kind: 'enumeration',
    description: 'Repayment frequency',
    required: true,
    allowedValues: ['monthly', 'quarterly', 'halfYearly', 'yearly'],
  },
  { name: 'tenureInstallments', kind: 'integer', description: 'Number of EMIs (amortizing only)', required: false },
  { name: 'maturityDate', kind: 'date', description: 'Principal due date (interest-only, optional)', required: false },
  { name: 'recordDisbursement', kind: 'boolean', description: 'Record the disbursement as a cash movement', required: false },
  { name: 'accountId', kind: 'id', description: 'Account the disbursement moved through (defaults to the default account)', required: false },
  { name: 'channel', kind: 'string', description: 'How the disbursement moved (free text, up to 30 characters)', required: false },
  {
    name: 'prepaymentStrategy',
    kind: 'enumeration',
    description: 'What a prepayment changes (default reduceTenure)',
    required: false,
    allowedValues: ['reduceTenure', 'reduceEmi'],
  },
  { name: 'note', kind: 'string', description: 'Free-text note', required: false },
];

export const createLoan = defineAction({
  descriptor: {
    id: 'loans.create',
    module: 'loans',
    title: 'Add a loan',
    description: 'Adds a borrowed or lent loan (EMI or interest-only). Optionally records the disbursement as cash.',
    risk: 'low',
    movesMoney: false,
    reversible: true,
    fields: createFields,
  },
  input: loanInput,
  async prepare(input, ctx) {
    fail(validateLoan(input, ctx.today));
    if (input.recordDisbursement) await resolveAccountId(ctx, input.accountId);
    const ppy = FREQUENCY_INFO[input.frequency].periodsPerYear;
    const lines: PreviewLine[] = [
      { label: 'Principal', value: fmtMoney(input.principal), emphasis: true },
      { label: 'Interest', value: `${rateLabel(input.rateBps)} p.a. · ${STRUCTURE_INFO[input.structure].label}` },
    ];
    if (input.structure === 'amortizing') {
      const schedule = originalSchedule(termsOf(quoteTerms(input), 'preview'));
      lines.push(
        { label: `${FREQUENCY_INFO[input.frequency].label} EMI`, value: fmtMoney(emi(input.principal, input.rateBps, input.tenureInstallments!, ppy)) },
        { label: 'Total interest', value: fmtMoney(sumPaise(schedule.map((r) => r.interestPaise))) },
        { label: 'Last instalment', value: formatDate(schedule[schedule.length - 1]!.dueDate) },
      );
    } else {
      lines.push({
        label: `Interest per ${FREQUENCY_INFO[input.frequency].unit}`,
        value: fmtMoney(periodInterest(input.principal, input.rateBps, ppy)),
      });
    }
    lines.push({
      label: 'Cash balance',
      value: !input.recordDisbursement
        ? 'Unchanged (existing loan)'
        : input.direction === 'borrowed'
          ? fmtMoney(input.principal, 'always')
          : fmtMoney(-input.principal),
    });
    return {
      title: `Add ${input.name}`,
      summary: `${DIRECTION_INFO[input.direction].phrase} ${fmtMoney(input.principal)} ${input.direction === 'borrowed' ? 'from' : 'to'} ${input.counterparty}`,
      lines,
      requiresConfirmation: input.recordDisbursement,
    };
  },
  async execute(input, ctx): Promise<Loan> {
    const id = ctx.ids.next('loan');
    let txId: string | null = null;
    if (input.recordDisbursement) {
      const borrowed = input.direction === 'borrowed';
      const t = buildLinkedTransaction(ctx, {
        type: borrowed ? 'income' : 'expense',
        amountPaise: input.principal,
        categoryId: borrowed ? SystemCategories.loanReceived : SystemCategories.loanGiven,
        date: input.startDate,
        origin: 'loanDisbursement',
        originRefId: id,
        counterparty: input.counterparty.trim(),
        note: `${input.name} · disbursement`,
        accountId: await resolveAccountId(ctx, input.accountId),
        channel: input.channel,
      });
      // The loan references its disbursement, so the transaction goes in first.
      await insertTransaction(ctx.tx, ctx.userId, t);
      ctx.touched.push(t.id);
      txId = t.id;
    }
    const loan = toLoan(input, id, ctx.now.toISOString(), { disbursementTransactionId: txId });
    const row = await ctx.tx.insertInto('loans').values(loanToRow(ctx.userId, loan)).returningAll().executeTakeFirstOrThrow();
    ctx.touched.push(id);
    return loanFromRow(row);
  },
});

// ---------------------------------------------------------------------------

const updateInput = z.object({ id: zId, expectedVersion: zVersion, ...loanShape });

/**
 * Edits a loan. Terms (principal, rate, structure, dates, tenure) can only
 * change while no payments are recorded; afterwards only descriptive fields
 * and the prepayment strategy are editable.
 */
export const updateLoan = defineAction({
  descriptor: {
    id: 'loans.update',
    module: 'loans',
    title: 'Edit a loan',
    description: 'Edits loan details. Terms are locked once payments exist.',
    risk: 'low',
    movesMoney: false,
    reversible: true,
    fields: [
      { name: 'id', kind: 'id', description: 'Loan id', required: true },
      { name: 'expectedVersion', kind: 'integer', description: 'Version read', required: true },
      // Same shape as create; terms are locked once a payment exists.
      ...createFields,
    ],
  },
  input: updateInput,
  async prepare(input, ctx) {
    const st = await existingState(ctx, input.id);
    const l = st.loan;
    if (l.version !== input.expectedVersion) throw AppFailure.stale('This loan changed since you opened it. Reload and try again.');
    const termsChanged =
      input.principal !== l.principalPaise ||
      input.rateBps !== l.rateBps ||
      input.structure !== l.structure ||
      input.direction !== l.direction ||
      input.frequency !== l.frequency ||
      input.startDate !== l.startDate ||
      input.firstDueDate !== l.firstDueDate ||
      input.tenureInstallments !== l.tenureInstallments;
    if (termsChanged && st.payments.length > 0) {
      throw AppFailure.notPermitted(
        'Loan terms cannot change after payments are recorded. Record a prepayment instead, or add a new loan.',
      );
    }
    const e = validateLoan(input, ctx.today);
    delete e.startDate;
    const disbursementChanges = l.disbursementTransactionId != null && disbursementDiffers(l, input);
    if (disbursementChanges && input.startDate > ctx.today) {
      e.startDate = 'A future disbursement cannot be recorded as cash yet.';
    }
    fail(e);
    return {
      title: 'Save changes',
      summary: `Update ${l.name}`,
      warnings: disbursementChanges ? ['The recorded disbursement changes to match, so your cash balance updates too.'] : [],
      basis: { v: l.version },
    };
  },
  async execute(input, ctx): Promise<Loan> {
    const l = (await loadLoanState(ctx.snapshot, input.id))!.loan;
    const updated = toLoan(input, l.id, ctx.now.toISOString(), {
      disbursementTransactionId: l.disbursementTransactionId,
      version: l.version + 1,
      createdAt: l.createdAt,
      status: l.status,
    });
    const { user_id: _u, id: _i, created_at: _c, ...values } = loanToRow(ctx.userId, updated);
    const row = await ctx.tx
      .updateTable('loans')
      .set(values)
      .where('user_id', '=', ctx.userId)
      .where('id', '=', l.id)
      .where('version', '=', input.expectedVersion)
      .returningAll()
      .executeTakeFirst();
    if (!row) throw AppFailure.stale('This loan changed since you opened it. Reload and try again.');
    ctx.touched.push(l.id);
    // Keep the linked disbursement consistent with the corrected terms (only
    // possible while no payment exists, which prepare enforces).
    if (l.disbursementTransactionId && disbursementDiffers(l, input)) {
      const t = await ctx.snapshot.transaction(l.disbursementTransactionId);
      if (t) {
        const borrowed = input.direction === 'borrowed';
        const next = await updateTransaction(
          ctx.tx,
          ctx.userId,
          {
            ...t,
            type: borrowed ? 'income' : 'expense',
            amountPaise: input.principal,
            categoryId: borrowed ? SystemCategories.loanReceived : SystemCategories.loanGiven,
            date: input.startDate,
            counterparty: input.counterparty.trim(),
            note: `${input.name.trim()} · disbursement`,
            updatedAt: ctx.now.toISOString(),
            version: t.version + 1,
          },
          t.version,
        );
        ctx.touched.push(next.id);
      }
    }
    return loanFromRow(row);
  },
});

/** Whether edited terms change what the disbursement transaction recorded. */
function disbursementDiffers(
  l: Loan,
  input: { principal: number; direction: string; startDate: string; counterparty: string; name: string },
): boolean {
  return (
    input.principal !== l.principalPaise ||
    input.direction !== l.direction ||
    input.startDate !== l.startDate ||
    input.counterparty.trim() !== l.counterparty ||
    input.name.trim() !== l.name
  );
}

// ---------------------------------------------------------------------------

export const loanPaymentInput = z.object({
  loanId: zId,
  kind: zEnum(LOAN_PAYMENT_KINDS),
  amount: zMoney,
  date: zDate,
  accountId: zId.nullish().transform((v) => v ?? null),
  channel: zTextOpt,
  recordCashMovement: zBool(true),
  note: zTextOpt,
});
export type LoanPaymentInput = z.output<typeof loanPaymentInput>;

/** Splits the payment; shared by prepare, execute and the payment-preview endpoint. */
export async function splitPayment(input: Pick<LoanPaymentInput, 'loanId' | 'kind' | 'amount' | 'date'>, ctx: ActionContext) {
  const st = await existingState(ctx, input.loanId);
  if (input.date > ctx.today) {
    throw AppFailure.validation('The date cannot be in the future.', { date: 'The date cannot be in the future.' });
  }
  if (input.date < st.loan.startDate) {
    throw AppFailure.validation('The date is before the loan started.', { date: 'Before the loan start date.' });
  }
  const r = previewPayment(st, input.kind, input.amount);
  if (!r.ok) throw r.failure;
  return { state: st, preview: r.value as LoanPaymentPreview };
}

export const recordLoanPayment = defineAction({
  descriptor: {
    id: 'loans.recordPayment',
    module: 'loans',
    title: 'Record a loan payment',
    description:
      'Records an EMI, an interest payment, or a principal prepayment. Interest due is paid first; the rest reduces principal.',
    risk: 'consequential',
    movesMoney: true,
    reversible: false,
    fields: [
      { name: 'loanId', kind: 'id', description: 'Loan id', required: true },
      {
        name: 'kind',
        kind: 'enumeration',
        description: 'installment, interest, or principal',
        required: true,
        allowedValues: ['installment', 'interest', 'principal'],
      },
      { name: 'amount', kind: 'money', description: 'Amount paid (or received for lent loans)', required: true },
      { name: 'date', kind: 'date', description: 'Payment date', required: true },
      { name: 'accountId', kind: 'id', description: 'Account the payment moved through (defaults to the default account)', required: false },
      { name: 'channel', kind: 'string', description: 'How it moved (free text, up to 30 characters)', required: false },
      { name: 'recordCashMovement', kind: 'boolean', description: 'Create the matching cash transaction (default true)', required: false },
      { name: 'note', kind: 'string', description: 'Free-text note', required: false },
    ],
  },
  input: loanPaymentInput,
  async prepare(input, ctx) {
    const ce = channelError(input.channel);
    if (ce) throw AppFailure.validation(ce, { channel: ce });
    if (input.recordCashMovement) await resolveAccountId(ctx, input.accountId);
    const { state: st, preview: p } = await splitPayment(input, ctx);
    const loan = st.loan;
    const borrowed = loan.direction === 'borrowed';
    const warnings: string[] = [];
    if (borrowed && input.recordCashMovement) {
      const available = (await ctx.snapshot.balance()).availablePaise;
      if (input.amount > available) warnings.push(`This is more than your available balance of ${fmtMoney(available)}.`);
    }
    if (p.includesPrepayment && input.kind !== 'principal') {
      warnings.push(`Includes ${fmtMoney(input.amount - p.interestPortionPaise - (st.nextDue?.principalPaise ?? 0))} extra towards principal.`);
    }
    if (p.closesLoan) warnings.push('This payment closes the loan.');
    const lines: PreviewLine[] = [];
    if (p.periodNumber !== null) {
      lines.push({
        label: loan.structure === 'amortizing' ? 'Instalment' : 'Interest period',
        value: `#${p.periodNumber}${p.dueDate === null ? '' : ` · due ${formatDate(p.dueDate)}`}`,
      });
    }
    lines.push(
      { label: 'Towards interest', value: fmtMoney(p.interestPortionPaise) },
      { label: 'Towards principal', value: fmtMoney(p.principalPortionPaise), emphasis: true },
      { label: 'Outstanding', value: `${fmtMoney(p.outstandingBeforePaise)} → ${fmtMoney(p.outstandingAfterPaise)}` },
      {
        label: 'Cash balance',
        value: !input.recordCashMovement ? 'Not recorded as cash' : borrowed ? fmtMoney(-input.amount) : fmtMoney(input.amount, 'always'),
      },
    );
    return {
      title: borrowed ? `Record ${PAYMENT_KIND_LABELS[input.kind].toLowerCase()}` : 'Record repayment received',
      summary: `${borrowed ? 'Pay' : 'Receive'} ${fmtMoney(input.amount)} · ${loan.name}`,
      lines,
      warnings,
      basis: { v: loan.version, payments: st.payments.length, outstanding: p.outstandingBeforePaise },
    };
  },
  async execute(input, ctx): Promise<LoanPayment> {
    const { state: st, preview: p } = await splitPayment(input, ctx);
    const loan = st.loan;
    const borrowed = loan.direction === 'borrowed';
    let txId: string | null = null;
    if (input.recordCashMovement) {
      const t = buildLinkedTransaction(ctx, {
        type: borrowed ? 'expense' : 'income',
        amountPaise: input.amount,
        categoryId: borrowed ? SystemCategories.loanEmi : SystemCategories.loanRepaymentReceived,
        date: input.date,
        origin: 'loanRepayment',
        originRefId: loan.id,
        accountId: await resolveAccountId(ctx, input.accountId),
        channel: input.channel,
        counterparty: loan.counterparty,
        note: `${loan.name} · ${PAYMENT_KIND_LABELS[input.kind]}${p.periodNumber !== null ? ` #${p.periodNumber}` : ''}`,
      });
      await insertTransaction(ctx.tx, ctx.userId, t);
      ctx.touched.push(t.id);
      txId = t.id;
    }
    const now = ctx.now.toISOString();
    const row = await ctx.tx
      .insertInto('loan_payments')
      .values({
        user_id: ctx.userId,
        id: ctx.ids.next('lp'),
        loan_id: loan.id,
        kind: input.kind,
        date: input.date,
        interest_paise: p.interestPortionPaise,
        principal_paise: p.principalPortionPaise,
        period_number: p.periodNumber,
        transaction_id: txId,
        note: input.note,
        created_at: now,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    ctx.touched.push(row.id);
    if (p.closesLoan) {
      const closed = await ctx.tx
        .updateTable('loans')
        .set({ status: 'closed', updated_at: now, version: loan.version + 1 })
        .where('user_id', '=', ctx.userId)
        .where('id', '=', loan.id)
        .where('version', '=', loan.version)
        .executeTakeFirst();
      if (Number(closed.numUpdatedRows) === 0) throw AppFailure.stale('This loan changed since you opened it. Reload and try again.');
      ctx.touched.push(loan.id);
    }
    return loanPaymentFromRow(row);
  },
});

// ---------------------------------------------------------------------------

/** Deletes a loan with no recorded payments (and its disbursement entry). */
export const deleteLoan = defineAction({
  descriptor: {
    id: 'loans.delete',
    module: 'loans',
    title: 'Delete a loan',
    description: 'Removes a loan added by mistake. Loans with payments cannot be deleted.',
    risk: 'consequential',
    reversible: false,
    movesMoney: true,
    fields: [{ name: 'id', kind: 'id', description: 'Loan id', required: true }],
  },
  input: z.object({ id: zId }),
  async prepare(input, ctx) {
    const st = await existingState(ctx, input.id);
    if (st.payments.length > 0) throw AppFailure.notPermitted('This loan has payments recorded, so it is kept for your history.');
    const warnings: string[] = [];
    if (st.loan.disbursementTransactionId !== null) warnings.push('The recorded disbursement transaction will also be removed.');
    warnings.push('This cannot be undone.');
    return {
      title: `Delete ${st.loan.name}?`,
      summary: `Delete ${st.loan.name} with ${st.loan.counterparty}`,
      warnings,
      basis: { v: st.loan.version },
    };
  },
  async execute(input, ctx): Promise<Loan> {
    const l = (await loadLoanState(ctx.snapshot, input.id))!.loan;
    // The loan references its disbursement transaction: delete the loan first.
    await ctx.tx.deleteFrom('loans').where('user_id', '=', ctx.userId).where('id', '=', l.id).where('version', '=', l.version).execute();
    ctx.touched.push(l.id);
    if (l.disbursementTransactionId !== null) {
      await deleteTransaction(ctx.tx, ctx.userId, l.disbursementTransactionId);
      ctx.touched.push(l.disbursementTransactionId);
    }
    return l;
  },
});

export const loansActions: AnyAction[] = [createLoan, updateLoan, recordLoanPayment, deleteLoan] as AnyAction[];
