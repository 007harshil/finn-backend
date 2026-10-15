// accounts.* (money accounts: cash, banks, cards). See finn/docs/MONEY_ACCOUNTS.md.
// Credit cards hold an amount owed; every other kind holds money. Money inputs
// are rupees (zMoney), like every other action.

import { z } from 'zod';
import { zBool, zDate, zDateOpt, zEnum, zId, zMoney, zMoneyOpt, zTextOpt, zVersion } from '../../actions/input';
import { defineAction, type ActionContext, type AnyAction, type FieldSpec, type PreviewLine } from '../../actions/types';
import { formatDate } from '../../core/dates';
import { AppFailure, throwIfErrors } from '../../core/failure';
import { formatInr } from '../../core/money';
import { loadBalance } from '../../finance/ledger';
import { ACCOUNT_KINDS, ACCOUNT_KIND_LABELS, isLiabilityKind, type AccountKind, type MoneyAccount } from '../../finance/models';
import { accountUsage, clearDefaultExcept, deleteMoneyAccount, insertMoneyAccount, updateMoneyAccount } from './repo';

/** Largest opening balance / limit accepted (₹1,000 crore): guards against typos. */
export const MAX_ACCOUNT_PAISE = 10_000_000_000 * 100;

const STALE_MSG = 'This account changed since you opened it. Reload and try again.';

const dataShape = {
  name: z.string(),
  kind: zEnum(ACCOUNT_KINDS),
  institution: zTextOpt,
  last4: zTextOpt,
  openingBalance: zMoney,
  creditLimit: zMoneyOpt,
  note: zTextOpt,
};

/** `expectedVersion` (house convention) or `version` (spec name): either is accepted, both optional. */
const versionShape = { expectedVersion: zVersion.optional(), version: zVersion.optional() };
const versionFields: FieldSpec[] = [
  { name: 'expectedVersion', kind: 'integer', description: 'Version that was read. Omit to skip the stale check', required: false },
  { name: 'version', kind: 'integer', description: 'Alias of expectedVersion', required: false },
];
const expectedOf = (i: { expectedVersion?: number; version?: number }): number | null => i.expectedVersion ?? i.version ?? null;

const dataFields: FieldSpec[] = [
  { name: 'name', kind: 'string', description: 'Account name, 1–40 characters', required: true },
  { name: 'kind', kind: 'enumeration', description: 'Kind of account', required: true, allowedValues: ACCOUNT_KINDS },
  { name: 'institution', kind: 'string', description: 'Bank or issuer, up to 40 characters', required: false },
  { name: 'last4', kind: 'string', description: 'Last 4 digits (cards only)', required: false },
  {
    name: 'openingBalance',
    kind: 'money',
    description: 'Money in the account on the opening date (credit card: amount owed), in rupees',
    required: true,
  },
  { name: 'creditLimit', kind: 'money', description: 'Credit limit in rupees (credit cards only)', required: false },
  { name: 'note', kind: 'string', description: 'Free-text note, up to 200 characters', required: false },
];

interface AccountData {
  name: string;
  kind: AccountKind;
  institution: string | null;
  last4: string | null;
  openingBalance: number;
  openingDate: string;
  creditLimit: number | null;
  note: string | null;
}

export function validateAccount(i: AccountData, today: string): Record<string, string> {
  const e: Record<string, string> = {};
  const name = i.name.trim();
  if (name.length === 0) e.name = 'Enter a name.';
  else if (name.length > 40) e.name = 'Keep the name under 40 characters.';
  if ((i.institution?.length ?? 0) > 40) e.institution = 'Keep this under 40 characters.';
  if (i.last4 !== null) {
    if (i.kind === 'cash' || i.kind === 'bank') e.last4 = 'Only cards have last 4 digits.';
    else if (!/^[0-9]{4}$/.test(i.last4)) e.last4 = 'Enter exactly 4 digits.';
  }
  if (i.openingBalance > MAX_ACCOUNT_PAISE) e.openingBalance = 'That amount looks too large. Please check it.';
  if (i.creditLimit !== null) {
    if (i.kind !== 'creditCard') e.creditLimit = 'Only credit cards have a limit.';
    else if (i.creditLimit > MAX_ACCOUNT_PAISE) e.creditLimit = 'That amount looks too large. Please check it.';
  }
  if (i.openingDate > today) e.openingDate = 'The date cannot be in the future.';
  if ((i.note?.length ?? 0) > 200) e.note = 'Keep the note under 200 characters.';
  return e;
}

