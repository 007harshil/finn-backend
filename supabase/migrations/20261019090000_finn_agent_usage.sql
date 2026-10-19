-- Durable daily usage counters for the operator-paid agent providers
-- (OpenAI completions, Groq transcription).
--
-- The in-memory limiters in server/agent/rate-limit.ts are per server instance,
-- so on serverless they multiply with the instance count, and new accounts are
-- free to create. These counters are shared by every instance: one row per
-- user, UTC day and kind holds the request count and the request bytes, and the
-- relay also checks the sum across all users against a global daily cap.
--
-- Lives in finn_auth, which the API's connection role alone can reach (schema
-- usage is revoked from anon, authenticated, service_role and finn_api).

create table finn_auth.agent_usage (
  user_id uuid not null references finn_auth.users (id) on delete cascade,
  day date not null,
  kind text not null check (kind in ('completion', 'transcription')),
  requests integer not null default 0 check (requests >= 0),
  bytes bigint not null default 0 check (bytes >= 0),
  primary key (user_id, day, kind)
);
create index agent_usage_day_kind_idx on finn_auth.agent_usage (day, kind);

comment on table finn_auth.agent_usage is 'Per-user daily agent provider usage (requests, request bytes); durable across server instances.';
