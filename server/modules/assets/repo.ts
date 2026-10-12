import { AppFailure } from '../../core/failure';
import type { Tx } from '../../db/tx';
import { assetFromRow, type Asset } from '../../finance/models';

export async function insertAsset(tx: Tx, userId: string, a: Asset): Promise<Asset> {
  const row = await tx
    .insertInto('assets')
    .values({
      user_id: userId,
      id: a.id,
      name: a.name,
      type: a.type,
      value_paise: a.valuePaise,
      valued_on: a.valuedOn,
      note: a.note,
      version: a.version,
      created_at: new Date(a.createdAt),
      updated_at: new Date(a.updatedAt),
    })
    .returningAll()
    .executeTakeFirstOrThrow();
  return assetFromRow(row);
}

export async function updateAsset(tx: Tx, userId: string, a: Asset, expectedVersion: number): Promise<Asset> {
  const row = await tx
    .updateTable('assets')
    .set({
      name: a.name,
      type: a.type,
      value_paise: a.valuePaise,
      valued_on: a.valuedOn,
      note: a.note,
      version: a.version,
      updated_at: new Date(a.updatedAt),
    })
    .where('user_id', '=', userId)
    .where('id', '=', a.id)
    .where('version', '=', expectedVersion)
    .returningAll()
    .executeTakeFirst();
  if (!row) throw AppFailure.stale('This asset changed since you opened it. Reload and try again.');
  return assetFromRow(row);
}

export async function deleteAsset(tx: Tx, userId: string, id: string): Promise<void> {
  await tx.deleteFrom('assets').where('user_id', '=', userId).where('id', '=', id).execute();
}
