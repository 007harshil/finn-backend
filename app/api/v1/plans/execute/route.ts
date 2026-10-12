import { z } from 'zod';
import { executePlan, planSchema } from '@/server/actions/plans';
import { parseWith, preflight, readJson, route } from '@/server/http/handler';

const body = planSchema.and(
  z.object({
    approvedFingerprints: z.array(z.string().min(1).max(200)).max(20),
    stopOnFailure: z.boolean().default(true),
  }),
);

/** POST /api/v1/plans/execute — runs only approved steps, in order; reports each step's outcome. */
export const POST = route(async (ctx) => {
  const b = parseWith(body, await readJson(ctx.request));
  return { steps: await executePlan(ctx.user, b, b.approvedFingerprints, b.stopOnFailure) };
});

export const OPTIONS = preflight();
