# Architecture

## Principles

- **The Flutter app is the specification.** Every write action, validation message, preview and calculation rule is a
  port of `../finn/lib/features/*/application/*_actions.dart` and the domain calculators, with the same action ids and
  JSON shapes, so the app can switch from its local mock to the API without changing features.
- **The server is the authority** for persisted financial state, validation, permissions and anything that changes
  records. The app may keep computing presentation figures locally from synced records; the server's endpoints use the
  same rules (`../finn/docs/FINANCIAL_MODEL.md`), so both agree.
- **Records only, never money movement.** A transaction is a recorded cash event; a repayment or settlement is a record.
- **Derived values are never stored.** Balances, budget spending, goal savings, loan outstanding, alerts and net worth
  are computed from records on request.

## Request flow

```
HTTP request
  → app/api/v1/**/route.ts          parse params/body (zod), call one service
  → server/http/handler.ts route()  authenticate (Supabase JWT), first-request account bootstrap,
                                    error → envelope mapping, request id, structured log, CORS
  → server/db/tx.ts withUserTx()    BEGIN; set role finn_api + request.jwt.claims (RLS applies);
                                    per-user advisory lock for writes
  → service / dispatcher            business rules (pure calculators + Kysely queries scoped by user_id)
  → COMMIT → { "data": ... }
```

Handlers stay thin; rules live in `server/modules/<feature>/calculator.ts` (pure, unit-tested) and `actions.ts`.

## Action framework (`server/actions`)

Every financial write is an `ActionDefinition` with a stable id, descriptor (risk, movesMoney, reversible, field specs),
zod input codec, `prepare` (validate against current data, build a human-readable preview, no writes) and `execute`.

`dispatch()` guarantees, in **one database transaction**:

1. **Policy** per channel (`ui`, `agent`, `voice`, `import`; `system` is server-internal): agent/voice must confirm
   everything and may never delete; import may only create.
2. **Locks**: the caller plus any users the action declares (`extraLocks`, shared pending items), in sorted order.
3. **Idempotency**: `idempotency_keys` (user, key). A completed key replays its stored result; a key reused with a
   different request is `conflict`. The key is written in the same transaction as the operation, so a failed attempt
   leaves no key and can be retried. Concurrent duplicates serialise on the user lock and the second one replays.
4. **Fresh validation**: `prepare` runs on data read inside the same transaction, right before `execute`.
5. **Confirmation**: consequential actions (and all agent/voice actions) need `confirmation.fingerprint` equal to the
   current preview's fingerprint = FNV-1a(action id + canonical input) + optional hash of the record state (`basis`,
   e.g. version and outstanding). If the record changed after review, the fingerprint changes and the user is asked again.
6. **Atomic multi-record writes**: a loan repayment's transaction + payment row + loan status, a settlement and its
   transaction, a subscription payment and the next due date commit together or not at all.
7. **Audit**: every executed attempt (success, or failure after validation passed) goes to `audit_log`.
8. **Changes**: the response carries every record the operation changed (sync payload), so clients update caches
   without a second round trip.

Plans (`server/actions/plans.ts`) prepare and execute multi-step requests step by step; see AGENT_READINESS.md.

## Data access

- Kysely over `pg` (transaction-mode pooler, small pool, 15 s statement timeout). Bigint columns are parsed to JS
  numbers (paise, safe to 2^53), `date` columns stay `yyyy-MM-dd` strings.
- `FinanceSnapshot` (`server/finance/snapshot.ts`) lazily loads the small collections of one user once per request
  (categories, budgets, goals, movements, loans, payments, subscriptions, pending, settlements, assets, moneyAccounts, transfers).
  **Transactions are never loaded whole**: balances and cash-flow totals are SQL aggregates
  (`server/finance/ledger.ts`); budgets load only one period's expenses; lists are keyset-paginated.

## Money, dates, rounding

- Integer paise everywhere (`bigint` columns, JS numbers); `bigint` arithmetic where products can overflow (EMI
  factors, scaling). Every division names its rounding mode (`server/core/money.ts`), per the table in
  FINANCIAL_MODEL.md.
- Calendar dates are ISO strings in the user's calendar. "Today" is computed in the user's time zone
  (`user_preferences.time_zone`, default `Asia/Kolkata`). Month arithmetic clamps and keeps anchor days.
- Budget months honour the user's month start day (1–28).

## Security model

- Authentication: FiNN's own email OTP (`server/auth/service.ts`, codes mailed with nodemailer, stored as HMACs) issuing
  HS256 access JWTs (`Authorization: Bearer`, verified locally with `AUTH_JWT_SECRET`) and rotating refresh tokens with
  reuse detection. Accounts and tokens live in the `finn_auth` schema, invisible to every client-facing role.
- Authorization, three layers:
  1. every query filters `user_id = caller`;
  2. the API runs queries as the dedicated `finn_api` role with the caller's claims, so Postgres RLS enforces
     ownership even if a query forgot the filter. The Supabase Data API roles (`anon`, `authenticated`) have no
     privileges on FiNN tables, so clients cannot bypass the API's validation; trigger guards additionally block
     identity changes on shared pending items and other-party edits beyond bookkeeping/write-off;
  3. composite foreign keys `(user_id, id)` make cross-user references impossible.
- Other users are visible only through `private.search_users` / `private.directory_entries` (name, handle, phone hint).
- Secrets are server-only env vars; the DB password never reaches clients. Logs are structured JSON with request ids
  and never contain tokens, bodies, amounts or notes. Error responses never contain SQL or stack traces.
- Input limits: 1 MB JSON bodies (25 MB for the one-time import), bounded page sizes, bounded list lengths.

## Sync

Every table row has `sync_seq` (global sequence, bumped by trigger on update); deletes write tombstones
(`deleted_records`, including the other party's `mir_` ids for shared items). Because one user's writes are serialised
by the advisory lock, a user's sequence numbers commit in order, and `GET /sync` reads every collection from one
repeatable-read snapshot, so a cursor never skips a change. `GET /sync` pages
with `hasMore` when any collection exceeds the limit.

## Shared pending items

Stored once under the creator (`shared_id`, `shared_with_user_id`). The other person sees a derived, reversed view with
id `mir_<sharedId>`; settlements recorded by the other person appear as `mir_<id>` without a transaction. Either party
can record settlements (own linked transaction only); only the creator edits/deletes; only the owed person writes off.
Writes lock both users in sorted order.

## Performance

- Stateless instances; horizontal scaling behind any load balancer.
- Indexes match the queries: `(user_id, date desc, created_at desc, id)` for lists, `(user_id, category_id, type, date)`
  for budgets/analytics, `(user_id, sync_seq)` for sync, partial indexes for linked transactions and shared items.
- Responses are purpose-specific summaries, not full histories.

## Not implemented (by design, this phase)

- Background jobs, schedulers, queues, caches, push notifications: alerts are derived on request. A scheduler can call
  the same alert service later (e.g. Supabase cron or a platform cron hitting an internal endpoint).
- AI, speech, tool-calling or any agent runtime: only the reusable action/plan interfaces exist.
- Payments, bank or UPI integrations: out of product scope.
