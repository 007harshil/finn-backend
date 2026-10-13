// Agent LLM relay: forwards the Flutter agent's OpenAI-compatible Chat
// Completions request to OpenAI with the server-held key. The server never
// executes tools and never touches financial data here; the app runs the agent
// loop (lib/agent/) and calls the normal action/plan endpoints itself.
//
// Privacy: prompts, inputs and outputs are never logged. Logs carry only the
// request id, a hashed user id, upstream status, latency and token counts.
// The API key and raw upstream bodies never reach the client.

import { createHash } from 'node:crypto';
import { AppFailure } from '../core/failure';
import { agentEnv, type AgentEnv } from '../env';
import { parseWith, readJson, type RequestContext } from '../http/handler';
import { logger } from '../http/logger';
import { modelCooldownSeconds, noteModelRateLimited, takeAgentRequest } from './rate-limit';
import { AGENT_MAX_BODY_BYTES, completionRequestSchema, type CompletionRequest } from './schema';

export interface CompletionToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export interface CompletionResult {
  id: string | null;
  finish_reason: string | null;
  message: { content: string | null; tool_calls: CompletionToolCall[] };
  usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number } | null;
}

const UNAVAILABLE = 'The assistant is unavailable right now. Please try again.';
const MALFORMED = 'The assistant returned an unexpected response. Please try again.';

/** Cooldown for a rate-limited model when the provider sends no `retry-after`. */
const DEFAULT_MODEL_COOLDOWN_SECONDS = 5;

function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/** Stable, non-reversible per-user id for provider abuse monitoring (`safety_identifier`). */
export function safetyIdentifier(userId: string): string {
  return sha256Hex(userId).slice(0, 32);
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

function retryAfterSeconds(header: string | null, now = Date.now()): number | undefined {
  if (!header) return undefined;
  const trimmed = header.trim();
  let seconds: number;
  if (/^\d+(\.\d+)?$/.test(trimmed)) seconds = Math.ceil(Number(trimmed));
  else {
    const at = Date.parse(trimmed);
    if (Number.isNaN(at)) return undefined;
    seconds = Math.ceil((at - now) / 1000);
  }
  return Math.min(3600, Math.max(1, seconds));
}

/** The primary model, then each distinct fallback, in order. */
export function upstreamModels(config: AgentEnv): string[] {
  return [...new Set([config.OPENAI_MODEL, ...config.OPENAI_FALLBACK_MODELS])];
}

export function buildUpstreamBody(
  req: CompletionRequest,
  config: AgentEnv,
  userId: string,
  model: string = config.OPENAI_MODEL,
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model,
    messages: req.messages,
    max_completion_tokens: Math.min(req.max_completion_tokens ?? config.AGENT_MAX_OUTPUT_TOKENS, config.AGENT_MAX_OUTPUT_TOKENS),
    safety_identifier: safetyIdentifier(userId),
  };
  if (config.OPENAI_REASONING_EFFORT !== 'off') body.reasoning_effort = config.OPENAI_REASONING_EFFORT;
  if (req.tools.length > 0) {
    body.tools = req.tools;
    if (req.tool_choice !== undefined) body.tool_choice = req.tool_choice;
    if (req.parallel_tool_calls !== undefined) body.parallel_tool_calls = req.parallel_tool_calls;
  }
  return body;
}

/** True when a 400 body reports a failed tool call generation (OpenAI-compatible providers such as Groq). */
function isToolUseFailure(text: string): boolean {
  try {
    const parsed: unknown = JSON.parse(text);
    const error = isRecord(parsed) && isRecord(parsed.error) ? parsed.error : null;
    return !!error && (error.code === 'tool_use_failed' || 'failed_generation' in error);
  } catch {
    return false;
  }
}

