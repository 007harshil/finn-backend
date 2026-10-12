// Display helpers shared by the alert engine and the insights layer. They
// reproduce the Flutter formatters used inside alert / insight copy exactly:
//   Money.format(decimals: DecimalDisplay.none)  -> fmtWhole
//   formatBps(bps, decimals: n)                   -> formatBps
//   DateFormats.dueIn                             -> dueIn

import { daysBetween, type IsoDate } from '../../core/dates';
import { formatInr, roundDiv, type Paise } from '../../core/money';

/** `₹1,25,000`: rounded half-up to whole rupees; negative amounts use U+2212 (MoneyFormatter.format, decimals none). */
export function fmtWhole(paise: Paise): string {
  const negative = paise < 0;
  const rupees = roundDiv(Math.abs(paise), 100, 'halfUp');
  return `${negative ? '−' : ''}${formatInr(rupees * 100, { showPaise: false })}`;
}

/** Basis points as a percentage string: 1850 -> "18.5%" (decimals 1), "19%" (decimals 0). */
export function formatBps(bps: number, decimals = 1): string {
  const s = (bps / 100).toFixed(decimals);
  return `${decimals > 0 ? s.replace(/\.0+$/, '') : s}%`;
}

/** "due today", "due in 3 days", "overdue by 1 day" (DateFormats.dueIn). */
export function dueIn(due: IsoDate, today: IsoDate): string {
  const diff = daysBetween(today, due);
  if (diff === 0) return 'due today';
  if (diff === 1) return 'due tomorrow';
  if (diff > 1) return `due in ${diff} days`;
  if (diff === -1) return 'overdue by 1 day';
  return `overdue by ${-diff} days`;
}

/** "today", "tomorrow", "in 3 days". */
export function inDays(d: number): string {
  return d <= 0 ? 'today' : d === 1 ? 'tomorrow' : `in ${d} days`;
}

export const MONTH_NAMES = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
] as const;
