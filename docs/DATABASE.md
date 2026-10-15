# Database

PostgreSQL 17 on the Supabase project `FiNN` (`xeqhygypqyyyoortalod`). Source of truth:
`supabase/migrations/*.sql` (applied; table and column comments are in the SQL).

## Conventions

- Money: `bigint` paise. Never floating point.
- Dates: `date` (user's calendar). Instants: `timestamptz`.
- Ids: client-style text ids (`tx_…`, fixed `cat_food`, `cat_sys_emi`), unique **per user**: every primary key is
  `(user_id, id)` and every reference is a composite foreign key, so a record can only reference the same user's records.
- `version` (optimistic concurrency, checked by the API: `UPDATE … WHERE version = expected`).
- `sync_seq` + `deleted_records` tombstones for incremental sync.
- Derived figures are not stored.

## Tables

| Table | Holds | Notes |
|---|---|---|
| `profiles` | Directory entry (name, `@handle`, phone hint) + FinancialProfile (opening balance/date, income estimate) | 1 row per auth user, created on first request; handle unique case-insensitively |
| `user_preferences` | Month start day, reminder windows, thresholds, disabled alert types, time zone | Visual settings stay on device |
| `categories` | Income/expense categories, standard + custom + system | `(user_id,id,type)` unique so transactions pin type |
| `transactions` | Completed cash events | `type` must match category type (FK); `origin`+`origin_ref_id` mark linked rows |
| `budgets`, `budget_limit_changes` | Monthly limits per expense category; earlier limits per month | One **active** budget per category (partial unique index) |
| `goals` | Savings goals | Saved amount derived from movements |
| `savings_movements` | Earmarking (contribution/withdrawal) for a goal or the emergency fund | Generated `goal_id` FK cascades on goal delete; never cash |
| `emergency_plans` | Essentials × months or override | 1 row per user |
| `loans`, `loan_payments` | Borrowed/lent loans (EMI or interest-only) and recorded repayments | Payments restrict loan delete; each payment's transaction unique |
| `subscriptions` | Expected recurring charges | Only "mark paid" records a transaction |
| `pending_payments`, `pending_settlements` | Obligations to/from people and their settlements | Shared items stored once; settlements owned by the recorder |
| `assets` | User-entered valuations | |
| `money_accounts` | User-owned cash/bank/card accounts (credit cards hold an amount owed); `acc_cash` is every user's default Cash account | Exactly one default (unique partial index); FKs from transactions, transfers, subscriptions, settlements |
| `transfers` | Money moved between own accounts (not income or spending) | Both accounts must be the user's and differ |
| `alert_inbox` | Read/dismissed alert keys | Alerts themselves are derived |
| `idempotency_keys` | Completed action results per (user, key) | Pruned after 30 days |
| `audit_log` | Every attempted operation (summary, channel, confirmation, outcome) | Append-only for the owner |
| `agent_runs` | Agent history: one row per agent turn that proposed changes (request ≤ 500 chars, status, summary, `operations` jsonb of {ref, actionId, summary, status, recordIds, message?}, notes) | Written by `POST /plans/execute` from step reports; keyed (user, run id) so retries update it; pruned after 180 days; never sent to the LLM |
| `deleted_records` | Sync tombstones | Written by trigger |

## Linked records (who owns a cash movement)

| Source | Transaction origin | Reference |
|---|---|---|
| Loan disbursement | `loanDisbursement` | `loans.disbursement_transaction_id` (FK) |
| Loan repayment | `loanRepayment` | `loan_payments.transaction_id` (FK, unique) |
| Pending settlement | `pendingSettlement` | `pending_settlements.transaction_id` (FK, unique); `origin_ref_id` = pending item id as the recorder sees it |
| Subscription payment | `subscription` | `origin_ref_id` = subscription id; note carries the cycle date |

Linked transactions cannot be edited or deleted through `transactions.*`; their module owns them. FKs from the source
records make deleting a referenced transaction impossible at the database level.

## Deletion policy

- Users delete records explicitly through actions (consequential, confirmed). Linked records are deleted by their
  owning module in the same transaction.
- Categories in use cannot be deleted (archive instead). Loans with payments and pending items with settlements cannot
  be deleted. Deleting a goal removes its movements.
- Deleting an auth user cascades to all of the user's rows (no tombstones are written for a deleted account).

## Row Level Security

RLS is enabled on every table. Only the NOLOGIN role `finn_api` (which the API switches to per request) has
privileges; `anon` and `authenticated` — the roles of Supabase's Data API — have none, so the app's publishable key
cannot be used to bypass the API. Policies (all `to finn_api`, caller = `(select private.uid())` from the JWT claims):

- owner-only `for all` on profile-scoped tables;
- `pending_payments`: owner or `shared_with_user_id` may read/update; only the owner inserts/deletes;
- `pending_settlements`: visible to recorder, item owner and shared user; insert only by the recorder on an item they
  can access (`private.can_access_pending`, security definer); the item owner may only set `shared_with_user_id`
  on earlier settlements when the item becomes shared (guard trigger);
- `audit_log`, `deleted_records`: owner read/insert only;
- `agent_runs`: owner-only `for all` (the API inserts/updates it in the caller's transaction; the owner can clear it).

The API runs every query as `finn_api` with the caller's claims (`server/db/tx.ts`), so these policies also
constrain the backend. New tables must be granted to `finn_api` and revoked from `authenticated` (Supabase's default
privileges grant new tables to the Data API roles).

## Functions and triggers

- `private.bump_sync_seq()` — before update, every synced table.
- `private.record_tombstone()` — after delete; writes the owner's tombstone and, for shared items, the other party's
  `mir_` tombstone (security definer; skips users being deleted).
- `private.search_users(query, max)`, `private.directory_entries(ids)` — directory lookups exposing name, handle and
  phone hint only (security definer, `search_path = ''`, executable by `finn_api` only).
- `private.can_access_pending(owner, id)` — used by the settlements insert policy.
- `private.uid()` — caller id from `request.jwt.claims`.
- `private.guard_pending_update()`, `private.guard_settlement_update()` — before-update guards (identity of shared
  items immutable; the other party may only bump bookkeeping fields or write off when owed; settlements immutable
  except being shared once).

The `private` schema is not exposed through Supabase's Data API.