/** Trims `choices[0]` to the app contract; null when the payload is not usable. */
function toResult(payload: unknown): CompletionResult | null {
  if (!isRecord(payload) || !Array.isArray(payload.choices)) return null;
  const choice: unknown = payload.choices[0];
  if (!isRecord(choice) || !isRecord(choice.message)) return null;
  const msg = choice.message;

  const toolCalls: CompletionToolCall[] = [];
  if (msg.tool_calls !== undefined && msg.tool_calls !== null) {
    if (!Array.isArray(msg.tool_calls)) return null;
    for (const call of msg.tool_calls) {
      if (!isRecord(call) || typeof call.id !== 'string' || !isRecord(call.function)) return null;
      const { name, arguments: args } = call.function;
      if (typeof name !== 'string') return null;
      toolCalls.push({ id: call.id, type: 'function', function: { name, arguments: typeof args === 'string' ? args : '' } });
    }
  }

  const usage = isRecord(payload.usage)
    ? {
        prompt_tokens: num(payload.usage.prompt_tokens) ?? 0,
        completion_tokens: num(payload.usage.completion_tokens) ?? 0,
        total_tokens: num(payload.usage.total_tokens) ?? 0,
      }
    : null;

  return {
    id: typeof payload.id === 'string' ? payload.id : null,
    finish_reason: typeof choice.finish_reason === 'string' ? choice.finish_reason : null,
    message: { content: typeof msg.content === 'string' ? msg.content : null, tool_calls: toolCalls },
    usage,
  };
}

function usageCounts(payload: unknown): Record<string, number | undefined> {
  const usage = isRecord(payload) && isRecord(payload.usage) ? payload.usage : null;
  const details = usage && isRecord(usage.completion_tokens_details) ? usage.completion_tokens_details : null;
  // Field names avoid "token"/"key": the logger redacts those.
  return {
    usageIn: num(usage?.prompt_tokens),
    usageOut: num(usage?.completion_tokens),
    usageReasoning: num(details?.reasoning_tokens),
    usageTotal: num(usage?.total_tokens),
  };
}

