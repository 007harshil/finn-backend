// transfers.create / update / delete: money moved between the user's own
// accounts (ATM withdrawal, credit-card bill payment). Never income or spending.

import { z } from 'zod';
import { zDate, zId, zPositiveMoney, zTextOpt, zVersion } from '../../actions/input';
import { defineAction, type ActionContext, type AnyAction, type FieldSpec } from '../../actions/types';
import { formatDate } from '../../core/dates';
import { AppFailure, throwIfErrors } from '../../core/failure';
import { formatInr } from '../../core/money';
import { isLiabilityKind, type MoneyAccount, type Transfer } from '../../finance/models';
import { MAX_TRANSACTION_PAISE } from '../transactions/actions';
import { channelError } from '../accounts/resolve';
import { deleteTransfer, insertTransfer, updateTransfer } from './repo';

const dataShape = {
  fromAccountId: zId,
  toAccountId: zId,
  amount: zPositiveMoney,
  date: zDate,
  channel: zTextOpt,
  note: zTextOpt,
};
const createInput = z.object(dataShape);
type TransferInput = z.output<typeof createInput>;

const fields: FieldSpec[] = [
  { name: 'fromAccountId', kind: 'id', description: 'Account the money leaves', required: true },
  { name: 'toAccountId', kind: 'id', description: 'Account the money arrives in (different from the source)', required: true },
  { name: 'amount', kind: 'money', description: 'Amount in rupees, greater than zero', required: true },
  { name: 'date', kind: 'date', description: 'Date of the transfer (not in the future)', required: true },
  { name: 'channel', kind: 'string', description: 'How it moved (UPI, ATM, Cheque…), up to 30 characters', required: false },
  { name: 'note', kind: 'string', description: 'Free-text note', required: false },
];

async function existingTransfer(id: string, ctx: ActionContext): Promise<Transfer> {
  const t = (await ctx.snapshot.transfers()).find((x) => x.id === id);
  if (!t) throw AppFailure.notFound('This transfer no longer exists.');
  return t;
}

/** Both accounts must exist; new writes also need them not archived (an edit may keep the ones it already uses). */
async function loadAccounts(i: TransferInput, ctx: ActionContext, keep: Transfer | null): Promise<{ from: MoneyAccount; to: MoneyAccount }> {
  const e: Record<string, string> = {};
  const check = async (field: 'fromAccountId' | 'toAccountId', id: string, kept: string | undefined) => {
    const a = await ctx.snapshot.moneyAccount(id);
    if (!a) e[field] = 'This account does not exist.';
    else if (a.isArchived && a.id !== kept) e[field] = 'This account is archived.';
    return a;
  };
  const from = await check('fromAccountId', i.fromAccountId, keep?.fromAccountId);
  const to = await check('toAccountId', i.toAccountId, keep?.toAccountId);
  if (i.fromAccountId === i.toAccountId) e.toAccountId = 'Choose a different account.';
  if (i.amount > MAX_TRANSACTION_PAISE) e.amount = 'That amount looks too large. Please check it.';
  if (i.date > ctx.today) e.date = 'The date cannot be in the future.';
  const ce = channelError(i.channel);
  if (ce) e.channel = ce;
  if ((i.note?.length ?? 0) > 500) e.note = 'Keep the note under 500 characters.';
  throwIfErrors(e);
  return { from: from!, to: to! };
}

function effectLines(from: MoneyAccount, to: MoneyAccount, i: TransferInput) {
  const out = [
    { label: 'From', value: from.name },
    { label: 'To', value: to.name },
    { label: 'Amount', value: formatInr(i.amount), emphasis: true },
    { label: 'Date', value: formatDate(i.date) },
  ];
  if (i.channel) out.push({ label: 'Via', value: i.channel, emphasis: false });
  return out;
}

