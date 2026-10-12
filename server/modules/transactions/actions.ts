// transactions.create / update / delete (lib/features/transactions/application/transaction_actions.dart).
// Only manual transactions are edited here; linked ones belong to their module.

import { z } from 'zod';
import { PAYMENT_METHODS, zDate, zEnum, zEnumOpt, zId, zPositiveMoney, zTextOpt, zVersion } from '../../actions/input';
import { defineAction, type ActionContext, type AnyAction, type FieldSpec, type PreviewLine } from '../../actions/types';
import { formatDate } from '../../core/dates';
import { AppFailure, throwIfErrors } from '../../core/failure';
import { formatInr } from '../../core/money';
import { ORIGIN_LABELS, PAYMENT_METHOD_LABELS, type Transaction } from '../../finance/models';
import { deleteTransaction, insertTransaction, updateTransaction } from './repo';

/** Maximum single amount (₹10 crore): guards against typos. */
export const MAX_TRANSACTION_PAISE = 100_000_000 * 100;

const dataShape = {
  type: zEnum(['income', 'expense'] as const),
  amount: zPositiveMoney,
  categoryId: zId,
  date: zDate,
  paymentMethod: zEnumOpt(PAYMENT_METHODS),
  counterparty: zTextOpt,
  note: zTextOpt,
};
const transactionInput = z.object(dataShape);
type TransactionInput = z.output<typeof transactionInput>;

const fields: FieldSpec[] = [
  { name: 'type', kind: 'enumeration', description: 'income or expense', required: true, allowedValues: ['income', 'expense'] },
  { name: 'amount', kind: 'money', description: 'Amount in rupees, greater than zero', required: true },
  { name: 'categoryId', kind: 'id', description: 'Category id matching the type', required: true },
  { name: 'date', kind: 'date', description: 'Date the money moved (not in the future)', required: true },
  { name: 'paymentMethod', kind: 'enumeration', description: 'How it was paid', required: false, allowedValues: PAYMENT_METHODS },
  { name: 'counterparty', kind: 'string', description: 'Merchant or person', required: false },
  { name: 'note', kind: 'string', description: 'Free-text note', required: false },
];

const typeLabel = (t: 'income' | 'expense') => (t === 'income' ? 'Income' : 'Expense');

export async function validateTransaction(i: TransactionInput, ctx: ActionContext): Promise<Record<string, string>> {
  const errors: Record<string, string> = {};
  if (i.amount <= 0) errors.amount = 'Enter an amount greater than zero.';
  if (i.amount > MAX_TRANSACTION_PAISE) errors.amount = 'That amount looks too large. Please check it.';
  const cat = await ctx.snapshot.category(i.categoryId);
  if (!cat || cat.isArchived) {
    errors.categoryId = 'Choose a category.';
  } else if (cat.type !== i.type) {
    errors.categoryId = `This category is for ${typeLabel(cat.type).toLowerCase()}.`;
  } else if (cat.isSystem && !(cat.id.endsWith('_other_out') || cat.id.endsWith('_other_in'))) {
    errors.categoryId = 'This category is managed automatically. Choose another.';
  }
  if (i.date > ctx.today) errors.date = 'The date cannot be in the future.';
  if ((i.counterparty?.length ?? 0) > 80) errors.counterparty = 'Keep this under 80 characters.';
  if ((i.note?.length ?? 0) > 500) errors.note = 'Keep the note under 500 characters.';
  return errors;
}

async function lines(i: TransactionInput, ctx: ActionContext): Promise<PreviewLine[]> {
  const out: PreviewLine[] = [
    { label: 'Type', value: typeLabel(i.type) },
    { label: 'Amount', value: formatInr(i.amount), emphasis: true },
    { label: 'Category', value: (await ctx.snapshot.category(i.categoryId))?.name ?? '—' },
    { label: 'Date', value: formatDate(i.date) },
  ];
  if (i.paymentMethod) out.push({ label: 'Paid via', value: PAYMENT_METHOD_LABELS[i.paymentMethod] });
  if (i.counterparty) out.push({ label: i.type === 'income' ? 'From' : 'To', value: i.counterparty });
  return out;
}

