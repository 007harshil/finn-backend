// subscriptions.* (lib/features/subscriptions/application/subscription_actions.dart).
// A due date passing NEVER creates a transaction: only markPaid records a payment.

import { z } from 'zod';
import { zBool, zDate, zDateOpt, zEnum, zId, zMoneyOpt, zPositiveMoney, zTextOpt, zVersion } from '../../actions/input';
import { defineAction, type ActionContext, type AnyAction, type FieldSpec, type PreviewLine } from '../../actions/types';
import { formatDate, formatDayMonth } from '../../core/dates';
import { AppFailure, throwIfErrors } from '../../core/failure';
import { FREQUENCIES, FREQUENCY_INFO } from '../../core/frequency';
import { formatInr } from '../../core/money';
import { type Subscription } from '../../finance/models';
import { channelError, defaultAccount, resolveAccountId } from '../accounts/resolve';
import { SystemCategories } from '../account/standard-categories';
import { MAX_TRANSACTION_PAISE } from '../transactions/actions';
import { buildLinkedTransaction, insertTransaction } from '../transactions/repo';
import { isCyclePaid, nextCycleAfterCurrent, paymentNote, subscriptionMonthly } from './calculator';
import { deleteSubscription, insertSubscription, updateSubscription } from './repo';

const STATUS_LABELS = { active: 'Active', paused: 'Paused', cancelled: 'Cancelled' } as const;
const lc = (s: string) => s.toLowerCase();
const freqLabel = (f: keyof typeof FREQUENCY_INFO) => FREQUENCY_INFO[f].label;

const STALE_MSG = 'This subscription changed since you opened it. Reload and try again.';

const dataShape = {
  name: z.string(),
  amount: zPositiveMoney,
  categoryId: zId,
  frequency: zEnum(FREQUENCIES),
  nextDueDate: zDate,
  startDate: zDateOpt,
  autoRenews: zBool(true),
  accountId: zId.nullish().transform((v) => v ?? null),
  note: zTextOpt,
};
const dataInput = z.object(dataShape);
type SubscriptionInput = z.output<typeof dataInput>;

const fields: FieldSpec[] = [
  { name: 'name', kind: 'string', description: 'Service name, e.g. "Netflix"', required: true },
  { name: 'amount', kind: 'money', description: 'Amount per cycle in rupees, greater than zero', required: true },
  { name: 'categoryId', kind: 'id', description: 'Expense category id', required: true },
  { name: 'frequency', kind: 'enumeration', description: 'Billing frequency', required: true, allowedValues: FREQUENCIES },
  { name: 'nextDueDate', kind: 'date', description: 'Next renewal date', required: true },
  { name: 'startDate', kind: 'date', description: 'When the subscription started', required: false },
  { name: 'autoRenews', kind: 'boolean', description: 'Renews automatically (informational)', required: false },
  { name: 'accountId', kind: 'id', description: 'Account usually charged', required: false },
  { name: 'note', kind: 'string', description: 'Note', required: false },
];

async function findSub(ctx: ActionContext, id: string): Promise<Subscription> {
  const s = (await ctx.snapshot.subscriptions()).find((x) => x.id === id);
  if (!s) throw AppFailure.notFound('This subscription no longer exists.');
  return s;
}

