# Production hardening report (2026-11-06)

Branches: `finn-backend` `hardening/perf-security` (7 commits on top of `security/next-16.4.5`), `finn` `hardening/perf-security` (1 commit). Nothing is deployed and no live migration has been run. The research checklist is in `docs/PRODUCTION_CHECKLIST.md`. Raw numbers are in `docs/perf/` and `finn/docs/agent-benchmarks/`.

## Architecture and endpoints

The backend runs Next.js 16.4.5 with App Router route handlers only. There are no server actions, no middleware and no Edge routes. It is deployed on Vercel in `sin1`, next to the Supabase Postgres 17 database in ap-southeast-1.

Every handler goes through `server/http/handler.ts`, which does four things:
- verifies FiNN's own HS256 access token;
- bootstraps the account on the user's first request;
- maps errors to the JSON envelope;
- sends `Cache-Control: no-store` and logs one line per request.

Data access uses Kysely over a small `pg` pool connected to the Supabase transaction pooler. Each user operation runs in one transaction under the `finn_api` role, carrying the caller's claims, so row-level security applies on top of explicit `user_id` filters and composite foreign keys.

All financial writes go through the action dispatcher, which handles policy, the per-user advisory lock, idempotency keys, fresh validation, confirmation fingerprints, audit rows and the `changes` sync payload in one transaction. Money is stored as integer paise.

There are no background jobs, queues or caches. Mail is sent with nodemailer over Gmail SMTP.

The agent's prompt and context are built in the Flutter app. The backend relays a single model call to OpenAI `gpt-6-luna`: a non-streaming Chat Completions request with `response_format: json_object` and `reasoning_effort: none`. Around that call the relay applies the input and output guardrails, moderation in parallel, and the per-user and global budgets. The model returns a JSON plan. The app answers data questions from its own synced data. Changes run through `/plans/preview` and `/plans/execute` after the user approves.

Endpoints the mobile app uses, all under `/api/v1`:
- **Auth:** `auth/otp`, `auth/verify`, `auth/refresh`, `auth/logout`.
- **Account:** `me`, `me/handle`, `me/delete/code`, `me/delete`, `preferences`.
- **Writes:** `actions`, `actions/{id}`, `actions/{id}/preview`, `plans/preview`, `plans/execute`, `import`.
- **Sync and reads:** `sync`, `dashboard`, `transactions`, `transactions/{id}`, `timeline`, `analytics`, `budgets`, `budgets/{id}`, `goals`, `goals/{id}`, `loans`, `loans/{id}`, `loans/{id}/payment-preview`, `loans/quote`, `subscriptions`, `subscriptions/{id}`, `subscriptions/upcoming`, `upcoming`, `pending`, `pending/{id}`, `pending/resolve`, `categories`, `assets`, `net-worth`, `emergency-fund`, `alerts`, `alerts/inbox`, `audit`, `export`.
- **Agent:** `agent/completions`, `agent/history`, `agent/reports`.
- **Social:** `friends`, `friends/{userId}`, `friends/requests` (plus `/{id}`, `/{id}/accept`, `/{id}/reject`), `friends/blocks`, `friends/blocks/{userId}`, `users/search`, `users/lookup`.
- **Other:** `health`.

Full shapes are in `docs/API.md`.

## What was measured, and how

You chose local-only measurement, so no load was sent to production. A new harness, `tests/perf/endpoints.test.ts` (run with `FINN_PERF=1`), seeds a user with 3,000 transactions over a year and calls the real route handlers in-process against PGlite. For each endpoint it records the number of SQL statements and the p50/p95 latency.

PGlite has no network. In production every statement also costs one round trip from Vercel `sin1` to the Supabase pooler, so the statement count is the figure that carries over. I ran the old and new code three times each, interleaved, on an idle machine.

