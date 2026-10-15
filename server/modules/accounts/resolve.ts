// Account resolution shared by every module that records a money movement.

import type { ActionContext } from '../../actions/types';
import { AppFailure } from '../../core/failure';
import type { MoneyAccount } from '../../finance/models';

export const MAX_CHANNEL_CHARS = 30;

/** The account used when an input omits `accountId`: the default, else the first active one. */
export async function defaultAccount(ctx: ActionContext): Promise<MoneyAccount> {
  const all = await ctx.snapshot.moneyAccounts();
  const active = all.filter((a) => !a.isArchived);
  const found = active.find((a) => a.isDefault) ?? active[0];
  if (!found) throw AppFailure.validation('Add an account first.', { accountId: 'No account available.' });
  return found;
}

/**
 * Resolves and validates the account for a write. A missing id falls back to
 * [fallback] (e.g. a subscription's account) and then the default account.
 * The account must exist and not be archived, except [keep] (an edited record
 * may stay on the archived account it already uses).
 */
export async function resolveAccountId(
  ctx: ActionContext,
  accountId: string | null | undefined,
  opts: { fallback?: string | null; keep?: string | null; field?: string } = {},
): Promise<string> {
  const field = opts.field ?? 'accountId';
  const wanted = accountId ?? opts.fallback ?? null;
  if (wanted === null) return (await defaultAccount(ctx)).id;
  const a = await ctx.snapshot.moneyAccount(wanted);
  if (!a) throw AppFailure.validation('Choose one of your accounts.', { [field]: 'This account does not exist.' });
  if (a.isArchived && a.id !== opts.keep) {
    throw AppFailure.validation('That account is archived. Choose another.', { [field]: 'This account is archived.' });
  }
  return a.id;
}

/** Field error for a too-long channel; null when fine. */
export function channelError(channel: string | null | undefined): string | null {
  return (channel?.length ?? 0) > MAX_CHANNEL_CHARS ? `Keep the channel under ${MAX_CHANNEL_CHARS + 1} characters.` : null;
}
