// A payment split across several accounts (lib/features/transactions/
// application/transaction_actions.dart: accountSplitError). Still one
// transaction: the parts live on it (Transaction.splits).

import { z } from 'zod';
import { zId, zPositiveMoney } from '../../actions/input';
import type { ActionContext } from '../../actions/types';
import { AppFailure } from '../../core/failure';
import { formatInr, type Paise } from '../../core/money';
import type { AccountLeg } from '../../finance/models';

/** `splits: [{accountId, amount}]` (rupees); absent = one account. */
export const zSplits = z
  .array(z.object({ accountId: zId, amount: zPositiveMoney }))
  .max(20)
  .nullish()
  .transform((v): AccountLeg[] => (v ?? []).map((l) => ({ accountId: l.accountId, amountPaise: l.amount })));

export const splitsField = {
  name: 'splits',
  kind: 'list',
  description: 'Optional: pay from several accounts, a list of {accountId, amount} adding up to amount. Overrides accountId',
  required: false,
} as const;

/**
 * Validates [legs] against [amountPaise]; throws a validation failure on
 * `splits`. Two or more different accounts, every part above zero, parts
 * adding up to the amount, accounts existing and not archived (except
 * accounts in [keep], which an edited record already uses).
 */
export async function assertValidSplits(ctx: ActionContext, amountPaise: Paise, legs: AccountLeg[], keep: string[] = []): Promise<void> {
  if (legs.length === 0) return;
  const bad = (message: string): never => {
    throw AppFailure.validation(message, { splits: message });
  };
  if (legs.length < 2) bad('Choose at least two accounts to split the payment.');
  if (new Set(legs.map((l) => l.accountId)).size !== legs.length) bad('Each account can appear only once.');
  if (legs.some((l) => l.amountPaise <= 0)) bad('Enter an amount for each account.');
  const total = legs.reduce((n, l) => n + l.amountPaise, 0);
  if (total !== amountPaise) bad(`The parts add up to ${formatInr(total)}, not ${formatInr(amountPaise)}.`);
  for (const l of legs) {
    const a = await ctx.snapshot.moneyAccount(l.accountId);
    if (!a) bad('Choose one of your accounts.');
    else if (a.isArchived && !keep.includes(a.id)) bad(`${a.name} is archived. Choose another account.`);
  }
}

/** Preview lines: one per part. */
export async function splitLines(ctx: ActionContext, legs: AccountLeg[]): Promise<{ label: string; value: string }[]> {
  const out: { label: string; value: string }[] = [];
  for (const l of legs) out.push({ label: (await ctx.snapshot.moneyAccount(l.accountId))?.name ?? '—', value: formatInr(l.amountPaise) });
  return out;
}
