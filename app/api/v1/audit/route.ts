import { z } from 'zod';
import { parseWith, preflight, query, route } from '@/server/http/handler';
import { withUserTx } from '@/server/db/tx';

const schema = z.object({
  limit: z.string().regex(/^\d+$/).transform(Number).pipe(z.number().int().min(1).max(200)).default(50),
  before: z.string().regex(/^\d{1,18}$/).optional(),
});

/** GET /api/v1/audit?limit&before — the activity log (newest first). */
export const GET = route(async (ctx) => {
  const q = parseWith(schema, query(ctx.url));
  return withUserTx(ctx.user, async (tx) => {
    let sel = tx
      .selectFrom('audit_log')
      .select(['id', 'action_id', 'summary', 'channel', 'confirmed_by', 'succeeded', 'failure_code', 'failure_message', 'record_ids', 'at'])
      .where('user_id', '=', ctx.user.userId);
    if (q.before) sel = sel.where('id', '<', Number(q.before));
    const rows = await sel.orderBy('id', 'desc').limit(q.limit + 1).execute();
    const items = rows.slice(0, q.limit).map((r) => ({
      id: String(r.id),
      actionId: r.action_id,
      summary: r.summary,
      channel: r.channel,
      confirmedBy: r.confirmed_by,
      succeeded: r.succeeded,
      failure: r.failure_code ? { code: r.failure_code, message: r.failure_message } : null,
      recordIds: r.record_ids,
      at: new Date(r.at).toISOString(),
    }));
    return { items, nextBefore: rows.length > q.limit ? items[items.length - 1]!.id : null };
  });
});

export const OPTIONS = preflight();
