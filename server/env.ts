// Server configuration, validated once. Never import this from client code:
// DATABASE_URL carries a database password.

import { z } from 'zod';

const schema = z.object({
  /** Supavisor pooler URL (transaction mode, port 6543) of the FiNN project. */
  DATABASE_URL: z.string().url(),
  /** https://<ref>.supabase.co — used to verify user access tokens (JWKS). */
  SUPABASE_URL: z.string().url(),
  /** Optional legacy HS256 JWT secret: verifies tokens locally (fastest) when the project still signs with it. */
  SUPABASE_JWT_SECRET: z.string().min(32).optional(),
  /** Publishable (anon) key: used to ask Supabase Auth to verify HS256 tokens when no JWT secret is set. */
  SUPABASE_PUBLISHABLE_KEY: z.string().min(20).optional(),
  /** Max pooled connections per server instance. */
  DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(50).default(5),
  /** Comma-separated origins allowed by CORS (Flutter web builds). Empty = no CORS. */
  CORS_ORIGINS: z.string().default(''),
});

export type Env = z.infer<typeof schema>;

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
