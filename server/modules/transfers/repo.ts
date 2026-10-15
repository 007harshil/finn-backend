import { AppFailure } from '../../core/failure';
import type { Tx } from '../../db/tx';
import { transferFromRow, type Transfer } from '../../finance/models';
import { extendTrackingStart } from '../account/repo';

const rowValues = (t: Transfer) => ({
  from_account_id: t.fromAccountId,
  to_account_id: t.toAccountId,
  amount_paise: t.amountPaise,
  date: t.date,
  channel: t.channel,
  note: t.note,
  version: t.version,
  updated_at: new Date(t.updatedAt),
});

/** A transfer dated before an account's opening date moves that account's start back, so it counts. */
export async function insertTransfer(tx: Tx, userId: string, t: Transfer): Promise<Transfer> {
  const row = await tx
    .insertInto('transfers')
    .values({ user_id: userId, id: t.id, created_at: new Date(t.createdAt), ...rowValues(t) })
    .returningAll()
    .executeTakeFirstOrThrow();
  await extendTrackingStart(tx, userId, t.date, [t.fromAccountId, t.toAccountId]);
  return transferFromRow(row);
}

/** Writes [next] (version already bumped) only if the stored version is still next.version - 1. */
export async function updateTransfer(tx: Tx, userId: string, next: Transfer): Promise<Transfer> {
  const row = await tx
    .updateTable('transfers')
    .set(rowValues(next))
    .where('user_id', '=', userId)
    .where('id', '=', next.id)
    .where('version', '=', next.version - 1)
    .returningAll()
    .executeTakeFirst();
  if (!row) throw AppFailure.stale('This transfer changed since you opened it. Reload and try again.');
  await extendTrackingStart(tx, userId, next.date, [next.fromAccountId, next.toAccountId]);
  return transferFromRow(row);
}

export async function deleteTransfer(tx: Tx, userId: string, id: string): Promise<void> {
  await tx.deleteFrom('transfers').where('user_id', '=', userId).where('id', '=', id).execute();
}