| Endpoint | Statements before → after | p50 ms (median of 3) | p95 ms |
|---|---|---|---|
| GET /dashboard | 29 → 29 | 15.5 → 15.3 | 17.3 → 18.0 |
| GET /transactions | 2 → 2 | 2.5 → 2.5 | 3.9 → 3.3 |
| GET /timeline | 16 → 16 | 17.7 → 18.9 | 35.8 → 34.6 |
| GET /budgets | 6 → 6 | 4.0 → 4.3 | 10.9 → 7.1 |
| GET /analytics (month) | 27 → 27 | 22.1 → 20.0 | 39.0 → 30.4 |
| GET /net-worth | 10 → 10 | 6.0 → 6.0 | 15.2 → 15.8 |
| GET /sync | 20 → 20 | 42.6 → 45.3 | 73.3 → 72.8 |
| POST transactions.create | 41 → 40 | 23.9 → 22.2 | 46.2 → 40.6 |
| POST /plans/preview | 7 → 7 | 5.8 → 5.1 | 12.4 → 11.5 |

In-process times did not change beyond run-to-run noise. The real gain is one round trip per write: claims, role and the advisory lock now go in one statement.

The main finding is the statement count on writes. Adding one expense sends 40 statements, 19 of them to build the `changes` payload, and it runs the account-balance aggregate three times, twice before the insert. At about 1–3 ms per round trip in-region, that is roughly 40–120 ms of database time per write in production. Cutting it would mean restructuring the dispatcher's read and response path. I did not do that, because it rewrites working core code; see the decisions below.

Cold starts and production p50/p95 need Vercel's own metrics. The relay now logs enough to read them per phase (see the agent section).

## Agent latency: where the time goes

The live golden eval ran twice, 86 cases and 80 model calls per run, at a cost of $0.0044 each. Both runs used the app's own per-stage trace.

Per turn, the model call is about 99% of the time:
- p50 1.22–1.34 s, p90 1.52–1.70 s;
- preview and execute take 6–8 ms each (local dispatcher);
- prompt build, parse and compile take under 1 ms.

The prompt averages 2,448 input tokens, 93% of which are already served from OpenAI's prompt cache. Output averages 31 tokens. Each turn makes one model call, with no tool loops and no repeated calls.

So the agent is not stuck thinking anywhere in our code. It waits about 1.2 s on one short model call that is already cached.

This changes the plan from the brief:
- **Streaming would barely help.** Output is about 31 tokens of JSON plan, and the reply text is composed in the app afterwards.
- **Trimming the prompt would barely help.** It is already 93% cached, and OpenAI states that input size has a small latency effect.
- **The remaining levers are all model-side:** a faster model, a priority service tier, or provider proximity. Each one costs accuracy or money, so each needs your decision.

On the backend, every relay request now writes one `agent.timing` log line with milliseconds for each phase (`parse`, `rateLimit`, `inputRail`, `dailyBudget`, `upstreamWait`, `upstreamRead`, `moderationWait`, `outputRail`, plus total `relay`). It also records attempts, model, token counts and outcome. The line joins the app's trace through `x-request-id`. Once deployed, this gives the production breakdown from the moment the request reaches the server. The new shared rate limit adds one small database transaction to the relay path, about 3–8 ms, which `rateLimit` will show.

I added `prompt_cache_key` to match OpenAI's guidance for GPT-5.6+ models; it does not change output. In the eval the cache hit rate was the same with and without it (93.4% vs 93.5%), and the faster p50 in the second run is within noise. The key matters for cache routing at production scale, across many instances and users. `OPENAI_PROMPT_CACHE_KEY=off` switches it off.

## Accuracy

The golden set grew from 71 to 86 cases. The 15 new cases ask about:
- spend by category and period;
- monthly totals and earnings;
- budgets, goals, subscriptions and loans;
- a month-to-month comparison;
- an empty day, refunds, and a Hinglish question.

They are graded against figures computed from the scenario data itself (`answerOf`): every rupee amount in the true answer must appear in the agent's reply.

Results:

| Run | normal | edge | hinglish | adversarial |
|---|---|---|---|---|
| A, before (no cache key) | 97.9% | 94.4% | 100% | 100% |
| B, after (cache key) | 100% | 94.4% | 100% | 100% |
| Thresholds | 95% | 85% | 85% | 100% |

