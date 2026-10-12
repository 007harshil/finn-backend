# FiNN API — client contract (v1)

Base URL: `FINN_API_URL` (e.g. `https://api.example.com`), all paths under `/api/v1`.

## Authentication
- Supabase Auth (project `https://xeqhygypqyyyoortalod.supabase.co`), passwordless **email OTP**:
  `signInWithOtp(email)` then `verifyOTP(email, token, type: email)`. The Flutter client uses the
  publishable key `sb_publishable_1iDr4zeoG6ykOvNETNF72w_HOTRv0tC` (public by design).
- Every request: `Authorization: Bearer <access_token>`. On `401` (`code: unauthenticated`) refresh the session once,
  then sign out.
- First authenticated request creates the account (profile with a generated `@handle`, preferences, standard categories with
  the same fixed ids as the app's seed: `cat_food`, `cat_sys_emi`, …).

## Envelope
- Success: `{ "data": <payload> }`.
- Failure: `{ "error": { "code", "message", "fieldErrors"?, "retryable", "details"? } }` with HTTP status:
  validation 422, notFound 404, conflict/staleData/duplicate 409, insufficientFunds 422, ambiguous 422,
  confirmationRequired 428, notPermitted 403, unauthenticated 401, unavailable 503, unknown/storage 500.
  `code` values equal the Flutter `FailureCode` names (plus `unauthenticated`). `fieldErrors` keys are action input field names.
- Money: integer paise in records (`amountPaise`, …). Action INPUT money is rupees (decimal string `"1250.50"` or number), as
  `ActionInput.toJson()` already produces. Dates `yyyy-MM-dd`, instants ISO-8601.

## Records = Flutter DTOs
Records returned by the API have exactly the JSON shape of `lib/data/dto/dtos.dart` (`TransactionDto`, `CategoryDto`, …,
`ProfileDto` `{exists:false}|{exists:true,...}`, `EmergencyPlanDto` `{configured:false}|{configured:true,...}`,
`AlertInboxDto` `{read:[...],dismissed:[...]}`), so `XxxDto.fromJson` decodes them unchanged.

Shared pending items: the person an item is shared with receives it as a normal pending record with id `mir_<sharedId>`
(direction reversed, `link.createdByMe=false`); settlements recorded by the other person arrive with `mir_<id>` ids and
`transactionId: null`. The server does all mirroring — the client never writes the shared ledger.

## Sync — `GET /sync?since=<cursor>&limit=<n>`
Omit `since` for a full load. Response `data`:
```json
{ "cursor": "1234", "hasMore": false,
  "collections": { "transactions": { "upserted": [TransactionDto...], "deleted": ["tx_1"] }, "categories": {...},
    "budgets": {...}, "goals": {...}, "savingsMovements": {...}, "loans": {...}, "loanPayments": {...},
    "subscriptions": {...}, "pending": {...}, "settlements": {...}, "assets": {...} },
  "values": { "profile": ProfileDto, "emergencyPlan": EmergencyPlanDto, "preferences": {...},
              "alertInbox": AlertInboxDto, "me": { "id", "name", "handle", "phoneHint" } } }
```
Collections/values appear only when changed. Repeat with the returned cursor while `hasMore`. Apply upserts by id and
deletions by id. Full load always includes `emergencyPlan` and `alertInbox`.

## Actions (all writes)
- `GET /actions` → `{ actions: [ActionDescriptor JSON] }` (same shape as `ActionRegistry.describe()`).
- `POST /actions/{actionId}/preview` body `{ "input": <ActionInput.toJson()>, "channel": "ui" }` →
  `{ preview: { actionId, title, summary, lines:[{label,value,emphasis}], warnings:[], fingerprint, requiresConfirmation } }`.
- `POST /actions/{actionId}` header `Idempotency-Key: <8–128 chars [A-Za-z0-9._:-]>`, body
  `{ "input": {...}, "confirmation": { "fingerprint": "...", "confirmedBy": "user" } | null, "channel": "ui" }` →
  - `{ status: "needsConfirmation", actionId, preview }` — show review, then repeat with the SAME key and
    `confirmation.fingerprint = preview.fingerprint`;
  - `{ status: "completed", actionId, result: <record DTO or action output>, preview, replayed, changes: <sync payload> }` —
    apply `changes` exactly like a sync page, but do NOT advance the sync cursor from it (other changes, e.g. a
    counterparty's settlement, may sit between the old cursor and `changes.cursor`); run a normal incremental sync next.
  Action ids and input JSON are identical to the Flutter actions (`transactions.create`, `loans.recordPayment`, …).
- Plans: `POST /plans/preview` `{ planId, channel, steps:[{stepId, actionId, input, dependsOn}] }` →
  `{ steps:[{stepId, actionId, status, preview?, failure?}] }`; `POST /plans/execute` same + `approvedFingerprints`.

## Other reads
`GET /transactions?...` (keyset pages), `GET /categories`, `GET /audit` (activity log), `GET /users/search?q=` (≥ 2 chars →
`{items:[{id,name,handle,phoneHint}]}`), `GET /me`, `GET|PATCH /preferences`, module summaries (`/budgets`, `/goals`,
`/emergency-fund`, `/loans`, `/subscriptions`, `/pending`, `/assets`, `/dashboard`, `/analytics/...`, `/alerts`,
`/net-worth`) — the app may keep computing its own projections from synced records; the server uses the same rules.

## Alert inbox
`PUT /alerts/inbox` body `{ "read": [keys], "dismissed": [keys], "restore": [keys] }` (read/dismissed keys to ADD;
`restore` removes keys from dismissed) → AlertInboxDto.

## One-time upload of on-device data — `POST /import`
Only for an account with no financial records yet (else `409 conflict`). Header `Idempotency-Key`. Body: the local
store's DTO JSON:
```json
{ "categories": [CategoryDto], "transactions": [...], "budgets": [...], "goals": [...], "savingsMovements": [...],
  "loans": [...], "loanPayments": [...], "subscriptions": [...], "pending": [...], "settlements": [...],
  "assets": [...], "profile": ProfileDto, "emergencyPlan": EmergencyPlanDto }
```
Pending items: send own items only (not mirrors); `link` is dropped (sharing is re-established online). Validated and
written atomically (all or nothing) with the client ids preserved. Response = full sync payload.
