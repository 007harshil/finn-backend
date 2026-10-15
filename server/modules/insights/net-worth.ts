// Net worth read model: computeNetWorth (assets module, pure) fed from the
// ledger balance, loan states, pending views and asset records, plus the
// presentation facts of lib/features/net_worth/application/net_worth_view.dart.

import { daysBetween, type IsoDate } from '../../core/dates';
import { roundDivBig, toSafeNumber, type Paise } from '../../core/money';
import type { Asset } from '../../finance/models';
import type { FinanceSnapshot } from '../../finance/snapshot';
import { computeNetWorth, type NetWorthGroup, type NetWorthLine, type NetWorthSnapshot } from '../assets/net-worth';
import { loanStatesOf, memo, pendingStatesOf } from './memo';

/** Valuations older than this are flagged so the user can refresh them. */
export const ASSET_STALE_AFTER_DAYS = 180;

/** Same figures as FinanceSnapshot.netWorth. Memoised per request. */
export function loadNetWorth(s: FinanceSnapshot): Promise<NetWorthSnapshot> {
  return memo(s, 'netWorth', async () => {
    const [balance, loans, pending, assets] = await Promise.all([s.balance(), loanStatesOf(s), pendingStatesOf(s), s.assets()]);
    return computeNetWorth({
      cashPaise: balance.cashPaise,
      earmarkedPaise: balance.earmarkedPaise,
      creditOwedPaise: balance.creditOwedPaise,
      assets,
      loans: loans.map((l) => ({
        id: l.loan.id,
        name: l.loan.name,
        counterparty: l.loan.counterparty,
        direction: l.loan.direction,
        outstandingPaise: l.outstandingPaise,
      })),
      pending: pending.map((p) => ({
        id: p.payment.id,
        counterparty: p.payment.counterparty,
        direction: p.payment.direction,
        outstandingPaise: p.outstandingPaise,
      })),
    });
  });
}

/** Rounds part×10000/whole half-up (non-negative inputs), like Dart's `(x * 10000 / y).round()`. */
const bpsOf = (part: Paise, whole: Paise): number => toSafeNumber(roundDivBig(BigInt(part) * 10000n, BigInt(whole), 'halfUp'));

export interface AssetRow {
  asset: Asset;
  stale: boolean;
  shareBps: number;
}

export interface OwnSlice {
  group: NetWorthGroup;
  label: string;
  amountPaise: Paise;
  /** Share of total assets in basis points. */
  shareBps: number;
}

export interface NetWorthView {
  snapshot: NetWorthSnapshot;
  /** Asset entries, highest value first. */
  assets: AssetRow[];
  receivables: NetWorthLine[];
  /** Largest first. */
  liabilities: NetWorthLine[];
  /** Non-empty parts of what the user owns, largest first. */
  slices: OwnSlice[];
  /** Liabilities as a share of total assets; null when the user owns nothing. */
  debtRatioBps: number | null;
  staleCount: number;
}

export function buildNetWorthView(s: NetWorthSnapshot, assets: readonly Asset[], today: IsoDate): NetWorthView {
  const total = assets.reduce((n, a) => n + a.valuePaise, 0);
  const rows = assets
    .map((asset) => ({
      asset,
      stale: daysBetween(asset.valuedOn, today) > ASSET_STALE_AFTER_DAYS,
      shareBps: total > 0 && asset.valuePaise >= 0 ? bpsOf(asset.valuePaise, total) : 0,
    }))
    .sort((a, b) => {
      const c = b.asset.valuePaise - a.asset.valuePaise;
      if (c !== 0) return c;
      const x = a.asset.name.toLowerCase();
      const y = b.asset.name.toLowerCase();
      return x < y ? -1 : x > y ? 1 : 0;
    });
  const own = s.totalAssetsPaise;
  const slice = (group: NetWorthGroup, label: string, amountPaise: Paise): OwnSlice => ({
    group,
    label,
    amountPaise,
    shareBps: own > 0 && amountPaise > 0 ? bpsOf(amountPaise, own) : 0,
  });
  const slices = [slice('cash', 'Cash & bank', s.cashPaise), slice('assets', 'Assets', s.assetsPaise), slice('receivables', 'Owed to you', s.receivablesPaise)]
    .filter((x) => x.amountPaise > 0)
    .sort((a, b) => b.amountPaise - a.amountPaise);
  return {
    snapshot: s,
    assets: rows,
    receivables: s.lines.filter((l) => l.group === 'receivables'),
    liabilities: s.lines.filter((l) => l.group === 'liabilities').sort((a, b) => b.amountPaise - a.amountPaise),
    slices,
    debtRatioBps: own > 0 && s.liabilitiesPaise >= 0 ? bpsOf(s.liabilitiesPaise, own) : null,
    staleCount: rows.filter((r) => r.stale).length,
  };
}

/** GET /net-worth. */
export async function netWorthView(s: FinanceSnapshot): Promise<NetWorthView> {
  const [snapshot, assets] = await Promise.all([loadNetWorth(s), s.assets()]);
  return buildNetWorthView(snapshot, assets, s.today);
}