async function validateSubscription(i: SubscriptionInput, ctx: ActionContext, keepAccountId: string | null = null): Promise<Record<string, string>> {
  const e: Record<string, string> = {};
  if (i.accountId !== null) {
    const acc = await ctx.snapshot.moneyAccount(i.accountId);
    if (!acc) e.accountId = 'This account does not exist.';
    else if (acc.isArchived && acc.id !== keepAccountId) e.accountId = 'This account is archived.';
  }
  const name = i.name.trim();
  if (name.length === 0) e.name = 'Enter the service name.';
  if (name.length > 60) e.name = 'Keep the name under 60 characters.';
  if (i.amount <= 0) e.amount = 'Enter an amount greater than zero.';
  if (i.amount > MAX_TRANSACTION_PAISE) e.amount = 'That amount looks too large. Please check it.';
  const cat = await ctx.snapshot.category(i.categoryId);
  if (!cat || cat.isArchived) {
    e.categoryId = 'Choose a category.';
  } else if (cat.type !== 'expense') {
    e.categoryId = 'Choose an expense category.';
  } else if (cat.isSystem && cat.id !== SystemCategories.uncategorizedExpense) {
    e.categoryId = 'This category is managed automatically. Choose another.';
  }
  if (i.startDate && i.startDate > i.nextDueDate) e.startDate = 'The start date must be on or before the next due date.';
  if ((i.note?.length ?? 0) > 500) e.note = 'Keep the note under 500 characters.';
  return e;
}

async function subscriptionLines(i: SubscriptionInput, ctx: ActionContext): Promise<PreviewLine[]> {
  return [
    { label: 'Amount', value: `${formatInr(i.amount)} ${lc(freqLabel(i.frequency))}`, emphasis: true },
    { label: 'Per month', value: formatInr(subscriptionMonthly({ frequency: i.frequency, amountPaise: i.amount } as Subscription)) },
    { label: 'Category', value: (await ctx.snapshot.category(i.categoryId))?.name ?? '—' },
    { label: 'Next due', value: formatDate(i.nextDueDate) },
    { label: 'Cash balance', value: 'Unchanged until you mark a payment as paid' },
  ];
}

export const createSubscription = defineAction({
  descriptor: {
    id: 'subscriptions.create',
    module: 'subscriptions',
    title: 'Add a subscription',
    description: 'Tracks a recurring cost. Upcoming charges are projections; nothing is paid automatically.',
    risk: 'low',
    movesMoney: false,
    reversible: true,
    fields,
  },
  input: dataInput,
  async prepare(input, ctx) {
    throwIfErrors(await validateSubscription(input, ctx));
    return {
      title: `Add ${input.name.trim()}`,
      summary: `${input.name.trim()} added · ${formatInr(input.amount)} ${lc(freqLabel(input.frequency))}`,
      lines: await subscriptionLines(input, ctx),
    };
  },
  async execute(input, ctx) {
    const now = ctx.now.toISOString();
    const s = await insertSubscription(ctx.tx, ctx.userId, {
      id: ctx.ids.next('sub'),
      name: input.name.trim(),
      amountPaise: input.amount,
      categoryId: input.categoryId,
      frequency: input.frequency,
      nextDueDate: input.nextDueDate,
      startDate: input.startDate,
      status: 'active',
      autoRenews: input.autoRenews,
      accountId: input.accountId,
      note: input.note,
      createdAt: now,
      updatedAt: now,
      version: 1,
    });
    ctx.touched.push(s.id);
    return s;
  },
});

export const updateSubscriptionAction = defineAction({
  descriptor: {
    id: 'subscriptions.update',
    module: 'subscriptions',
    title: 'Edit a subscription',
    description: 'Changes a subscription. Past payments are not affected.',
    risk: 'low',
    movesMoney: false,
    reversible: true,
    fields: [
      { name: 'id', kind: 'id', description: 'Subscription id', required: true },
      { name: 'expectedVersion', kind: 'integer', description: 'Version that was read', required: true },
      ...fields,
    ],
  },
  input: z.object({ id: zId, expectedVersion: zVersion, ...dataShape }),
  async prepare(input, ctx) {
    const existing = await findSub(ctx, input.id);
    if (existing.version !== input.expectedVersion) throw AppFailure.stale(STALE_MSG);
    throwIfErrors(await validateSubscription(input, ctx, existing.accountId));
    return { title: 'Save changes', summary: `${input.name.trim()} updated`, lines: await subscriptionLines(input, ctx) };
  },
  async execute(input, ctx) {
    const existing = await findSub(ctx, input.id);
    const updated = await updateSubscription(ctx.tx, ctx.userId, {
      ...existing,
      name: input.name.trim(),
      amountPaise: input.amount,
      categoryId: input.categoryId,
      frequency: input.frequency,
      nextDueDate: input.nextDueDate,
      startDate: input.startDate,
      autoRenews: input.autoRenews,
      accountId: input.accountId,
      note: input.note,
      updatedAt: ctx.now.toISOString(),
      version: existing.version + 1,
    });
    ctx.touched.push(updated.id);
    return updated;
  },
});

