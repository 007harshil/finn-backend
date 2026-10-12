# Brief for backend module implementers (read fully before coding)

FiNN backend = Next.js 16.4 (App Router route handlers) + TypeScript + Supabase Postgres (Kysely). It ports the
Flutter app's write actions and calculators to the server so the server is the authority for persisted financial
state. The Flutter app (`../finn`) is the specification: port its rules exactly, including messages, rounding and
edge cases. FiNN records finances only; it never moves real money.

## Mandatory repo rules
- `finn-backend/CLAUDE.md` and `finn/CLAUDE.md`: for codebase questions run `graphify query "<q>"` / `graphify explain "<Name>"`
  first (in the repo concerned), never open anything in `graphify-out/`. Fall back to Grep/Read after. Run `graphify update .`
  in finn-backend after editing.
- Next.js here has breaking changes vs. training data. Route handler docs: `node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/route.md`.
  Do not export route segment config (`runtime`, `dynamic`, ...): `cacheComponents` is on.

## Read first (backend)
- `supabase/migrations/*.sql` — the schema (already applied to the live project; do NOT change or add migrations without
  reporting why — if you truly need one, write the SQL file and report it, do not apply it).
- `server/finance/models.ts` — domain records = Flutter DTO JSON shapes, row mappers.
- `server/finance/snapshot.ts` — `FinanceSnapshot` (lazy loaders per collection, `balance()`, `summary(range)`,
  `transactionsIn(range, filter)`, `linkedTransactions(originRefId)`, `transaction(id)`). Transactions are NEVER loaded
  whole: use SQL aggregates or bounded date windows.
- `server/finance/ledger.ts` — cash / earmarked / available, cash-flow summaries.
- `server/actions/types.ts`, `server/actions/input.ts`, `server/actions/dispatcher.ts` — action framework.
- `server/modules/transactions/actions.ts`, `server/modules/categories/actions.ts` — REFERENCE implementations. Copy their style.
- `server/modules/transactions/repo.ts` — `insertTransaction`, `buildLinkedTransaction` (linked cash movements).
- `server/core/*` — money (paise numbers, bigint helpers, `formatInr`), dates (ISO strings, `MonthKey`, `DateRange`,
  `addMonthsClamped`), frequency, failure (`AppFailure`, `throwIfErrors`).
- `tests/transactions.test.ts`, `tests/support/*` — test style (PGlite with real migrations, `act()` helper, `fixClock()` → today 2026-10-10).

## Read first (Flutter spec)
- `../finn/docs/FINANCIAL_MODEL.md` (rules + rounding table), `../finn/docs/BACKEND_INTEGRATION.md`.
- Your module: `../finn/lib/features/<f>/domain/*.dart` (models, calculators) and `../finn/lib/features/<f>/application/*_actions.dart`.

## How to implement a module
1. Calculators: pure TypeScript in `server/modules/<m>/calculator.ts` (no DB), deterministic, `today` passed in.
   Port Dart logic line by line: same rounding modes, bigint where Dart uses BigInt, same null semantics.
2. Actions: `server/modules/<m>/actions.ts` exporting `<name>Actions: AnyAction[]` (the registry already imports that
   name — keep it). One `defineAction` per Dart action, SAME action id, descriptor fields, validation messages, preview
   title/summary/lines/warnings and `basis`. Input JSON = the Dart `toJson()` of its ActionInput (money as rupees via
   `zMoney`/`zPositiveMoney`, dates via `zDate`, ids via `zId`, enums via `zEnum`). `prepare` must not write.
   `execute` writes via `ctx.tx` (Kysely, always `.where('user_id','=',ctx.userId)`), pushes touched ids to `ctx.touched`,
   returns the created/updated record (DTO shape). Ids: `ctx.ids.next('<prefix>')` with the Dart prefix.
   Timestamps: `ctx.now.toISOString()`. Today: `ctx.today`.
3. Multi-record writes are already atomic (the dispatcher runs prepare+execute in one DB transaction). No compensation
   logic needed. Optimistic concurrency: compare `expectedVersion` in prepare AND use `where version = expected` in the
   UPDATE (throw `AppFailure.stale(...)` when 0 rows), bump `version` by 1.
4. Linked transactions: create with `buildLinkedTransaction` + `insertTransaction` in the same execute; delete the
   source record first when FKs require (see FK directions in the migration), then the linked transaction.
5. Read endpoints the Flutter screens need (summaries/projections), under `app/api/v1/<m>/...`, using
   `route()` from `server/http/handler.ts`, `withUserTx(ctx.user, ...)`, `createContext(tx, ctx.user, 'ui')` for a snapshot.
   Return small, purpose-specific JSON (paise ints, ISO dates). Validate query params with zod via `parseWith`.
6. Tests: `tests/<m>.test.ts` — calculator unit tests (port the important cases from `../finn/test/domain/*` and
   `../finn/test/actions/*` for your module, with the same expected numbers) + action integration tests through `act()`
   (validation, confirmation, stale version, idempotent replay, linked transaction created exactly once, user isolation)
   + at least one route test via `makeClient`.
7. Run `npx tsc --noEmit -p .` and `npx vitest run tests/<m>.test.ts` until clean. Do not break other tests.

## Boundaries
- Only edit: `server/modules/<your modules>/**`, `app/api/v1/<your modules>/**`, `tests/<your module>*.test.ts`.
  Do NOT edit `server/core`, `server/actions`, `server/db`, `server/http`, `server/finance/*`, `server/modules/sync`,
  `server/modules/transactions`, `server/modules/categories`, registry, migrations, or other modules. If you need a
  shared change, implement a local helper and list the proposed shared change in your report.
- No new npm packages. No real-money/payment concepts. No AI/agent features.
- Never log amounts, notes, tokens.

## Report (≤ 40 lines)
Files created, action ids implemented, endpoints (method, path, query, response shape), deviations from the Dart
behaviour and why, proposed shared changes, test count and result.
