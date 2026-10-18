// Shared by goals.* and emergencyFund.*: setting money aside happens ON an
// account. It never changes the account's balance (saving is not spending); it
// lowers what can be spent from that account and from the total.
// See finn/docs/SAVINGS_ACCOUNTS.md.

import type { ActionContext } from '../../actions/types';
import { AppFailure } from '../../core/failure';
import { formatInr, type Paise } from '../../core/money';
import type { MoneyAccount, SavingsMovement } from '../../finance/models';
import { resolveAccountId } from '../accounts/resolve';

export interface SetAside {
  account: MoneyAccount;
  /** Balance − set aside on the account right now. */
  available: Paise;
  /** Account balance. */
  balance: Paise;
}

/** The account a contribution sets money aside on (default account when omitted). Cards hold debt, not money. */
export async function resolveSetAsideAccount(ctx: ActionContext, accountId: string | null | undefined, field = 'accountId'): Promise<SetAside> {
  const id = await resolveAccountId(ctx, accountId, { field });
  const account = (await ctx.snapshot.moneyAccount(id))!;
  if (account.kind === 'creditCard') {
    throw AppFailure.validation('Choose an account that holds money.', { [field]: 'A credit card cannot hold savings.' });
  }
  const row = (await ctx.snapshot.balance()).accounts.find((a) => a.accountId === id);
  return { account, available: row?.availablePaise ?? 0, balance: row?.balancePaise ?? 0 };
}

/** Message when an account has too little unreserved money. */
export function notEnoughOn(account: MoneyAccount, available: Paise): string {
  return available > 0
    ? `Only ${formatInr(available)} in ${account.name} is free to set aside.`
    : `There is no free money in ${account.name} to set aside.`;
}

/** What one bucket holds on each account (null = old allocations on no account), after [movements]. */
export function holdingsOf(movements: readonly SavingsMovement[], bucketType: string, bucketId: string, today: string): Map<string | null, Paise> {
  const held = new Map<string | null, Paise>();
  for (const m of movements) {
    if (m.bucketType !== bucketType || m.bucketId !== bucketId || m.date > today) continue;
    held.set(m.accountId, (held.get(m.accountId) ?? 0) + (m.kind === 'contribution' ? m.amountPaise : -m.amountPaise));
  }
  return held;
}

export interface Release {
  accountId: string | null;
  amountPaise: Paise;
}

/**
 * Where a withdrawal comes from. With [accountId] it must come from that
 * account; without, from the accounts holding the most first. Returns an error
 * message when the bucket does not hold enough there.
 */
export function planRelease(
  held: Map<string | null, Paise>,
  amount: Paise,
  accountId: string | null,
  names: Map<string, string>,
): { releases: Release[]; error: null } | { releases: []; error: string } {
  if (accountId !== null) {
    const here = held.get(accountId) ?? 0;
    if (amount > here) {
      const name = names.get(accountId) ?? 'this account';
      return { releases: [], error: here > 0 ? `Only ${formatInr(here)} is set aside on ${name}.` : `Nothing is set aside on ${name}.` };
    }
    return { releases: [{ accountId, amountPaise: amount }], error: null };
  }
  const releases: Release[] = [];
  let left = amount;
  const order = [...held.entries()].filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0])));
  for (const [id, v] of order) {
    if (left <= 0) break;
    const take = Math.min(v, left);
    releases.push({ accountId: id, amountPaise: take });
    left -= take;
  }
  if (left > 0) return { releases: [], error: 'That is more than is set aside.' };
  return { releases, error: null };
}