export const setSubscriptionStatus = defineAction({
  descriptor: {
    id: 'subscriptions.setStatus',
    module: 'subscriptions',
    title: 'Pause, resume or cancel a subscription',
    description: 'Changes whether a subscription counts towards your monthly commitment. Past payments are kept.',
    risk: 'low',
    movesMoney: false,
    reversible: true,
    fields: [
      { name: 'id', kind: 'id', description: 'Subscription id', required: true },
      { name: 'status', kind: 'enumeration', description: 'New status', required: true, allowedValues: ['active', 'paused', 'cancelled'] },
    ],
  },
  input: z.object({ id: zId, status: zEnum(['active', 'paused', 'cancelled'] as const) }),
  async prepare(input, ctx) {
    const sub = await findSub(ctx, input.id);
    if (sub.status === input.status) throw AppFailure.validation(`${sub.name} is already ${lc(STATUS_LABELS[input.status])}.`);
    const verb = input.status === 'active' ? (sub.status === 'paused' ? 'resumed' : 'reactivated') : input.status;
    const monthly = formatInr(subscriptionMonthly(sub));
    return {
      title: `${sub.name} ${verb}`,
      summary: `${sub.name} ${verb}`,
      lines: [
        { label: 'Status', value: `${STATUS_LABELS[sub.status]} → ${STATUS_LABELS[input.status]}` },
        { label: 'Monthly commitment', value: input.status === 'active' ? `+${monthly}` : `−${monthly}` },
      ],
    };
  },
  async execute(input, ctx) {
    const sub = await findSub(ctx, input.id);
    const updated = await updateSubscription(ctx.tx, ctx.userId, {
      ...sub,
      status: input.status,
      updatedAt: ctx.now.toISOString(),
      version: sub.version + 1,
    });
    ctx.touched.push(updated.id);
    return updated;
  },
});

// ---------------------------------------------------------------------------
// Mark paid / skip
// ---------------------------------------------------------------------------

const markPaidInput = z.object({
  subscriptionId: zId,
  cycleDate: zDateOpt,
  date: zDateOpt,
  amount: zMoneyOpt,
  accountId: zId.nullish().transform((v) => v ?? null),
  channel: zTextOpt,
});

/** Validates and resolves defaults; shared by prepare and execute. */
async function plan(input: z.output<typeof markPaidInput>, ctx: ActionContext) {
  const sub = await findSub(ctx, input.subscriptionId);
  if (sub.status !== 'active') {
    throw AppFailure.validation(`${sub.name} is ${lc(STATUS_LABELS[sub.status])}. Resume it before recording a payment.`);
  }
  const cycle = sub.nextDueDate;
  const requested = input.cycleDate;
  const linked = await ctx.snapshot.linkedTransactions(sub.id);
  if (requested && requested !== cycle) {
    if (requested < cycle || isCyclePaid(sub, requested, linked)) {
      throw new AppFailure('duplicate', `The renewal due ${formatDate(requested)} is already settled.`);
    }
    throw AppFailure.stale(STALE_MSG);
  }
  if (isCyclePaid(sub, cycle, linked)) {
    throw new AppFailure('duplicate', `A payment for the renewal due ${formatDate(cycle)} is already recorded.`);
  }
  const date = input.date ?? (cycle > ctx.today ? ctx.today : cycle);
  const amount = input.amount ?? sub.amountPaise;
  const e: Record<string, string> = {};
  if (date > ctx.today) e.date = 'The date cannot be in the future.';
  if (amount <= 0) e.amount = 'Enter an amount greater than zero.';
  if (amount > MAX_TRANSACTION_PAISE) e.amount = 'That amount looks too large. Please check it.';
  const ce = channelError(input.channel);
  if (ce) e.channel = ce;
  throwIfErrors(e);
  // Explicit account, else the subscription's (when still active), else the default.
  let accountId: string;
  if (input.accountId) accountId = await resolveAccountId(ctx, input.accountId);
  else {
    const own = sub.accountId ? await ctx.snapshot.moneyAccount(sub.accountId) : null;
    accountId = own && !own.isArchived ? own.id : (await defaultAccount(ctx)).id;
  }
  return { sub, cycle, date, amount, accountId, channel: input.channel, nextDueDate: nextCycleAfterCurrent(sub) };
}

