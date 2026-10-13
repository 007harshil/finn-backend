import { agentHistoryQuerySchema, clearAgentRuns, listAgentRuns } from '@/server/agent/history';
import { parseWith, preflight, query, route } from '@/server/http/handler';

/**
 * GET /api/v1/agent/history?limit&before&status — the user's agent history, newest first:
 * `{ items: [{ id, request, status, summary, operations: [{ ref, actionId, summary, status,
 * recordIds, message? }], notes, createdAt, updatedAt }], nextBefore }`.
 */
export const GET = route(async (ctx) => listAgentRuns(ctx.user, parseWith(agentHistoryQuerySchema, query(ctx.url))));

/** DELETE /api/v1/agent/history — clears the user's agent history (financial records are not touched). */
export const DELETE = route(async (ctx) => clearAgentRuns(ctx.user));

export const OPTIONS = preflight();