/** 0 is "no limit". */
const limitOf = (v: number | null): number | null => (v !== null && v > 0 ? v : null);

const balanceWord = (kind: AccountKind) => (isLiabilityKind(kind) ? 'Owed' : 'Balance');

function lines(i: AccountData): PreviewLine[] {
  const out: PreviewLine[] = [
    { label: 'Account', value: i.name.trim() },
    { label: 'Kind', value: ACCOUNT_KIND_LABELS[i.kind] },
  ];
  if (i.institution) out.push({ label: 'Institution', value: i.institution });
  if (i.last4) out.push({ label: 'Card', value: `•••• ${i.last4}` });
  out.push({ label: isLiabilityKind(i.kind) ? 'Owed on opening date' : 'Opening balance', value: formatInr(i.openingBalance), emphasis: true });
  out.push({ label: 'As of', value: formatDate(i.openingDate) });
  if (i.creditLimit !== null && i.creditLimit > 0) out.push({ label: 'Credit limit', value: formatInr(i.creditLimit) });
  return out;
}

async function existingAccount(id: string, ctx: ActionContext): Promise<MoneyAccount> {
  const a = await ctx.snapshot.moneyAccount(id);
  if (!a) throw AppFailure.notFound('This account no longer exists.');
  return a;
}

function checkVersion(existing: MoneyAccount, expected: number | null): void {
  if (expected !== null && existing.version !== expected) throw AppFailure.stale(STALE_MSG);
}

// ---------------------------------------------------------------------------

const createInput = z.object({
  ...dataShape,
  openingDate: zDateOpt,
  isDefault: zBool(false),
});

export const createAccount = defineAction({
  descriptor: {
    id: 'accounts.create',
    module: 'accounts',
    title: 'Add an account',
    description: 'Adds a cash, bank or card account with its own balance. Credit cards track the amount owed.',
    risk: 'low',
    movesMoney: false,
    reversible: true,
    fields: [
      ...dataFields,
      { name: 'openingDate', kind: 'date', description: 'Date the opening balance is as of (defaults to today)', required: false },
      { name: 'isDefault', kind: 'boolean', description: 'Make this the default account', required: false },
    ],
  },
  input: createInput,
  async prepare(input, ctx) {
    const data: AccountData = { ...input, openingDate: input.openingDate ?? ctx.today, creditLimit: limitOf(input.creditLimit) };
    throwIfErrors(validateAccount(data, ctx.today));
    const name = data.name.trim();
    const warnings: string[] = [];
    const dup = (await ctx.snapshot.moneyAccounts()).some((a) => a.kind === data.kind && a.name.trim().toLowerCase() === name.toLowerCase());
    if (dup) warnings.push(`You already have a ${ACCOUNT_KIND_LABELS[data.kind].toLowerCase()} called "${name}".`);
    return { title: 'Add account', summary: `Added ${name}`, lines: lines(data), warnings };
  },
  async execute(input, ctx): Promise<MoneyAccount> {
    const all = await ctx.snapshot.moneyAccounts();
    const now = ctx.now.toISOString();
    const hasDefault = all.some((a) => a.isDefault && !a.isArchived);
    const makeDefault = input.isDefault || !hasDefault;
    if (makeDefault) await clearDefaultExcept(ctx.tx, ctx.userId, null);
    const a = await insertMoneyAccount(ctx.tx, ctx.userId, {
      id: ctx.ids.next('acc'),
      name: input.name.trim(),
      kind: input.kind,
      institution: input.institution,
      last4: input.last4,
      openingPaise: input.openingBalance,
      openingDate: input.openingDate ?? ctx.today,
      creditLimitPaise: limitOf(input.creditLimit),
      isDefault: makeDefault,
      isArchived: false,
      sortOrder: all.reduce((n, x) => Math.max(n, x.sortOrder), -1) + 1,
      note: input.note,
      createdAt: now,
      updatedAt: now,
      version: 1,
    });
    ctx.snapshot.invalidate();
    ctx.touched.push(a.id);
    return a;
  },
});

