import { relayCompletion } from '@/server/agent/relay';
import { preflight, route } from '@/server/http/handler';

/**
 * POST /api/v1/agent/completions
 * LLM relay for the in-app agent: body is an OpenAI-compatible Chat Completions
 * request (forwarded to OpenAI) without model/reasoning_effort/user/stream
 * (server-owned). Returns `{ id, finish_reason, message, usage }`. The server
 * adds the key, never executes tools and never stores or logs prompt content.
 */
export const POST = route(relayCompletion);

export const OPTIONS = preflight();

/** Seconds; above the relay's default 60 s upstream timeout (OPENAI_TIMEOUT_MS) so it fires first. */
export const maxDuration = 75;
