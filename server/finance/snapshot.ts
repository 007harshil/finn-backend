// Server-side counterpart of lib/finance/finance_snapshot.dart: one
// consistent view of a user's records inside a single database transaction.
//
// Small collections (categories, budgets, goals, movements, loans, payments,
// subscriptions, pending items, settlements, assets) are loaded whole and
// memoised on first use. Transactions are never loaded whole: balances and
// cash-flow totals come from SQL aggregates, and individual transactions or
// date windows are queried on demand.

import { sql } from 'kysely';
import type { FinnUser } from '../actions/types';
import type { DateRange, IsoDate } from '../core/dates';
import type { Tx } from '../db/tx';
import { loadBalance, loadPeriodSummary, type BalanceSnapshot, type PeriodSummary } from './ledger';
import {
  assetFromRow,
  budgetFromRow,
  categoryFromRow,
  emergencyPlanFromRow,
  financialProfileFromRow,
  goalFromRow,
  loanFromRow,
  loanPaymentFromRow,
  moneyAccountFromRow,
  movementFromRow,
  pendingFromRow,
  settlementFromRow,
  subscriptionFromRow,
  transactionFromRow,
  transferFromRow,
  type Asset,
  type Budget,
  type BudgetLimitChange,
  type Category,
  type EmergencyPlan,
  type FinancialProfile,
  type Goal,
  type Loan,
  type MoneyAccount,
  type Transfer,
  type LoanPayment,
  type PendingPayment,
  type PendingSettlement,
  type Preferences,
  type SavingsMovement,
  type Subscription,
  type Transaction,
  type TransactionType,
} from './models';

export interface DirectoryEntry {
  userId: string;
  name: string;
  handle: string;
  phoneHint: string | null;
}

export async function directoryEntries(tx: Tx, ids: string[]): Promise<Map<string, DirectoryEntry>> {
  const unique = [...new Set(ids.filter(Boolean))];
  if (unique.length === 0) return new Map();
  const rows = await sql<{ user_id: string; display_name: string; handle: string; phone_hint: string | null }>`
    select * from private.directory_entries(${unique}::uuid[])`.execute(tx);
  return new Map(rows.rows.map((r) => [r.user_id, { userId: r.user_id, name: r.display_name, handle: r.handle, phoneHint: r.phone_hint }]));
}

export class FinanceSnapshot {
  private memo = new Map<string, Promise<unknown>>();

  constructor(
    readonly tx: Tx,
    readonly userId: string,
    readonly today: IsoDate,
    readonly prefs: Preferences,
  ) {}

  get monthStartDay(): number {
    return this.prefs.monthStartDay;
  }

  /** Drops memoised data (after writes that a later read depends on). */
  invalidate(): void {
    this.memo.clear();
  }

  private once<T>(key: string, load: () => Promise<T>): Promise<T> {
    let p = this.memo.get(key) as Promise<T> | undefined;
    if (!p) {
      p = load();
      this.memo.set(key, p);
    }
    return p;
  }

  me(): Promise<FinnUser> {
    return this.once('me', async () => {
      const r = await this.tx.selectFrom('profiles').selectAll().where('user_id', '=', this.userId).executeTakeFirstOrThrow();
      return { id: r.user_id, name: r.display_name, handle: r.handle, phoneHint: r.phone_hint };
    });
  }

  profile(): Promise<FinancialProfile | null> {
    return this.once('profile', async () => {
      const r = await this.tx.selectFrom('profiles').selectAll().where('user_id', '=', this.userId).executeTakeFirst();
      return r ? financialProfileFromRow(r) : null;
    });
  }

  categories(): Promise<Category[]> {
    return this.once('categories', async () =>
      (await this.tx.selectFrom('categories').selectAll().where('user_id', '=', this.userId).orderBy('created_at').orderBy('id').execute()).map(
        categoryFromRow,
      ),
    );
  }

  async category(id: string): Promise<Category | null> {
    return (await this.categories()).find((c) => c.id === id) ?? null;
  }

  balance(): Promise<BalanceSnapshot> {
    return this.once('balance', async () => loadBalance(this.tx, this.userId, this.today));
  }

