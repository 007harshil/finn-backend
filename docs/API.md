# FiNN API reference (v1)

Audience: Flutter/mobile engineers and agent developers. Sources: `app/api/v1/**/route.ts`, zod schemas in `server/`, `docs/contract/fixtures.json`. Examples marked "fixture" are real payloads from `fixtures.json` (trimmed). Where no fixture exists, the response is described by field list only.

## 1. Overview

### 1.1 Base URL and transport
- Base: `<FINN_API_URL>/api/v1`. JSON only (`content-type: application/json`). Responses carry `cache-control: no-store` and `x-request-id` (echo of the request's `x-request-id`, max 64 chars, else generated).
- CORS: only origins listed in `CORS_ORIGINS` get headers (`*` matches one port or subdomain label, e.g. `http://localhost:*`). Allowed request headers: `authorization, content-type, idempotency-key, x-confirmation-fingerprint, x-channel`; methods `GET, POST, PUT, PATCH, DELETE, OPTIONS`; max-age 600. Native mobile clients are unaffected.

### 1.2 Authentication
- FiNN's own passwordless email OTP (no Supabase Auth). Public endpoints, no `Authorization` header:
  - `POST /api/v1/auth/otp` `{email}` -> `{sent: true, expiresInSeconds: 600, resendAfterSeconds: 60}`. Emails a 6-digit code (nodemailer/SMTP). A new code replaces any earlier unused one. Limits: 1 code per email per 60 s, 5 per hour; 10 requests per client IP per 10 min. Bad email: 422 `validation` (`fieldErrors.email`). Limited: 503 `unavailable`, retryable, `details.retryAfterSeconds`. Mail failure: 503 `unavailable`.
  - `POST /api/v1/auth/verify` `{email, code}` -> Session. Creates the account on first sign-in. Wrong/expired/used code: 401 `unauthenticated` "The code was invalid or has expired."; 5 wrong guesses burn the code. Malformed code: 422 (`fieldErrors.code`). 30 requests per IP per 10 min.
  - `POST /api/v1/auth/refresh` `{refreshToken}` -> Session with a **new** refresh token (rotation). Presenting an already-rotated token revokes the whole session (all tokens of that sign-in). Invalid/expired/revoked: 401 `unauthenticated`.
  - `POST /api/v1/auth/logout` `{refreshToken}` -> `{signedOut: true}`. Always 200.
  - Session: `{accessToken, refreshToken, tokenType: "Bearer", expiresIn: 900, expiresAt: ISO-8601, user: {id, email}}`.
- Send the access token on every other request except `GET /health`: `Authorization: Bearer <accessToken>`. It is an HS256 JWT (`iss: finn-api`, `aud: authenticated`, `sub` = user UUID, `role: authenticated`, `email`), verified locally with `AUTH_JWT_SECRET`.
- Missing/invalid/expired token: HTTP 401, `code: "unauthenticated"`. Client: call `/auth/refresh` once, retry, else sign out.
- First authenticated request per user (per server instance) bootstraps the account: profile with generated `@handle`, preferences defaults, standard categories with fixed ids (`cat_food`, `cat_sys_emi`, ...). No explicit signup call.
- All data is scoped to the token's user (RLS). There is no user id in any path.

### 1.3 Envelope
- Success: `{ "data": <payload> }`, HTTP 200 (every endpoint, including POST creates; no 201/204).
- Failure: `{ "error": { "code", "message", "fieldErrors"?, "retryable", "details"? } }`.
- Unhandled DB/server errors are mapped to safe messages; SQL and stack traces never reach the client.

### 1.4 Conventions
| Topic | Rule |
|---|---|
| Money in records/responses | integer **paise** (`amountPaise`, `valuePaise`, ...) |
| Money in action `input` | **rupees**: decimal string `"1250.50"` (commas tolerated) or JSON number; max 2 decimals; never negative. Decoded to paise server-side |
| Money in non-action bodies | `loans/quote` and `loans/{id}/payment-preview` use rupees (`zMoney`); `pending/resolve?amount=` rupees; `transactions` filters `minPaise`/`maxPaise` are paise |
| Dates | `yyyy-MM-dd` (calendar day, user time zone from preferences); months `yyyy-MM` |
| Instants | ISO-8601 UTC (`2026-10-10T03:30:00.000Z`) |
| `version` | integer >= 1 on every mutable record; update actions require `expectedVersion`; mismatch gives `staleData` (409) |
| Ids | `prefix_<time36><rand36>` (`tx_`, `cat_`, `bud_`, `goal_`, `sv_`, `loan_`, `lp_`, `sub_`, `pend_`, `set_`, `asset_`); standard categories `cat_*`; users are UUIDs; audit ids are numeric strings |
| `mir_` ids | A pending item shared *with* you appears as a normal pending record with id `mir_<sharedId>` (direction reversed, `link.createdByMe=false`). Its settlements by the other person have id `mir_<id>` and `transactionId: null`. Server does all mirroring; clients never write the shared ledger |
| Basis points | `rateBps` (10.5% = 1050), `warningThresholdBps` (5000-9500), `progressBps` |
| Records | JSON shape identical to Flutter `lib/data/dto/dtos.dart` DTOs |
| Query booleans/lists | lists are comma-separated (`categoryIds=a,b`) |
| Unknown JSON keys | ignored on action input (zod object default); `PATCH /preferences` is `.strict()` (unknown key = 422) |

### 1.5 Errors
| code | HTTP | retryable | Meaning / example |
|---|---|---|---|
| `validation` | 422 | false | Bad input; `fieldErrors` keyed by input field (nested: `people.0.value`; no field: `request`) |
| `notFound` | 404 | false | Record or action id unknown |
| `conflict` | 409 | false | Handle taken, idempotency key reused for another request, import into non-empty account, unique/FK violation |
| `staleData` | 409 | false | `expectedVersion` or confirmed preview basis no longer current; reload and retry |
| `duplicate` | 409 | false | Duplicate record |
| `insufficientFunds` | 422 | false | Not enough balance/outstanding |
| `ambiguous` | 422 | false | Several matches; `details` carries candidates |
| `confirmationRequired` | 428 | false | Confirmation missing |
| `notPermitted` | 403 | false | Policy (agent delete, import non-create) or non-manual transaction edit |
| `unauthenticated` | 401 | false | See 1.2 |
| `unavailable` | 503 | true | Lock/deadlock/serialization, statement timeout, auth server down. Safe to retry (same Idempotency-Key) |
| `storage` / `unknown` | 500 | true (`unknown`) | Unexpected failure; nothing was changed |

Example (fixture, 422):
```json
{"error":{"code":"validation","message":"Enter an amount greater than zero","fieldErrors":{"amount":"Enter an amount greater than zero"},"retryable":false}}
```
Zod failures on query/body: `fieldErrors` maps the first message per path; `message` is the first error.

### 1.6 Pagination
| Endpoint | Style | Params | Limits |
|---|---|---|---|
| `GET /transactions` | keyset cursor | `limit` 1-200 (default 50), `cursor` (opaque base64url, max 500 chars) | response `nextCursor` null when last page; cursor depends on `sort`: keep filters/sort identical across pages; invalid cursor 422 (`fieldErrors.cursor`) |
| `GET /audit` | numeric keyset, newest first | `limit` 1-200 (default 50), `before` (digits, 1-18) | response `nextBefore` = last item id, null at end |
| `GET /timeline` | month keyset | `limit` 1-6 (default 3), `cursor` `yyyy-MM` (chapters strictly older) | `nextCursor` while older months remain |
| `GET /sync` | change-sequence cursor | `since` (digits 1-18), `limit` 50-5000 (default 2000) | `cursor` + `hasMore`; loop until `hasMore=false` |
Other lists (`/categories`, `/goals`, `/loans`, ...) are unpaged.

### 1.7 Idempotency
- `Idempotency-Key` header is **required** on `POST /actions/{actionId}` and `POST /import`; regex `^[A-Za-z0-9._:\-]{8,128}$`, else 422 with `fieldErrors.idempotencyKey: "Required"`. Not used elsewhere (previews and quotes write nothing).
- Keys are stored per user in the same transaction as the write. Same key + same action + same input: replays the stored `{result, preview}` with `replayed: true` (no `changes`). Same key with different action/input: 409 `conflict`. A failed attempt stores no key, so retrying with the same key is safe. Stored keys are pruned after about 30 days.
- A `needsConfirmation` response stores nothing: repeat with the SAME key plus the confirmation.
- Plan steps use key `<planId>:<stepId>`.

### 1.8 Confirmation flow
1. `POST /actions/{id}/preview` (or first execute call) returns a `preview` with `fingerprint` and `requiresConfirmation`.
2. `fingerprint` = `<requestHash>[.<basisHash>]`: FNV-1a 64 of canonical (sorted-key) JSON of action id + decoded input; the optional suffix hashes the record state the preview depends on (e.g. record `version`, outstanding). Approval is valid only for that exact input and state.
3. If `requiresConfirmation` (action risk `consequential`, or channel `agent`/`voice`) and the execute call has no matching `confirmation.fingerprint`, the server returns `{status:"needsConfirmation", preview}` and writes nothing. Show the review, then repeat the call with the same key and `confirmation: {fingerprint: preview.fingerprint, confirmedBy: "user"}`.
4. If state changed between preview and confirm, the fingerprint no longer matches and the server returns `needsConfirmation` again with the new preview (in plans: step `notApproved` + `staleData`).
5. `confirmedBy` (max 60 chars) is written to the audit log (`"user"` default).

### 1.9 Channels and policy
Body field `channel` on actions/plans: `ui` (default) | `agent` | `voice` | `import` (`system` is server-internal; not accepted). Plans accept `ui|agent|voice`, default `agent`.
| Channel | Rule |
|---|---|
| `ui` | all actions; only `consequential` need confirmation |
| `agent`, `voice` | every action needs confirmation; ids ending `.delete` rejected with 403 `notPermitted` |
| `import` | only ids ending `.create`; else 403 |

### 1.10 Limits
| Item | Limit |
|---|---|
| JSON body | 1,000,000 bytes (`POST /import`: 25,000,000). Larger: 422 "The request is too large." Invalid JSON: 422. Empty body = `{}` |
| Route param | 1-128 chars else 404 |
| Transactions list | `limit` max 200; `categoryIds` first 100 used; `q` max 100 |
| Audit | `limit` max 200 |
| Sync | `limit` 50-5000 |
| Alerts inbox PUT | each key array max 500, key 1-200 chars |
| Plans | 1-20 steps; `approvedFingerprints` max 20 |
| Agent relay | body 600,000 bytes; `messages` 1-200; `tools` <= 64; `max_completion_tokens` <= `AGENT_MAX_OUTPUT_TOKENS`; per-user 20/min, 300/day (defaults); see 2.22 |
| Users search | `q` max 60, min 2 effective chars; 10 results |
| Export | range <= 3 years, <= 20,000 transactions, `categoryIds` max 200 |
| Analytics custom range | <= 366 days |
| Upcoming | `days` 1-90 (`/subscriptions/upcoming`: 1-366) |
| Split bill | 2-20 people |
| Import arrays | categories 500, transactions 100,000, budgets 500, goals 500, savingsMovements 20,000, loans 500, loanPayments 20,000, subscriptions 1,000, pending 5,000, settlements 20,000, assets 1,000, moneyAccounts 100, transfers 20,000 |
| Text | transaction note 500, counterparty 80; category name 2-30; asset name 2-40; profile name 1-40; goal name <= 50; handle 3-30 |
| Amount ceilings (action input, "looks too large" 422) | transaction/loan/pending 10,000,00,000 rupees (1e8 rupees); asset/opening 1e10; goal/emergency 1e9 |

---

## 2. Endpoint groups

Auth: every endpoint requires Bearer unless noted. All responses are wrapped in `{ "data": ... }`; only the inner payload is shown.

### 2.1 Health
| | |
|---|---|
| `GET /health` | Public, no DB. Response `{ "status": "ok" }` |

### 2.2 Me, preferences, handle
**`GET /me`** returns `{ user:{id,name,handle,phoneHint,email}, profile: {exists:false}|{exists:true,displayName,openingPaise,openingDate,monthlyIncomeEstimatePaise}, preferences }`. 404 if profile missing. Fixture:
```json
{"user":{"id":"00000000-0000-4000-8000-00000000000a","name":"Alice","handle":"@alice","phoneHint":null,"email":"alice@example.com"},"profile":{"exists":true,"displayName":"Alice","openingPaise":2000000,"openingDate":"2026-01-01","monthlyIncomeEstimatePaise":null},"preferences":{"monthStartDay":1,"emiReminderDays":5,"subscriptionReminderDays":3,"lowEmergencyCoverageMonths":3,"defaultBudgetWarningBps":8000,"disabledAlertTypes":[],"timeZone":"Asia/Kolkata"}}
```
Profile is changed through action `profile.update`, not here.

**`GET /preferences`** returns Preferences (same object as above).

**`PATCH /preferences`** partial body, `.strict()` (unknown keys 422), returns full Preferences.
| Field | Type | Range |
|---|---|---|
| `monthStartDay` | int | 1-28 |
| `emiReminderDays` | int | 0-30 |
| `subscriptionReminderDays` | int | 0-30 |
| `lowEmergencyCoverageMonths` | int | 1-24 |
| `defaultBudgetWarningBps` | int | 5000-9500 |
| `disabledAlertTypes` | string[] | AlertType: `emiDue emiOverdue pendingOwed collectOwed subscriptionRenewal subscriptionOverdue budgetNearLimit budgetBreached emergencyFundLow emergencyFundNotSet goalMilestone goalAtRisk monthlyDeficit` (deduplicated) |
| `timeZone` | string <= 64 | valid IANA name (`Asia/Kolkata`) |

**`PATCH /me/handle`** body `{ "handle": "@name" }` (trimmed, lowercased; `^@[a-z0-9._]{3,30}$`). Returns `{ "handle": "@name" }`. 409 `conflict` when taken (case-insensitive); 422 on format.

**Account deletion** (permanent, confirmed by an emailed code):
- **`POST /me/delete/code`** (no body) -> `{sent: true, expiresInSeconds: 600, resendAfterSeconds: 60}`. Emails a 6-digit deletion code to the account's address on record. Same limits and failures as `POST /auth/otp`. Deletion codes and sign-in codes are separate: neither works for the other purpose.
- **`POST /me/delete`** `{code}` -> `{deleted: true}`. Deletes the account and every row it owns in one transaction (profile, preferences, sessions, all finance data, audit log, sign-in codes). Pending items shared with another person: theirs stay but are unlinked; they get tombstones for the deleting user's items and settlements. A goodbye email is sent (best effort). Wrong, expired or burned code: 422 `validation` (`fieldErrors.code` "The code was invalid or has expired.", not 401, so the session stays); 5 wrong guesses burn the code. Afterwards refresh tokens fail and any leftover access token gets 401. The same email can sign up again as a new, empty account.

### 2.3 Sync
**`GET /sync?since=<cursor>&limit=<n>`**
| Param | Type | Rules |
|---|---|---|
| `since` | digits (1-18) | omit, or `"0"`, for a full load |
| `limit` | int | 50-5000, default 2000 |

Response `{ cursor, hasMore, collections, values }`. `collections` keys (only those changed): `transactions categories budgets goals savingsMovements loans loanPayments subscriptions pending settlements assets moneyAccounts transfers`, each `{ upserted: DTO[], deleted: string[] }`. `values` keys (only when changed): `profile, emergencyPlan, preferences, alertInbox, me:{id,name,handle,phoneHint}`. Full load always includes `emergencyPlan` and `alertInbox`.
Client algorithm: apply upserts by id, deletions by id, store `cursor`; repeat with the returned cursor while `hasMore`. Fixture (trimmed to 1 item per collection):
```json
{"cursor":"194","hasMore":false,
 "collections":{
  "transactions":{"upserted":[{"id":"tx_1","type":"income","amountPaise":10000000,"categoryId":"cat_salary","date":"2026-10-01","accountId":"acc_1","channel":"NEFT","counterparty":"Acme Corp","note":null,"origin":"manual","originRefId":null,"createdAt":"2026-10-10T03:30:00.000Z","updatedAt":"2026-10-10T03:30:00.000Z","version":1}],"deleted":["tx_3"]},
  "categories":{"upserted":[{"id":"cat_food","name":"Food & Dining","type":"expense","iconKey":"utensils","colorIndex":12,"description":"Restaurants, cafés, Swiggy, Zomato","isSystem":false,"isArchived":false,"isEssential":false,"version":1}],"deleted":[]},
  "budgets":{"upserted":[{"id":"bud_1","categoryId":"cat_food","limitPaise":900000,"previousLimits":[],"status":"active","warningThresholdBps":8500,"note":null,"createdAt":"2026-10-10T03:30:00.000Z","updatedAt":"2026-10-10T03:30:00.000Z","version":4}],"deleted":[]},
  "goals":{"upserted":[{"id":"goal_1","name":"Japan trip 2027","category":"travel","targetPaise":20000000,"targetDate":"2027-04-10","plannedMonthlyPaise":null,"colorIndex":2,"status":"active","note":null,"createdAt":"2026-10-10T03:30:00.000Z","updatedAt":"2026-10-10T03:30:00.000Z","version":4}],"deleted":[]},
  "savingsMovements":{"upserted":[{"id":"sv_1","bucketType":"goal","bucketId":"goal_1","kind":"contribution","amountPaise":1000000,"date":"2026-10-10","note":"Starting amount","createdAt":"2026-10-10T03:30:00.000Z"}],"deleted":[]},
  "loans":{"upserted":[{"id":"loan_1","name":"Swift car loan","counterparty":"HDFC Bank","direction":"borrowed","structure":"amortizing","principalPaise":60000000,"rateBps":950,"startDate":"2026-09-01","firstDueDate":"2026-10-05","frequency":"monthly","tenureInstallments":60,"maturityDate":null,"prepaymentStrategy":"reduceTenure","status":"active","disbursementTransactionId":"tx_7","note":null,"createdAt":"2026-10-10T03:30:00.000Z","updatedAt":"2026-10-10T03:30:00.000Z","version":2}],"deleted":[]},
  "loanPayments":{"upserted":[{"id":"lp_1","loanId":"loan_1","kind":"installment","date":"2026-10-05","interestPaise":475000,"principalPaise":785200,"periodNumber":1,"transactionId":"tx_8","note":null,"createdAt":"2026-10-10T03:30:00.000Z"}],"deleted":[]},
  "subscriptions":{"upserted":[{"id":"sub_1","name":"Netflix","amountPaise":64900,"categoryId":"cat_food","frequency":"monthly","nextDueDate":"2026-12-08","startDate":null,"status":"active","autoRenews":true,"accountId":"acc_1","note":null,"createdAt":"2026-10-10T03:30:00.000Z","updatedAt":"2026-10-10T03:30:00.000Z","version":6}],"deleted":[]},
  "pending":{"upserted":[{"id":"pend_1","counterparty":"Rahul Verma","direction":"owedToMe","kind":"lent","originalPaise":700000,"purpose":"Goa trip hotel share (updated)","createdDate":"2026-10-01","notes":null,"isCancelled":false,"createdAt":"2026-10-10T03:30:00.000Z","updatedAt":"2026-10-10T03:30:00.000Z","version":2,"link":null,"split":null}],"deleted":[]},
  "settlements":{"upserted":[{"id":"set_1","pendingId":"pend_1","amountPaise":120000,"date":"2026-10-05","accountId":"acc_1","channel":"UPI","transactionId":"tx_4","note":"Part payment","createdAt":"2026-10-10T03:30:00.000Z"}],"deleted":[]},
  "assets":{"upserted":[{"id":"asset_1","name":"Gold coins","type":"gold","valuePaise":8200000,"valuedOn":"2026-10-09","note":null,"createdAt":"2026-10-10T03:30:00.000Z","updatedAt":"2026-10-10T03:30:00.000Z","version":2}],"deleted":[]}},
 "values":{
  "profile":{"exists":true,"displayName":"Alice","openingPaise":2000000,"openingDate":"2026-01-01","monthlyIncomeEstimatePaise":null},
  "me":{"id":"00000000-0000-4000-8000-00000000000a","name":"Alice","handle":"@alice","phoneHint":null},
  "emergencyPlan":{"configured":true,"essentialMonthlyPaise":4000000,"targetMonths":6,"targetOverridePaise":null,"updatedAt":"2026-10-10T03:30:00.000Z"},
  "preferences":{"monthStartDay":1,"emiReminderDays":5,"subscriptionReminderDays":3,"lowEmergencyCoverageMonths":3,"defaultBudgetWarningBps":8000,"disabledAlertTypes":[],"timeZone":"Asia/Kolkata"},
  "alertInbox":{"read":[],"dismissed":[]}}}
```
```json
{"id":"mir_shr_1","counterparty":"Alice","direction":"owedToMe","kind":"lent","originalPaise":100000,"purpose":"Dinner","createdDate":"2026-10-01","notes":null,"isCancelled":false,"version":3,"link":{"userId":"00000000-0000-4000-8000-00000000000a","handle":"@alice","sharedId":"shr_1","createdByMe":false},"split":null}
```
Settlement from the other person: `{"id":"mir_set_3","pendingId":"mir_shr_1","amountPaise":30000,"date":"2026-10-09","accountId":null,"channel":null,"transactionId":null,...}` (the other person never sees the recorder's account).

### 2.4 Import
**`POST /import`** one-time upload of on-device data. Header `Idempotency-Key` required. Body cap 25 MB. Only for an account with no financial records yet, else 409 `conflict`. Atomic (all or nothing), client ids preserved. Own pending items only (no mirrors); `link` dropped. Response = full sync payload (same shape as `GET /sync`).
Body keys (all arrays default empty): `categories transactions budgets goals savingsMovements loans loanPayments subscriptions pending settlements assets moneyAccounts transfers` (DTO JSON, array caps in 1.10), `profile` (`{exists:false}` | `{exists:true,displayName(1-40),openingPaise,openingDate,monthlyIncomeEstimatePaise?}`), `emergencyPlan` (`{configured:false}` | `{configured:true,essentialMonthlyPaise,targetMonths 1-24,...}`). Accounts: without `moneyAccounts` the bootstrapped Cash account (`acc_cash`) receives the profile's opening balance/date and every transaction without `accountId`; with `moneyAccounts` they replace it (the account flagged `isDefault`, else the first active one, is the default and receives records without `accountId`). Every `accountId` must refer to an included account (422 otherwise). Import validation is stricter than action input on some fields (e.g. category `name` 2-30, `iconKey` 1-40, `colorIndex` 0-63, `description` <= 120; amounts are integer paise, instants ISO-8601, `version` default 1).

### 2.5 Actions (all writes)
All state changes go through actions. Ids and input JSON equal the Flutter actions.

**`GET /actions`** returns `{ actions: ActionDescriptor[] }` where descriptor = `{id,module,title,description,risk,movesMoney,reversible,fields:[{name,kind,description,required,allowedValues?}]}`. `kind`: `string money date integer boolean enumeration id rate list object`. Fixture (first item): see `fixtures.json` `http.actionsList` (`transactions.create`, 7 fields).

**`POST /actions/{actionId}/preview`** body `{ input: object (default {}), channel: ui|agent|voice|import (default ui) }`. Validates against fresh data, writes nothing. Response `{ preview }`:
| Field | Type |
|---|---|
| `actionId` | string |
| `title`, `summary` | string |
| `lines` | `{label, value, emphasis?}[]` |
| `warnings` | string[] |
| `fingerprint` | string (see 1.8) |
| `requiresConfirmation` | bool (forced true for agent/voice) |

Errors: 404 unknown action; 403 policy; 422 validation (`fieldErrors` keyed by input field); 409 `staleData`.

**`POST /actions/{actionId}`** header `Idempotency-Key`; body:
| Field | Type | Rules |
|---|---|---|
| `input` | object | default `{}`; per-action fields below |
| `confirmation` | `{fingerprint: string 1-200, confirmedBy?: string <= 60}` or null | required when `requiresConfirmation` |
| `channel` | enum | default `ui` |

Response is one of:
1. `{ status:"needsConfirmation", actionId, preview }` (fixture):
```json
{"status":"needsConfirmation","actionId":"transactions.delete","preview":{"actionId":"transactions.delete","title":"Delete transaction?","summary":"Delete ₹1,300.25 expense on 5 Oct 2026","lines":[{"label":"Category","value":"Food & Dining"},{"label":"Balance effect","value":"+₹1,300.25","emphasis":true}],"warnings":["This cannot be undone."],"fingerprint":"be40cebd63f28c17.9d193d6e1dfee9e3","requiresConfirmation":true}}
```
2. `{ status:"completed", actionId, result, preview, replayed, changes? }`. `result` is the record DTO (or action output). `changes` is a sync payload (`{cursor,hasMore,collections,values}`) of what this call changed, absent when `replayed: true`. Apply `changes` like a sync page but do NOT advance the stored sync cursor from it (a counterparty's changes may sit between the old cursor and `changes.cursor`); run a normal incremental sync next. Fixture (`transactions.create`, input `{"type":"expense","amount":"42.75","categoryId":"cat_food","date":"2026-10-07"}`):
```json
{"status":"completed","actionId":"transactions.create","result":{"id":"tx_10","type":"expense","amountPaise":4275,"categoryId":"cat_food","date":"2026-10-07","accountId":"acc_cash","channel":null,"counterparty":null,"note":null,"origin":"manual","originRefId":null,"createdAt":"2026-10-10T03:30:00.000Z","updatedAt":"2026-10-10T03:30:00.000Z","version":1},"preview":{"actionId":"transactions.create","title":"Record expense","summary":"Spent ₹42.75","lines":[{"label":"Type","value":"Expense"},{"label":"Amount","value":"₹42.75","emphasis":true},{"label":"Category","value":"Food & Dining"},{"label":"Date","value":"7 Oct 2026"},{"label":"From","value":"Cash"}],"warnings":[],"fingerprint":"8c85dc3f865e73ee","requiresConfirmation":false},"replayed":false,"changes":{"cursor":"194","hasMore":false,"collections":{"transactions":{"upserted":["<tx_10 record>"],"deleted":[]}},"values":{}}}
```
Errors: 422 (bad key, bad input), 409 `conflict` (key reuse) / `staleData`, 403, 404, 422 `insufficientFunds`/`ambiguous`. Every executed attempt is audited, including failures (see 2.20).

#### 2.5.1 Action catalogue (40 actions)
Columns: Conf. = needs confirmation on `ui` (risk `consequential`; always true on agent/voice). Rev. = `reversible`. Field legend: `*` required; `money` = rupees; `date` = `yyyy-MM-dd`; `id` = record id (<= 64 chars). Update actions also require `id` and `expectedVersion` (int >= 1) in addition to the shared fields.

| Action id | Module | Risk | movesMoney | Conf. | Rev. | Input fields |
|---|---|---|---|---|---|---|
| `transactions.create` | transactions | low | yes | no | yes | `type`* income/expense; `amount`* money > 0; `categoryId`* id (type-matching, non-archived; system cats only `*_other_out`/`*_other_in`); `date`* date (not future); `accountId` id (existing, non-archived; default: the default account; on update default: keep); `channel` free text <= 30 (trimmed, blank = null); `counterparty` <= 80; `note` <= 500 |
| `transactions.update` | transactions | low | yes | no | yes | `id`*, `expectedVersion`*, + create fields. Manual-origin transactions only (else 403) |
| `transactions.delete` | transactions | consequential | yes | yes | no | `id`*. Manual-origin only |
| `categories.create` | categories | low | no | no | yes | `name`* 2-30 unique per type; `type`* income/expense; `iconKey`*; `colorIndex`* int 0-13; `description`; `isEssential` bool (default false) |
| `categories.update` | categories | low | no | no | yes | `id`*, `expectedVersion`*, + create fields |
| `categories.toggleArchive` | categories | low | no | no | yes | `id`* |
| `categories.delete` | categories | consequential | no | yes | no | `id`* |
| `budgets.create` | budgets | low | no | no | yes | `categoryId`* (expense cat); `limit`* money > 0; `warningThresholdBps` int 5000-9500; `note` |
| `budgets.update` | budgets | low | no | no | yes | `id`*, `expectedVersion`*, + create fields |
| `budgets.setPaused` | budgets | low | no | no | yes | `id`*; `paused`* bool |
| `budgets.delete` | budgets | consequential | no | yes | no | `id`* |
| `pending.create` | pending | low | no | no | yes | `counterparty`*; `direction`* iOwe/owedToMe; `kind` borrowed/lent/sharedExpense/reimbursement/other (default other); `amount`* money; `purpose`*; `createdDate`* date; `notes`; `linkedUserId` (FiNN user to share with; find via `/users/search`) |
| `pending.split` | pending | low | no | no | yes | `direction`*; `kind` (default sharedExpense); `total`* money; `purpose`*; `createdDate`*; `method` equally/exact/percent/shares/adjustment (default equally); `people`* array 2-20 of `{counterparty*, linkedUserId?, value?}` (value unit by method: rupees / % / parts / +- rupees); `includeMe` bool (owedToMe only); `myValue`; `notes`. Creates one item per person |
| `pending.update` | pending | low | no | no | yes | `id`*, `expectedVersion`*, + create fields |
| `pending.settle` | pending | consequential | yes | yes | no | `pendingId`* (exact id; use `/pending/resolve`); `amount`* money <= outstanding; `date`*; `accountId` (default: default account; used only with `recordCashMovement`); `channel` <= 30; `recordCashMovement` bool (default true); `note` |
| `pending.cancel` | pending | consequential | no | yes | yes | `id`* |
| `pending.delete` | pending | consequential | no | yes | no | `id`* |
| `loans.create` | loans | low | no | no | yes | `name`*; `counterparty`*; `direction`* borrowed/lent; `structure`* amortizing/interestOnly; `principal`* money; `rateBps`* int; `startDate`*; `firstDueDate`*; `frequency`* monthly/quarterly/halfYearly/yearly; `tenureInstallments` int (amortizing); `maturityDate` (interest-only); `prepaymentStrategy` reduceTenure/reduceEmi (default reduceTenure); `recordDisbursement` bool (default false); `accountId`, `channel` (account the disbursement moved through; default account); `note` |
| `loans.update` | loans | low | no | no | yes | `id`*, `expectedVersion`*, + create fields. Terms locked once payments exist |
| `loans.recordPayment` | loans | consequential | yes | yes | no | `loanId`*; `kind`* installment/interest/principal; `amount`* money; `date`*; `accountId`; `channel` <= 30; `recordCashMovement` bool (default true); `note` |
| `loans.delete` | loans | consequential | yes | yes | no | `id`* |
| `subscriptions.create` | subscriptions | low | no | no | yes | `name`*; `amount`* money > 0; `categoryId`* (expense cat); `frequency`* weekly/monthly/quarterly/halfYearly/yearly; `nextDueDate`*; `startDate`; `autoRenews` bool; `accountId` (usually charged); `note` |
| `subscriptions.update` | subscriptions | low | no | no | yes | `id`*, `expectedVersion`*, + create fields |
| `subscriptions.setStatus` | subscriptions | low | no | no | yes | `id`*; `status`* active/paused/cancelled |
| `subscriptions.markPaid` | subscriptions | consequential | yes | yes | no | `subscriptionId`*; `cycleDate` (default next due); `date` (not future, default due date); `amount` money (default subscription amount); `accountId` (default: the subscription's account, then the default account); `channel` <= 30 |
| `subscriptions.skipCycle` | subscriptions | low | no | no | no | `subscriptionId`*; `cycleDate` |
| `subscriptions.delete` | subscriptions | consequential | no | yes | no | `id`* |
| `goals.create` | goals | low | no | no | yes | `name`* <= 50 unique among active; `category` travel/purchase/education/investment/home/vehicle/wedding/health/other (default other); `target`* money; `targetDate` (future); `plannedMonthlyContribution` money; `initialAllocation` money; `colorIndex` int (default 5); `note` |
| `goals.update` | goals | low | no | no | yes | `id`*, `expectedVersion`*, + create fields except `initialAllocation` (ignored) |
| `goals.contribute` | goals | consequential | no | yes | yes | `goalId`*; `amount`* money; `date`*; `note` |
| `goals.withdraw` | goals | consequential | no | yes | yes | `goalId`*; `amount`* money; `date`*; `note` |
| `goals.toggleArchive` | goals | low | no | no | yes | `id`* |
| `goals.delete` | goals | consequential | no | yes | no | `id`* |
| `emergencyFund.configure` | emergencyFund | low | no | no | yes | `essentialMonthlyExpenses`* money; `targetMonths`* int 1-24; `targetOverride` money |
| `emergencyFund.contribute` | emergencyFund | consequential | no | yes | yes | `amount`* money; `date`* (not future); `note` |
| `emergencyFund.withdraw` | emergencyFund | consequential | no | yes | yes | `amount`* money; `date`*; `note` |
| `assets.create` | assets | low | no | no | yes | `name`* 2-40; `type`* bankDeposit/investment/retirement/gold/property/vehicle/other; `value`* money >= 0; `valuedOn`* (not future); `note` |
| `assets.update` | assets | low | no | no | yes | `id`*, `expectedVersion`*, + create fields |
| `assets.delete` | assets | consequential | no | yes | no | `id`* |
| `accounts.create` | accounts | low | no | no | yes | `name`* 1-40; `kind`* cash/bank/debitCard/creditCard/promoCard/otherCard; `institution` <= 40; `last4` exactly 4 digits (cards only); `openingBalance`* money >= 0 (credit card: amount owed); `openingDate` (default today, not future); `creditLimit` money (credit cards only, 0 = none); `isDefault` bool; `note` <= 200. Same name+kind only warns. Result: MoneyAccountDto |
| `accounts.update` | accounts | low | no | no | yes | `id`*; `expectedVersion` (alias `version`, both optional: omitted = no stale check); `name`*, `kind`*, `institution`, `last4`, `openingBalance`*, `openingDate`*, `creditLimit`, `note`. Switching between creditCard and any other kind needs an account without movements |
| `accounts.setBalance` | accounts | low | no | no | yes | `id`*; `expectedVersion`/`version`; `balance`* money >= 0 (credit card: amount owed); `asOf` date (default today, not future). Sets `openingPaise` so the computed balance on `asOf` equals `balance` (if that needs a negative opening, the opening date moves to `asOf` instead). Preview line `Balance` (or `Owed`): `old -> new` |
| `accounts.setDefault` | accounts | low | no | no | yes | `id`* (not archived); unsets the previous default |
| `accounts.archive` | accounts | low | no | no | yes | `id`*; `archived`* bool. 422 for the default account or the last active one |
| `accounts.delete` | accounts | consequential | no | yes | no | `id`*. 422 when any transaction, transfer, subscription or settlement refers to it (archive instead) or it is the last active account; deleting the default hands the default to the next active account |
| `transfers.create` | transfers | low | yes | no | yes | `fromAccountId`*, `toAccountId`* (different, existing, non-archived); `amount`* money > 0; `date`* (not future); `channel` <= 30; `note` <= 500. Not income or spending. Warning when the source (non-credit) account holds less. Result: TransferDto |
| `transfers.update` | transfers | low | yes | no | yes | `id`*; `expectedVersion`/`version`; same fields as create (an edit may keep an archived account it already uses) |
| `transfers.delete` | transfers | consequential | yes | yes | no | `id`* |
| `profile.update` | profile | consequential | no | yes | yes | `displayName`* 1-40; `openingBalance`* money >= 0 (also written to the Cash account `acc_cash` with `openingDate`); `openingDate`* (not future); `monthlyIncomeEstimate` money |

Notes: `movesMoney` means the action records/changes a cash movement (never moves real money). `profile.update` is consequential per descriptor (registered in the `account/actions.ts` module, descriptor module name `profile`). Real input examples for every action id are in `docs/contract/fixtures.json` under `actions[].input`, e.g.:
```json
{"actionId":"pending.settle","input":{"pendingId":"pend_1","amount":"1200","date":"2026-10-05","accountId":"acc_1","channel":"UPI","recordCashMovement":true,"note":"Part payment"}}
{"actionId":"pending.split","input":{"direction":"owedToMe","total":"3000","purpose":"Weekend cabin","createdDate":"2026-10-10","method":"equally","includeMe":true,"people":[{"counterparty":"Asha"},{"counterparty":"Bina"}]}}
{"actionId":"loans.recordPayment","input":{"loanId":"loan_1","kind":"installment","amount":"12602","date":"2026-10-05","recordCashMovement":true}}
```

### 2.6 Plans (multi-action)
**`POST /plans/preview`** body:
| Field | Type | Rules |
|---|---|---|
| `planId` | string | `^[A-Za-z0-9._\-]{8,64}$` |
| `channel` | enum | `ui|agent|voice`, default `agent` |
| `steps` | array | 1-20 of `{stepId (^[A-Za-z0-9_\-]{1,32}$), actionId (1-64), input: object, dependsOn: string[] default []}`; ids unique; a dependency must appear earlier (422 otherwise) |

Response `{ steps: [{stepId, actionId, status: "ready"|"invalid", preview?, failure?}] }`. Each step is previewed independently (no writes).

**`POST /plans/execute`** same body plus `approvedFingerprints` (string[] 1-200 chars each, max 20) and `stopOnFailure` (bool, default true). Runs steps in order; each commits on its own (no cross-step rollback). Idempotency key per step = `<planId>:<stepId>`, so retrying with the same `planId` only re-runs what is left. A step runs only if its request fingerprint matches an approved fingerprint (prefix match before `.`). `confirmedBy` = `plan:<planId>`.
Response `{ steps: [{stepId, actionId, status, preview?, failure?, result?, replayed?}] }` with `status`: `succeeded | failed | skipped` (halted or dependency not succeeded) `| notApproved` (no approval, or state changed since approval, with `failure.code=staleData`) `| invalid`. Plan responses carry no `changes`; run a sync afterwards.

Optional `history` (agent turns): `{ runId (^[A-Za-z0-9._\-]{8,64}$), request (1-2,000, stored trimmed to 500), notes?: string[] (<= 10 of <= 300), labels?: { [stepId]: summary (<= 300) } }`. After the steps run, the server records one agent history entry from its **own** step reports (see 2.23): each step's preview summary (or its label when the server did not run it), its status and the ids of the records it touched. The response then adds `history: { id, status, summary } | null` (null if the history write failed; the steps have committed regardless). The entry is keyed by `runId`: a retried call (lost reply) replays its steps and rewrites the same entry, and a later call with the same `runId` (a second wave of dependent steps) merges its steps into it by `stepId`.

### 2.7 Transactions
**`GET /transactions`**
| Param | Type | Rules |
|---|---|---|
| `from`, `to` | date | `from <= to` else 422 (`fieldErrors.from`) |
| `type` | enum | income, expense |
| `categoryIds` | csv | first 100 |
| `accountIds` | csv | account ids (first 100) |
| `channels` | csv | exact channel texts (first 20) |
| `origins` | csv | transaction origin values (`manual`, ... per `TRANSACTION_ORIGINS`) |
| `minPaise`, `maxPaise` | int (digits) | paise; `min <= max` |
| `q` | string <= 100 | matches counterparty, note, category name, or amount typed as digits (`1250`, `1250.5`) |
| `sort` | enum | newest (default), oldest, highest, lowest |
| `limit` | int | 1-200, default 50 |
| `cursor` | string | opaque |

Response `{ items: TransactionDto[], nextCursor: string|null }`. Record = the `transactions` DTO in 2.3.
**`GET /transactions/{id}`** returns one TransactionDto; 404 `notFound` if missing.

### 2.8 Categories
**`GET /categories`** returns `{ items: CategoryDto[] }` including archived and system categories (DTO in 2.3).

### 2.9 Budgets
**`GET /budgets?month=yyyy-MM`** budget overview for a budget month (default the current budget month per `monthStartDay`; later months clamp to current). Month regex `^\d{4}-(0[1-9]|1[0-2])$` else 422.
**`GET /budgets/{id}?month=yyyy-MM`** one budget with its daily spend series. Response field lists are produced by `budgetsOverview`/`budgetDetail` (`server/modules/budgets/service.ts`); no fixture. 404 if unknown id.

### 2.10 Goals
**`GET /goals`** returns `{ items: [...] }`; each = goal DTO plus derived progress: `saved, progressBps, achieved, averageMonthly, requiredPerMonth, estimatedCompletion, onTrack` (via `goalProgressDto`).
**`GET /goals/{id}`** same item plus `movements` (up to today, newest first). 404 `notFound` if missing.

### 2.11 Emergency fund
**`GET /emergency-fund`** returns `plan, saved, target, coverageTenths, level, suggestedEssentialMonthly, movements` (via `emergencyStatusDto`). Plan changes: `emergencyFund.configure/contribute/withdraw`.

### 2.12 Loans
**`GET /loans`** every loan with derived state: outstanding, EMI, next due `{date, amountPaise, period}`, overdue count, paid instalments, interest paid, closed.
**`GET /loans/{id}`** loan, state, payments (newest first) and schedule rows with status paid/overdue/due/upcoming. 404 if unknown.
**`POST /loans/quote`** live estimate for the loan form; writes nothing. Body (rupees):
| Field | Type | Rules |
|---|---|---|
| `structure`* | enum | amortizing, interestOnly |
| `principal`* | money | rupees, >= 0 |
| `rateBps`* | int | |
| `startDate`*, `firstDueDate`* | date | |
| `frequency`* | enum | monthly, quarterly, halfYearly, yearly |
| `tenureInstallments` | int? | |
| `maturityDate` | date? | |
| `prepaymentStrategy` | enum? | reduceTenure, reduceEmi |

Response `{ quote: {installmentPaise, installments, totalInterestPaise, ...} | null, schedule }` (`quote` null while terms are incomplete).
**`POST /loans/{id}/payment-preview`** body `{ kind*: installment|interest|principal, amount*: money (rupees), date?: yyyy-MM-dd (default today) }`. Response = interest/principal split plus `payoffPaise`. Invalid amount: 422 with calculator message. Writes nothing.

### 2.13 Subscriptions
**`GET /subscriptions`** every subscription with monthly equivalent and due state, plus totals.
**`GET /subscriptions/{id}`** subscription, linked payments (newest first), next renewals. 404 if missing.
**`GET /subscriptions/upcoming?days=30`** `days` int 1-366 (default 30). Projected renewals `{items:[{subscriptionId, date, amount..., name, frequency, daysUntil}]...}`; never transactions.

### 2.14 Pending
**`GET /pending`** every visible item (own and shared, caller's perspective) with outstanding, settled, status, ageDays and settlements (newest first), totals (toPay, toCollect, long pending, per-tab counts), long-pending ids (oldest first), splits, and active items grouped by person.
**`GET /pending/{id}`** (own id or `mir_<sharedId>`) item, its split, other open items with the same person.
**`GET /pending/resolve?name=&direction=&amount=`** resolver used before `pending.settle`:
| Param | Type | Rules |
|---|---|---|
| `name`* | string | <= 80 |
| `direction` | enum | iOwe, owedToMe |
| `amount` | money (rupees) | outstanding amount to tell items with one person apart |

Response: `{status:"found", item}` | `{status:"ambiguous", message, candidates}` | `{status:"none", message}`. HTTP is 200 for all three; it never picks one of several matches.

### 2.14a Money accounts and transfers
Accounts and transfers are written only through the actions above and read through sync (collections `moneyAccounts`, `transfers`) and the balance read model. Money inputs are rupees (number or string, as everywhere).

`MoneyAccountDto`: `{"id":"acc_cash","name":"Cash","kind":"cash","institution":null,"last4":null,"openingPaise":250000,"openingDate":"2026-09-01","creditLimitPaise":null,"isDefault":true,"isArchived":false,"sortOrder":0,"note":null,"createdAt":"...","updatedAt":"...","version":1}`. `kind` is `cash|bank|debitCard|creditCard|promoCard|otherCard`; `creditCard` is the only liability.

`TransferDto`: `{"id":"trf_1","fromAccountId":"acc_sbi","toAccountId":"acc_cash","amountPaise":200000,"date":"2026-10-10","channel":"ATM","note":null,"createdAt":"...","updatedAt":"...","version":1}`.

Balance rules (counting movements dated `openingDate <= date <= today` per account): `flow = income - expense + transfers in - transfers out`; asset balance `= openingPaise + flow`; credit card owed `= openingPaise - flow`. `cashPaise` is the sum of asset balances (archived included), `creditOwedPaise` the sum owed, `availablePaise = cashPaise - earmarkedPaise`. Net worth subtracts credit owed (liability line "Credit card owed"). Recording a transaction or transfer dated before an account's `openingDate` moves that account's `openingDate` (and the profile's tracking start) back to that date.

Balance read model (`GET /dashboard` -> `balance`, also `FinanceSnapshot.balance()`): `{openingBalancePaise (sum of asset openings), totalInflowPaise, totalOutflowPaise, earmarkedGoalsPaise, earmarkedEmergencyPaise, cashPaise, creditOwedPaise, earmarkedPaise, availablePaise, accounts:[{accountId, balancePaise}]}` where `balancePaise` is the amount owed for credit cards. `GET /analytics`: `methods` is replaced by `accounts:[{accountId,label,kind,amountPaise,shareBps}]` and `channels:[{channel,amountPaise,shareBps}]` (expense only, descending); the internal period summary has `byAccount:[{accountId,amountPaise}]` and `byChannel:[{channel,amountPaise}]` instead of `byMethod`. `baselines.digitalShareBps` is the share of spending not on `cash` accounts.

### 2.15 Assets
**`GET /assets`** returns `{ assets: AssetDto[], totalPaise }`. Note this uses key `assets`, not `items`.

### 2.16 Net worth, dashboard, analytics
- **`GET /net-worth`** net worth snapshot with lines, asset rows, slices and debt ratio.
- **`GET /dashboard`** home overview in one payload (same figures as detail endpoints).
- **`GET /analytics`** Insights screen data. Params: `period` month|quarter|half|year (default month); `month` `yyyy-MM`; or `from` + `to` (both required together, `to >= from`, <= 366 days). 422 otherwise (`fieldErrors.from|to`).
Payload fields are defined in `server/modules/insights/*.ts`; no fixtures.

### 2.17 Alerts and inbox
**`GET /alerts`** active alerts derived on request (dismissed keys removed): `{ items: (FinancialAlert & {read})[], unreadCount, total, counts, breakdown }`.
**`GET /alerts/inbox`** returns `AlertInboxDto` `{read: string[], dismissed: string[]}`.
**`PUT /alerts/inbox`** body (each array: strings 1-200 chars, max 500, default `[]`):
| Field | Effect |
|---|---|
| `read` | keys added to read |
| `dismissed` | keys added to dismissed |
| `restore` | keys removed from dismissed (un-dismiss) |

Returns the updated AlertInboxDto. Fixture of an empty inbox: `{"read":[],"dismissed":[]}`.

### 2.18 Upcoming and timeline
**`GET /upcoming?days=7`** EMIs, loan receipts and subscription renewals due in the window (overdue included). `days` int 1-90, default 7.
**`GET /timeline?cursor=yyyy-MM&limit=3`** monthly chapters newest first; `{ months, chapters, nextCursor }`. `month=yyyy-MM` returns a single chapter. `limit` 1-6 default 3.

### 2.19 Export
**`GET /export`** JSON export document (CSV/PDF are client-side).
| Param | Type | Rules |
|---|---|---|
| `from`*, `to`* | date | `to >= from`; range < 3 years |
| `modules` | csv | transactions, budgets, goals, emergencyFund, loans, subscriptions, pending, assets (>= 1 if given) |
| `categoryIds` | csv | <= 200 ids |

More than 20,000 transactions in range: 422 with a "choose a shorter range" message.

### 2.20 Audit
**`GET /audit?limit=&before=`** activity log, newest first. Item: `{id (string), actionId, summary, channel, confirmedBy, succeeded, failure: {code,message}|null, recordIds, at}`. Response `{ items, nextBefore }`. Fixture (trimmed):
```json
{"items":[{"id":"60","actionId":"transactions.create","summary":"Spent ₹42.75","channel":"ui","confirmedBy":null,"succeeded":true,"failure":null,"recordIds":["tx_10"],"at":"2026-10-11T19:01:16.158Z"},{"id":"59","actionId":"assets.delete","summary":"Deleted Old bike","channel":"ui","confirmedBy":"user","succeeded":true,"failure":null,"recordIds":["asset_2"],"at":"2026-10-11T19:01:16.130Z"}],"nextBefore":"10"}
```

### 2.21 Users search
**`GET /users/search?q=`** FiNN users by name or handle (for shared pending items). `q` <= 60; trimmed length < 2 returns `{items: []}`; max 10 results; exposes only name, handle, phone hint. Fixture:
```json
{"items":[{"id":"00000000-0000-4000-8000-00000000000b","name":"Bob","handle":"@bob","phoneHint":null}]}
```
Use `id` as `linkedUserId` in `pending.create`/`pending.split`.

### 2.22 Agent LLM relay
**`POST /agent/completions`** (+ `OPTIONS` preflight). Relay for the in-app agent (orchestrated by the Flutter app in
`lib/agent/`): the app sends an OpenAI-compatible Chat Completions request, the server adds the secret OpenAI key and
forwards it to `POST {OPENAI_BASE_URL}/chat/completions` (OpenAI). The server never executes tools, never stores the
conversation and never logs prompt, message or output content (only request id, hashed user, upstream status, latency
and token counts). Tool calls returned in `message.tool_calls` are run by the app through the normal action/plan
endpoints. No streaming.

Guardrails (`server/agent/guardrails.ts`; the app answers in scope only): the server pins a scope policy in front of
`messages[0]` (added as the system message when there is none); the user's latest message is refused without a provider
call when it asks for code, app internals or secrets or tries to override the rules; with `AGENT_MODERATION=on`
(default) OpenAI moderation screens it in parallel (an outage never blocks); a reply whose text (plan fields, content,
tool arguments) carries code, a secret or the instructions is replaced. A refusal is a normal 200 with
`message.content` = `{"ops":[],"reply":"<refusal>"}` (plain text when no `response_format`), `tool_calls: []`, and
`guardrail` = `code` | `internals` | `injection` | `moderation` | `secret` | `leak`. Only the rule name is logged.

Body (strict: any other top-level key, e.g. `model`, `user`, `safety_identifier`, `service_tier`, `stream`,
`reasoning_effort`, `prompt_cache_options`, `prompt_cache_key`, is 422; max 600,000 bytes):
| Field | Type | Rules |
|---|---|---|
| `messages`* | array | 1-200 items, each one of the shapes below; a `system` message is only allowed as `messages[0]` |
| `tools` | array | 0-64 `{ type: "function", function: { name, description, parameters } }`; `name` `^[a-zA-Z0-9_-]{1,64}$`, `description` <= 2,000, `parameters` JSON-schema object. Any other tool type (`browser_search`, `code_interpreter`, `mcp`, …) is 422 |
| `tool_choice` | enum | `auto`, `none`, `required` (provider default when omitted) |
| `parallel_tool_calls` | bool | forwarded only when sent |
| `max_completion_tokens` | int | 1..`AGENT_MAX_OUTPUT_TOKENS` (default and ceiling) |
| `response_format` | object | JSON output only: `{ type: "json_object" }` or `{ type: "json_schema", json_schema: { name, schema, strict?, description? } }` (the agent's plan uses `json_object`); anything else is 422 |

Messages:
| Shape | Limits |
|---|---|
| `{ role: "system", content }` | first message only; `content` 1-20,000 |
| `{ role: "user", content }` | `content` <= 8,000 |
| `{ role: "assistant", content?, tool_calls? }` | `content` string <= 8,000 or `null`; `tool_calls` <= 16 of `{ id, type: "function", function: { name, arguments } }`, `id` 1-128, `arguments` (JSON string) <= 20,000 |
| `{ role: "tool", tool_call_id, name?, content }` | `tool_call_id` 1-128, `content` <= 20,000 |

The server always sets `model` (`OPENAI_MODEL`; on a provider 429 the same request goes to each
`OPENAI_FALLBACK_MODELS` entry in turn, and a model is skipped while its `retry-after` lasts), `max_completion_tokens` (requested value capped at
`AGENT_MAX_OUTPUT_TOKENS`, or the cap), `reasoning_effort` (`OPENAI_REASONING_EFFORT`; not sent when `off`) and
`safety_identifier` (hash of the user id). `tools`/`tool_choice`/`parallel_tool_calls` are omitted when `tools` is empty.
Prompt caching (`OPENAI_PROMPT_CACHE`, default `explicit`): the server sends `prompt_cache_options: { mode: "explicit" }` and
turns the system message into one text part carrying `prompt_cache_breakpoint: { mode: "explicit" }`. The agent's system
message is static (identical for every user and day), so it is written to the cache once and read back at the cached
rate; per-request messages after it are never written to the cache (on GPT-5.6+ a cache write costs 1.25× input).
`implicit` leaves caching to the provider.

Response (trimmed from `choices[0]`; `reasoning` and any other provider fields are dropped):
```json
{"id":"chatcmpl_1","finish_reason":"tool_calls",
 "message":{"content":null,"tool_calls":[{"id":"call_1","type":"function","function":{"name":"list_goals","arguments":"{}"}}]},
 "usage":{"prompt_tokens":10,"completion_tokens":5,"total_tokens":15,"cached_tokens":0,"cache_write_tokens":0,"reasoning_tokens":2}}
```
`usage.cached_tokens` / `cache_write_tokens` / `reasoning_tokens` come from the provider's token details (0 when absent).
`message.refusal` is present only when the model refused.
`message.tool_calls` is always an array (empty when the model answered in text); `usage` may be `null`. Append the
assistant message (with its `tool_calls`) and one `role: "tool"` message per call to `messages` for the next turn.

Errors:
| Situation | code | HTTP | retryable | details |
|---|---|---|---|---|
| `OPENAI_API_KEY` not set | `unavailable` | 503 | false | `{ reason: "notConfigured" }` "The assistant is not configured on this server." |
| Per-user limit (`AGENT_RATE_LIMIT_PER_MINUTE`, `AGENT_DAILY_REQUEST_LIMIT`; in-memory, per server instance) | `unavailable` | 503 | true | `{ reason: "rateLimited", retryAfterSeconds }` |
| Provider 429 (or 498 capacity) on the main model and every fallback | `unavailable` | 503 | true | `{ reason: "providerRateLimited", retryAfterSeconds? }` (soonest `retry-after` or remaining cooldown, 1-3600) |
| Provider 400 `tool_use_failed` (model produced an invalid tool call; Groq-style providers) | `unknown` | 500 | true | `{ reason: "toolCallFailed" }` "The assistant made a malformed request. Please try again." |
| Provider 413 | `validation` | 422 | false | `{ reason: "tooLarge" }` "This conversation is too long. Start a new chat." |
| Provider timeout (`OPENAI_TIMEOUT_MS`) or network error | `unavailable` | 503 | true | `{ reason: "timeout" \| "network" }` |
| Provider 5xx | `unavailable` | 503 | true | — |
| Provider 401/403 (bad server key) | `unavailable` | 503 | false | `{ reason: "notConfigured" }` |
| Other provider 4xx | `unknown` | 500 | false | `{ upstreamStatus }` |
| Provider 200 that is not JSON or has no `choices[0].message` | `unknown` | 500 | true | — |

Provider error bodies are never passed through.

### 2.23 Agent history
What the user asked the in-app agent to do and what actually happened, for the user's own review. Entries are written
only by `POST /plans/execute` with `history` (2.6), from the server's step reports; they are never sent to the LLM.
Kept 180 days (pruned on write) and removed with the account.

**`GET /agent/history?limit=&before=&status=`**: newest first. `limit` 1-50 (default 20); `before` = `nextBefore` of the previous
page; `status` = `completed | partial | failed | declined`. Response:
```json
{"items":[{"id":"run_m2x9k1","request":"got 5k salary yesterday, gave 300 to Utsav, protein powder 5000",
  "status":"completed","summary":"3 of 3 saved","notes":[],
  "operations":[{"ref":"1a2b3c-0","actionId":"transactions.create","summary":"Received ₹5,000","status":"saved","recordIds":["tx_9"]}],
  "createdAt":"2026-10-13T15:02:11.000Z","updatedAt":"2026-10-13T15:02:11.000Z"}],"nextBefore":null}
```
Turn `status` is judged on the operations the user approved: `completed` (all saved), `partial` (some saved), `failed` (none
saved), `declined` (none approved). Operation `status`: `saved | alreadySaved` (replayed) `| declined | failed | skipped`
(a dependency was not saved) `| changed` (the record changed after approval); `message` explains failures.

**`DELETE /agent/history`**: clears the caller's history; financial records are not touched. Response `{ deleted }`.
