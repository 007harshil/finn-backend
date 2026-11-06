// Rule: a cash, bank or debit account never goes below zero
// (lib/finance/overdraft.dart). Credit cards hold an amount owed and are not
// checked. An account already below zero (old data) may still receive money
// or unrelated edits, but can never drop further.
//
// Two layers:
// * checkOverdraft: in prepare, from the balance change each action is about
//   to make, so the preview refuses before anything is written.
// * assertNoNewOverdraft: in the dispatcher, after execute and inside the same
//   database transaction, comparing real balances before and after. Any write
//   that overdraws an account (whatever action did it) rolls back.

import type { ActionContext } from '../actions/types';
import { AppFailure } from '../core/failure';
import { formatInr, type Paise } from '../core/money';
import type { BalanceSnapshot } from './ledger';
import { legsOf, type Transaction } from './models';

/** A signed change to one account's balance (negative = money out). */
export interface BalanceChange {
  accountId: string;
  paise: Paise;
}

/** Balance changes of recording [t] (or of removing it with [sign] = -1). */
export function transactionChanges(t: Pick<Transaction, 'type' | 'accountId' | 'amountPaise' | 'splits'>, sign: 1 | -1 = 1): BalanceChange[] {
  const dir = t.type === 'income' ? 1 : -1;
  return legsOf(t).map((l) => ({ accountId: l.accountId, paise: sign * dir * l.amountPaise }));
}

/** Balance changes of a transfer (or of removing it with [sign] = -1). */
export function transferChanges(t: { fromAccountId: string; toAccountId: string; amountPaise: Paise }, sign: 1 | -1 = 1): BalanceChange[] {
  return [
    { accountId: t.fromAccountId, paise: -sign * t.amountPaise },
    { accountId: t.toAccountId, paise: sign * t.amountPaise },
  ];
}

/** [spare]: money across all active asset accounts; the hint shows when it covers [needs]. */
function failure(name: string, has: Paise, needs: Paise, spare: Paise, canSplit: boolean, field: string): AppFailure {
  const hint = canSplit && spare >= needs ? ' Split the payment across accounts.' : '';
  const message =
    has > 0
      ? `Not enough money in ${name}. It has ${formatInr(has)}, this needs ${formatInr(needs)}.${hint}`
      : `Not enough money in ${name}. It has ${formatInr(has)}.${hint}`;
  return new AppFailure('insufficientFunds', message, { fieldErrors: { [field]: message } });
}

/**
 * Refuses [changes] when they push an asset account below zero. Use in
 * prepare. [canSplit] adds a "split the payment" hint when other accounts
 * hold enough.
 */
export async function checkOverdraft(
  ctx: ActionContext,
  changes: BalanceChange[],
  opts: { field?: string; canSplit?: boolean } = {},
): Promise<void> {
  const net = new Map<string, Paise>();
  for (const c of changes) net.set(c.accountId, (net.get(c.accountId) ?? 0) + c.paise);
  if (![...net.values()].some((v) => v < 0)) return;
  const balance = await ctx.snapshot.balance();
  const accounts = await ctx.snapshot.moneyAccounts();
  const spare = balance.accounts
    .filter((b) => !b.isLiability && b.balancePaise > 0 && !accounts.find((a) => a.id === b.accountId)?.isArchived)
    .reduce((n, b) => n + b.balancePaise, 0);
  for (const [accountId, delta] of net) {
    if (delta >= 0) continue;
    const b = balance.accounts.find((x) => x.accountId === accountId);
    if (!b || b.isLiability) continue;
    const after = b.balancePaise + delta;
    if (after < 0 && after < b.balancePaise) {
      const name = accounts.find((a) => a.id === accountId)?.name ?? 'this account';
      throw failure(name, b.balancePaise, -delta, spare, opts.canSplit ?? false, opts.field ?? 'amount');
    }
  }
}

/**
 * Safety net: refuses (and so rolls back) any operation after which an asset
 * account is below zero and lower than before.
 */
export function assertNoNewOverdraft(before: BalanceSnapshot, after: BalanceSnapshot, names: Map<string, string>): void {
  const was = new Map(before.accounts.map((b) => [b.accountId, b.balancePaise]));
  for (const b of after.accounts) {
    if (b.isLiability) continue;
    const prev = was.get(b.accountId) ?? 0;
    if (b.balancePaise < 0 && b.balancePaise < prev) {
      throw failure(names.get(b.accountId) ?? 'this account', prev, prev - b.balancePaise, 0, false, 'amount');
    }
  }
}
