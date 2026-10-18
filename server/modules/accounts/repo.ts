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
