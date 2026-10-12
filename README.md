# FiNN API

Backend for the FiNN personal finance app (Flutter frontend in `../finn`). Next.js 16 route handlers + TypeScript,
PostgreSQL on the existing Supabase project (`FiNN`, ref `xeqhygypqyyyoortalod`), FiNN's own email-OTP auth (nodemailer).

FiNN is a manual record-keeping app: every write records something the user did. The API never moves money, never
talks to banks, UPI or payment providers.

## Documentation

| Document | What it covers |
|---|---|
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Layers, request flow, action framework, security model, sync, performance |
| [docs/DATABASE.md](docs/DATABASE.md) | Schema, ownership rules, constraints, RLS, migrations |
| [docs/API.md](docs/API.md) | Every endpoint with examples, errors, auth, pagination |
| [docs/CLIENT_CONTRACT.md](docs/CLIENT_CONTRACT.md) | Short contract the Flutter client implements (auth, envelope, sync, actions, import) |
| [docs/AGENT_READINESS.md](docs/AGENT_READINESS.md) | How the in-app agent uses the LLM relay, actions and plans |
| `../finn/docs/FINANCIAL_MODEL.md` | The financial rules (ledger, rounding, budgets, loans, …) the server implements |

## Requirements

- Node.js 22+ (tested on 24), npm.
- Access to the Supabase project (database password for the pooler connection string).

## Setup

```sh
npm install
cp .env.example .env.local   # fill DATABASE_URL, AUTH_JWT_SECRET and SMTP_PASS
npm run dev                  # http://localhost:3000/api/v1/health
```

Environment variables (server-only; see `.env.example`):

| Variable | Required | Purpose |
|---|---|---|
| `DATABASE_URL` | yes | Supavisor **transaction** pooler URL (port 6543) |
| `AUTH_JWT_SECRET` | yes | ≥32-char random secret: signs access tokens, keys code/refresh-token hashes |
| `AUTH_ACCESS_TTL_SECONDS` | no | Access token lifetime (default 900) |
| `AUTH_REFRESH_TTL_DAYS` | no | Refresh token lifetime (default 30) |
| `AUTH_OTP_TTL_SECONDS` | no | Sign-in code lifetime (default 600) |
| `SMTP_USER` / `SMTP_PASS` | yes (for sign-in) | SMTP login; for Gmail the address and a 16-char App Password |
| `SMTP_HOST` / `SMTP_PORT` / `SMTP_SECURE` | no | Default `smtp.gmail.com` / 465 / true for 465 |
| `MAIL_FROM` | no | From header (default `FiNN <SMTP_USER>`) |
| `DATABASE_CA_CERT` | recommended | Supabase root CA (PEM) for verified TLS |
| `DATABASE_POOL_MAX` | no | Pool size per instance (default 5) |
| `CORS_ORIGINS` | no | Allowed browser origins (Flutter web only) |
| `GROQ_API_KEY` | for the agent | Groq key for `POST /agent/completions`; unset = assistant disabled (503), rest of the API unaffected |
| `GROQ_BASE_URL` | no | Default `https://api.groq.com/openai/v1` |
| `GROQ_MODEL` | no | Model used by the relay (default `openai/gpt-oss-20b`) |
| `GROQ_REASONING_EFFORT` | no | `off`/`none`/`default`/`low`/`medium`/`high` (default `low`; `off` = not sent) |
| `GROQ_TIMEOUT_MS` | no | Provider timeout (default 60000, 100-300000) |
| `AGENT_MAX_OUTPUT_TOKENS` | no | Default and ceiling for `max_completion_tokens` (default 2048) |
| `AGENT_RATE_LIMIT_PER_MINUTE` | no | Relay requests per user per minute (default 20; in-memory, per instance) |
| `AGENT_DAILY_REQUEST_LIMIT` | no | Relay requests per user per 24 h (default 300; in-memory, per instance) |
| `GROQ_STT_MODEL` | no | Whisper model for `POST /agent/transcriptions` (default `whisper-large-v3`) |
| `GROQ_STT_LANGUAGE` | no | Default ISO-639-1 language (e.g. `en`, `hi`); unset = Whisper auto-detects |
| `GROQ_STT_PROMPT` | no | Vocabulary hint for finance terms (default: FiNN/rupee/UPI/EMI/... list) |
| `GROQ_STT_TIMEOUT_MS` | no | Transcription provider timeout (default 30000, 100-300000) |
| `AGENT_STT_RATE_LIMIT_PER_MINUTE` | no | Transcription requests per user per minute (default 10; in-memory, per instance) |
| `AGENT_STT_DAILY_LIMIT` | no | Transcription requests per user per 24 h (default 200; in-memory, per instance) |

