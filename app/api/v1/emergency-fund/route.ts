import { preflight, route } from '@/server/http/handler';
import { withUserTx } from '@/server/db/tx';
import { createContext } from '@/server/actions/dispatcher';
import { emergencyStatusDto, loadEmergencyStatus } from '@/server/modules/emergency-fund/service';

/** GET /api/v1/emergency-fund: plan, saved, target, coverageTenths, level, suggestedEssentialMonthly, movements. */
export const GET = route(async (ctx) =>
  withUserTx(ctx.user, async (tx) => {
    const { snapshot } = await createContext(tx, ctx.user, 'ui');
    return emergencyStatusDto(await loadEmergencyStatus(snapshot));
  }),
);

export const OPTIONS = preflight();