// ---------------------------------------------------------------------------

const updateInput = z.object({ id: zId, ...versionShape, ...dataShape, openingDate: zDate });

export const updateAccount = defineAction({
  descriptor: {
    id: 'accounts.update',
    module: 'accounts',
    title: 'Edit an account',
    description:
      'Changes an account\'s name, kind, details, opening balance or opening date. Switching between a credit card and any other kind is allowed only while the account has no movements.',
    risk: 'low',
    movesMoney: false,
    reversible: true,
    fields: [
      { name: 'id', kind: 'id', description: 'Account id', required: true },
      ...versionFields,
      ...dataFields,
      { name: 'openingDate', kind: 'date', description: 'Date the opening balance is as of', required: true },
    ],
  },
  input: updateInput,
  async prepare(input, ctx) {
    const existing = await existingAccount(input.id, ctx);
    checkVersion(existing, expectedOf(input));
    const data: AccountData = { ...input, creditLimit: limitOf(input.creditLimit) };
    const e = validateAccount(data, ctx.today);
    if (isLiabilityKind(existing.kind) !== isLiabilityKind(input.kind) && (await accountUsage(ctx.tx, ctx.userId, existing.id)).movements > 0) {
      e.kind = 'This account has movements, so it cannot switch between a credit card and another kind.';
    }
    throwIfErrors(e);
    return { title: 'Save changes', summary: `Updated ${input.name.trim()}`, lines: lines(data) };
  },
  async execute(input, ctx) {
    const existing = await existingAccount(input.id, ctx);
    const updated = await updateMoneyAccount(ctx.tx, ctx.userId, {
      ...existing,
      name: input.name.trim(),
      kind: input.kind,
      institution: input.institution,
      last4: input.last4,
      openingPaise: input.openingBalance,
      openingDate: input.openingDate,
      creditLimitPaise: limitOf(input.creditLimit),
      note: input.note,
      updatedAt: ctx.now.toISOString(),
      version: existing.version + 1,
    });
    ctx.snapshot.invalidate();
    ctx.touched.push(updated.id);
    return updated;
  },
});

// ---------------------------------------------------------------------------

const setBalanceInput = z.object({ id: zId, ...versionShape, balance: zMoney, asOf: zDateOpt });

/** Opening figures that make the account's balance (owed for credit cards) on [asOf] equal [balance]. */
async function correctedOpening(ctx: ActionContext, a: MoneyAccount, balance: number, asOf: string) {
  const liability = isLiabilityKind(a.kind);
  const attempt = async (from: string) => {
    const b = await loadBalance(ctx.tx, ctx.userId, asOf, { accountId: a.id, openingPaise: 0, openingDate: from });
    const raw = b.accounts.find((x) => x.accountId === a.id)?.balancePaise ?? 0;
    const flow = liability ? -raw : raw;
    return liability ? balance + flow : balance - flow;
  };
  let from = a.openingDate <= asOf ? a.openingDate : asOf;
  let opening = await attempt(from);
  if (opening < 0 && from !== asOf) {
    from = asOf;
    opening = await attempt(from);
  }
  if (opening < 0) {
    throw AppFailure.validation('That balance cannot be reached with the movements already recorded on this account.', {
      balance: 'Check the amount.',
    });
  }
  return { openingPaise: opening, openingDate: from };
}

