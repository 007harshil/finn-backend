# FiNN API

Backend for the FiNN personal finance app (Flutter frontend in `../finn`). Next.js 16 route handlers + TypeScript,
PostgreSQL on the existing Supabase project (`FiNN`, ref `xeqhygypqyyyoortalod`), Supabase Auth (email OTP).

FiNN is a manual record-keeping app: every write records something the user did. The API never moves money, never
talks to banks, UPI or payment providers.

## Documentation

| Document | What it covers |
|---|---|
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Layers, request flow, action framework, security model, sync, performance |
| [docs/DATABASE.md](docs/DATABASE.md) | Schema, ownership rules, constraints, RLS, migrations |
| [docs/API.md](docs/API.md) | Every endpoint with examples, errors, auth, pagination |
| [docs/CLIENT_CONTRACT.md](docs/CLIENT_CONTRACT.md) | Short contract the Flutter client implements (auth, envelope, sync, actions, import) |
| [docs/AGENT_READINESS.md](docs/AGENT_READINESS.md) | How a future conversational/voice agent plugs into actions and plans |
| `../finn/docs/FINANCIAL_MODEL.md` | The financial rules (ledger, rounding, budgets, loans, …) the server implements |

## Requirements

- Node.js 22+ (tested on 24), npm.
- Access to the Supabase project (database password for the pooler connection string).

## Setup

```sh
npm install
cp .env.example .env.local   # fill DATABASE_URL and one token-verification option
npm run dev                  # http://localhost:3000/api/v1/health
```

Environment variables (server-only; see `.env.example`):

| Variable | Required | Purpose |
|---|---|---|
| `DATABASE_URL` | yes | Supavisor **transaction** pooler URL (port 6543) |
| `SUPABASE_URL` | yes | `https://xeqhygypqyyyoortalod.supabase.co` |
| `SUPABASE_JWT_SECRET` | one of | Verify the project's HS256 access tokens locally |
| `SUPABASE_PUBLISHABLE_KEY` | one of | Otherwise ask Supabase Auth to verify tokens (cached 60 s) |
| `DATABASE_CA_CERT` | recommended | Supabase root CA (PEM) for verified TLS |
| `DATABASE_POOL_MAX` | no | Pool size per instance (default 5) |
| `CORS_ORIGINS` | no | Allowed browser origins (Flutter web only) |

If the project switches to asymmetric JWT signing keys, tokens are verified through JWKS and neither secret is needed.

Supabase Auth must have the **Email** provider enabled with OTP codes (Dashboard → Authentication → Email templates:
the magic-link template must include `{{ .Token }}` so users receive the 6-digit code the app asks for).

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
  actions/                 action framework: types, input codecs, dispatcher, policy, registry, plans
  finance/                 domain records (= Flutter DTOs), snapshot loader, ledger aggregates
  modules/<feature>/       calculator.ts (pure rules), actions.ts, service.ts (reads), repo.ts
supabase/migrations/       versioned SQL
tests/                     vitest suites + support (PGlite, HTTP client, action helper)
```
