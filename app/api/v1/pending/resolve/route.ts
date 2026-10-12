import { parseWith, preflight, query, route } from '@/server/http/handler';
import { createContext } from '@/server/actions/dispatcher';
import { withUserTx } from '@/server/db/tx';
import { resolvePendingQuery, resolveQuery } from '@/server/modules/pending/service';

/**
 * GET /api/v1/pending/resolve?name=&direction=iOwe|owedToMe&amount=<rupees>
 * PendingResolver: `{status:'found', item}`, `{status:'ambiguous', message, candidates}` or
 * `{status:'none', message}`. Never picks one of several matches.
 */
export const GET = route(async (ctx) => {
  const q = parseWith(resolveQuery, query(ctx.url));
  return withUserTx(ctx.user, async (tx) => resolvePendingQuery((await createContext(tx, ctx.user, 'ui')).snapshot, q));
});

export const OPTIONS = preflight();
