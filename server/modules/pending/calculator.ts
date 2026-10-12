// Pure pending-payment maths (lib/features/pending/domain/pending_payment.dart,
// pending_split.dart, shared_pending.dart). No database access; `today` is
// always passed in.
//
// * outstanding = original − Σ settlements, never below zero, and zero once
//   the item is cancelled (written off).
// * status: open → partiallySettled → settled, or cancelled.
// * Splits divide a bill with exact paise (largest remainder, earliest
//   people first), so the shares always add up to the total.

import { daysBetween, type IsoDate } from '../../core/dates';
import { AppFailure } from '../../core/failure';
import { formatInr, ratioBps, sumPaise, type Paise } from '../../core/money';
import type { PendingKind, PendingPayment, PendingSettlement, PendingSplit, SplitMethod } from '../../finance/models';

export type PendingDirection = PendingPayment['direction'];
export type PendingStatus = 'open' | 'partiallySettled' | 'settled' | 'cancelled';

export const PENDING_STATUS_LABELS: Record<PendingStatus, string> = {
  open: 'Open',
  partiallySettled: 'Partially settled',
  settled: 'Settled',
  cancelled: 'Cancelled',
};

export const PENDING_KIND_LABELS: Record<PendingKind, string> = {
  borrowed: 'Borrowed money',
  lent: 'Lent money',
  sharedExpense: 'Shared expense',
  reimbursement: 'Reimbursement',
  other: 'Other',
};

export const DIRECTION_LABELS: Record<PendingDirection, { label: string; shortLabel: string }> = {
  iOwe: { label: 'I owe', shortLabel: 'To pay' },
  owedToMe: { label: 'I will receive', shortLabel: 'To collect' },
};

export const SPLIT_METHOD_LABELS: Record<SplitMethod, string> = {
  equally: 'Equally',
  exact: 'Exact amounts',
  percent: 'Percentages',
  shares: 'Shares',
  adjustment: 'Adjust',
};

/** Whether each person enters a value (everything except `equally`). */
export const splitTakesValues = (m: SplitMethod) => m !== 'equally';

export const isActiveStatus = (s: PendingStatus) => s === 'open' || s === 'partiallySettled';

/** Days an item stays open before it is gently surfaced as long pending. */
export const LONG_PENDING_DAYS = 21;

/** Derived view of one pending payment (PendingView). */
export interface PendingState {
  payment: PendingPayment;
  /** Newest first. */
  settlements: PendingSettlement[];
  settledPaise: Paise;
  outstandingPaise: Paise;
  status: PendingStatus;
  /** Days since the obligation began (no deadlines exist). */
  daysOpen: number;
  lastPaymentOn: IsoDate | null;
  daysSinceLastPayment: number | null;
  isLongPending: boolean;
  /** Settled share of the original, 0..10000. */
  settledBps: number;
  settledOn: IsoDate | null;
}

/** PendingCalculator.view: [all] may hold every settlement; only [p]'s are used. */
export function pendingView(p: PendingPayment, all: readonly PendingSettlement[], today: IsoDate): PendingState {
  // Stable sort, newest date first (Dart List.sort on date only).
  const settlements = all
    .filter((x) => x.pendingId === p.id)
    .map((x, i) => ({ x, i }))
    .sort((a, b) => (a.x.date === b.x.date ? a.i - b.i : a.x.date < b.x.date ? 1 : -1))
    .map((e) => e.x);
  const settledPaise = sumPaise(settlements.map((s) => s.amountPaise));
  const outstandingPaise = p.isCancelled ? 0 : Math.max(p.originalPaise - settledPaise, 0);
  const status: PendingStatus = p.isCancelled
    ? 'cancelled'
    : outstandingPaise === 0
      ? 'settled'
      : settledPaise > 0
        ? 'partiallySettled'
        : 'open';
  const daysOpen = daysBetween(p.createdDate, today);
  const lastPaymentOn = settlements.length === 0 ? null : settlements[0]!.date;
  return {
    payment: p,
    settlements,
    settledPaise,
    outstandingPaise,
    status,
    daysOpen,
    lastPaymentOn,
    daysSinceLastPayment: lastPaymentOn === null ? null : daysBetween(lastPaymentOn, today),
    isLongPending: isActiveStatus(status) && daysOpen > LONG_PENDING_DAYS,
    settledBps: Math.min(Math.max(ratioBps(settledPaise, p.originalPaise) ?? 0, 0), 10000),
    settledOn: status === 'settled' && settlements.length > 0 ? settlements[0]!.date : null,
  };
}

