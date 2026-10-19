// Reports of assistant replies (table agent_reports). Google Play requires
// apps that generate content with AI to let users flag offensive output
// without leaving the app. The user picks a reason; the app sends the reply
// they flagged and the request that produced it. Reports are reviewed by the
// developer in the database dashboard and feed the guardrail patterns.

import { z } from 'zod';
import type { AuthUser } from '../auth/verify';
import { AppFailure } from '../core/failure';
import { withUserTx } from '../db/tx';

/** Reports one user can file per rolling day (keeps the table from being flooded). */
export const AGENT_REPORTS_DAILY_LIMIT = 50;

export const agentReportSchema = z.object({
  reason: z.enum(['offensive', 'harmful', 'inaccurate', 'other']),
  reply: z
    .string()
    .trim()
    .min(1)
    .max(20_000)
    .transform((s) => s.slice(0, 4000)),
  request: z
    .string()
    .trim()
    .max(4000)
    .nullish()
    .transform((s) => (s ? s.slice(0, 500) : null)),
  note: z
    .string()
    .trim()
    .max(2000)
    .nullish()
    .transform((s) => (s ? s.slice(0, 500) : null)),
});

export type AgentReportInput = z.infer<typeof agentReportSchema>;

export async function fileAgentReport(user: AuthUser, input: AgentReportInput, now = new Date()): Promise<{ id: string }> {
  return withUserTx(
    user,
    async (tx) => {
      const dayAgo = new Date(now.getTime() - 86_400_000);
      const { n } = await tx
        .selectFrom('agent_reports')
        .select((eb) => eb.fn.countAll<number>().as('n'))
        .where('user_id', '=', user.userId)
        .where('created_at', '>', dayAgo)
        .executeTakeFirstOrThrow();
      if (Number(n) >= AGENT_REPORTS_DAILY_LIMIT) {
        throw new AppFailure('unavailable', 'You have sent many reports today. Please try again tomorrow.', { retryable: false });
      }
      const row = await tx
        .insertInto('agent_reports')
        .values({ user_id: user.userId, reason: input.reason, reply: input.reply, request: input.request, note: input.note, created_at: now })
        .returning('id')
        .executeTakeFirstOrThrow();
      return { id: row.id };
    },
    { write: true },
  );
}
