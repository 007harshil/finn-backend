// Read side of pending payments: views with derived figures, totals, splits
// and safe name resolution. Every view is in the viewer's perspective (shared
// items the viewer did not create appear as `mir_<sharedId>`). Exported for
// the dashboard, alerts and net worth.

import { z } from 'zod';
import { zMoneyOpt } from '../../actions/input';
import type { IsoDate } from '../../core/dates';
import { AppFailure } from '../../core/failure';
import type { Paise } from '../../core/money';
import type { PendingPayment, PendingSettlement } from '../../finance/models';
import type { FinanceSnapshot } from '../../finance/snapshot';
import {
  collectSplits,
  isActiveStatus,
  longPending,
  oldestActive,
  pendingTotals,
  pendingViews,
  resolvePending,
  splitPartLabel,
  type PendingSplitState,
  type PendingState,
  type PendingStatus,
  type PendingTotals,
} from './calculator';

export type { PendingState, PendingTotals } from './calculator';

/** A pending item with its derived figures (PendingView), flattened for JSON. */
export interface PendingViewDto extends PendingPayment {
  settledPaise: Paise;
  outstandingPaise: Paise;
  status: PendingStatus;
  isActive: boolean;
  /** Days since the obligation began. */
  ageDays: number;
  isLongPending: boolean;
  settledBps: number;
  lastPaymentOn: IsoDate | null;
  daysSinceLastPayment: number | null;
  settledOn: IsoDate | null;
  /** "Equal share", "40%", … when the item is part of a split. */
  splitPartLabel: string | null;
  /** Newest first. */
  settlements: PendingSettlement[];
}

export function toPendingDto(v: PendingState): PendingViewDto {
  return {
    ...v.payment,
    settledPaise: v.settledPaise,
    outstandingPaise: v.outstandingPaise,
    status: v.status,
    isActive: isActiveStatus(v.status),
    ageDays: v.daysOpen,
    isLongPending: v.isLongPending,
    settledBps: v.settledBps,
    lastPaymentOn: v.lastPaymentOn,
    daysSinceLastPayment: v.daysSinceLastPayment,
    settledOn: v.settledOn,
    splitPartLabel: v.payment.split ? splitPartLabel(v.payment.split) : null,
    settlements: v.settlements,
  };
}

/** Every visible pending item (own and shared with the viewer) with its derived state. */
export async function loadPendingStates(snapshot: FinanceSnapshot): Promise<PendingState[]> {
  const [items, settlements] = await Promise.all([snapshot.pending(), snapshot.settlements()]);
  return pendingViews(items, settlements, snapshot.today);
}

/** Views as JSON-ready DTOs (for the dashboard, alerts and net worth). */
export async function loadPendingViews(snapshot: FinanceSnapshot): Promise<PendingViewDto[]> {
  return (await loadPendingStates(snapshot)).map(toPendingDto);
}

/** Headline totals: to pay / to collect, long pending, people, counts per tab. */
export async function loadPendingTotals(snapshot: FinanceSnapshot): Promise<PendingTotals> {
  return pendingTotals(await loadPendingStates(snapshot));
}

/** Compact summary for the dashboard and alerts: totals plus long-pending items, oldest first. */
export async function pendingSummary(snapshot: FinanceSnapshot) {
  const states = await loadPendingStates(snapshot);
  return { totals: pendingTotals(states), longPending: longPending(states).map(toPendingDto) };
}

export interface PendingSplitDto {
  id: string;
  method: string;
  methodLabel: string;
  includesMe: boolean;
  mySharePaise: Paise;
  direction: PendingPayment['direction'];
  purpose: string;
  people: number;
  totalPaise: Paise;
  outstandingPaise: Paise;
  settledPaise: Paise;
  settledCount: number;
  activeCount: number;
  /** Item ids in the order people were added. */
  memberIds: string[];
}