/** Views of every item, in the order given. */
export function pendingViews(items: readonly PendingPayment[], settlements: readonly PendingSettlement[], today: IsoDate): PendingState[] {
  return items.map((p) => pendingView(p, settlements, today));
}

// ---------------------------------------------------------------------------
// Totals (FinanceSnapshot.pendingToPay / pendingToCollect, PendingOverview)
// ---------------------------------------------------------------------------

export interface PendingTotals {
  toPayPaise: Paise;
  toCollectPaise: Paise;
  payCount: number;
  collectCount: number;
  /** Outstanding on items open longer than LONG_PENDING_DAYS. */
  longToPayPaise: Paise;
  longToCollectPaise: Paise;
  longCount: number;
  /** Distinct people with active items. */
  people: number;
  /** Positive: more is coming back than going out. */
  netPaise: Paise;
  /** Items per list tab. */
  counts: { active: number; settled: number; writtenOff: number };
}

export function pendingTotals(views: readonly PendingState[]): PendingTotals {
  const active = views.filter((v) => isActiveStatus(v.status));
  const owe = active.filter((v) => v.payment.direction === 'iOwe');
  const collect = active.filter((v) => v.payment.direction === 'owedToMe');
  const long = active.filter((v) => v.isLongPending);
  const toPayPaise = sumPaise(owe.map((v) => v.outstandingPaise));
  const toCollectPaise = sumPaise(collect.map((v) => v.outstandingPaise));
  return {
    toPayPaise,
    toCollectPaise,
    payCount: owe.length,
    collectCount: collect.length,
    longToPayPaise: sumPaise(long.filter((v) => v.payment.direction === 'iOwe').map((v) => v.outstandingPaise)),
    longToCollectPaise: sumPaise(long.filter((v) => v.payment.direction === 'owedToMe').map((v) => v.outstandingPaise)),
    longCount: long.length,
    people: new Set(active.map((v) => v.payment.counterparty.trim().toLowerCase())).size,
    netPaise: toCollectPaise - toPayPaise,
    counts: {
      active: active.length,
      settled: views.filter((v) => v.status === 'settled').length,
      writtenOff: views.filter((v) => v.status === 'cancelled').length,
    },
  };
}

/** Active items open longer than LONG_PENDING_DAYS, oldest first (stable). */
export function longPending(views: readonly PendingState[]): PendingState[] {
  return views
    .map((v, i) => ({ v, i }))
    .filter((e) => e.v.isLongPending)
    .sort((a, b) => b.v.daysOpen - a.v.daysOpen || a.i - b.i)
    .map((e) => e.v);
}

/** Active items waiting longest, oldest first (up to [n]). */
export function oldestActive(views: readonly PendingState[], n = 3): PendingState[] {
  return views
    .map((v, i) => ({ v, i }))
    .filter((e) => isActiveStatus(e.v.status))
    .sort((a, b) => b.v.daysOpen - a.v.daysOpen || a.i - b.i)
    .slice(0, n)
    .map((e) => e.v);
}

// ---------------------------------------------------------------------------
// Splits (pending_split.dart)
// ---------------------------------------------------------------------------