export const setAccountBalance = defineAction({
  descriptor: {
    id: 'accounts.setBalance',
    module: 'accounts',
    title: 'Correct an account balance',
    description:
      'Adjusts the opening balance so the account shows the given balance (amount owed for a credit card) as of the date. Records no transaction.',
    risk: 'low',
    movesMoney: false,
    reversible: true,
    fields: [
      { name: 'id', kind: 'id', description: 'Account id', required: true },
      ...versionFields,
      { name: 'balance', kind: 'money', description: 'What the account really holds (credit card: owes), in rupees', required: true },
      { name: 'asOf', kind: 'date', description: 'Date the balance is as of (defaults to today, not in the future)', required: false },
    ],
  },
  input: setBalanceInput,
  async prepare(input, ctx) {
    const a = await existingAccount(input.id, ctx);
    checkVersion(a, expectedOf(input));
    const asOf = input.asOf ?? ctx.today;
    const e: Record<string, string> = {};
    if (input.balance > MAX_ACCOUNT_PAISE) e.balance = 'That amount looks too large. Please check it.';
    if (asOf > ctx.today) e.asOf = 'The date cannot be in the future.';
    throwIfErrors(e);
    const next = await correctedOpening(ctx, a, input.balance, asOf);
    const before = (await ctx.snapshot.balance()).accounts.find((x) => x.accountId === a.id)?.balancePaise ?? 0;
    const after = (await loadBalance(ctx.tx, ctx.userId, ctx.today, { accountId: a.id, ...next })).accounts.find((x) => x.accountId === a.id)
      ?.balancePaise ?? 0;
    return {
      title: 'Correct balance',
      summary: `${a.name} set to ${formatInr(input.balance)}`,
      lines: [
        { label: 'Account', value: a.name },
        { label: balanceWord(a.kind), value: `${formatInr(before)} → ${formatInr(after)}`, emphasis: true },
        { label: 'As of', value: formatDate(asOf) },
      ],
      basis: { v: a.version, before },
    };
  },
  async execute(input, ctx) {
    const a = await existingAccount(input.id, ctx);
    const next = await correctedOpening(ctx, a, input.balance, input.asOf ?? ctx.today);
    const updated = await updateMoneyAccount(ctx.tx, ctx.userId, {
      ...a,
      ...next,
      updatedAt: ctx.now.toISOString(),
      version: a.version + 1,
    });
    ctx.snapshot.invalidate();
    ctx.touched.push(updated.id);
    return updated;
  },
});

// ---------------------------------------------------------------------------

const idInput = z.object({ id: zId });

export const setDefaultAccount = defineAction({
  descriptor: {
    id: 'accounts.setDefault',
    module: 'accounts',
    title: 'Set the default account',
    description: 'Makes an account the one preselected in forms and used when a movement does not name an account.',
    risk: 'low',
    movesMoney: false,
    reversible: true,
    fields: [{ name: 'id', kind: 'id', description: 'Account id', required: true }],
  },
  input: idInput,
  async prepare(input, ctx) {
    const a = await existingAccount(input.id, ctx);
    if (a.isArchived) throw AppFailure.validation('An archived account cannot be the default.', { id: 'Archived' });
    return { title: 'Set default', summary: `${a.name} is now the default account`, lines: [{ label: 'Account', value: a.name }], basis: { v: a.version } };
  },
  async execute(input, ctx) {
    const a = await existingAccount(input.id, ctx);
    if (a.isDefault) return a;
    await clearDefaultExcept(ctx.tx, ctx.userId, a.id);
    const updated = await updateMoneyAccount(ctx.tx, ctx.userId, {
      ...a,
      isDefault: true,
      updatedAt: ctx.now.toISOString(),
      version: a.version + 1,
    });
    ctx.snapshot.invalidate();
    ctx.touched.push(updated.id);
    return updated;
  },
});

// ---------------------------------------------------------------------------

const archiveInput = z.object({ id: zId, archived: z.boolean() });

