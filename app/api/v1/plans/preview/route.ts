import { planSchema, preparePlan } from '@/server/actions/plans';
import { parseWith, preflight, readJson, route } from '@/server/http/handler';

/** POST /api/v1/plans/preview — validates and previews every step of a multi-action plan. */
export const POST = route(async (ctx) => {
  const plan = parseWith(planSchema, await readJson(ctx.request));
  return { steps: await preparePlan(ctx.user, plan) };
});

export const OPTIONS = preflight();
