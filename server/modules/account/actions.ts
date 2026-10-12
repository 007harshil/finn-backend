// profile.update (lib/features/settings/application/profile_actions.dart).
// Changing the opening balance or date recalculates every balance, so those
// edits need an explicit review; renaming does not. A first profile
// (onboarding) needs no review either.

import { z } from 'zod';
import { zDate, zMoney, zMoneyOpt } from '../../actions/input';
import { defineAction, type AnyAction, type PreviewLine } from '../../actions/types';
import { formatDate } from '../../core/dates';
import { throwIfErrors } from '../../core/failure';
import { formatInr } from '../../core/money';
import { loadBalance } from '../../finance/ledger';
import { profileDto, type FinancialProfile } from '../../finance/models';
import { updateOwnProfile } from './repo';

/** Largest opening balance accepted (₹1,000 crore): guards against typos. */
export const MAX_OPENING_PAISE = 10_000_000_000 * 100;

const profileInput = z.object({
  displayName: z.string(),
  openingBalance: zMoney,
  openingDate: zDate,
  monthlyIncomeEstimate: zMoneyOpt,
});
type ProfileInput = z.output<typeof profileInput>;

export function validateProfile(i: ProfileInput, today: string): Record<string, string> {
  const errors: Record<string, string> = {};
  const name = i.displayName.trim();
  if (name.length === 0) errors.displayName = 'Enter a name.';
  else if (name.length > 40) errors.displayName = 'Keep the name under 40 characters.';
  if (i.openingBalance > MAX_OPENING_PAISE) errors.openingBalance = 'That amount looks too large. Please check it.';
  if (i.openingDate > today) errors.openingDate = 'The start date cannot be in the future.';
  if (i.monthlyIncomeEstimate !== null && i.monthlyIncomeEstimate > MAX_OPENING_PAISE) {
    errors.monthlyIncomeEstimate = 'That amount looks too large. Please check it.';
  }
  return errors;
}

/** Whether [input] changes the figures every balance is derived from. */
export function changesBalances(input: ProfileInput, existing: FinancialProfile | null): boolean {
  return existing === null || existing.openingPaise !== input.openingBalance || existing.openingDate !== input.openingDate;
}

/** Stored value: the database keeps "no estimate" as null, so a zero estimate is stored as null. */
const incomeOrNull = (i: ProfileInput) => (i.monthlyIncomeEstimate && i.monthlyIncomeEstimate > 0 ? i.monthlyIncomeEstimate : null);

const newProfile = (i: ProfileInput): FinancialProfile => ({
  displayName: i.displayName.trim(),
  openingPaise: i.openingBalance,
  openingDate: i.openingDate,
  monthlyIncomeEstimatePaise: incomeOrNull(i),
});

const signed = (paise: number) => `${paise >= 0 ? '+' : '-'}${formatInr(Math.abs(paise))}`;

export const updateProfile = defineAction({
  descriptor: {
    id: 'profile.update',
    module: 'settings',
    title: 'Update profile',
    description:
      'Changes your name, opening balance, start date or income estimate. Changing the opening balance or start date recalculates every balance.',
    risk: 'consequential',
    movesMoney: false,
    reversible: true,
    fields: [
      { name: 'displayName', kind: 'string', description: 'Name, 1–40 characters', required: true },
      { name: 'openingBalance', kind: 'money', description: 'Cash when tracking started, zero or more', required: true },
      { name: 'openingDate', kind: 'date', description: 'Date tracking started (not in the future)', required: true },
      { name: 'monthlyIncomeEstimate', kind: 'money', description: 'Typical monthly income', required: false },
    ],
  },
  input: profileInput,
  async prepare(input, ctx) {
    throwIfErrors(validateProfile(input, ctx.today));
    const existing = await ctx.snapshot.profile();
    const balanceChange = changesBalances(input, existing);
    const lines: PreviewLine[] = [
      { label: 'Name', value: input.displayName.trim() },
      { label: 'Opening balance', value: formatInr(input.openingBalance), emphasis: balanceChange },
      { label: 'Tracking since', value: formatDate(input.openingDate) },
    ];
    if (input.monthlyIncomeEstimate !== null) lines.push({ label: 'Monthly income estimate', value: formatInr(input.monthlyIncomeEstimate) });
    const warnings: string[] = [];
    if (balanceChange && existing) {
      const current = await ctx.snapshot.balance();
      const next = await loadBalance(ctx.tx, ctx.userId, newProfile(input), ctx.today);
      const delta = next.cashPaise - current.cashPaise;
      lines.push({ label: 'Cash balance', value: `${formatInr(current.cashPaise)} → ${formatInr(next.cashPaise)}`, emphasis: true });
      warnings.push(`Every balance is recalculated from the opening balance and start date (${signed(delta)} change to cash).`);
      if (next.cashPaise < current.earmarkedPaise) {
        warnings.push(`Cash would be less than the ${formatInr(current.earmarkedPaise)} earmarked for goals and emergencies.`);
      }
    }
    return {
      title: balanceChange ? 'Update starting point?' : 'Save profile',
      summary: balanceChange ? `Opening balance set to ${formatInr(input.openingBalance)}` : 'Profile updated',
      lines,
      warnings,
      requiresConfirmation: balanceChange && existing !== null,
      basis: { opening: existing ? [existing.openingPaise, existing.openingDate] : null },
    };
  },
  async execute(input, ctx) {
    const profile = newProfile(input);
    await updateOwnProfile(ctx.tx, ctx.userId, profile, ctx.now);
    ctx.snapshot.invalidate();
    ctx.touched.push(ctx.userId);
    return profileDto(profile);
  },
});

export const profileActions: AnyAction[] = [updateProfile] as AnyAction[];
