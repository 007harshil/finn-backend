import { z } from 'zod';
import { executePlan, planSchema } from '@/server/actions/plans';
import { agentRunInputSchema, recordAgentRunSafely } from '@/server/agent/history';
import { parseWith, preflight, readJson, route } from '@/server/http/handler';

const body = planSchema.and(
  z.object({
    approvedFingerprints: z.array(z.string().min(1).max(200)).max(20),
    stopOnFailure: z.boolean().default(true),
    /** Agent turns: record the outcome in the user's agent history (GET /agent/history). */
    history: agentRunInputSchema.optional(),
  }),
);

/**
 * POST /api/v1/plans/execute — runs only approved steps, in order; reports each step's outcome.
 * With `history`, the outcome is also recorded as one agent history entry (keyed by
 * `history.runId`, so a retried call updates the same entry instead of adding one).
 */
export const POST = route(async (ctx) => {
  const b = parseWith(body, await readJson(ctx.request));
  const steps = await executePlan(ctx.user, b, b.approvedFingerprints, b.stopOnFailure);
  if (!b.history) return { steps };
  const run = await recordAgentRunSafely(ctx.user, b.history, steps);
  return { steps, history: run ? { id: run.id, status: run.status, summary: run.summary } : null };
});

export const OPTIONS = preflight();
