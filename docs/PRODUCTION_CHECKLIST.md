# Production hardening checklist (research phase, 2026-11-06)

Best practices from official docs and standards, filtered to what applies to this codebase:
Next.js 16.4.5 App Router route handlers on Vercel (`sin1`), Kysely + `pg` over the Supabase pooler
(ap-southeast-1, PG17), FiNN's own HS256 JWT auth, and the OpenAI relay that serves the Flutter agent.
Items that do not apply (Edge runtime, server actions, cookie sessions, CSRF, page caching, vector search) are left out.

Status key:
- **Done**: already true in the code. Keep it and cover it with tests.
- **Verify**: probably true. Confirm with a measurement or a live check before relying on it.
- **Gap**: needs a fix. The fix keeps behaviour and the API contract unchanged.
- **Approval**: the fix changes behaviour, the contract, a dependency major version, cost, or the live database. Ask first.

## 1. Runtime, region and connections

| # | Practice | Status | FiNN notes |
|---|---|---|---|
| R1 | Use the Node.js runtime. Next 16 marks `runtime = 'edge'` as deprecated, and Vercel recommends moving from Edge to Node. | Done | No route sets `runtime`. Default is `nodejs`. |
| R2 | Run functions in the same region as the database. Every query costs one network round trip. | Done | `vercel.json` sets `sin1`. Supabase is ap-southeast-1 (Singapore). Do not move to `bom1`: it is nearer users but each query would cross to Singapore. |
| R3 | Use Fluid compute and attach the pool with `attachDatabasePool(pool)` from `@vercel/functions`. The instance then stays alive just long enough to close idle connections. | Gap | `server/db/client.ts` keeps a module-scope pool, which is correct, but does not attach it. Also confirm that Fluid is on in the Vercel project settings. Adding the dependency is additive. |
| R4 | Keep the client pool small, but larger than 1. Vercel says `max: 1` harms concurrency under Fluid. | Verify | `DATABASE_POOL_MAX` defaults to 5. The Supabase pooler's pool size is shared by session and transaction modes (e.g. 30 total on small compute). Instances × `max` must stay under it. Measure under load. |
| R5 | In transaction-mode pooling, use only transaction-scoped session state. | Done | `set_config(..., true)` is local to the transaction. Locks use `pg_advisory_xact_lock`. `pg` sends unnamed statements by default. |
| R6 | Bound every external call with a timeout. | Done | Statement 15 s, connect 5 s, OpenAI 60 s, moderation 10 s, SMTP 10/10/20 s, agent route `maxDuration = 75`. |
| R7 | Verify DB TLS against the CA in production (fail closed). | Verify | Without `DATABASE_CA_CERT` the pool falls back to `rejectUnauthorized: false` and only logs a warning. Confirm the variable is set in Vercel. That item is still open from the security audit. |
| R8 | Cold starts: Node 20+ functions get bytecode caching, and Fluid pre-warms production. Avoid heavy imports at module scope on hot routes. | Verify | Record cold-start and warm latency per endpoint in the baseline. |

## 2. Database performance

| # | Practice | Status | FiNN notes |
|---|---|---|---|
| D1 | Index the columns that RLS policies and queries filter on. Supabase reports 100×+ speedups on large tables. | Verify | `docs/ARCHITECTURE.md` lists `(user_id, date desc, created_at desc, id)` and similar indexes. Check them against `pg_stat_statements` and the Supabase performance advisors. |
| D2 | In RLS policies, wrap per-request functions such as `(select current_setting(...))` or `(select auth.uid())` in a subselect. Postgres then evaluates them once per statement instead of once per row. | Verify | Read the live policies on `finn_api` tables. A rewrite is a migration (Approval), but it does not change behaviour. |
| D3 | Filter by `user_id` in the query as well as in RLS, so the planner can use the index. | Done | Every repository query is scoped by `user_id`. |
| D4 | Use keyset pagination for long lists, and never load all transactions. | Done | Lists are keyset-paginated. Balances are SQL aggregates (`server/finance/ledger.ts`). |
| D5 | Count queries per request and remove N+1 patterns. | Verify | `FinanceSnapshot` loads lazily, once per request. Instrument the per-request query count and time. The fixed overhead is BEGIN + `set_config` + lock + COMMIT, about 4 round trips. |
| D6 | Build new indexes with `CREATE INDEX CONCURRENTLY`. Set a short `lock_timeout` (2–5 s) and turn off `statement_timeout` for that session. Check for long transactions first. After a failure, check `pg_index.indisvalid` and do not trust `IF NOT EXISTS`. `CONCURRENTLY` cannot run inside a transaction block. | Approval | Applies to every index migration. Each one needs your sign-off before it runs. |