export const archiveAccount = defineAction({
  descriptor: {
    id: 'accounts.archive',
    module: 'accounts',
    title: 'Archive an account',
    description:
      'Hides an account from pickers and Home. History and balance are kept. The default or last active account cannot be archived.',
    risk: 'low',
    movesMoney: false,
    reversible: true,
    fields: [
      { name: 'id', kind: 'id', description: 'Account id', required: true },
      { name: 'archived', kind: 'boolean', description: 'true to archive, false to restore', required: true },
    ],
  },
  input: archiveInput,
  async prepare(input, ctx) {
    const a = await existingAccount(input.id, ctx);
    if (input.archived && !a.isArchived) {
      if (a.isDefault) throw AppFailure.validation('Choose another default account before archiving this one.', { id: 'Default account' });
      const others = (await ctx.snapshot.moneyAccounts()).filter((x) => x.id !== a.id && !x.isArchived);
      if (others.length === 0) throw AppFailure.validation('You need at least one active account.', { id: 'Last account' });
    }
    return {
      title: input.archived ? 'Archive account' : 'Restore account',
      summary: `${input.archived ? 'Archived' : 'Restored'} ${a.name}`,
      lines: [{ label: 'Account', value: a.name }],
      basis: { v: a.version },
    };
  },
  async execute(input, ctx) {
    const a = await existingAccount(input.id, ctx);
    if (a.isArchived === input.archived) return a;
    const updated = await updateMoneyAccount(ctx.tx, ctx.userId, {
      ...a,
      isArchived: input.archived,
      updatedAt: ctx.now.toISOString(),
      version: a.version + 1,
    });
    ctx.snapshot.invalidate();
    ctx.touched.push(updated.id);
    return updated;
  },
});

// ---------------------------------------------------------------------------

export const deleteAccountAction = defineAction({
  descriptor: {
    id: 'accounts.delete',
    module: 'accounts',
    title: 'Delete an account',
    description:
      'Removes an account that nothing refers to. Accounts with transactions, transfers, subscriptions or settlements must be archived instead.',
    risk: 'consequential',
    movesMoney: false,
    reversible: false,
    fields: [{ name: 'id', kind: 'id', description: 'Account id', required: true }],
  },
  input: idInput,
  async prepare(input, ctx) {
    const a = await existingAccount(input.id, ctx);
    const others = (await ctx.snapshot.moneyAccounts()).filter((x) => x.id !== a.id && !x.isArchived);
    if (!a.isArchived && others.length === 0) throw AppFailure.validation('You need at least one active account.', { id: 'Last account' });
    const usage = await accountUsage(ctx.tx, ctx.userId, a.id);
    if (usage.references > 0) {
      throw AppFailure.validation('This account has records. Archive it instead of deleting it.', { id: 'In use' });
    }
    return {
      title: 'Delete account?',
      summary: `Deleted ${a.name}`,
      lines: [
        { label: 'Account', value: a.name },
        { label: 'Kind', value: ACCOUNT_KIND_LABELS[a.kind] },
      ],
      warnings: ['This cannot be undone.'],
      basis: { v: a.version },
    };
  },
  async execute(input, ctx) {
    const a = await existingAccount(input.id, ctx);
    await deleteMoneyAccount(ctx.tx, ctx.userId, a.id);
    // Keep exactly one default: hand it to the next active account.
    if (a.isDefault) {
      const next = (await ctx.snapshot.moneyAccounts()).find((x) => x.id !== a.id && !x.isArchived);
      if (next) {
        await updateMoneyAccount(ctx.tx, ctx.userId, { ...next, isDefault: true, updatedAt: ctx.now.toISOString(), version: next.version + 1 });
        ctx.touched.push(next.id);
      }
    }
    ctx.snapshot.invalidate();
    ctx.touched.push(a.id);
    return a;
  },
});

export const accountsActions: AnyAction[] = [
  createAccount,
  updateAccount,
  setAccountBalance,
  setDefaultAccount,
  archiveAccount,
  deleteAccountAction,
] as AnyAction[];
