// Net worth with a transparent breakdown (lib/features/net_worth/domain/net_worth.dart).
// Pure: cash comes from the ledger, loans and pending items from their modules.
//
//   cash is counted once (earmarked savings are part of cash, shown as a split)
//   receivables = outstanding principal of lent loans + pending to collect
//   liabilities = outstanding principal of borrowed loans + pending to pay

import type { Paise } from '../../core/money';
import type { Asset } from '../../finance/models';
import { ASSET_TYPE_LABELS } from './labels';

export type NetWorthGroup = 'cash' | 'assets' | 'receivables' | 'liabilities';

export interface NetWorthLine {
  group: NetWorthGroup;
  label: string;
  /** Positive for cash/assets/receivables; positive magnitude for liabilities. */
  amountPaise: Paise;
  detail: string | null;
  recordId: string | null;
}

export interface NetWorthLoanInput {
  id: string;
  name: string;
  /** Shown after the name when present ("Car loan · HDFC Bank"). */
  counterparty?: string | null;
  direction: 'borrowed' | 'lent';
  outstandingPaise: Paise;
}

export interface NetWorthPendingInput {
  id: string;
  counterparty?: string | null;
  direction: 'iOwe' | 'owedToMe';
  outstandingPaise: Paise;
}

export interface NetWorthInput {
  cashPaise: Paise;
  earmarkedPaise: Paise;
  assets: Pick<Asset, 'id' | 'name' | 'type' | 'valuePaise'>[];
  loans: NetWorthLoanInput[];
  pending: NetWorthPendingInput[];
}

export interface NetWorthSnapshot {
  cashPaise: Paise;
  /** Part of cash set aside for goals and emergencies (informational, not added). */
  earmarkedPaise: Paise;
  assetsPaise: Paise;
  receivablesPaise: Paise;
  liabilitiesPaise: Paise;
  totalAssetsPaise: Paise;
  netWorthPaise: Paise;
  lines: NetWorthLine[];
}

const sum = (xs: Iterable<number>): number => {
  let t = 0;
  for (const x of xs) t += x;
  return t;
};

export function computeNetWorth(input: NetWorthInput): NetWorthSnapshot {
  const lines: NetWorthLine[] = [
    {
      group: 'cash',
      label: 'Cash & bank (tracked)',
      amountPaise: input.cashPaise,
      detail: input.earmarkedPaise > 0 ? 'Includes earmarked savings' : null,
      recordId: null,
    },
    ...input.assets.map(
      (a): NetWorthLine => ({ group: 'assets', label: a.name, amountPaise: a.valuePaise, detail: ASSET_TYPE_LABELS[a.type], recordId: a.id }),
    ),
  ];
  for (const l of input.loans) {
    if (l.outstandingPaise === 0) continue;
    lines.push({
      group: l.direction === 'borrowed' ? 'liabilities' : 'receivables',
      label: l.counterparty ? `${l.name} · ${l.counterparty}` : l.name,
      amountPaise: l.outstandingPaise,
      detail: 'Outstanding principal',
      recordId: l.id,
    });
  }
  const owe = sum(input.pending.filter((p) => p.direction === 'iOwe').map((p) => p.outstandingPaise));
  const collect = sum(input.pending.filter((p) => p.direction === 'owedToMe').map((p) => p.outstandingPaise));
  if (collect > 0) lines.push({ group: 'receivables', label: 'Pending to collect', amountPaise: collect, detail: null, recordId: null });
  if (owe > 0) lines.push({ group: 'liabilities', label: 'Pending to pay', amountPaise: owe, detail: null, recordId: null });

  const total = (g: NetWorthGroup) => sum(lines.filter((l) => l.group === g).map((l) => l.amountPaise));
  const cash = total('cash');
  const assets = total('assets');
  const receivables = total('receivables');
  const liabilities = total('liabilities');
  const totalAssets = cash + assets + receivables;
  return {
    cashPaise: cash,
    earmarkedPaise: input.earmarkedPaise,
    assetsPaise: assets,
    receivablesPaise: receivables,
    liabilitiesPaise: liabilities,
    totalAssetsPaise: totalAssets,
    netWorthPaise: totalAssets - liabilities,
    lines,
  };
}