## 3. HTTP layer

| # | Practice | Status | FiNN notes |
|---|---|---|---|
| H1 | Route handlers are not cached by default. Per-user financial data must never go into a shared cache. | Done | No `'use cache'` on user data. Do not add it: invalidation risk outweighs the gain. |
| H2 | Send `Cache-Control: private, no-store` on authenticated responses. | Verify | The code sets no `Cache-Control`. Check what Vercel and Next emit in production. Adding the header is additive, but mention it before changing it. |
| H3 | Compress responses. Vercel's CDN applies brotli or gzip to JSON when the client sends `Accept-Encoding`. | Verify | Dart's `HttpClient` sends `Accept-Encoding: gzip` by default. Confirm `Content-Encoding` on a production response. Do not set `compress: false`. |
| H4 | Keep non-essential work off the response path (`after()` in Next 16). | Approval | Audit rows stay inside the transaction on purpose, for atomicity. Moving `agent_runs` history writes to `after()` would change failure semantics. |

## 4. Security (OWASP API Security Top 10, 2023)

| # | Item | Status | FiNN notes |
|---|---|---|---|
| S1 | API1 BOLA: every object access checks ownership. | Done | Three layers: a `user_id` filter, RLS as `finn_api` with the caller's claims, and composite `(user_id, id)` foreign keys. Gap: add an automated cross-user test matrix over every route with an `[id]` or `[userId]` segment. |
| S2 | API2 broken authentication. Pin the algorithm, check `iss` and `aud`, use a high-entropy HS256 key (RFC 8725 §3.5, at least 256 bits), and rotate refresh tokens with reuse detection that revokes the token family (RFC 9700 §4.14). | Done / Verify | `jose` `jwtVerify` pins `HS256` and checks issuer and audience. Rotation with reuse detection exists. `AUTH_JWT_SECRET` only requires 32 characters: confirm the production value is random. |
| S3 | API3 BOPLA: return only the fields the client needs, and do not accept writes to protected fields. | Done | Zod codecs per action. Other users are visible only through `private.directory_entries`. Do not switch schemas to strict mode: that turns accepted requests into 422s. |
| S4 | API4 unrestricted resource consumption: rate limits, body limits, page bounds. | Gap / Approval | Body and page limits exist. Agent budgets are durable in Postgres. The auth OTP and agent request limiters are in-memory per instance, so under Fluid the effective limit grows with the instance count. Fix options: a Postgres-backed counter (no new service), or Vercel WAF rate-limit rules (Pro plan). You choose. |
| S5 | API5 BFLA: function-level permissions. | Done | Channel policy: agent and voice must confirm and may never delete; import may only create. |
| S6 | API6 sensitive business flows: OTP mail, account deletion, import. | Gap | Still open from the audit: SMTP quota exhaustion on the existing-account OTP path, and exhaustion of the new-account agent pool. |
| S7 | API8 security misconfiguration: headers, CORS, TLS. | Done / Verify | HSTS, `nosniff`, `DENY` and `no-referrer` are set. CORS uses exact origins, and the wildcard pattern escapes regex characters. The mobile app needs no CORS, so `CORS_ORIGINS` should be empty in production. See R7 for TLS. |
| S8 | API9 inventory: document every endpoint. | Done | `docs/API.md` and `docs/contract/fixtures.json`. |
| S9 | API10 unsafe consumption of upstream APIs: treat model output as untrusted. | Done | Output rail. Plans are re-validated by `/plans/preview` and `/plans/execute` under the caller's transaction. |
| S10 | Vulnerable dependencies. | Approval | `npm audit --omit=dev`: **high**, `nodemailer` ≤10.1.3 (16 advisories: SMTP/CRLF injection, address-parser DoS, SSRF via `raw`). The fix is 7.0.13 → ≥10.1.4, a major bump. Review the API changes and test the OTP mail path. |
| S11 | Secrets: server-only, never logged, rotated after exposure. | Gap (owner) | The OpenAI key and SMTP app password were pasted in chat earlier. Rotate them. Set OpenAI spend limits. |
| S12 | Safe errors and no sensitive logs. | Done | Error envelope without SQL or stacks. Logs exclude tokens, bodies, amounts and notes. Verify that no route leaks an unhandled rejection. |