export const markSubscriptionPaid = defineAction({
  descriptor: {
    id: 'subscriptions.markPaid',
    module: 'subscriptions',
    title: 'Mark a subscription as paid',
    description:
      'Records one renewal payment as an expense and moves the next due date forward by one cycle. Each cycle can be paid only once.',
    risk: 'consequential',
    movesMoney: true,
    reversible: false,
    fields: [
      { name: 'subscriptionId', kind: 'id', description: 'Subscription id', required: true },
      { name: 'cycleDate', kind: 'date', description: 'Due date of the cycle being paid (defaults to next due date)', required: false },
      { name: 'date', kind: 'date', description: 'Payment date, not in the future (defaults to the due date)', required: false },
      { name: 'amount', kind: 'money', description: 'Amount paid (defaults to the subscription amount)', required: false },
      { name: 'accountId', kind: 'id', description: 'Account paid from (defaults to the subscription account, then the default account)', required: false },
      { name: 'channel', kind: 'string', description: 'How it was paid (free text, up to 30 characters)', required: false },
    ],
  },
  input: markPaidInput,
  async prepare(input, ctx) {
    const p = await plan(input, ctx);
    const balance = await ctx.snapshot.balance();
    const warnings: string[] = [];
    if (p.amount > balance.availablePaise) warnings.push(`This is more than your available balance of ${formatInr(balance.availablePaise)}.`);
    if (p.amount !== p.sub.amountPaise) {
      warnings.push(`This differs from the usual ${formatInr(p.sub.amountPaise)}. The subscription amount stays the same.`);
    }
    const lines: PreviewLine[] = [
      { label: 'Renewal due', value: formatDate(p.cycle) },
      { label: 'Paid on', value: formatDate(p.date) },
    ];
    lines.push({ label: 'Paid from', value: (await ctx.snapshot.moneyAccount(p.accountId))?.name ?? '—' });
    if (p.channel) lines.push({ label: 'Via', value: p.channel });
    lines.push({ label: 'Cash balance', value: formatInr(-p.amount), emphasis: true });
    lines.push({ label: 'Next due', value: formatDate(p.nextDueDate) });
    return {
      title: `Mark ${p.sub.name} as paid`,
      summary: `Paid ${formatInr(p.amount)} · ${p.sub.name}`,
      lines,
      warnings,
      // An approval is bound to this exact cycle and subscription version.
      basis: { cycle: p.cycle, v: p.sub.version },
    };
  },
  async execute(input, ctx) {
    const p = await plan(input, ctx);
    const category = await ctx.snapshot.category(p.sub.categoryId);
    const tx = buildLinkedTransaction(ctx, {
      type: 'expense',
      amountPaise: p.amount,
      categoryId: category ? p.sub.categoryId : SystemCategories.uncategorizedExpense,
      date: p.date,
      origin: 'subscription',
      originRefId: p.sub.id,
      accountId: p.accountId,
      channel: p.channel,
      counterparty: p.sub.name,
      note: paymentNote(p.sub, p.cycle),
    });
    const t = await insertTransaction(ctx.tx, ctx.userId, tx);
    const updated = await updateSubscription(ctx.tx, ctx.userId, {
      ...p.sub,
      nextDueDate: p.nextDueDate,
      updatedAt: ctx.now.toISOString(),
      version: p.sub.version + 1,
    });
    ctx.touched.push(t.id, updated.id);
    return t;
  },
});

