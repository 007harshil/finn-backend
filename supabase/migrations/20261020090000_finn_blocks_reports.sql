-- Blocking users and reporting assistant replies (Google Play user-generated
-- content and AI-generated content policies).
--
-- user_blocks: a block removes the friendship and any open request between
-- the two people, and stops new requests in both directions. The blocked
-- person is not told: looking up the blocker's FiNN ID answers "no user".
-- Only the blocker can see the row, so private.blocked_between() (security
-- definer) answers the "either side blocked?" question for the API.
--
-- agent_reports: a user flags an assistant reply as offensive, harmful or
-- wrong, from inside the app. Owner can insert and read their own reports;
-- the developer reviews them in the dashboard. Deleting the account removes
-- them (FK cascade).
-- Like the other tables, rows are reachable only by the `finn_api` role.

create table public.user_blocks (
  blocker_id uuid not null references finn_auth.users (id) on delete cascade,
  blocked_id uuid not null references finn_auth.users (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (blocker_id, blocked_id),
  constraint user_blocks_not_self check (blocker_id <> blocked_id)
);
comment on table public.user_blocks is 'People a user blocked: no friend requests either way, no new shares. Visible to the blocker only.';
create index user_blocks_blocked_idx on public.user_blocks (blocked_id);

alter table public.user_blocks enable row level security;
revoke all on public.user_blocks from anon, authenticated;
grant select, insert, delete on public.user_blocks to finn_api;
create policy user_blocks_owner on public.user_blocks for all to finn_api
  using ((select private.uid()) = blocker_id) with check ((select private.uid()) = blocker_id);

-- Whether the caller and [other] have blocked each other in either direction.
create function private.blocked_between(other uuid)
returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.user_blocks b
    where (b.blocker_id = (select private.uid()) and b.blocked_id = other)
       or (b.blocker_id = other and b.blocked_id = (select private.uid()))
  );
$$;

-- Name and FiNN ID of the people the caller blocked.
create function private.block_entries()
returns table (user_id uuid, display_name text, finn_id text, since timestamptz)
language sql stable security definer set search_path = '' as $$
  select p.user_id, p.display_name, p.finn_id, b.created_at
  from public.user_blocks b
  join public.profiles p on p.user_id = b.blocked_id
  where b.blocker_id = (select private.uid());
$$;

revoke all on function private.blocked_between(uuid) from public, anon, authenticated;
revoke all on function private.block_entries() from public, anon, authenticated;
grant execute on function private.blocked_between(uuid) to finn_api;
grant execute on function private.block_entries() to finn_api;

create table public.agent_reports (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references finn_auth.users (id) on delete cascade,
  reason text not null check (reason in ('offensive', 'harmful', 'inaccurate', 'other')),
  request text check (char_length(request) <= 500),
  reply text not null check (char_length(reply) between 1 and 4000),
  note text check (char_length(note) <= 500),
  status text not null default 'open' check (status in ('open', 'reviewed')),
  created_at timestamptz not null default now()
);
comment on table public.agent_reports is 'Assistant replies flagged by users from inside the app (Play AI-generated content policy). Reviewed by the developer.';
create index agent_reports_user_idx on public.agent_reports (user_id, created_at desc);
create index agent_reports_open_idx on public.agent_reports (created_at desc) where status = 'open';

alter table public.agent_reports enable row level security;
revoke all on public.agent_reports from anon, authenticated;
grant select, insert on public.agent_reports to finn_api;
create policy agent_reports_owner_read on public.agent_reports for select to finn_api
  using ((select private.uid()) = user_id);
create policy agent_reports_owner_insert on public.agent_reports for insert to finn_api
  with check ((select private.uid()) = user_id);
