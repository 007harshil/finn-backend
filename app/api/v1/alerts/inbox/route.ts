import { z } from 'zod';
import { parseWith, preflight, readJson, route } from '@/server/http/handler';
import { withUserTx } from '@/server/db/tx';
import { loadInbox, markInbox } from '@/server/modules/alerts/inbox';

const keys = z.array(z.string().min(1).max(200)).max(500).default([]);
const body = z.object({ read: keys, dismissed: keys, restore: keys });

/** GET /api/v1/alerts/inbox — AlertInboxDto. */
export const GET = route(async (ctx) => withUserTx(ctx.user, (tx) => loadInbox(tx, ctx.user.userId)));

/** PUT /api/v1/alerts/inbox — adds keys to read / dismissed, un-dismisses `restore` keys; returns the inbox. */
export const PUT = route(async (ctx) => {
  const b = parseWith(body, await readJson(ctx.request));
  return withUserTx(ctx.user, (tx) => markInbox(tx, ctx.user.userId, b.read, b.dismissed, b.restore), { write: true });
});

export const OPTIONS = preflight();
