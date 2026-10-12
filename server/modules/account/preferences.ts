import type { Tx } from '../../db/tx';
import { DEFAULT_PREFERENCES, preferencesFromRow, type Preferences } from '../../finance/models';

export async function loadPreferences(tx: Tx, userId: string): Promise<Preferences> {
  const row = await tx.selectFrom('user_preferences').selectAll().where('user_id', '=', userId).executeTakeFirst();
  return row ? preferencesFromRow(row) : DEFAULT_PREFERENCES;
}
