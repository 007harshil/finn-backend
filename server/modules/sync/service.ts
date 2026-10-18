// Incremental sync for the app's local caches (GET /api/v1/sync).
//
// Every row carries `sync_seq`, bumped by a trigger on every change, and
// deletions leave tombstones. A client sends the cursor it last received and
// gets every record that changed after it, in the exact Flutter DTO shape.
// Writes of one user are serialised (per-user lock), so a user's sequence
// numbers commit in order and a cursor never skips a change.
//
// Pages are bounded: when any collection has more than `limit` changes, the
// cursor stops at the last fully included sequence number and `hasMore` is set.

import { sql } from 'kysely';
import type { Tx } from '../../db/tx';
import {
  assetFromRow,
  budgetFromRow,
  categoryFromRow,
  emergencyPlanDto,
  emergencyPlanFromRow,
  financialProfileFromRow,
  goalFromRow,
  loanFromRow,
  loanPaymentFromRow,
  moneyAccountFromRow,
  movementFromRow,
  pendingFromRow,
  preferencesFromRow,
  profileDto,
  settlementFromRow,
  subscriptionFromRow,
  transactionFromRow,
  transferFromRow,
  type BudgetLimitChange,
} from '../../finance/models';
import { directoryEntries } from '../../finance/snapshot';

export const COLLECTIONS = [
  'transactions',
  'categories',
  'budgets',
  'goals',
  'savingsMovements',
  'loans',
  'loanPayments',
  'subscriptions',
  'pending',
  'settlements',
  'assets',
  'moneyAccounts',
  'transfers',
] as const;
export type Collection = (typeof COLLECTIONS)[number];

/** Tombstone collection names written by the database trigger. */
const TOMBSTONE_NAMES: Record<string, Collection> = {
  transactions: 'transactions',
  categories: 'categories',
  budgets: 'budgets',
  goals: 'goals',
  savings_movements: 'savingsMovements',
  loans: 'loans',
  loan_payments: 'loanPayments',
  subscriptions: 'subscriptions',
  pending: 'pending',
  settlements: 'settlements',
  assets: 'assets',
  moneyAccounts: 'moneyAccounts',
  transfers: 'transfers',
};

export interface CollectionChanges {
  upserted: unknown[];
  deleted: string[];
}

export interface SyncChanges {
  /** Opaque cursor to send as `since` next time. */
  cursor: string;
  hasMore: boolean;
  collections: Partial<Record<Collection, CollectionChanges>>;
  /** Single values, present only when changed: ProfileDto, EmergencyPlanDto, preferences, AlertInboxDto. */
  values: {
    profile?: unknown;
    emergencyPlan?: unknown;
    preferences?: unknown;
    alertInbox?: { read: string[]; dismissed: string[] };
    me?: { id: string; name: string; handle: string; phoneHint: string | null; finnId: string };
  };
}

type Row = { sync_seq: number } & Record<string, unknown>;