Both runs pass every threshold. The one normal miss in run A (`qa_compare_months`: the model gave only this month's figure) passed in run B. That is model variance, since caching cannot change output.

`ambiguous_then_choice` failed in both runs, and it is not caused by this work. The case expects the user to settle the shared "concert" item. Today's earlier `finn_settle_only_owed` change made that refusal correct: the agent answers "only Rahul Verma can close it". The case expectation is out of date and needs your confirmation before I change it.

## Security issues and resolutions

1. **High – vulnerable `nodemailer`.** Version 7.0.13 had 16 advisories, including SMTP/CRLF injection, an SSRF via the `raw` option and address-parser DoS. I upgraded it to 10.3.1. Our SMTP-only use is not affected by the breaking changes, and `npm audit --omit=dev` now reports 0.
2. **Medium – rate limits were per instance.** The sign-in limits (code requests, code checks, token refresh) and the agent per-minute limit lived in memory, so on Vercel the real limit grew with the number of instances. A shared Postgres sliding-window limiter now enforces the same limits across all instances (`finn_auth.rate_limit_hits`, which stores only SHA-256 key prefixes, never IPs or user ids). The in-memory limiters remain as the cheap first check. Limits, messages and error envelopes are unchanged.
3. **Verified – no cross-user access.** A new matrix test confirms it. A user holding another user's record ids gets 404 from every by-id route. Every id-taking action is refused, never previewed or completed, and a coverage check makes sure no such action is missed. A control proves each attack input is valid for the owner. The owner's full sync payload is unchanged afterwards, and none of the owner's text leaks.
4. **Verified – concurrent writes and retries.** Five overlapping retries with one `Idempotency-Key` create one record (four replays). A reused key with a different body gets `conflict`. Racing goal contributions cannot overspend. A stale concurrent edit gets `staleData`.
5. **Hardening – database pool on Vercel.** `attachDatabasePool` is now attached, so a suspending Vercel instance closes its idle pooler connections instead of leaking them.

Already in place, confirmed during the audit:
- every RLS policy uses `(select private.uid())`;
- tokens pin HS256, issuer and audience;
- refresh tokens rotate with reuse detection;
- every API response sends `Cache-Control: no-store`;
- CORS allows exact origins only;
- logs redact sensitive fields;
- money is stored as integer paise;
- idempotency keys are retained for 30 days.

## API contract with the Flutter app

The contract test now compares live responses with the committed `docs/contract/fixtures.json`, the same file the app decodes. It ignores only wall-clock timestamps and random FiNN IDs, and I confirmed it fails when a fixture is altered. It passes on the final code, so routes, response shapes, status codes and error formats are unchanged.

The only new response field is none. The relay's upstream request gained `prompt_cache_key`; the app never sees that request.

All tests pass:
- backend: 476 passing, plus the opt-in perf harness;
- Flutter: offline eval tests 12 of 12.

## Database migration

`supabase/migrations/20261106150000_finn_rate_limits.sql` adds one new table in `finn_auth` and its two indexes. It is additive only: it creates objects on an empty table, takes no locks on existing tables, and needs no backfill.

Order matters. **It must be applied before the new backend is deployed.** Otherwise sign-in and the agent will fail, because the table they now use would be missing.

It has not been run. I will apply it via the Supabase MCP only after you say so.

## Needs your decision

1. **Apply the rate-limit migration live, then deploy.** Recommended, in that order.
2. **Write-path round trips** (40 statements per expense). I recommend a scoped follow-up: compute the account-balance aggregate once per transaction while nothing has been written, and build the `changes` payload from the rows the action already holds instead of re-reading 13 collections. It is behaviour-preserving, but it touches the dispatcher core, so I want your go-ahead and would gate it on the contract and BOLA tests.
3. **Agent speed beyond about 1.2 s.** Options are a priority service tier (more cost, same model and accuracy) or a faster or smaller model. Earlier benchmarks scored those 15–18 of 24 against 24 of 24, so a model switch would fail the accuracy bar. I recommend trying the priority tier and measuring it with `agent.timing`. I do not recommend streaming for the current plan format.
4. **Database TLS.** Without `DATABASE_CA_CERT` the pool still connects without verifying the certificate. Once you confirm the variable is set in Vercel, I recommend failing closed in production.
5. **`ambiguous_then_choice` eval case.** Update it to expect the "only Rahul can settle" answer, as the new rule requires.
6. **Still open from the audit:** SMTP quota exhaustion on the existing-account code path, and exhaustion of the new-account agent pool. Both need a policy choice on limits.
7. **Secrets.** Rotate the OpenAI key and the SMTP app password (both were pasted in chat earlier), and set OpenAI spend limits.
