import { sql } from 'kysely';
import { z } from 'zod';
import { parseWith, preflight, query, route } from '@/server/http/handler';
import { withUserTx } from '@/server/db/tx';

const schema = z.object({ q: z.string().max(60).default('') });

/**
 * GET /api/v1/users/search?q= — FiNN users by name or handle, for shared pending items.
 * Returns only name, handle and a phone hint; queries shorter than 2 characters return nothing.
 */
export const GET = route(async (ctx) => {
  const { q } = parseWith(schema, query(ctx.url));
  if (q.trim().length < 2) return { items: [] };
  return withUserTx(ctx.user, async (tx) => {
    const rows = await sql<{ user_id: string; display_name: string; handle: string; phone_hint: string | null }>`
      select * from private.search_users(${q}, 10)`.execute(tx);
    return { items: rows.rows.map((r) => ({ id: r.user_id, name: r.display_name, handle: r.handle, phoneHint: r.phone_hint })) };
  });
});

export const OPTIONS = preflight();
