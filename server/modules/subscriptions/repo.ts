import { AppFailure } from '../../core/failure';
import type { Tx } from '../../db/tx';
import { subscriptionFromRow, type Subscription } from '../../finance/models';

const rowValues = (s: Subscription) => ({
  name: s.name,
  amount_paise: s.amountPaise,
  category_id: s.categoryId,
  frequency: s.frequency,
  next_due_date: s.nextDueDate,
  start_date: s.startDate,
  status: s.status,
  auto_renews: s.autoRenews,
  account_id: s.accountId,
  note: s.note,
  updated_at: s.updatedAt,
  version: s.version,
});

export async function insertSubscription(tx: Tx, userId: string, s: Subscription): Promise<Subscription> {
  const row = await tx
    .insertInto('subscriptions')
    .values({ user_id: userId, id: s.id, created_at: s.createdAt, ...rowValues(s) })
    .returningAll()
    .executeTakeFirstOrThrow();
  return subscriptionFromRow(row);
}

/** Writes [next] (version already bumped) only if the stored version is still next.version - 1. */
export async function updateSubscription(tx: Tx, userId: string, next: Subscription): Promise<Subscription> {
  const row = await tx
    .updateTable('subscriptions')
    .set(rowValues(next))
    .where('user_id', '=', userId)
    .where('id', '=', next.id)
    .where('version', '=', next.version - 1)
    .returningAll()
    .executeTakeFirst();
  if (!row) throw AppFailure.stale('This subscription changed since you opened it. Reload and try again.');
  return subscriptionFromRow(row);
}

/** Linked payment transactions are not FK-bound and are kept (as in the app). */
export async function deleteSubscription(tx: Tx, userId: string, id: string): Promise<void> {
  await tx.deleteFrom('subscriptions').where('user_id', '=', userId).where('id', '=', id).execute();
}
