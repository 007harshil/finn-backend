import { parseWith, preflight, readJson, route } from '@/server/http/handler';
import { withUserTx } from '@/server/db/tx';
import { loadPreferences } from '@/server/modules/account/preferences';
import { patchPreferences, preferencesPatchSchema } from '@/server/modules/account/service';

/** GET /api/v1/preferences -> Preferences */
export const GET = route(async (ctx) => withUserTx(ctx.user, (tx) => loadPreferences(tx, ctx.user.userId)));

/**
 * PATCH /api/v1/preferences — partial update of monthStartDay (1-28), emiReminderDays (0-30),
 * subscriptionReminderDays (0-30), lowEmergencyCoverageMonths (1-24), defaultBudgetWarningBps (5000-9500),
 * disabledAlertTypes (AlertType names), timeZone (IANA). Returns the full Preferences.
 */
export const PATCH = route(async (ctx) => {
  const patch = parseWith(preferencesPatchSchema, await readJson(ctx.request));
  return withUserTx(ctx.user, (tx) => patchPreferences(tx, ctx.user.userId, patch, new Date()), { write: true });
});

export const OPTIONS = preflight();
