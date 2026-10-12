import { z } from 'zod';
import { parseWith, preflight, query, route } from '@/server/http/handler';
import { withUserTx } from '@/server/db/tx';
import { changesSince, fullSync } from '@/server/modules/sync/service';

const schema = z.object({
  since: z.string().regex(/^\d{1,18}$/).optional(),
  limit: z.string().regex(/^\d+$/).transform(Number).pipe(z.number().int().min(50).max(5000)).optional(),
});

/**
 * GET /api/v1/sync?since=<cursor>&limit=<n>
 * Records changed after `since` (all records when omitted) in Flutter DTO shape,
 * plus tombstones. Repeat with the returned cursor while `hasMore` is true.
 */
export const GET = route(async (ctx) => {
  const q = parseWith(schema, query(ctx.url));
  return withUserTx(ctx.user, (tx) =>
      q.since && q.since !== '0' ? changesSince(tx, ctx.user.userId, Number(q.since), q.limit) : fullSync(tx, ctx.user.userId, q.limit),
    // One snapshot for all collections, so the cursor never passes a row committed mid-read.
    { isolation: 'repeatable read' },
  );
});

export const OPTIONS = preflight();