  /** Cash-flow summary for an inclusive range (memoised per range). */
  summary(range: DateRange): Promise<PeriodSummary> {
    return this.once(`summary:${range.key}`, () => loadPeriodSummary(this.tx, this.userId, range));
  }

  async transaction(id: string): Promise<Transaction | null> {
    const r = await this.tx.selectFrom('transactions').selectAll().where('user_id', '=', this.userId).where('id', '=', id).executeTakeFirst();
    return r ? transactionFromRow(r) : null;
  }

  /** Transactions dated within [range], newest first, optionally filtered. */
  async transactionsIn(
    range: DateRange,
    filter: { type?: TransactionType; categoryIds?: string[]; excludeOrigins?: string[] } = {},
  ): Promise<Transaction[]> {
    let q = this.tx
      .selectFrom('transactions')
      .selectAll()
      .where('user_id', '=', this.userId)
      .where('date', '>=', range.start)
      .where('date', '<=', range.end);
    if (filter.type) q = q.where('type', '=', filter.type);
    if (filter.categoryIds) {
      if (filter.categoryIds.length === 0) return [];
      q = q.where('category_id', 'in', filter.categoryIds);
    }
    if (filter.excludeOrigins && filter.excludeOrigins.length > 0) q = q.where('origin', 'not in', filter.excludeOrigins);
    const rows = await q.orderBy('date', 'desc').orderBy('created_at', 'desc').orderBy('id', 'desc').execute();
    return rows.map(transactionFromRow);
  }

  /** Transactions created by a source record (loan, settlement, subscription). */
  async linkedTransactions(originRefId: string): Promise<Transaction[]> {
    const rows = await this.tx
      .selectFrom('transactions')
      .selectAll()
      .where('user_id', '=', this.userId)
      .where('origin', '<>', 'manual')
      .where('origin_ref_id', '=', originRefId)
      .execute();
    return rows.map(transactionFromRow);
  }

  /** Whether the user has any transactions/pending/loans/goals (FinanceSnapshot.isFreshUser negated). */
  hasActivity(): Promise<boolean> {
    return this.once('hasActivity', async () => {
      const r = await sql<{ any: boolean }>`
        select exists (select 1 from public.transactions where user_id = ${this.userId})
            or exists (select 1 from public.pending_payments where user_id = ${this.userId})
            or exists (select 1 from public.loans where user_id = ${this.userId})
            or exists (select 1 from public.goals where user_id = ${this.userId}) as any`.execute(this.tx);
      return Boolean(r.rows[0]?.any);
    });
  }

  budgets(): Promise<Budget[]> {
    return this.once('budgets', async () => {
      const rows = await this.tx.selectFrom('budgets').selectAll().where('user_id', '=', this.userId).orderBy('created_at').orderBy('id').execute();
      const changes = await this.tx.selectFrom('budget_limit_changes').selectAll().where('user_id', '=', this.userId).execute();
      const byBudget = new Map<string, BudgetLimitChange[]>();
      for (const c of changes) {
        const list = byBudget.get(c.budget_id) ?? [];
        list.push({ until: c.until_month, limitPaise: c.limit_paise });
        byBudget.set(c.budget_id, list);
      }
      return rows.map((r) => budgetFromRow(r, byBudget.get(r.id) ?? []));
    });
  }

  goals(): Promise<Goal[]> {
    return this.once('goals', async () =>
      (await this.tx.selectFrom('goals').selectAll().where('user_id', '=', this.userId).orderBy('created_at').orderBy('id').execute()).map(goalFromRow),
    );
  }

  /** All goal and emergency-fund movements (including future-dated ones). */
  movements(): Promise<SavingsMovement[]> {
    return this.once('movements', async () =>
      (
        await this.tx.selectFrom('savings_movements').selectAll().where('user_id', '=', this.userId).orderBy('date', 'desc').orderBy('created_at', 'desc').execute()
      ).map(movementFromRow),
    );
  }

