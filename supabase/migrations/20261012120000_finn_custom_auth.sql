-- FiNN's own email-OTP authentication replaces Supabase Auth.
--
-- The API emails one-time codes (nodemailer), stores only their HMAC, and
-- issues its own short-lived access JWTs plus rotating refresh tokens. User
-- identity moves from auth.users to finn_auth.users; every user_id foreign key
-- is repointed there with its ON DELETE action unchanged. The finn_auth schema
-- is not exposed through the Supabase Data API and is reachable only by the
-- API's connection role (never by finn_api, anon or authenticated).

create schema if not exists finn_auth;
revoke all on schema finn_auth from public;
do $$
declare
  r text;
begin
  foreach r in array array['anon', 'authenticated', 'service_role', 'finn_api'] loop
    if exists (select 1 from pg_roles where rolname = r) then
      execute format('revoke all on schema finn_auth from %I', r);
    end if;
  end loop;
end $$;

create table finn_auth.users (
  id uuid primary key default gen_random_uuid(),
  email text not null unique check (email = lower(btrim(email)) and char_length(email) between 3 and 254),
  created_at timestamptz not null default now(),
  last_sign_in_at timestamptz
);
comment on table finn_auth.users is 'FiNN accounts. Identity is the email address, proven by an emailed one-time code.';

-- One row per emailed code. Only an HMAC of the code is kept.
create table finn_auth.email_otps (
  id bigint generated always as identity primary key,
  email text not null check (email = lower(btrim(email))),
  code_hash text not null,
  expires_at timestamptz not null,
  attempts integer not null default 0 check (attempts >= 0),
  consumed_at timestamptz,
  created_at timestamptz not null default now()
);
create index email_otps_email_created_idx on finn_auth.email_otps (email, created_at desc);
create index email_otps_created_idx on finn_auth.email_otps (created_at);

-- Rotating refresh tokens. Tokens of one sign-in share a family; presenting a
-- token that was already rotated revokes the whole family (theft detection).
create table finn_auth.refresh_tokens (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references finn_auth.users (id) on delete cascade,
  family_id uuid not null,
  token_hash text not null unique,
  expires_at timestamptz not null,
  rotated_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz not null default now()
);
create index refresh_tokens_user_idx on finn_auth.refresh_tokens (user_id);
create index refresh_tokens_family_idx on finn_auth.refresh_tokens (family_id);
create index refresh_tokens_expires_idx on finn_auth.refresh_tokens (expires_at);

revoke all on all tables in schema finn_auth from public;
do $$
declare
  r text;
begin
  foreach r in array array['anon', 'authenticated', 'service_role', 'finn_api'] loop
    if exists (select 1 from pg_roles where rolname = r) then
      execute format('revoke all on all tables in schema finn_auth from %I', r);
      execute format('revoke all on all sequences in schema finn_auth from %I', r);
    end if;
  end loop;
end $$;

-- Keep any existing accounts (same ids, so their data stays attached).
insert into finn_auth.users (id, email, created_at)
select u.id, lower(btrim(u.email)), now()
from auth.users u
where u.email is not null and btrim(u.email) <> ''
on conflict do nothing;

-- Repoint every public foreign key from auth.users to finn_auth.users.
do $$
declare
  c record;
  def text;
begin
  for c in
    select con.conname, con.conrelid::regclass as tbl, pg_get_constraintdef(con.oid) as condef
    from pg_constraint con
    where con.contype = 'f'
      and con.confrelid = 'auth.users'::regclass
      and con.connamespace = 'public'::regnamespace
  loop
    def := replace(c.condef, 'REFERENCES auth.users(id)', 'REFERENCES finn_auth.users(id)');
    if def = c.condef then
      raise exception 'Unexpected foreign key definition on %: %', c.tbl, c.condef;
    end if;
    execute format('alter table %s drop constraint %I', c.tbl, c.conname);
    execute format('alter table %s add constraint %I %s', c.tbl, c.conname, def);
  end loop;
end $$;

-- Tombstones are written only for accounts that still exist.
create or replace function private.record_tombstone() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  coll text := tg_argv[0];
  other_user uuid;
  other_id text;
begin
  -- Account deletion cascades through every table: only users that still
  -- exist get tombstones.
  if exists (select 1 from finn_auth.users where id = old.user_id) then
    insert into public.deleted_records (user_id, collection, record_id) values (old.user_id, coll, old.id);
  end if;
  if coll = 'pending' then
    other_user := old.shared_with_user_id;
    other_id := 'mir_' || old.shared_id;
  elsif coll = 'settlements' then
    -- Recorder sees the raw id; the other party sees mir_<id>.
    other_user := case when old.pending_owner_id <> old.user_id then old.pending_owner_id else old.shared_with_user_id end;
    other_id := 'mir_' || old.id;
  end if;
  if other_user is not null and exists (select 1 from finn_auth.users where id = other_user) then
    insert into public.deleted_records (user_id, collection, record_id) values (other_user, coll, other_id);
  end if;
  return old;
end $$;
revoke all on function private.record_tombstone() from public, anon, authenticated;