export async function changesSince(tx: Tx, userId: string, since: number, limit = 2000): Promise<SyncChanges> {
  const fetch = async <R extends Row>(build: () => Promise<R[]>) => build();
  const take = limit + 1;
  const own = <T extends 'transactions' | 'categories' | 'budgets' | 'goals' | 'savings_movements' | 'loans' | 'loan_payments' | 'subscriptions' | 'assets' | 'money_accounts' | 'transfers'>(
    table: T,
  ) =>
    fetch(
      () =>
        tx
          .selectFrom(table as 'transactions')
          .selectAll()
          .where('user_id', '=', userId)
          .where('sync_seq', '>', since)
          .orderBy('sync_seq')
          .limit(take)
          .execute() as unknown as Promise<Row[]>,
    );

  const [transactions, categories, budgets, goals, movements, loans, loanPayments, subscriptions, assets, moneyAccounts, transfers] = await Promise.all([
    own('transactions'),
    own('categories'),
    own('budgets'),
    own('goals'),
    own('savings_movements'),
    own('loans'),
    own('loan_payments'),
    own('subscriptions'),
    own('assets'),
    own('money_accounts'),
    own('transfers'),
  ]);
  const pending = (await tx
    .selectFrom('pending_payments')
    .selectAll()
    .where((eb) => eb.or([eb('user_id', '=', userId), eb('shared_with_user_id', '=', userId)]))
    .where('sync_seq', '>', since)
    .orderBy('sync_seq')
    .limit(take)
    .execute()) as unknown as Row[];
  const settlements = (await tx
    .selectFrom('pending_settlements as s')
    .innerJoin('pending_payments as p', (j) => j.onRef('p.user_id', '=', 's.pending_owner_id').onRef('p.id', '=', 's.pending_id'))
    .selectAll('s')
    .select(['p.shared_id as p_shared_id'])
    .where((eb) => eb.or([eb('s.user_id', '=', userId), eb('s.pending_owner_id', '=', userId), eb('s.shared_with_user_id', '=', userId)]))
    .where('s.sync_seq', '>', since)
    .orderBy('s.sync_seq')
    .limit(take)
    .execute()) as unknown as Row[];
  const tombstones = (await tx
    .selectFrom('deleted_records')
    .select(['collection', 'record_id', 'sync_seq'])
    .where('user_id', '=', userId)
    .where('sync_seq', '>', since)
    .orderBy('sync_seq')
    .limit(take)
    .execute()) as unknown as Row[];

  const lists = { transactions, categories, budgets, goals, movements, loans, loanPayments, subscriptions, assets, moneyAccounts, transfers, pending, settlements, tombstones };

  // Bound the page: stop at the smallest last-included seq of any truncated list.
  let cutoff = Number.POSITIVE_INFINITY;
  for (const list of Object.values(lists)) {
    if (list.length > limit) cutoff = Math.min(cutoff, Number(list[limit - 1]!.sync_seq));
  }
  const hasMore = Number.isFinite(cutoff);
  const within = <R extends Row>(list: R[]) => (hasMore ? list.filter((r) => Number(r.sync_seq) <= cutoff) : list);

  let maxSeq = since;
  const track = <R extends Row>(list: R[]) => {
    for (const r of list) maxSeq = Math.max(maxSeq, Number(r.sync_seq));
    return list;
  };

  const collections: SyncChanges['collections'] = {};
  const put = (name: Collection, upserted: unknown[]) => {
    if (upserted.length === 0) return;
    (collections[name] ??= { upserted: [], deleted: [] }).upserted.push(...upserted);
  };

  put('transactions', track(within(transactions)).map((r) => transactionFromRow(r as never)));
  put('categories', track(within(categories)).map((r) => categoryFromRow(r as never)));
  const budgetRows = track(within(budgets));
  if (budgetRows.length > 0) {
    const changes = await tx
      .selectFrom('budget_limit_changes')
      .selectAll()
      .where('user_id', '=', userId)
      .where('budget_id', 'in', budgetRows.map((b) => b.id as string))
      .execute();
    const byBudget = new Map<string, BudgetLimitChange[]>();
    for (const c of changes) {
      const list = byBudget.get(c.budget_id) ?? [];
      list.push({ until: c.until_month, limitPaise: c.limit_paise });
      byBudget.set(c.budget_id, list);
    }
    put('budgets', budgetRows.map((r) => budgetFromRow(r as never, byBudget.get(r.id as string) ?? [])));
  }
  put('goals', track(within(goals)).map((r) => goalFromRow(r as never)));
  put('savingsMovements', track(within(movements)).map((r) => movementFromRow(r as never)));
  put('loans', track(within(loans)).map((r) => loanFromRow(r as never)));
  put('loanPayments', track(within(loanPayments)).map((r) => loanPaymentFromRow(r as never)));
  put('subscriptions', track(within(subscriptions)).map((r) => subscriptionFromRow(r as never)));
  put('assets', track(within(assets)).map((r) => assetFromRow(r as never)));
  put('moneyAccounts', track(within(moneyAccounts)).map((r) => moneyAccountFromRow(r as never)));
  put('transfers', track(within(transfers)).map((r) => transferFromRow(r as never)));

  const pendingRows = track(within(pending));
  const owners = await directoryEntries(
    tx,
    pendingRows.filter((r) => r.user_id !== userId).map((r) => r.user_id as string),
  );
  put('pending', pendingRows.map((r) => pendingFromRow(r as never, userId, owners.get(r.user_id as string))));
  put(
    'settlements',
    track(within(settlements)).map((r) =>
      settlementFromRow(r as never, userId, r.pending_owner_id === userId ? (r.pending_id as string) : `mir_${r.p_shared_id as string}`),
    ),
  );

  for (const t of track(within(tombstones))) {
    const name = TOMBSTONE_NAMES[t.collection as string];
    if (!name) continue;
    (collections[name] ??= { upserted: [], deleted: [] }).deleted.push(t.record_id as string);
  }

  const values: SyncChanges['values'] = {};
  const profile = await tx.selectFrom('profiles').selectAll().where('user_id', '=', userId).where('sync_seq', '>', since).executeTakeFirst();
  if (profile) {
    track([profile as unknown as Row]);
    values.profile = profileDto(financialProfileFromRow(profile));
    values.me = { id: profile.user_id, name: profile.display_name, handle: profile.handle, phoneHint: profile.phone_hint, finnId: profile.finn_id };
  }
  const plan = await tx.selectFrom('emergency_plans').selectAll().where('user_id', '=', userId).where('sync_seq', '>', since).executeTakeFirst();
  if (plan) {
    track([plan as unknown as Row]);
    values.emergencyPlan = emergencyPlanDto(emergencyPlanFromRow(plan));
  }
  const prefs = await tx.selectFrom('user_preferences').selectAll().where('user_id', '=', userId).where('sync_seq', '>', since).executeTakeFirst();
  if (prefs) {
    track([prefs as unknown as Row]);
    values.preferences = preferencesFromRow(prefs);
  }
  const inboxChanged = await tx
    .selectFrom('alert_inbox')
    .select(sql<number>`max(sync_seq)`.as('seq'))
    .where('user_id', '=', userId)
    .where('sync_seq', '>', since)
    .executeTakeFirst();
  if (inboxChanged?.seq) {
    track([{ sync_seq: Number(inboxChanged.seq) }]);
    const rows = await tx.selectFrom('alert_inbox').selectAll().where('user_id', '=', userId).execute();
    values.alertInbox = {
      read: rows.filter((r) => r.read_at).map((r) => r.alert_key),
      dismissed: rows.filter((r) => r.dismissed_at).map((r) => r.alert_key),
    };
  }
  // A deleted emergency plan resets to "not configured".
  if (!plan && since > 0) {
    const planGone = await tx
      .selectFrom('deleted_records')
      .select('record_id')
      .where('user_id', '=', userId)
      .where('collection', '=', 'emergency_plan')
      .where('sync_seq', '>', since)
      .executeTakeFirst();
    if (planGone) values.emergencyPlan = emergencyPlanDto(null);
  }

  const cursor = hasMore ? Math.min(maxSeq, cutoff) : maxSeq;
  return { cursor: String(cursor), hasMore, collections, values };
}

/** Full snapshot of a fresh account (since = 0) always includes the single values. */
export async function fullSync(tx: Tx, userId: string, limit?: number): Promise<SyncChanges> {
  const changes = await changesSince(tx, userId, 0, limit);
  if (!changes.values.emergencyPlan) changes.values.emergencyPlan = emergencyPlanDto(null);
  if (!changes.values.alertInbox) changes.values.alertInbox = { read: [], dismissed: [] };
  return changes;
}
