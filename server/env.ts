// Server configuration, validated once. Never import this from client code:
// DATABASE_URL carries a database password.

import { z } from 'zod';

const schema = z.object({
  /** Supavisor pooler URL (transaction mode, port 6543) of the FiNN project. */
  DATABASE_URL: z.string().url(),
  /** Max pooled connections per server instance. */
  DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(50).default(5),
  /** Comma-separated origins allowed by CORS (Flutter web builds). Empty = no CORS. */
  CORS_ORIGINS: z.string().default(''),
});

export type Env = z.infer<typeof schema>;

/**
 * Agent LLM relay (POST /api/v1/agent/completions). Validated separately from
 * the core schema so a missing or bad agent setting never stops the rest of
 * the API from booting: only the relay route reports it.
 */
const agentSchema = z.object({
  /** Groq API key. Unset or empty = the relay answers `unavailable` (not configured). */
  GROQ_API_KEY: z
    .string()
    .trim()
    .optional()
    .transform((v) => (v ? v : undefined)),
  /** Groq OpenAI-compatible base URL (no trailing slash needed). */
  GROQ_BASE_URL: z
    .string()
    .url()
    .default('https://api.groq.com/openai/v1')
    .transform((v) => v.replace(/\/+$/, '')),
  /** Model id the server always uses; clients cannot choose it. */
  GROQ_MODEL: z.string().trim().min(1).max(100).default('openai/gpt-oss-20b'),
  /** `reasoning_effort` sent upstream; `off` = the parameter is not sent at all. */
  GROQ_REASONING_EFFORT: z.enum(['off', 'none', 'default', 'low', 'medium', 'high']).default('low'),
  /** Upstream request timeout in milliseconds. */
  GROQ_TIMEOUT_MS: z.coerce.number().int().min(100).max(300_000).default(60_000),
  /** Ceiling (and default) for `max_completion_tokens`. */
  AGENT_MAX_OUTPUT_TOKENS: z.coerce.number().int().min(1).max(100_000).default(2048),
  /** Relay requests per user per rolling minute (per server instance). */
  AGENT_RATE_LIMIT_PER_MINUTE: z.coerce.number().int().min(1).max(10_000).default(20),
  /** Relay requests per user per rolling 24 hours (per server instance). */
  AGENT_DAILY_REQUEST_LIMIT: z.coerce.number().int().min(1).max(1_000_000).default(300),
});

export type AgentEnv = z.infer<typeof agentSchema>;

/**
 * Agent relay settings. Parsed on every call (a handful of fields, cheap), so
 * there is no cache to reset when tests change process.env.
 */
export function agentEnv(): AgentEnv {
  const parsed = agentSchema.safeParse(process.env);
  if (!parsed.success) {
    const names = parsed.error.issues.map((i) => i.path.join('.')).join(', ');
    // Names only: values may be secrets.
    throw new Error(`Invalid agent configuration: ${names}`);
  }
  return parsed.data;
}

/**
 * Authentication (FiNN email-OTP sign-in and session tokens). Parsed on every
 * call, like the agent settings, so tests can change process.env.
 */
const authSchema = z.object({
  /** HS256 key for FiNN access tokens; also keys the HMACs of one-time codes and refresh tokens. */
  AUTH_JWT_SECRET: z.string().min(32),
  /** Access token lifetime in seconds. */
  AUTH_ACCESS_TTL_SECONDS: z.coerce.number().int().min(60).max(86_400).default(900),
  /** Refresh token lifetime in days (each refresh rotates the token and restarts it). */
  AUTH_REFRESH_TTL_DAYS: z.coerce.number().int().min(1).max(365).default(30),
  /** One-time code lifetime in seconds. */
  AUTH_OTP_TTL_SECONDS: z.coerce.number().int().min(60).max(3_600).default(600),
});

export type AuthEnv = z.infer<typeof authSchema>;

export function authEnv(): AuthEnv {
  const parsed = authSchema.safeParse(process.env);
  if (!parsed.success) {
    const names = parsed.error.issues.map((i) => i.path.join('.')).join(', ');
    // Names only: values may be secrets.
    throw new Error(`Invalid auth configuration: ${names}`);
  }
  return parsed.data;
}

/**
 * Outgoing email (nodemailer over SMTP; Gmail by default). Validated
 * separately so missing mail settings only fail the routes that send mail.
 */
const mailSchema = z.object({
  SMTP_HOST: z.string().trim().min(1).default('smtp.gmail.com'),
  SMTP_PORT: z.coerce.number().int().min(1).max(65_535).default(465),
  /** true = implicit TLS (port 465); false = STARTTLS (port 587). Defaults from the port. */
  SMTP_SECURE: z
    .enum(['true', 'false'])
    .optional()
    .transform((v) => (v === undefined ? undefined : v === 'true')),
  /** SMTP login, e.g. the Gmail address. */
  SMTP_USER: z.string().trim().min(3),
  /** SMTP password; for Gmail a 16-character App Password (spaces are ignored). */
  SMTP_PASS: z
    .string()
    .transform((v) => v.replace(/\s+/g, ''))
    .pipe(z.string().min(1)),
  /** From header, e.g. `FiNN <finn.team007@gmail.com>`. Defaults to SMTP_USER. */
  MAIL_FROM: z.string().trim().optional(),
});

export type MailEnv = Omit<z.infer<typeof mailSchema>, 'SMTP_SECURE' | 'MAIL_FROM'> & { SMTP_SECURE: boolean; MAIL_FROM: string };

export function mailEnv(): MailEnv {
  const parsed = mailSchema.safeParse(process.env);
  if (!parsed.success) {
    const names = parsed.error.issues.map((i) => i.path.join('.')).join(', ');
    // Names only: values may be secrets.
    throw new Error(`Invalid mail configuration: ${names}`);
  }
  const m = parsed.data;
  return {
    ...m,
    SMTP_SECURE: m.SMTP_SECURE ?? m.SMTP_PORT === 465,
    MAIL_FROM: m.MAIL_FROM || `FiNN <${m.SMTP_USER}>`,
  };
}

let cached: Env | null = null;

export function env(): Env {
  if (cached) return cached;
  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    const names = parsed.error.issues.map((i) => i.path.join('.')).join(', ');
    // Names only: values may be secrets.
    throw new Error(`Invalid server configuration: ${names}`);
  }
  cached = parsed.data;
  return cached;
}
