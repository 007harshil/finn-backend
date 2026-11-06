-- Shared sliding-window rate limits (sign-in endpoints per client IP, agent
-- relay per user per minute).
--
-- The in-memory limiters in server/auth/rate-limit.ts and
-- server/agent/rate-limit.ts are per server instance, so on Vercel the
-- effective limit grows with the instance count. These rows are shared by
-- every instance: one row per allowed request, keyed by bucket and a SHA-256
-- prefix of the client key (IPs and user ids are never stored in clear).
-- Rows older than the longest window are deleted as keys are touched, plus an
-- occasional bounded sweep.
--
-- Additive only (new table + indexes on an empty table): safe on a live
-- database, no locks on existing tables.
--
-- Lives in finn_auth, which the API's connection role alone can reach (schema
-- usage is revoked from anon, authenticated, service_role and finn_api).

create table finn_auth.rate_limit_hits (
  id bigint generated always as identity primary key,
  bucket text not null check (bucket in ('auth.otp', 'auth.verify', 'auth.refresh', 'agent.completions')),
  key text not null check (length(key) between 1 and 64),
  at timestamptz not null
);
create index rate_limit_hits_bucket_key_at_idx on finn_auth.rate_limit_hits (bucket, key, at);
create index rate_limit_hits_at_idx on finn_auth.rate_limit_hits (at);

alter table finn_auth.rate_limit_hits enable row level security;
revoke all on finn_auth.rate_limit_hits from public;

comment on table finn_auth.rate_limit_hits is 'Allowed requests per rate-limit bucket and hashed client key; shared by every server instance.';
