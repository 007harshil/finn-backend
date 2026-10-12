// Exact money. Every amount is an integer number of paise held in a JS
// number (safe up to 2^53 paise, far beyond any personal-finance amount).
// Intermediate products that could exceed 2^53 use bigint. Mirrors
// lib/core/money/money.dart in the Flutter app; see docs/FINANCIAL_MODEL.md.

export type Paise = number;

export type RoundingMode = 'halfUp' | 'halfEven' | 'down' | 'up';

/** Integer division of [numerator] by a positive [denominator] with explicit rounding. */
export function roundDivBig(numerator: bigint, denominator: bigint, mode: RoundingMode): bigint {
  if (denominator <= 0n) throw new RangeError('denominator must be positive');
  const negative = numerator < 0n;
  const n = negative ? -numerator : numerator;
  const q = n / denominator;
  const r = n % denominator;
  let result: bigint;
  if (r === 0n) {
    result = q;
  } else {
    switch (mode) {
      case 'down':
        result = q;
        break;
      case 'up':
        result = q + 1n;
        break;
      case 'halfUp':
        result = r * 2n >= denominator ? q + 1n : q;
        break;
      case 'halfEven': {
        const twice = r * 2n;
        if (twice > denominator) result = q + 1n;
        else if (twice < denominator) result = q;
        else result = q % 2n === 0n ? q : q + 1n;
        break;
      }
    }
  }
  return negative ? -result : result;
}

export function roundDiv(numerator: number, denominator: number, mode: RoundingMode): number {
  return toSafeNumber(roundDivBig(BigInt(numerator), BigInt(denominator), mode));
}

export function toSafeNumber(v: bigint): number {
  if (v > BigInt(Number.MAX_SAFE_INTEGER) || v < BigInt(Number.MIN_SAFE_INTEGER)) {
    throw new RangeError('Amount out of range');
  }
  return Number(v);
}

/** Multiplies by numerator/denominator with explicit rounding (Money.scale). */
export function scale(paise: Paise, numerator: number, denominator: number, mode: RoundingMode = 'halfUp'): Paise {
  return toSafeNumber(roundDivBig(BigInt(paise) * BigInt(numerator), BigInt(denominator), mode));
}

/** Rounds to whole rupees (Money.roundToRupee). */
export function roundToRupee(paise: Paise, mode: RoundingMode = 'halfUp'): Paise {
  return roundDiv(paise, 100, mode) * 100;
}

/**
 * Ratio of [part] to [whole] in basis points, rounded half-up.
 * Null when [whole] is zero (ratio unknown, never 0%).
 */
export function ratioBps(part: Paise, whole: Paise): number | null {
  if (whole === 0) return null;
  const sign = part < 0 !== whole < 0 ? -1 : 1;
  const v = toSafeNumber(roundDivBig(BigInt(Math.abs(part)) * 10000n, BigInt(Math.abs(whole)), 'halfUp'));
  return sign * v;
}

/** Splits [paise] into [parts] amounts that sum exactly to it; remainder paise go first. */
export function allocateEvenly(paise: Paise, parts: number): Paise[] {
  if (parts <= 0) throw new RangeError('parts must be positive');
  const base = Math.trunc(paise / parts);
  let remainder = paise - base * parts;
  const step = remainder >= 0 ? 1 : -1;
  return Array.from({ length: parts }, () => {
    let share = base;
    if (remainder !== 0) {
      share += step;
      remainder -= step;
    }
    return share;
  });
}

export function sumPaise(values: Iterable<Paise>): Paise {
  let total = 0;
  for (const v of values) total += v;
  return total;
}

const PARSE_RE = /^(\d{0,13})(?:\.(\d{0,2}))?$/;

/**
 * Parses user/agent input such as `1,25,000`, `₹ 499.5` or `12000.75`
 * (Money.tryParse). Null for empty, malformed, negative or >2-decimal input.
 */
export function parseRupees(input: string): Paise | null {
  const cleaned = input.replace(/[₹,\s]/g, '');
  if (cleaned === '') return null;
  const m = PARSE_RE.exec(cleaned);
  if (!m) return null;
  const whole = m[1] ?? '';
  const frac = m[2] ?? '';
  if (whole === '' && frac === '') return null;
  const rupees = whole === '' ? 0 : Number(whole);
  const fracPaise = frac === '' ? 0 : Number(frac.padEnd(2, '0'));
  return rupees * 100 + fracPaise;
}

/** Machine-readable decimal string, e.g. `125000.50` or `-12.05` (Money.toDecimalString). */
export function toDecimalString(paise: Paise): string {
  const sign = paise < 0 ? '-' : '';
  const p = Math.abs(paise);
  return `${sign}${Math.trunc(p / 100)}.${String(p % 100).padStart(2, '0')}`;
}

/**
 * Indian digit grouping for previews (MoneyFormatter): ₹1,25,000 or ₹1,25,000.50.
 * Negative amounts use U+2212 (−); `sign: 'always'` prefixes positives with +.
 */
export function formatInr(paise: Paise, opts: { showPaise?: boolean; sign?: 'auto' | 'always' } = {}): string {
  const negative = paise < 0;
  const p = Math.abs(paise);
  const rupees = Math.trunc(p / 100);
  const fraction = p % 100;
  const digits = String(rupees);
  let grouped: string;
  if (digits.length <= 3) {
    grouped = digits;
  } else {
    const last3 = digits.slice(-3);
    const rest = digits.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ',');
    grouped = `${rest},${last3}`;
  }
  const showPaise = opts.showPaise ?? fraction !== 0;
  const tail = showPaise ? `.${String(fraction).padStart(2, '0')}` : '';
  const prefix = negative ? '−' : opts.sign === 'always' && p !== 0 ? '+' : '';
  return `${prefix}₹${grouped}${tail}`;
}

/** Normalises a bigint column value (pg returns strings, PGlite may return bigint). */
export function paiseFromDb(v: unknown): Paise {
  if (typeof v === 'number') return v;
  if (typeof v === 'bigint') return toSafeNumber(v);
  if (typeof v === 'string' && /^-?\d+$/.test(v)) return toSafeNumber(BigInt(v));
  throw new TypeError(`Not an integer amount: ${String(v)}`);
}

export function paiseFromDbOrNull(v: unknown): Paise | null {
  return v === null || v === undefined ? null : paiseFromDb(v);
}
