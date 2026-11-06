import { sql } from 'kysely';
import { AppFailure } from '../../core/failure';
import type { Tx } from '../../db/tx';
import { moneyAccountFromRow, type MoneyAccount } from '../../finance/models';

const rowValues = (a: MoneyAccount) => ({
  name: a.name,
  kind: a.kind,
  institution: a.institution,
  last4: a.last4,
  opening_paise: a.openingPaise,
  opening_date: a.openingDate,
  credit_limit_paise: a.creditLimitPaise,
  is_default: a.isDefault,
  is_archived: a.isArchived,
  sort_order: a.sortOrder,
  note: a.note,
  version: a.version,
  updated_at: new Date(a.updatedAt),
});

export async function insertMoneyAccount(tx: Tx, userId: string, a: MoneyAccount): Promise<MoneyAccount> {
  const row = await tx
    .insertInto('money_accounts')
    .values({ user_id: userId, id: a.id, created_at: new Date(a.createdAt), ...rowValues(a) })
    .returningAll()
    .executeTakeFirstOrThrow();
  return moneyAccountFromRow(row);
}

/** Writes [next] (version already bumped) only if the stored version is still next.version - 1. */
export async function updateMoneyAccount(tx: Tx, userId: string, next: MoneyAccount): Promise<MoneyAccount> {
  const row = await tx
    .updateTable('money_accounts')
    .set(rowValues(next))
    .where('user_id', '=', userId)
    .where('id', '=', next.id)
    .where('version', '=', next.version - 1)
    .returningAll()
    .executeTakeFirst();
  if (!row) throw AppFailure.stale('This account changed since you opened it. Reload and try again.');
  return moneyAccountFromRow(row);
}

export async function deleteMoneyAccount(tx: Tx, userId: string, id: string): Promise<void> {
  await tx.deleteFrom('money_accounts').where('user_id', '=', userId).where('id', '=', id).execute();
}

/** What deleting an account removes (transactions, transfers, set-aside savings) and unlinks (subscriptions, settlements). */
export interface AccountRecordCounts {
  transactions: number;
  transfers: number;
  savings: number;
  subscriptions: number;
  settlements: number;
}

export async function accountRecordCounts(tx: Tx, userId: string, id: string): Promise<AccountRecordCounts> {
  const r = await sql<{ tx: string; tr: string; sub: string; st: string; sv: string }>`
    select (select count(*) from public.transactions where user_id = ${userId} and account_id = ${id}) as tx,
           (select count(*) from public.transfers where user_id = ${userId} and (from_account_id = ${id} or to_account_id = ${id})) as tr,
           (select count(*) from public.subscriptions where user_id = ${userId} and account_id = ${id}) as sub,
           (select count(*) from public.pending_settlements where user_id = ${userId} and account_id = ${id}) as st,
           (select count(*) from public.savings_movements where user_id = ${userId} and account_id = ${id}) as sv`.execute(tx);
  const row = r.rows[0]!;
  return {
    transactions: Number(row.tx),
    transfers: Number(row.tr),
    savings: Number(row.sv),
    subscriptions: Number(row.sub),
    settlements: Number(row.st),
  };
}

/**
 * Clears everything that refers to an account so the account row itself can be deleted.
 *
 * Deleted (tombstoned by triggers): the account's transactions, every transfer into or
 * out of it, and the savings set aside on it. Kept but unlinked: subscriptions and
 * settlements paid from it (account_id -> null), and loans, loan payments and
 * settlements whose linked transaction is being deleted (transaction link -> null), so
 * loan outstanding and pending balances do not change.
 */
export async function purgeAccountRecords(tx: Tx, userId: string, id: string): Promise<void> {
  const txIds = tx.selectFrom('transactions').select('id').where('user_id', '=', userId).where('account_id', '=', id);

  await tx
    .updateTable('loans')
    .set({ disbursement_transaction_id: null, version: sql`version + 1`, updated_at: sql`now()` })
    .where('user_id', '=', userId)
    .where('disbursement_transaction_id', 'in', txIds)
    .execute();
  await tx
    .updateTable('loan_payments')
    .set({ transaction_id: null })
    .where('user_id', '=', userId)
    .where('transaction_id', 'in', txIds)
    .execute();
  await tx
    .updateTable('pending_settlements')
    .set({ transaction_id: null })
    .where('user_id', '=', userId)
    .where('transaction_id', 'in', txIds)
    .execute();
  await tx.updateTable('pending_settlements').set({ account_id: null }).where('user_id', '=', userId).where('account_id', '=', id).execute();
  await tx
    .updateTable('subscriptions')
    .set({ account_id: null, version: sql`version + 1`, updated_at: sql`now()` })
    .where('user_id', '=', userId)
    .where('account_id', '=', id)
    .execute();

  await tx.deleteFrom('savings_movements').where('user_id', '=', userId).where('account_id', '=', id).execute();
  await tx
    .deleteFrom('transfers')
    .where('user_id', '=', userId)
    .where((eb) => eb.or([eb('from_account_id', '=', id), eb('to_account_id', '=', id)]))
    .execute();
  await tx.deleteFrom('transactions').where('user_id', '=', userId).where('account_id', '=', id).execute();
}

/** Clears the default flag everywhere except [exceptId] (so a new default can be set). */
export async function clearDefaultExcept(tx: Tx, userId: string, exceptId: string | null): Promise<void> {
  let q = tx
    .updateTable('money_accounts')
    .set({ is_default: false, version: sql`version + 1`, updated_at: sql`now()` })
    .where('user_id', '=', userId)
    .where('is_default', '=', true);
  if (exceptId) q = q.where('id', '<>', exceptId);
  await q.execute();
}

/** How many records reference the account (transactions, transfers, subscriptions, settlements, savings). */
export async function accountUsage(tx: Tx, userId: string, id: string): Promise<{ movements: number; references: number }> {
  const r = await sql<{ tx: string; tr: string; sub: string; st: string; sv: string }>`
    select (select count(*) from public.transactions where user_id = ${userId} and account_id = ${id}) as tx,
           (select count(*) from public.transfers where user_id = ${userId} and (from_account_id = ${id} or to_account_id = ${id})) as tr,
           (select count(*) from public.subscriptions where user_id = ${userId} and account_id = ${id}) as sub,
           (select count(*) from public.pending_settlements where user_id = ${userId} and account_id = ${id}) as st,
           (select count(*) from public.savings_movements where user_id = ${userId} and account_id = ${id}) as sv`.execute(tx);
  const row = r.rows[0]!;
  const movements = Number(row.tx) + Number(row.tr);
  return { movements, references: movements + Number(row.sub) + Number(row.st) + Number(row.sv) };
}

/** Creates the Cash account every user starts with (idempotent). */
export async function ensureCashAccount(tx: Tx, userId: string, today: string): Promise<void> {
  await tx
    .insertInto('money_accounts')
    .values({ user_id: userId, id: 'acc_cash', name: 'Cash', kind: 'cash', opening_paise: 0, opening_date: today, is_default: true, sort_order: 0 })
    .onConflict((oc) => oc.columns(['user_id', 'id']).doNothing())
    .execute();
}

/** Sets the Cash account's opening figures (onboarding / profile opening balance). No-op without it. */
export async function setCashOpening(tx: Tx, userId: string, openingPaise: number, openingDate: string): Promise<void> {
  await tx
    .updateTable('money_accounts')
    .set({ opening_paise: openingPaise, opening_date: openingDate, version: sql`version + 1`, updated_at: sql`now()` })
    .where('user_id', '=', userId)
    .where('id', '=', 'acc_cash')
    .execute();
}