export const skipSubscriptionCycle = defineAction({
  descriptor: {
    id: 'subscriptions.skipCycle',
    module: 'subscriptions',
    title: 'Skip a renewal',
    description:
      'Moves the next due date forward by one cycle without recording a payment (for example a free month or a waived charge).',
    risk: 'low',
    movesMoney: false,
    reversible: false,
    fields: [
      { name: 'subscriptionId', kind: 'id', description: 'Subscription id', required: true },
      { name: 'cycleDate', kind: 'date', description: 'Due date of the cycle being skipped', required: false },
    ],
  },
  input: z.object({ subscriptionId: zId, cycleDate: zDateOpt }),
  async prepare(input, ctx) {
    const sub = await findSub(ctx, input.subscriptionId);
    if (sub.status !== 'active') throw AppFailure.validation(`${sub.name} is ${lc(STATUS_LABELS[sub.status])}.`);
    if (input.cycleDate && input.cycleDate !== sub.nextDueDate) throw AppFailure.stale(STALE_MSG);
    const next = nextCycleAfterCurrent(sub);
    return {
      title: 'Skip this renewal?',
      summary: `Skipped the ${formatDayMonth(sub.nextDueDate)} renewal of ${sub.name}`,
      lines: [
        { label: 'Skipped', value: formatDate(sub.nextDueDate) },
        { label: 'Next due', value: formatDate(next) },
        { label: 'Cash balance', value: 'Unchanged' },
      ],
      basis: { cycle: sub.nextDueDate, v: sub.version },
    };
  },
  async execute(input, ctx) {
    const sub = await findSub(ctx, input.subscriptionId);
    const updated = await updateSubscription(ctx.tx, ctx.userId, {
      ...sub,
      nextDueDate: nextCycleAfterCurrent(sub),
      updatedAt: ctx.now.toISOString(),
      version: sub.version + 1,
    });
    ctx.touched.push(updated.id);
    return updated;
  },
});

export const deleteSubscriptionAction = defineAction({
  descriptor: {
    id: 'subscriptions.delete',
    module: 'subscriptions',
    title: 'Delete a subscription',
    description: 'Removes a subscription. Payments already recorded stay in your transactions.',
    risk: 'consequential',
    movesMoney: false,
    reversible: false,
    fields: [{ name: 'id', kind: 'id', description: 'Subscription id', required: true }],
  },
  input: z.object({ id: zId }),
  async prepare(input, ctx) {
    const sub = await findSub(ctx, input.id);
    const paid = (await ctx.snapshot.linkedTransactions(sub.id)).length;
    return {
      title: `Delete ${sub.name}?`,
      summary: `${sub.name} deleted`,
      lines: [
        { label: 'Amount', value: `${formatInr(sub.amountPaise)} ${lc(freqLabel(sub.frequency))}` },
        { label: 'Recorded payments', value: paid === 0 ? 'None' : `${paid} kept in transactions` },
      ],
      warnings: ['This cannot be undone. To stop tracking without losing it, cancel instead.'],
      basis: { v: sub.version },
    };
  },
  async execute(input, ctx) {
    const sub = await findSub(ctx, input.id);
    await deleteSubscription(ctx.tx, ctx.userId, sub.id);
    ctx.touched.push(sub.id);
    return sub;
  },
});

export const subscriptionsActions: AnyAction[] = [
  createSubscription,
  updateSubscriptionAction,
  setSubscriptionStatus,
  markSubscriptionPaid,
  skipSubscriptionCycle,
  deleteSubscriptionAction,
] as AnyAction[];
