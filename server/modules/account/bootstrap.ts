// First-request account setup: profile (directory entry), preferences and
// the standard categories. Idempotent; runs inside the caller's transaction.

import { randomInt } from 'node:crypto';
import { sql } from 'kysely';
import type { AuthUser } from '../../auth/verify';
import type { Tx } from '../../db/tx';
import { STANDARD_CATEGORIES } from './standard-categories';

function baseHandle(email: string | null): string {
  const local = (email ?? '').split('@')[0]?.toLowerCase().replace(/[^a-z0-9._]/g, '') ?? '';
  const trimmed = local.replace(/^[._]+|[._]+$/g, '').slice(0, 24);
  return trimmed.length >= 3 ? trimmed : `user${trimmed}`;
}

function defaultName(email: string | null): string {
  const local = (email ?? '').split('@')[0]?.replace(/[._\-+]+/g, ' ').trim() ?? '';
  const name = local
    .split(' ')
    .filter(Boolean)
    .map((w) => w[0]!.toUpperCase() + w.slice(1))
    .join(' ')
    .slice(0, 40);
  return name.length > 0 ? name : 'FiNN user';
}

export async function ensureAccount(tx: Tx, user: AuthUser): Promise<void> {
  const existing = await tx.selectFrom('profiles').select('user_id').where('user_id', '=', user.userId).executeTakeFirst();
  if (existing) return;

  const base = baseHandle(user.email);
  let handle = `@${base}`;
  for (let attempt = 0; attempt < 5; attempt++) {
    const inserted = await tx
      .insertInto('profiles')
      .values({ user_id: user.userId, display_name: defaultName(user.email), handle })
      .onConflict((oc) => oc.doNothing())
      .returning('user_id')
      .executeTakeFirst();
    if (inserted) break;
    // Either the profile appeared concurrently or the handle is taken.
    const again = await tx.selectFrom('profiles').select('user_id').where('user_id', '=', user.userId).executeTakeFirst();
    if (again) break;
    handle = `@${base.slice(0, 24)}${randomInt(100, 10_000)}`;
  }

  await tx.insertInto('user_preferences').values({ user_id: user.userId }).onConflict((oc) => oc.doNothing()).execute();

  const now = new Date();
  await tx
    .insertInto('categories')
    .values(
      STANDARD_CATEGORIES.map((c) => ({
        user_id: user.userId,
        id: c.id,
        name: c.name,
        type: c.type,
        icon_key: c.iconKey,
        color_index: c.colorIndex,
        description: c.description,
        is_system: c.isSystem,
        is_essential: c.isEssential,
        created_at: now,
        updated_at: now,
      })),
    )
    .onConflict((oc) => oc.columns(['user_id', 'id']).doNothing())
    .execute();
}

/** Used by tests and the import endpoint: whether the account holds any financial records. */
export async function isAccountEmpty(tx: Tx, userId: string): Promise<boolean> {
  const row = await sql<{ any: boolean }>`
    select exists (select 1 from public.transactions where user_id = ${userId})
        or exists (select 1 from public.goals where user_id = ${userId})
        or exists (select 1 from public.loans where user_id = ${userId})
        or exists (select 1 from public.pending_payments where user_id = ${userId})
        or exists (select 1 from public.subscriptions where user_id = ${userId})
        or exists (select 1 from public.budgets where user_id = ${userId})
        or exists (select 1 from public.assets where user_id = ${userId})
        or exists (select 1 from public.savings_movements where user_id = ${userId}) as any`.execute(tx);
  return !row.rows[0]?.any;
}
