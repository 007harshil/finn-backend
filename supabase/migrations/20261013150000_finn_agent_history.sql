-- Agent history: what the user asked the in-app agent to do and what actually
-- happened, for the user's own review (Assistant → History).
--
-- One row per agent turn that proposed changes. It is written by
-- POST /plans/execute from the server's own step outcomes, so a change is only
-- ever listed as saved when it was. Each operation keeps its summary, status
-- and the ids of the records it touched, never a copy of the records.
-- History is never sent to the model; the app reads it only when the user asks.
-- Rows older than 180 days are pruned on write (like idempotency keys), and
-- deleting the account removes them (FK cascade).

create table public.agent_runs (
  user_id uuid not null references finn_auth.users (id) on delete cascade,
  id text not null check (id ~ '^[A-Za-z0-9._-]{8,64}$'),
  seq bigint generated always as identity,
  request text not null check (char_length(request) between 1 and 500),
  status text not null check (status in ('completed', 'partial', 'failed', 'declined')),
  summary text not null check (char_length(summary) <= 300),
  operations jsonb not null default '[]' check (jsonb_typeof(operations) = 'array' and jsonb_array_length(operations) <= 40),
  notes text[] not null default '{}' check (cardinality(notes) <= 10),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_id, id)
);
comment on table public.agent_runs is 'In-app agent turns that proposed changes, with the confirmed outcome of each operation. Owner-only; never sent to the LLM.';
create index agent_runs_user_seq_idx on public.agent_runs (user_id, seq desc);

alter table public.agent_runs enable row level security;
revoke all on public.agent_runs from anon, authenticated;
grant select, insert, update, delete on public.agent_runs to finn_api;
create policy agent_runs_owner on public.agent_runs for all to finn_api
  using ((select private.uid()) = user_id) with check ((select private.uid()) = user_id);
