// Calendar dates. Every financial date is an ISO calendar date string
// (`yyyy-MM-dd`) in the user's local calendar; arithmetic goes through a day
// number (days since 1970-01-01, UTC) so it is DST-safe. Mirrors
// lib/core/time/dates.dart.

export type IsoDate = string;

const ISO_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

export function isIsoDate(v: unknown): v is IsoDate {
  if (typeof v !== 'string') return false;
  const m = ISO_RE.exec(v);
  if (!m) return false;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  // Financial records live in a plausible calendar range; this also keeps
  // Date.UTC away from years 0-99 (which it maps to 1900-1999).
  return y >= 1900 && y <= 9999 && mo >= 1 && mo <= 12 && d >= 1 && d <= daysInMonth(y, mo);
}

export function parts(date: IsoDate): { year: number; month: number; day: number } {
  const m = ISO_RE.exec(date);
  if (!m) throw new RangeError(`Invalid date: ${date}`);
  return { year: Number(m[1]), month: Number(m[2]), day: Number(m[3]) };
}

/** Builds a date, normalising overflow like Dart's DateTime(y, m, d). */
export function makeDate(year: number, month: number, day: number): IsoDate {
  const ms = Date.UTC(year, month - 1, day);
  return new Date(ms).toISOString().slice(0, 10);
}

export function toDayNumber(date: IsoDate): number {
  const { year, month, day } = parts(date);
  return Math.round(Date.UTC(year, month - 1, day) / 86_400_000);
}

export function fromDayNumber(n: number): IsoDate {
  return new Date(n * 86_400_000).toISOString().slice(0, 10);
}

/** Whole calendar days from [from] to [to] (negative when [to] is earlier). */
export function daysBetween(from: IsoDate, to: IsoDate): number {
  return toDayNumber(to) - toDayNumber(from);
}

export function addDays(date: IsoDate, days: number): IsoDate {
  return fromDayNumber(toDayNumber(date) + days);
}

export function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

export function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/**
 * Adds [months], clamping the day to the target month's length. With
 * [anchorDay] the anchor is used instead of the date's day, so a schedule on
 * the 31st returns to the 31st after a short month.
 */
export function addMonthsClamped(date: IsoDate, months: number, anchorDay?: number): IsoDate {
  const { year, month, day } = parts(date);
  const total = year * 12 + (month - 1) + months;
  const y = Math.floor(total / 12);
  const m = (((total % 12) + 12) % 12) + 1;
  const last = daysInMonth(y, m);
  const d = Math.min(Math.max(anchorDay ?? day, 1), last);
  return makeDate(y, m, d);
}

export function startOfMonth(date: IsoDate): IsoDate {
  const { year, month } = parts(date);
  return makeDate(year, month, 1);
}

export function endOfMonth(date: IsoDate): IsoDate {
  const { year, month } = parts(date);
  return makeDate(year, month + 1, 0);
}

export function maxDate(a: IsoDate, b: IsoDate): IsoDate {
  return a >= b ? a : b;
}

export function minDate(a: IsoDate, b: IsoDate): IsoDate {
  return a <= b ? a : b;
}

/** A calendar month, e.g. 2026-10. */
export class MonthKey {
  constructor(
    readonly year: number,
    readonly month: number,
  ) {
    if (month < 1 || month > 12) throw new RangeError('month out of range');
  }

  static of(date: IsoDate): MonthKey {
    const { year, month } = parts(date);
    return new MonthKey(year, month);
  }

  static tryParse(value: string | null | undefined): MonthKey | null {
    if (!value) return null;
    const m = /^(\d{4})-(\d{2})$/.exec(value);
    if (!m) return null;
    const month = Number(m[2]);
    if (month < 1 || month > 12) return null;
    return new MonthKey(Number(m[1]), month);
  }

  get start(): IsoDate {
    return makeDate(this.year, this.month, 1);
  }

  get end(): IsoDate {
    return makeDate(this.year, this.month + 1, 0);
  }

  get range(): DateRange {
    return new DateRange(this.start, this.end);
  }

  get dayCount(): number {
    return daysInMonth(this.year, this.month);
  }

  shift(months: number): MonthKey {
    return MonthKey.of(makeDate(this.year, this.month + months, 1));
  }

  get next(): MonthKey {
    return this.shift(1);
  }

  get previous(): MonthKey {
    return this.shift(-1);
  }

  contains(date: IsoDate): boolean {
    const p = parts(date);
    return p.year === this.year && p.month === this.month;
  }

  /** `2026-10` */
  get id(): string {
    return `${this.year}-${String(this.month).padStart(2, '0')}`;
  }

  compareTo(other: MonthKey): number {
    return this.year * 12 + this.month - (other.year * 12 + other.month);
  }

  equals(other: MonthKey): boolean {
    return this.compareTo(other) === 0;
  }

  toString(): string {
    return this.id;
  }
}

/** Inclusive range of calendar dates. */
export class DateRange {
  constructor(
    readonly start: IsoDate,
    readonly end: IsoDate,
  ) {
    if (end < start) throw new RangeError('end before start');
  }

  contains(date: IsoDate): boolean {
    return date >= this.start && date <= this.end;
  }

  get dayCount(): number {
    return daysBetween(this.start, this.end) + 1;
  }

  /** The range of equal length immediately before this one. */
  get previous(): DateRange {
    const prevEnd = addDays(this.start, -1);
    return new DateRange(addDays(prevEnd, -(this.dayCount - 1)), prevEnd);
  }

  overlaps(other: DateRange): boolean {
    return !(other.end < this.start) && !(other.start > this.end);
  }

  equals(other: DateRange): boolean {
    return this.start === other.start && this.end === other.end;
  }

  get key(): string {
    return `${this.start}..${this.end}`;
  }
}

/** Today's calendar date in an IANA time zone. */
export function todayIn(timeZone: string, now: Date = new Date()): IsoDate {
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
  } catch {
    return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
  }
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** `5 Oct 2026` (DateFormats.dayMonthYear). */
export function formatDate(date: IsoDate): string {
  const { year, month, day } = parts(date);
  return `${day} ${MONTHS[month - 1]} ${year}`;
}

/** `5 Oct` (DateFormats.dayMonth). */
export function formatDayMonth(date: IsoDate): string {
  const { month, day } = parts(date);
  return `${day} ${MONTHS[month - 1]}`;
}

/** `October 2026`. */
export function formatMonthYear(month: MonthKey): string {
  const names = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  return `${names[month.month - 1]} ${month.year}`;
}
