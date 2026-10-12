// Read / dismissed state of derived alerts (AlertInboxDto). Alerts are
// regenerated deterministically, so their keys stay stable and this state
// survives regeneration.

import { sql } from 'kysely';
import type { Tx } from '../../db/tx';

export interface AlertInbox {
  read: string[];
  dismissed: string[];
}

export async function loadInbox(tx: Tx, userId: string): Promise<AlertInbox> {
  const rows = await tx.selectFrom('alert_inbox').selectAll().where('user_id', '=', userId).orderBy('alert_key').execute();
  return {
    read: rows.filter((r) => r.read_at).map((r) => r.alert_key),
    dismissed: rows.filter((r) => r.dismissed_at).map((r) => r.alert_key),
  };
}

/**
 * Adds keys to the read and dismissed sets and removes [restore] keys from the
 * dismissed set (idempotent). Restored alerts stay read.
 */
export async function markInbox(tx: Tx, userId: string, read: string[], dismissed: string[], restore: string[] = []): Promise<AlertInbox> {
  const now = new Date();
  const keys = new Set([...read, ...dismissed]);
  if (keys.size > 0) {
    await tx
      .insertInto('alert_inbox')
      .values(
        [...keys].map((k) => ({
          user_id: userId,
          alert_key: k,
          read_at: read.includes(k) || dismissed.includes(k) ? now : null,
          dismissed_at: dismissed.includes(k) ? now : null,
        })),
      )
      .onConflict((oc) =>
        oc.columns(['user_id', 'alert_key']).doUpdateSet({
          read_at: sql`coalesce(alert_inbox.read_at, excluded.read_at)`,
          dismissed_at: sql`coalesce(alert_inbox.dismissed_at, excluded.dismissed_at)`,
        }),
      )
      .execute();
  }
  if (restore.length > 0) {
    await tx
      .updateTable('alert_inbox')
      .set({ dismissed_at: null })
      .where('user_id', '=', userId)
      .where('alert_key', 'in', restore)
      .execute();
  }
  return loadInbox(tx, userId);
}