Voice input: `POST /api/v1/agent/transcriptions` (authenticated) takes `{ "audio": "<base64, max 10 MB decoded>", "mimeType": "audio/mp4|m4a|aac|webm|ogg|wav|mpeg|flac", "language"?: "<2-letter ISO-639-1>" }`, forwards it to Groq Whisper with the server-held `GROQ_API_KEY`, and returns `{ "text", "language", "durationSeconds" }`. `text` is `""` when no speech is detected. Audio and transcripts are never logged or stored. Rate limited separately from completions.

Sign-in is FiNN's own email OTP (Supabase Auth is not used): `POST /api/v1/auth/otp` emails a 6-digit
code through nodemailer, `POST /api/v1/auth/verify` returns an access token (HS256 JWT) and a rotating
refresh token. Accounts live in the private `finn_auth` schema. See docs/API.md §1.2.

## Database migrations

SQL migrations live in `supabase/migrations/`:

- `20261011182123_finn_core_schema.sql` — tables, constraints, indexes, triggers, RLS, directory functions
- `20261011182153_finn_fk_indexes.sql` — covering indexes for composite foreign keys
- `20261012090000_finn_api_role.sql` — **not yet applied** (the connector declined it): `finn_api` role, Data API
  roles lose table access, policies moved to `finn_api`, guard triggers. The API requires it. Apply with
  `supabase db push` or the SQL editor.

To set up another environment: `supabase link --project-ref <ref>` then `supabase db push`, or run the files in order.

## Scripts

```sh
npm test            # vitest: unit + integration tests on an in-process Postgres (PGlite) with the real migrations
npm run typecheck   # tsc --noEmit
npm run lint        # eslint
npm run build       # next build
```

Integration tests need no external services: `tests/support/db.ts` boots PGlite, adds a minimal stand-in for
Supabase's `auth` schema and roles, applies `supabase/migrations/*.sql`, and runs route handlers in-process, so RLS,
triggers and constraints are exercised for real.

## Deployment

- Any Node.js host that runs `next build && next start` (Vercel, Fly, Render, a container). The API is stateless:
  sessions are bearer tokens, idempotency keys and audit entries live in Postgres, so instances can scale horizontally.
- Keep `DATABASE_POOL_MAX` small per instance (5–10); Supavisor multiplexes connections. Serverless hosts should use
  the transaction pooler URL (as in `.env.example`).
- Region: put the API close to `ap-southeast-1` (the database region).
- No background workers, queues, caches or schedulers are used. Alerts are computed on request; push notifications
  and scheduled jobs are not implemented (see docs/ARCHITECTURE.md, "Not implemented").

## Project layout

```
app/api/v1/**/route.ts     thin HTTP handlers (parse → service → envelope)
server/
  core/                    money (paise, rounding), dates, frequency, failures, fingerprints, ids
  db/                      Kysely client, table types, per-user transactions (RLS role + locks)
  auth/                    Supabase token verification
  http/                    route wrapper, error mapping, logger
  agent/                   LLM relay and speech-to-text relay for the in-app agent (schemas, Groq forwarding, rate limits)
  actions/                 action framework: types, input codecs, dispatcher, policy, registry, plans
  finance/                 domain records (= Flutter DTOs), snapshot loader, ledger aggregates
  modules/<feature>/       calculator.ts (pure rules), actions.ts, service.ts (reads), repo.ts
supabase/migrations/       versioned SQL
tests/                     vitest suites + support (PGlite, HTTP client, action helper)
```
