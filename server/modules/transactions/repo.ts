// Transaction persistence shared by every module that records cash
// movements. Linked transactions (repayments, settlements, disbursements,
// subscription payments) are written only through buildLinkedTransaction +
// insertTransaction by their owning module, in the same database transaction
// as the source record.

import type { ActionContext } from '../../actions/types';
import type { PaymentMethod } from '../../actions/input';
import type { IsoDate } from '../../core/dates';
import { AppFailure } from '../../core/failure';
import type { Paise } from '../../core/money';
import type { Tx } from '../../db/tx';
import { transactionFromRow, transactionToRow, type Transaction, type TransactionOrigin, type TransactionType } from '../../finance/models';

export async function insertTransaction(tx: Tx, userId: string, t: Transaction): Promise<Transaction> {
  const row = await tx.insertInto('transactions').values(transactionToRow(userId, t)).returningAll().executeTakeFirstOrThrow();
  return transactionFromRow(row);
}

/** Writes [next] only if the stored version is still [expectedVersion]; otherwise staleData. */
export async function updateTransaction(tx: Tx, userId: string, next: Transaction, expectedVersion: number): Promise<Transaction> {
  const { user_id: _u, id: _i, created_at: _c, ...values } = transactionToRow(userId, next);
  const row = await tx
    .updateTable('transactions')
    .set(values)
    .where('user_id', '=', userId)
    .where('id', '=', next.id)
    .where('version', '=', expectedVersion)
    .returningAll()
    .executeTakeFirst();
  if (!row) throw AppFailure.stale('This transaction changed since you opened it. Reload and try again.');
  return transactionFromRow(row);
}

export async function deleteTransaction(tx: Tx, userId: string, id: string): Promise<void> {
  await tx.deleteFrom('transactions').where('user_id', '=', userId).where('id', '=', id).execute();
}

/** A cash movement created by another module, linked to its source record. */
export function buildLinkedTransaction(
  ctx: ActionContext,
  t: {
    type: TransactionType;
    amountPaise: Paise;
    categoryId: string;
    date: IsoDate;
    origin: Exclude<TransactionOrigin, 'manual'>;
    originRefId: string;
    method?: PaymentMethod | null;
    counterparty?: string | null;
    note?: string | null;
  },
): Transaction {
  const now = ctx.now.toISOString();
  return {
    id: ctx.ids.next('tx'),
    type: t.type,
    amountPaise: t.amountPaise,
    categoryId: t.categoryId,
    date: t.date,
    paymentMethod: t.method ?? null,
    counterparty: t.counterparty ?? null,
    note: t.note ?? null,
    origin: t.origin,
    originRefId: t.originRefId,
    createdAt: now,
    updatedAt: now,
    version: 1,
  };
}

/** Common date guard for completed money movements. */
export function notFutureError(date: IsoDate, today: IsoDate): string | null {
  return date > today ? 'The date cannot be in the future.' : null;
}