export const createTransfer = defineAction({
  descriptor: {
    id: 'transfers.create',
    module: 'transfers',
    title: 'Transfer between accounts',
    description:
      'Moves money between two of your own accounts (for example ATM withdrawal or paying a credit-card bill). Total money is unchanged; it is not income or spending.',
    risk: 'low',
    movesMoney: true,
    reversible: true,
    fields,
  },
  input: createInput,
  async prepare(input, ctx) {
    const { from, to } = await loadAccounts(input, ctx, null);
    const warnings: string[] = [];
    if (!isLiabilityKind(from.kind)) {
      const bal = (await ctx.snapshot.balance()).accounts.find((a) => a.accountId === from.id)?.balancePaise ?? 0;
      if (input.amount > bal) warnings.push(`This is more than the ${formatInr(bal)} in ${from.name}.`);
    }
    return {
      title: 'Transfer',
      summary: `Moved ${formatInr(input.amount)} from ${from.name} to ${to.name}`,
      lines: effectLines(from, to, input),
      warnings,
    };
  },
  async execute(input, ctx): Promise<Transfer> {
    await loadAccounts(input, ctx, null);
    const now = ctx.now.toISOString();
    const t = await insertTransfer(ctx.tx, ctx.userId, {
      id: ctx.ids.next('trf'),
      fromAccountId: input.fromAccountId,
      toAccountId: input.toAccountId,
      amountPaise: input.amount,
      date: input.date,
      channel: input.channel,
      note: input.note,
      createdAt: now,
      updatedAt: now,
      version: 1,
    });
    ctx.snapshot.invalidate();
    ctx.touched.push(t.id);
    return t;
  },
});

const updateInput = z.object({ id: zId, expectedVersion: zVersion.optional(), version: zVersion.optional(), ...dataShape });

export const updateTransferAction = defineAction({
  descriptor: {
    id: 'transfers.update',
    module: 'transfers',
    title: 'Edit a transfer',
    description: 'Changes a transfer between your accounts. Balances update automatically.',
    risk: 'low',
    movesMoney: true,
    reversible: true,
    fields: [
      { name: 'id', kind: 'id', description: 'Transfer id', required: true },
      { name: 'expectedVersion', kind: 'integer', description: 'Version that was read. Omit to skip the stale check', required: false },
      { name: 'version', kind: 'integer', description: 'Alias of expectedVersion', required: false },
      ...fields,
    ],
  },
  input: updateInput,
  async prepare(input, ctx) {
    const existing = await existingTransfer(input.id, ctx);
    const expected = input.expectedVersion ?? input.version ?? null;
    if (expected !== null && existing.version !== expected) {
      throw AppFailure.stale('This transfer changed since you opened it. Reload and try again.');
    }
    const { from, to } = await loadAccounts(input, ctx, existing);
    return {
      title: 'Save changes',
      summary: `Update transfer to ${formatInr(input.amount)} from ${from.name} to ${to.name}`,
      lines: effectLines(from, to, input),
    };
  },
  async execute(input, ctx) {
    const existing = await existingTransfer(input.id, ctx);
    await loadAccounts(input, ctx, existing);
    const updated = await updateTransfer(ctx.tx, ctx.userId, {
      ...existing,
      fromAccountId: input.fromAccountId,
      toAccountId: input.toAccountId,
      amountPaise: input.amount,
      date: input.date,
      channel: input.channel,
      note: input.note,
      updatedAt: ctx.now.toISOString(),
      version: existing.version + 1,
    });
    ctx.snapshot.invalidate();
    ctx.touched.push(updated.id);
    return updated;
  },
});

export const deleteTransferAction = defineAction({
  descriptor: {
    id: 'transfers.delete',
    module: 'transfers',
    title: 'Delete a transfer',
    description: 'Removes a transfer and reverses its effect on both account balances.',
    risk: 'consequential',
    movesMoney: true,
    reversible: false,
    fields: [{ name: 'id', kind: 'id', description: 'Transfer id', required: true }],
  },
  input: z.object({ id: zId }),
  async prepare(input, ctx) {
    const t = await existingTransfer(input.id, ctx);
    const name = async (id: string) => (await ctx.snapshot.moneyAccount(id))?.name ?? '—';
    return {
      title: 'Delete transfer?',
      summary: `Delete ${formatInr(t.amountPaise)} transfer on ${formatDate(t.date)}`,
      lines: [
        { label: 'From', value: await name(t.fromAccountId) },
        { label: 'To', value: await name(t.toAccountId) },
      ],
      warnings: ['This cannot be undone.'],
      basis: { v: t.version },
    };
  },
  async execute(input, ctx) {
    const t = await existingTransfer(input.id, ctx);
    await deleteTransfer(ctx.tx, ctx.userId, t.id);
    ctx.snapshot.invalidate();
    ctx.touched.push(t.id);
    return t;
  },
});

export const transfersActions: AnyAction[] = [createTransfer, updateTransferAction, deleteTransferAction] as AnyAction[];
