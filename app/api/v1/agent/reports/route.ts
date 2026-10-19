import { agentReportSchema, fileAgentReport } from '@/server/agent/reports';
import { parseWith, preflight, readJson, route } from '@/server/http/handler';

/**
 * POST /api/v1/agent/reports { reason: offensive|harmful|inaccurate|other, reply, request?, note? }
 * -> { id }. Flags an assistant reply for the developer to review.
 */
export const POST = route(async (ctx) => fileAgentReport(ctx.user, parseWith(agentReportSchema, await readJson(ctx.request, 64_000))));

export const OPTIONS = preflight();