/** Handles POST /api/v1/agent/completions for an authenticated user. */
export async function relayCompletion(ctx: RequestContext): Promise<CompletionResult> {
  const config = agentEnv();
  if (!config.OPENAI_API_KEY) {
    throw new AppFailure('unavailable', 'The assistant is not configured on this server.', {
      retryable: false,
      details: { reason: 'notConfigured' },
    });
  }

  const req = parseWith(completionRequestSchema(config.AGENT_MAX_OUTPUT_TOKENS), await readJson(ctx.request, AGENT_MAX_BODY_BYTES));

  const decision = takeAgentRequest(ctx.user.userId, {
    perMinute: config.AGENT_RATE_LIMIT_PER_MINUTE,
    perDay: config.AGENT_DAILY_REQUEST_LIMIT,
  });
  if (!decision.allowed) {
    throw new AppFailure('unavailable', "You're sending requests too quickly. Please wait a moment.", {
      retryable: true,
      details: { reason: 'rateLimited', retryAfterSeconds: decision.retryAfterSeconds },
    });
  }

  const user = sha256Hex(ctx.user.userId).slice(0, 12);
  const started = Date.now();
  const timeout = AbortSignal.timeout(config.OPENAI_TIMEOUT_MS);
  // Also stop paying for the call if the app disconnects.
  const signal = ctx.request.signal ? AbortSignal.any([timeout, ctx.request.signal]) : timeout;

  // Rate limits are metered per model, so a rate-limited model is skipped for
  // the next fallback (if any) instead of making the user wait. Models known
  // to be cooling down are not called at all.
  let res: Response | undefined;
  let model = config.OPENAI_MODEL;
  let soonest: number | undefined;
  const noteWait = (seconds: number) => {
    soonest = soonest === undefined ? seconds : Math.min(soonest, seconds);
  };
  for (const candidate of upstreamModels(config)) {
    const cooling = modelCooldownSeconds(candidate);
    if (cooling > 0) {
      noteWait(cooling);
      continue;
    }
    let attempt: Response;
    try {
      attempt = await fetch(`${config.OPENAI_BASE_URL}/chat/completions`, {
        method: 'POST',
        headers: { authorization: `Bearer ${config.OPENAI_API_KEY}`, 'content-type': 'application/json' },
        body: JSON.stringify(buildUpstreamBody(req, config, ctx.user.userId, candidate)),
        signal,
      });
    } catch (err) {
      const reason = err instanceof Error && err.name === 'TimeoutError' ? 'timeout' : 'network';
      logger.warn('agent.upstream', { requestId: ctx.requestId, user, model: candidate, outcome: reason, ms: Date.now() - started });
      throw new AppFailure('unavailable', UNAVAILABLE, { retryable: true, details: { reason } });
    }
    if (attempt.status === 429 || attempt.status === 498) {
      await attempt.body?.cancel().catch(() => undefined);
      const retry = retryAfterSeconds(attempt.headers.get('retry-after'));
      noteModelRateLimited(candidate, retry ?? DEFAULT_MODEL_COOLDOWN_SECONDS);
      if (retry !== undefined) noteWait(retry);
      logger.warn('agent.upstream', {
        requestId: ctx.requestId,
        user,
        model: candidate,
        upstreamStatus: attempt.status,
        ms: Date.now() - started,
      });
      continue;
    }
    res = attempt;
    model = candidate;
    break;
  }
  if (!res) {
    throw new AppFailure('unavailable', UNAVAILABLE, {
      retryable: true,
      details: { reason: 'providerRateLimited', ...(soonest !== undefined ? { retryAfterSeconds: soonest } : {}) },
    });
  }

  const ms = Date.now() - started;
  const upstreamStatus = res.status;

  if (!res.ok) {
    // Only a 400 body is inspected (for tool_use_failed); it is never logged or returned.
    const errorText = upstreamStatus === 400 ? await res.text().catch(() => '') : '';
    if (upstreamStatus !== 400) await res.body?.cancel().catch(() => undefined);

    if (upstreamStatus === 400 && isToolUseFailure(errorText)) {
      logger.warn('agent.upstream', { requestId: ctx.requestId, user, upstreamStatus, ms, outcome: 'toolCallFailed' });
      throw new AppFailure('unknown', 'The assistant made a malformed request. Please try again.', {
        retryable: true,
        details: { reason: 'toolCallFailed' },
      });
    }
    if (upstreamStatus === 401 || upstreamStatus === 403) {
      logger.error('agent.upstream.auth', { requestId: ctx.requestId, user, upstreamStatus, ms });
      throw new AppFailure('unavailable', 'The assistant is not configured correctly on this server.', {
        retryable: false,
        details: { reason: 'notConfigured' },
      });
    }
    if (upstreamStatus === 413) {
      logger.warn('agent.upstream', { requestId: ctx.requestId, user, upstreamStatus, ms });
      throw new AppFailure('validation', 'This conversation is too long. Start a new chat.', { details: { reason: 'tooLarge' } });
    }
    if (upstreamStatus >= 500) {
      logger.warn('agent.upstream', { requestId: ctx.requestId, user, upstreamStatus, ms });
      throw new AppFailure('unavailable', UNAVAILABLE, { retryable: true });
    }
    logger.warn('agent.upstream', { requestId: ctx.requestId, user, upstreamStatus, ms });
    throw new AppFailure('unknown', 'The assistant could not process this request.', { details: { upstreamStatus } });
  }

  let payload: unknown;
  try {
    payload = JSON.parse(await res.text());
  } catch {
    payload = null;
  }
  const result = toResult(payload);
  if (!result) {
    logger.warn('agent.upstream', { requestId: ctx.requestId, user, upstreamStatus, ms, outcome: 'malformed' });
    throw new AppFailure('unknown', MALFORMED, { retryable: true });
  }

  logger.info('agent.upstream', { requestId: ctx.requestId, user, model, upstreamStatus, ms, ...usageCounts(payload) });
  return result;
}