/** "40%", "33.33%", "33.5%". */
export function formatSplitPercent(bps: number): string {
  const whole = Math.trunc(bps / 100);
  const frac = Math.abs(bps) % 100;
  if (frac === 0) return `${whole}%`;
  return `${whole}.${String(frac).padStart(2, '0').replace(/0$/, '')}%`;
}

/** "Equal share", "40%", "2 shares", "+₹100 adjusted", "Exact amount". */
export function splitPartLabel(s: Pick<PendingSplit, 'method' | 'part'>): string {
  const part = s.part ?? 0;
  switch (s.method) {
    case 'equally':
      return 'Equal share';
    case 'exact':
      return 'Exact amount';
    case 'percent':
      return formatSplitPercent(part);
    case 'shares':
      return `${part} ${part === 1 ? 'share' : 'shares'}`;
    case 'adjustment':
      return part === 0 ? 'Equal share' : `${part > 0 ? '+' : '−'}${formatInr(Math.abs(part))} adjusted`;
  }
}

export type SplitOutcome = { valid: true; shares: Paise[]; error?: undefined } | { valid: false; shares: []; error: string };

const invalid = (error: string): SplitOutcome => ({ valid: false, shares: [], error });

/**
 * SplitCalculator.compute: divides [totalPaise] between people with exact
 * paise. [values] has one entry per person (paise for exact/adjustment, basis
 * points for percent, counts for shares; ignored for equally). Leftover paise
 * go to the earliest people first, so the user (first when included) absorbs them.
 */
export function computeSplit(totalPaise: Paise, method: SplitMethod, values: readonly number[]): SplitOutcome {
  const n = values.length;
  if (n === 0) return invalid('Add the people to split with.');
  if (totalPaise <= 0) return invalid('Enter the total amount first.');
  const t = totalPaise;
  const sum = values.reduce((a, b) => a + b, 0);
  switch (method) {
    case 'equally':
      return { valid: true, shares: apportion(t, Array(n).fill(1)) };
    case 'shares':
      if (values.some((v) => v < 0)) return invalid('Shares cannot be negative.');
      if (values.every((v) => v === 0)) return invalid('Give at least one person a share.');
      return { valid: true, shares: apportion(t, values) };
    case 'percent':
      if (values.some((v) => v < 0)) return invalid('Percentages cannot be negative.');
      if (sum !== 10000) return invalid(`Percentages add up to ${formatSplitPercent(sum)}, not 100%.`);
      return { valid: true, shares: apportion(t, values) };
    case 'exact':
      if (values.some((v) => v < 0)) return invalid('Amounts cannot be negative.');
      if (sum < t) return invalid(`${formatInr(t - sum)} of the total is not given to anyone yet.`);
      if (sum > t) return invalid(`The amounts are ${formatInr(sum - t)} more than the total.`);
      return { valid: true, shares: [...values] };
    case 'adjustment': {
      const base = t - sum;
      if (base < 0) return invalid('The adjustments add up to more than the total.');
      const even = apportion(base, Array(n).fill(1));
      const shares = even.map((e, i) => e + values[i]!);
      if (shares.some((s) => s < 0)) return invalid('A take-off is larger than that person’s equal share.');
      return { valid: true, shares };
    }
  }
}

/** Largest-remainder split of [paise] by [weights] (non-negative): shares add up exactly. */
function apportion(paise: Paise, weights: readonly number[]): Paise[] {
  const p = BigInt(paise);
  const w = weights.reduce((a, b) => a + BigInt(b), 0n);
  const base = weights.map((x) => (p * BigInt(x)) / w);
  let left = p - base.reduce((a, b) => a + b, 0n);
  const rem = weights.map((x) => (p * BigInt(x)) % w);
  const order = weights.map((_, i) => i).sort((a, b) => (rem[b]! > rem[a]! ? 1 : rem[b]! < rem[a]! ? -1 : a - b));
  for (const i of order) {
    if (left === 0n) break;
    if (weights[i] === 0) continue;
    base[i] = base[i]! + 1n;
    left -= 1n;
  }
  return base.map((b) => Number(b));
}