  emergencyPlan(): Promise<EmergencyPlan | null> {
    return this.once('emergencyPlan', async () => {
      const r = await this.tx.selectFrom('emergency_plans').selectAll().where('user_id', '=', this.userId).executeTakeFirst();
      return r ? emergencyPlanFromRow(r) : null;
    });
  }

  loans(): Promise<Loan[]> {
    return this.once('loans', async () =>
      (await this.tx.selectFrom('loans').selectAll().where('user_id', '=', this.userId).orderBy('created_at').orderBy('id').execute()).map(loanFromRow),
    );
  }

  loanPayments(): Promise<LoanPayment[]> {
    return this.once('loanPayments', async () =>
      (
        await this.tx.selectFrom('loan_payments').selectAll().where('user_id', '=', this.userId).orderBy('date').orderBy('created_at').execute()
      ).map(loanPaymentFromRow),
    );
  }

  subscriptions(): Promise<Subscription[]> {
    return this.once('subscriptions', async () =>
      (await this.tx.selectFrom('subscriptions').selectAll().where('user_id', '=', this.userId).orderBy('created_at').orderBy('id').execute()).map(
        subscriptionFromRow,
      ),
    );
  }

  /** Own pending items plus items shared with this user (mirrored view, id `mir_<sharedId>`). */
  pending(): Promise<PendingPayment[]> {
    return this.once('pending', async () => {
      const rows = await this.tx
        .selectFrom('pending_payments')
        .selectAll()
        .where((eb) => eb.or([eb('user_id', '=', this.userId), eb('shared_with_user_id', '=', this.userId)]))
        .orderBy('created_at')
        .orderBy('id')
        .execute();
      const owners = await directoryEntries(
        this.tx,
        rows.filter((r) => r.user_id !== this.userId).map((r) => r.user_id),
      );
      return rows.map((r) => pendingFromRow(r, this.userId, owners.get(r.user_id)));
    });
  }

  /** Settlements of every visible pending item, in the viewer's id space. */
  settlements(): Promise<PendingSettlement[]> {
    return this.once('settlements', async () => {
      const rows = await this.tx
        .selectFrom('pending_settlements as s')
        .innerJoin('pending_payments as p', (j) => j.onRef('p.user_id', '=', 's.pending_owner_id').onRef('p.id', '=', 's.pending_id'))
        .selectAll('s')
        .select(['p.shared_id as p_shared_id'])
        .where((eb) =>
          eb.or([eb('s.user_id', '=', this.userId), eb('s.pending_owner_id', '=', this.userId), eb('s.shared_with_user_id', '=', this.userId)]),
        )
        .orderBy('s.date', 'desc')
        .orderBy('s.created_at', 'desc')
        .execute();
      return rows.map((r) =>
        settlementFromRow(r, this.userId, r.pending_owner_id === this.userId ? r.pending_id : `mir_${r.p_shared_id}`),
      );
    });
  }

  assets(): Promise<Asset[]> {
    return this.once('assets', async () =>
      (await this.tx.selectFrom('assets').selectAll().where('user_id', '=', this.userId).orderBy('created_at').orderBy('id').execute()).map(assetFromRow),
    );
  }

  /** The user's money accounts (archived included), in display order. */
  moneyAccounts(): Promise<MoneyAccount[]> {
    return this.once('moneyAccounts', async () =>
      (
        await this.tx
          .selectFrom('money_accounts')
          .selectAll()
          .where('user_id', '=', this.userId)
          .orderBy('sort_order')
          .orderBy('created_at')
          .orderBy('id')
          .execute()
      ).map(moneyAccountFromRow),
    );
  }

  async moneyAccount(id: string): Promise<MoneyAccount | null> {
    return (await this.moneyAccounts()).find((a) => a.id === id) ?? null;
  }

  transfers(): Promise<Transfer[]> {
    return this.once('transfers', async () =>
      (
        await this.tx
          .selectFrom('transfers')
          .selectAll()
          .where('user_id', '=', this.userId)
          .orderBy('date', 'desc')
          .orderBy('created_at', 'desc')
          .orderBy('id', 'desc')
          .execute()
      ).map(transferFromRow),
    );
  }
}