## 5. Money and write safety

| # | Practice | Status | FiNN notes |
|---|---|---|---|
| M1 | Integer minor units, never floats. Name the rounding mode of every division. | Done | Paise in `bigint`. `parseInt8` throws above 2^53. Rounding modes live in `server/core/money.ts`. |
| M2 | Idempotency keys on every financial write (IETF draft-ietf-httpapi-idempotency-key-header-07): required header, reuse with a different payload rejected, published expiry policy. | Done | Required (8–128 characters). Stored in the same transaction. A conflict on a payload mismatch. Agent steps use `planId:stepId`. Expiry cleanup exists. Document the retention window in `API.md`. |
| M3 | Serialise concurrent writes to one user's balances. | Done | Per-user advisory lock. Shared items lock both users in sorted order. Gap: add a concurrency test, two parallel writes against one budget or goal. |
| M4 | Multi-record writes happen in one transaction. | Done | `dispatch()` wraps prepare, execute and audit in one transaction. |
| M5 | Audit log for sensitive actions. | Done | `audit_log` on every executed attempt. |

## 6. Agent pipeline

Current shape: Flutter builds the prompt and context on the device. `POST /agent/completions` runs auth, the input guardrail, moderation (in parallel, fail-open), the OpenAI call (non-streaming, `response_format: json_object`, `reasoning_effort: none`) and the output guardrail. Execution goes through `/plans/preview` and `/plans/execute`. Local intents answer some questions with no LLM call.

| # | Practice | Status | FiNN notes |
|---|---|---|---|
| A1 | Measure before changing anything: time per phase, prompt/cached/output tokens, time to first byte from upstream. | Gap | The relay logs total ms and token counts only. Add per-phase timings to the structured log: auth, guardrail, moderation, upstream connect/TTFB/total, output guardrail. Join them with the Flutter-side trace (`agent_trace.dart`) by request id. Log-only, so no contract change. |
| A2 | Output tokens dominate latency. OpenAI says cutting 50% of the prompt may gain only 1–5%. Reduce generated tokens first. | Verify | Measure output tokens per plan. A shorter plan JSON or a smaller `max_completion_tokens` only after the evals pass. |
| A3 | Prompt caching on exact prefixes: static content first, variable content last. Minimum 1,024 tokens. On GPT-5.6+ models, `prompt_cache_key` is required for reliable matching, and explicit mode caches only at breakpoints. | Gap | The relay sends explicit breakpoints but no `prompt_cache_key`. Add a stable key per prompt version. Track `cached_tokens` before and after. OpenAI states caching does not change output. |
| A4 | Streaming is the largest perceived-latency gain (OpenAI latency guide). | Approval | The current wire format is a whole JSON plan that Flutter parses at the end. Streaming needs a relay + Flutter protocol change, and probably a `reply`-first field order. Decide after A1 numbers. |
| A5 | Run independent calls in parallel, and do not let a side call gate the answer. | Verify | Moderation runs in parallel. Measure whether it ever finishes after the model call on short prompts. |
| A6 | Reuse connections to the provider. | Verify | Node's `fetch` (undici) keeps connections alive per instance. With Fluid, warm instances reuse them. |
| A7 | Prompt injection (OWASP LLM01) and excessive agency (LLM06): a system prompt is not a control. Enforce limits in code, require confirmation for consequential actions, log every action. | Done | Server scope policy plus input and output rails. Every agent action needs a preview fingerprint and user approval. Agent may never delete. Execution runs as the caller only, so the agent cannot reach another user's data. User-entered text (notes, names) reaches the model only as data. |
| A8 | Evals gate every optimisation: a fixed set, deterministic checks on ops and arguments (not only the reply text), repeated runs, and p50/p95 latency in the same report. | Gap | Existing benchmark: 24 cases (`finn/docs/agent-benchmarks`, `FINN_LIVE=1`). Extend it with balances, categories, budgets, trends, comparisons, empty months, refunds and splits, with ground truth from the database. |

