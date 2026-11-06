-- Agent quality tracking: which prompt and model planned each agent turn, so
-- a change in outcomes (more declines, more failures) can be traced to the
-- prompt or model change that caused it.
--
-- The app sends its prompt version (`agentPromptVersion`) and the model the
-- relay reported with each history entry. Rows written by older app versions
-- leave these null.
--
-- private.agent_quality_daily is for operators only (finn_api cannot read the
-- private schema). It never exposes requests, notes or record ids: only
-- counts per day, prompt version and model.

alter table public.agent_runs
  add column prompt_version text check (prompt_version ~ '^[A-Za-z0-9._-]{1,40}$'),
  add column model text check (char_length(model) between 1 and 100),
  add column model_calls smallint check (model_calls between 0 and 20);

comment on column public.agent_runs.prompt_version is 'App prompt version (agentPromptVersion) that planned the turn; null for older apps.';
comment on column public.agent_runs.model is 'Model that planned the turn, as the relay reported it (fallbacks included).';
comment on column public.agent_runs.model_calls is 'Model calls the turn made (a retry after unusable output counts).';

create index agent_runs_quality_idx on public.agent_runs (created_at, prompt_version, model);

create or replace view private.agent_quality_daily
with (security_invoker = true) as
select
  date_trunc('day', r.created_at)::date as day,
  coalesce(r.prompt_version, 'unknown') as prompt_version,
  coalesce(r.model, 'unknown') as model,
  count(*) as turns,
  count(*) filter (where r.status = 'completed') as completed,
  count(*) filter (where r.status = 'partial') as partial,
  count(*) filter (where r.status = 'failed') as failed,
  count(*) filter (where r.status = 'declined') as declined,
  round(avg(r.model_calls)::numeric, 2) as avg_model_calls,
  sum(jsonb_array_length(r.operations)) as operations,
  sum((select count(*) from jsonb_array_elements(r.operations) o where o ->> 'status' = 'declined')) as operations_declined,
  sum((select count(*) from jsonb_array_elements(r.operations) o where o ->> 'status' = 'failed')) as operations_failed,
  round(
    sum((select count(*) from jsonb_array_elements(r.operations) o where o ->> 'status' = 'declined'))::numeric
      / nullif(sum(jsonb_array_length(r.operations)), 0),
    3
  ) as decline_rate
from public.agent_runs r
group by 1, 2, 3;

comment on view private.agent_quality_daily is 'Operator view: agent turns and operation outcomes per day, prompt version and model. Counts only.';
revoke all on private.agent_quality_daily from public, anon, authenticated, finn_api;