export const createTransaction = defineAction({
  descriptor: {
    id: 'transactions.create',
    module: 'transactions',
    title: 'Record a transaction',
    description: 'Records completed income or an expense. Changes the cash balance.',
    risk: 'low',
    movesMoney: true,
    reversible: true,
    fields,
  },
  input: transactionInput,
  async prepare(input, ctx) {
    throwIfErrors(await validateTransaction(input, ctx));
    const warnings: string[] = [];
    const balance = await ctx.snapshot.balance();
    if (input.type === 'expense' && input.amount > balance.availablePaise) {
      warnings.push(`This is more than your available balance of ${formatInr(balance.availablePaise)}.`);
    }
    return {
      title: `Record ${typeLabel(input.type).toLowerCase()}`,
      summary: `${input.type === 'income' ? 'Received' : 'Spent'} ${formatInr(input.amount)}`,
      lines: await lines(input, ctx),
      warnings,
    };
  },
  async execute(input, ctx): Promise<Transaction> {
    const now = ctx.now.toISOString();
    const t = await insertTransaction(ctx.tx, ctx.userId, {
      id: ctx.ids.next('tx'),
      type: input.type,
      amountPaise: input.amount,
      categoryId: input.categoryId,
      date: input.date,
      paymentMethod: input.paymentMethod,
      counterparty: input.counterparty,
      note: input.note,
      origin: 'manual',
      originRefId: null,
      createdAt: now,
      updatedAt: now,
      version: 1,
    });
    ctx.touched.push(t.id);
    return t;
  },
});

const updateInput = z.object({ id: zId, expectedVersion: zVersion, ...dataShape });

async function editable(id: string, ctx: ActionContext, verb: 'change' | 'reverse'): Promise<Transaction> {
  const t = await ctx.snapshot.transaction(id);
  if (!t) throw AppFailure.notFound('This transaction no longer exists.');
  if (t.origin !== 'manual') {
    throw AppFailure.notPermitted(
      verb === 'change'
        ? `This transaction was created by ${ORIGIN_LABELS[t.origin].toLowerCase()}. Change it from there.`
        : `This transaction belongs to a ${ORIGIN_LABELS[t.origin].toLowerCase()}. Reverse it from there.`,
    );
  }
  return t;
}

export const updateTransactionAction = defineAction({
  descriptor: {
    id: 'transactions.update',
    module: 'transactions',
    title: 'Edit a transaction',
    description: 'Changes a manual transaction. Balances, budgets and analytics update automatically.',
    risk: 'low',
    movesMoney: true,
    reversible: true,
    fields: [
      { name: 'id', kind: 'id', description: 'Transaction id', required: true },
      { name: 'expectedVersion', kind: 'integer', description: 'Version that was read', required: true },
      ...fields,
    ],
  },
  input: updateInput,
  async prepare(input, ctx) {
    const existing = await editable(input.id, ctx, 'change');
    if (existing.version !== input.expectedVersion) {
      throw AppFailure.stale('This transaction changed since you opened it. Reload and try again.');
    }
    throwIfErrors(await validateTransaction(input, ctx));
    return {
      title: 'Save changes',
      summary: `Update ${formatInr(existing.amountPaise)} ${typeLabel(existing.type).toLowerCase()} to ${formatInr(input.amount)}`,
      lines: await lines(input, ctx),
    };
  },
  async execute(input, ctx) {
    const existing = (await ctx.snapshot.transaction(input.id))!;
    const updated = await updateTransaction(
      ctx.tx,
      ctx.userId,
      {
        ...existing,
        type: input.type,
        amountPaise: input.amount,
        categoryId: input.categoryId,
        date: input.date,
        paymentMethod: input.paymentMethod,
        counterparty: input.counterparty,
        note: input.note,
        updatedAt: ctx.now.toISOString(),
        version: existing.version + 1,
      },
      input.expectedVersion,
    );
    ctx.touched.push(updated.id);
    return updated;
  },
});

export const deleteTransactionAction = defineAction({
  descriptor: {
    id: 'transactions.delete',
    module: 'transactions',
    title: 'Delete a transaction',
    description: 'Permanently removes a manual transaction and reverses its effect on balances.',
    risk: 'consequential',
    reversible: false,
    movesMoney: true,
    fields: [{ name: 'id', kind: 'id', description: 'Transaction id', required: true }],
  },
  input: z.object({ id: zId }),
  async prepare(input, ctx) {
    const t = await editable(input.id, ctx, 'reverse');
    const effect = t.type === 'income' ? -t.amountPaise : t.amountPaise;
    return {
      title: 'Delete transaction?',
      summary: `Delete ${formatInr(t.amountPaise)} ${typeLabel(t.type).toLowerCase()} on ${formatDate(t.date)}`,
      lines: [
        { label: 'Category', value: (await ctx.snapshot.category(t.categoryId))?.name ?? '—' },
        { label: 'Balance effect', value: formatInr(effect, { sign: 'always' }), emphasis: true },
      ],
      warnings: ['This cannot be undone.'],
      basis: { v: t.version },
    };
  },
  async execute(input, ctx) {
    const t = (await ctx.snapshot.transaction(input.id))!;
    await deleteTransaction(ctx.tx, ctx.userId, t.id);
    ctx.touched.push(t.id);
    return t;
  },
});

export const transactionsActions: AnyAction[] = [createTransaction, updateTransactionAction, deleteTransactionAction] as AnyAction[];