## Measurement plan (before any fix)

1. Baseline per endpoint: p50/p95/p99 latency, error rate, query count and query time per request, cold vs warm. Use structured logs plus a load run against a staging deployment, not production data.
2. Agent: per-phase timings for the eval set, combined with Flutter tap-to-answer timings.
3. Re-measure after each themed commit group.

## Sources

- Vercel, [Efficiently manage database connection pools with Fluid compute](https://vercel.com/kb/guide/efficiently-manage-database-connection-pools-with-fluid-compute); [Connection pooling with functions](https://vercel.com/kb/guide/connection-pooling-with-functions); [Fluid compute](https://vercel.com/docs/functions/fluid-compute); [Edge runtime](https://vercel.com/docs/functions/edge-middleware/edge-runtime); [Compression](https://docs.vercel.com/docs/compression)
- Next.js 16 bundled docs: `node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/02-route-segment-config/`; [Route handlers](https://nextjs.org/docs/app/getting-started/route-handlers); [compress](https://nextjs.org/docs-wip/app/api-reference/config/next-config-js/compress)
- Supabase, [Accessing Postgres (pooler modes)](https://supabase.com/docs/guides/self-hosting/accessing-postgres); [RLS performance and best practices](https://supabase.com/docs/guides/troubleshooting/rls-performance-and-best-practices-Z5Jjwv)
- Postgres index migrations: [Shayon Mukherjee on IF NOT EXISTS with CONCURRENTLY](https://shayon.dev/post/2024/225/stop-relying-on-if-not-exists-for-concurrent-index-creation-in-postgresql); [Bytebase zero-downtime migrations](https://www.bytebase.com/blog/postgres-schema-migration-without-downtime/)
- OWASP API Security Top 10 2023 (summary: [Indusface](https://indusface.com/learning/owasp-api-top-10/)); OWASP Top 10 for LLM Applications 2025 (summary: [Gravitee](https://www.gravitee.io/blog/owasp-top-10-for-llm-applications-2025-a-practical-guide))
- IETF: [RFC 8725 JWT BCP](https://www.rfc-editor.org/rfc/rfc8725); [RFC 9700 OAuth 2.0 Security BCP](https://www.rfc-editor.org/info/rfc9700); [Idempotency-Key header draft-07](https://datatracker.ietf.org/doc/html/draft-ietf-httpapi-idempotency-key-header)
- OpenAI: [Latency optimization](https://developers.openai.com/api/docs/guides/latency-optimization); [Prompt caching](https://developers.openai.com/api/docs/guides/prompt-caching); [Prompt Caching 201](https://developers.openai.com/cookbook/examples/prompt_caching_201)
- Agent evals: [Arize LLM evaluation guide](https://arize.com/blog/llm-evaluation-guide/)
