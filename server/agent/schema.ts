// Request body of POST /api/v1/agent/completions: an OpenAI-compatible Chat
// Completions request (Groq) minus everything the server owns (model,
// reasoning_effort, user, service_tier, response_format, stream, ...). Strict
// top level: unknown keys are rejected so a client can never pick the model,
// stream, or add server-side tools.

import { z } from 'zod';

/** Byte cap for the request body (readJson). */
export const AGENT_MAX_BODY_BYTES = 600_000;

const toolName = z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/, 'Tool names are 1-64 letters, digits, "_" or "-".');
const callId = z.string().min(1).max(128);

const systemMessage = z.strictObject({
  role: z.literal('system'),
  content: z.string().min(1).max(20_000),
});

const userMessage = z.strictObject({
  role: z.literal('user'),
  content: z.string().max(8000),
});

const toolCall = z.strictObject({
  id: callId,
  type: z.literal('function'),
  function: z.strictObject({
    name: toolName,
    arguments: z.string().max(20_000),
  }),
});

const assistantMessage = z.strictObject({
  role: z.literal('assistant'),
  content: z.string().max(8000).nullable().optional(),
  tool_calls: z.array(toolCall).max(16).optional(),
});

const toolMessage = z.strictObject({
  role: z.literal('tool'),
  tool_call_id: callId,
  name: toolName.optional(),
  content: z.string().max(20_000),
});

const message = z.discriminatedUnion('role', [systemMessage, userMessage, assistantMessage, toolMessage]);

/** Only client-executed function tools; anything else is rejected. */
const functionTool = z.strictObject({
  type: z.literal('function'),
  function: z.strictObject({
    name: toolName,
    description: z.string().max(2000),
    parameters: z.record(z.string(), z.unknown()),
  }),
});

export function completionRequestSchema(maxOutputTokens: number) {
  return z
    .strictObject({
      messages: z.array(message).min(1).max(200),
      tools: z.array(functionTool).max(64).default([]),
      tool_choice: z.enum(['auto', 'none', 'required']).optional(),
      parallel_tool_calls: z.boolean().optional(),
      max_completion_tokens: z.number().int().min(1).max(maxOutputTokens).optional(),
    })
    .superRefine((req, ctx) => {
      req.messages.forEach((m, i) => {
        if (m.role === 'system' && i !== 0) {
          ctx.addIssue({
            code: 'custom',
            path: ['messages', i, 'role'],
            message: 'A system message is only allowed as the first message.',
          });
        }
      });
    });
}

export type CompletionRequest = z.infer<ReturnType<typeof completionRequestSchema>>;
