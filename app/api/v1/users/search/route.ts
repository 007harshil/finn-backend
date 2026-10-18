import { z } from 'zod';
import { parseWith, preflight, query, route } from '@/server/http/handler';
import { withUserTx } from '@/server/db/tx';
import { friendEntries, normalizeFinnId } from '@/server/modules/friends/service';

const schema = z.object({ q: z.string().max(60).default('') });

/**
 * GET /api/v1/users/search?q= — the caller's FRIENDS whose name, handle or FiNN ID
 * matches (the people a pending item can be shared with). An empty query lists
 * friends (up to 50). Strangers are found only by exact FiNN ID (/users/lookup).
 */
export const GET = route(async (ctx) => {
  const { q } = parseWith(schema, query(ctx.url));
  const needle = q.trim().toLowerCase().replace(/^@/, '');
  const code = normalizeFinnId(q);
  return withUserTx(ctx.user, async (tx) => {
    const friends = await friendEntries(tx);
    const hits = needle === ''
      ? friends
      : friends.filter((f) => f.name.toLowerCase().includes(needle) || f.handle.toLowerCase().replace(/^@/, '').includes(needle) || f.finnId === code);
    return {
      items: hits.slice(0, 50).map((f) => ({ id: f.id, name: f.name, handle: f.handle, phoneHint: f.phoneHint, finnId: f.finnId })),
    };
  });
});

export const OPTIONS = preflight();
