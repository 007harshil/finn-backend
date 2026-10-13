# FiNN agent integration

The conversational agent is orchestrated by the Flutter app (`lib/agent/`): it builds the prompt, exposes tools, runs the
tool loop and asks the user to approve previews. The backend contributes two things:

1. **LLM relay** — `POST /api/v1/agent/completions` (`server/agent/`, see `docs/API.md` §2.22). The app sends an
   OpenAI-compatible Chat Completions request; the server validates it (function tools only; no client-chosen model,
   streaming or response format), adds the secret `OPENAI_API_KEY`, forwards it to OpenAI (`/chat/completions`) and
   returns a trimmed `choices[0]` (`{ id, finish_reason, message: { content, tool_calls }, usage }`, reasoning
   stripped). It never executes tools, never stores or logs conversation content, and applies a per-user rate limit
   (in-memory, per instance). Without `OPENAI_API_KEY` it answers 503 `unavailable` (not retryable).
2. **The stable interfaces below**, which the app's tools call with the user's own token, exactly like the UI.

There is no speech endpoint; voice, if added, reuses the same flow with `channel: "voice"`.

## One business-logic path

Forms, imports and an agent all execute the same `ActionDefinition`s through `dispatch()`
(`server/actions/dispatcher.ts`). An agent never gets a separate transaction, repayment, settlement or budget rule.

## Discovery → tools

`GET /api/v1/actions` returns every action descriptor:

```json
{ "id": "pending.settle", "module": "pending", "title": "Settle a pending payment",
  "risk": "consequential", "movesMoney": true, "reversible": false,
  "fields": [ { "name": "pendingId", "kind": "id", "required": true, "description": "…" },
              { "name": "amount", "kind": "money", "required": true, "description": "…" } ] }
```

These map directly onto tool definitions. Inputs are validated by the action's zod schema (field-level `fieldErrors`).

## Plan first, execute later

1. The agent turns a request into a plan, e.g. "I paid Rahul 500 and add 2,000 to my Japan goal":
   ```json
   { "planId": "plan_7f3a9c21", "channel": "voice", "steps": [
       { "stepId": "s1", "actionId": "pending.settle", "input": { "pendingId": "pend_…", "amount": "500", "date": "2026-10-10" } },
       { "stepId": "s2", "actionId": "goals.contribute", "input": { "goalId": "goal_…", "amount": "2000", "date": "2026-10-10" } } ] }
   ```
2. **Resolve exact records before planning**: `GET /api/v1/pending/resolve?name=Rahul&direction=iOwe&amount=500`
   returns `found`, `ambiguous` (with candidate ids — the agent must ask, never guess) or `none`. Goals, loans and
   subscriptions are listed by their read endpoints with stable ids.
3. `POST /api/v1/plans/preview` validates every step against current data and returns per-step previews
   (`ready` with a human-readable summary/lines/warnings and a fingerprint, or `invalid` with the failure). Nothing is written.
4. The user approves specific previews. `POST /api/v1/plans/execute` with `approvedFingerprints` runs only those steps,
   in order. Each step reports `succeeded`, `failed`, `invalid`, `skipped` (dependency failed or halted) or `notApproved`
   (never approved, or the record changed after approval: `staleData`).

Interpretation is never permission: agent/voice channels always require an approval matching the exact preview, and
cannot delete records at all.

## Safety properties

| Risk | Safeguard |
|---|---|
| Retried request creates a duplicate expense | Step idempotency key `<planId>:<stepId>`; a retry replays the stored result |
| Ambiguous counterparty | `ambiguous` failure with candidates; actions take exact ids only |
| Data changed between preview and approval | Fingerprint includes record state (`basis`); execution asks again |
| Two writers on the same shared item | Both users locked in sorted order for the whole operation |
| Partial failure | Steps commit independently; the report states exactly what ran; dependants are skipped |
| Over-reach | Channel policy: no deletes from agent/voice; imports only create |

## Adding a new operation

Create a `defineAction` in the owning module (descriptor + zod input + `prepare` + `execute`), add it to the module's
exported list, and write tests. It is automatically discoverable, previewable, idempotent, audited and plan-capable.
