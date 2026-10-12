// Recurrence for subscriptions and repayment schedules (lib/core/time/frequency.dart).

import { addDays, addMonthsClamped, parts, type IsoDate } from './dates';
import { scale, type Paise } from './money';

export const FREQUENCIES = ['weekly', 'monthly', 'quarterly', 'halfYearly', 'yearly'] as const;
export type Frequency = (typeof FREQUENCIES)[number];

export const FREQUENCY_INFO: Record<Frequency, { label: string; unit: string; months: number; periodsPerYear: number }> = {
  weekly: { label: 'Weekly', unit: 'week', months: 0, periodsPerYear: 52 },
  monthly: { label: 'Monthly', unit: 'month', months: 1, periodsPerYear: 12 },
  quarterly: { label: 'Quarterly', unit: 'quarter', months: 3, periodsPerYear: 4 },
  halfYearly: { label: 'Half-yearly', unit: 'half-year', months: 6, periodsPerYear: 2 },
  yearly: { label: 'Yearly', unit: 'year', months: 12, periodsPerYear: 1 },
};

/** The occurrence after [date]; month steps keep [anchorDay]. */
export function nextOccurrence(freq: Frequency, date: IsoDate, anchorDay?: number): IsoDate {
  if (freq === 'weekly') return addDays(date, 7);
  return addMonthsClamped(date, FREQUENCY_INFO[freq].months, anchorDay);
}

/** The [count]-th occurrence after [start] (count 0 returns [start]). */
export function nthOccurrence(freq: Frequency, start: IsoDate, count: number): IsoDate {
  if (freq === 'weekly') return addDays(start, 7 * count);
  return addMonthsClamped(start, FREQUENCY_INFO[freq].months * count, parts(start).day);
}

/** Monthly equivalent of a per-period amount, half-up; weekly = x52/12. */
export function monthlyEquivalent(freq: Frequency, amount: Paise): Paise {
  if (freq === 'weekly') return scale(amount, 52, 12);
  if (freq === 'monthly') return amount;
  return scale(amount, 1, FREQUENCY_INFO[freq].months);
}

export function annualized(freq: Frequency, amount: Paise): Paise {
  return amount * FREQUENCY_INFO[freq].periodsPerYear;
}
