import { preflight, route } from '@/server/http/handler';
import { withUserTx } from '@/server/db/tx';
import { createContext } from '@/server/actions/dispatcher';
import { loadAlertList } from '@/server/modules/alerts/engine';

/**
 * GET /api/v1/alerts — active alerts (dismissed keys removed), derived on request from the
 * current data: `{ items: (FinancialAlert & { read })[], unreadCount, total, counts, breakdown }`.
 * Read/dismiss with PUT /api/v1/alerts/inbox.
 */
export const GET = route(async (ctx) =>
  withUserTx(ctx.user, async (tx) => loadAlertList((await createContext(tx, ctx.user, 'ui')).snapshot)),
);

export const OPTIONS = preflight();