function splitDto(s: PendingSplitState): PendingSplitDto {
  return {
    id: s.split.id,
    method: s.split.method,
    methodLabel: s.methodLabel,
    includesMe: s.split.includesMe,
    mySharePaise: s.split.mySharePaise,
    direction: s.direction,
    purpose: s.purpose,
    people: s.people,
    totalPaise: s.totalPaise,
    outstandingPaise: s.outstandingPaise,
    settledPaise: s.settledPaise,
    settledCount: s.settledCount,
    activeCount: s.activeCount,
    memberIds: s.members.map((m) => m.payment.id),
  };
}

/** Active items grouped by person (case-insensitive name), first-seen order. */
function personGroups(states: readonly PendingState[]) {
  const groups = new Map<string, { name: string; itemIds: string[]; toPayPaise: Paise; toCollectPaise: Paise }>();
  for (const v of states) {
    if (!isActiveStatus(v.status)) continue;
    const key = v.payment.counterparty.trim().toLowerCase();
    const g = groups.get(key) ?? { name: v.payment.counterparty, itemIds: [], toPayPaise: 0, toCollectPaise: 0 };
    g.itemIds.push(v.payment.id);
    if (v.payment.direction === 'iOwe') g.toPayPaise += v.outstandingPaise;
    else g.toCollectPaise += v.outstandingPaise;
    groups.set(key, g);
  }
  return [...groups.values()];
}

/** GET /pending: every item, totals, long pending (oldest first), splits and people. */
export async function listPending(snapshot: FinanceSnapshot) {
  const states = await loadPendingStates(snapshot);
  return {
    items: states.map(toPendingDto),
    totals: pendingTotals(states),
    longPending: longPending(states).map((v) => v.payment.id),
    oldest: oldestActive(states).map((v) => v.payment.id),
    splits: [...collectSplits(states).values()].map(splitDto),
    people: personGroups(states),
  };
}

/** GET /pending/{id}: one item (own id or `mir_` id), its split, and other open items with the same person. */
export async function pendingDetail(snapshot: FinanceSnapshot, id: string) {
  const states = await loadPendingStates(snapshot);
  const v = states.find((x) => x.payment.id === id);
  if (!v) throw AppFailure.notFound('This item no longer exists.');
  const split = v.payment.split ? collectSplits(states).get(v.payment.split.id) : undefined;
  const name = v.payment.counterparty.trim().toLowerCase();
  return {
    item: toPendingDto(v),
    split: split ? splitDto(split) : null,
    otherOpenWithPerson: states
      .filter((x) => x !== v && isActiveStatus(x.status) && x.payment.counterparty.trim().toLowerCase() === name)
      .map((x) => x.payment.id),
  };
}

export const resolveQuery = z.object({
  name: z.string().max(80),
  direction: z.enum(['iOwe', 'owedToMe']).optional(),
  /** Outstanding amount in rupees, to tell items with one person apart. */
  amount: zMoneyOpt,
});

export type ResolveResult =
  | { status: 'found'; item: PendingViewDto }
  | { status: 'ambiguous'; message: string; candidates: PendingViewDto[] }
  | { status: 'none'; message: string };

/** PendingResolver as a read: exact match, ambiguous candidates, or none (never a guess). */
export async function resolvePendingQuery(snapshot: FinanceSnapshot, q: z.output<typeof resolveQuery>): Promise<ResolveResult> {
  const states = await loadPendingStates(snapshot);
  try {
    const v = resolvePending(states, q.name, { direction: q.direction ?? null, amountPaise: q.amount });
    return { status: 'found', item: toPendingDto(v) };
  } catch (err) {
    if (!(err instanceof AppFailure)) throw err;
    if (err.code === 'ambiguous') {
      const ids = new Set((err.details?.candidates as string[] | undefined) ?? []);
      return { status: 'ambiguous', message: err.message, candidates: states.filter((s) => ids.has(s.payment.id)).map(toPendingDto) };
    }
    if (err.code === 'notFound') return { status: 'none', message: err.message };
    throw err;
  }
}