/** All items of one split, read together (PendingSplitView). */
export interface PendingSplitState {
  split: PendingSplit;
  /** One per person, in the order they were added. */
  members: PendingState[];
  direction: PendingDirection;
  purpose: string;
  /** Everyone in the bill, the user included when they were part of it. */
  people: number;
  totalPaise: Paise;
  outstandingPaise: Paise;
  settledPaise: Paise;
  settledCount: number;
  activeCount: number;
  /** The split's method, or "Custom" once an edited amount left the rule. */
  methodLabel: string;
}

/** Every split in [views], keyed by split id, members in creation order. */
export function collectSplits(views: readonly PendingState[]): Map<string, PendingSplitState> {
  const by = new Map<string, PendingState[]>();
  for (const v of views) {
    const s = v.payment.split;
    if (!s) continue;
    const list = by.get(s.id) ?? [];
    list.push(v);
    by.set(s.id, list);
  }
  const out = new Map<string, PendingSplitState>();
  for (const [id, members] of by) {
    members.sort((a, b) =>
      a.payment.createdAt !== b.payment.createdAt
        ? a.payment.createdAt < b.payment.createdAt
          ? -1
          : 1
        : a.payment.id < b.payment.id
          ? -1
          : a.payment.id > b.payment.id
            ? 1
            : 0,
    );
    const split = members[0]!.payment.split!;
    const methods = new Set(members.map((m) => m.payment.split!.method));
    out.set(id, {
      split,
      members,
      direction: members[0]!.payment.direction,
      purpose: members[0]!.payment.purpose,
      people: members.length + (split.includesMe ? 1 : 0),
      totalPaise: split.mySharePaise + sumPaise(members.map((m) => m.payment.originalPaise)),
      outstandingPaise: sumPaise(members.map((m) => m.outstandingPaise)),
      settledPaise: sumPaise(members.map((m) => m.settledPaise)),
      settledCount: members.filter((m) => m.status === 'settled').length,
      activeCount: members.filter((m) => isActiveStatus(m.status)).length,
      methodLabel: methods.size === 1 ? SPLIT_METHOD_LABELS[[...methods][0]!] : 'Custom',
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// PendingResolver: never guesses
// ---------------------------------------------------------------------------

/**
 * Finds the one active item for [counterparty] (exact name first, then
 * substring), optionally narrowed by direction and by an outstanding amount.
 * Throws notFound when nothing matches and `ambiguous` (candidate ids in
 * `details.candidates`) when several do.
 */
export function resolvePending(
  views: readonly PendingState[],
  counterparty: string,
  opts: { direction?: PendingDirection | null; amountPaise?: Paise | null } = {},
): PendingState {
  const name = counterparty.trim().toLowerCase();
  const fits = (v: PendingState) => isActiveStatus(v.status) && (opts.direction == null || v.payment.direction === opts.direction);
  let candidates = views.filter((v) => fits(v) && v.payment.counterparty.toLowerCase() === name);
  if (candidates.length === 0 && name !== '') {
    candidates = views.filter((v) => fits(v) && v.payment.counterparty.toLowerCase().includes(name));
  }
  if (opts.amountPaise != null && candidates.length > 1) {
    const exact = candidates.filter((v) => v.outstandingPaise === opts.amountPaise);
    if (exact.length === 1) candidates = exact;
  }
  if (candidates.length === 0) {
    throw AppFailure.notFound(`No open item found for "${counterparty}".`);
  }
  if (candidates.length > 1) {
    const list = candidates.map((v) => `${v.payment.purpose} (${formatInr(v.outstandingPaise)})`).join(', ');
    throw new AppFailure('ambiguous', `${candidates.length} open items match "${counterparty}": ${list}. Please choose one.`, {
      details: { candidates: candidates.map((v) => v.payment.id) },
    });
  }
  return candidates[0]!;
}
