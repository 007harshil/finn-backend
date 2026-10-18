-- Friends and FiNN IDs (docs: finn/docs/FRIENDS.md).
--
-- Shared pending items used to link any user found by name or handle, so a
-- stranger could put an obligation into anyone's account. Now:
-- * every profile has a random, unique, permanent FiNN ID (8 characters from
--   23456789ABCDEFGHJKLMNPQRSTUVWXYZ); other users are found only by exact ID;
-- * friend_requests holds pending requests (a rejected or cancelled request is
--   deleted, so it can be sent again); friendships holds accepted pairs;
-- * private.search_users returns friends only, and private.directory_entries
--   returns only people the caller is connected to (friend, request party or
--   shared pending item);
-- * sharing a pending item with someone needs a friendship (enforced by the
--   API's pending actions).
-- Like the other tables, rows are reachable only by the `finn_api` role.

-- ---------------------------------------------------------------------------
-- FiNN ID
-- ---------------------------------------------------------------------------

-- Eight characters from the random bytes of a v4 UUID (CSPRNG). Bytes 6 and 8
-- carry version/variant bits and are skipped; 256 is a multiple of 32, so
-- byte % 32 is unbiased. Security definer: the uniqueness check must see every
-- profile, not only the caller's (RLS); the unique index is the final guard.
create function private.new_finn_id() returns text
language plpgsql volatile security definer set search_path = '' as $$
declare
  alphabet constant text := '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
  b bytea;
  code text;
  i integer;
begin
  loop
    b := uuid_send(gen_random_uuid());
    code := '';
    foreach i in array array[0, 1, 2, 3, 4, 5, 9, 10] loop
      code := code || substr(alphabet, (get_byte(b, i) % 32) + 1, 1);
    end loop;
    exit when not exists (select 1 from public.profiles p where p.finn_id = code);
  end loop;
  return code;
end;
$$;

alter table public.profiles add column finn_id text;
update public.profiles set finn_id = private.new_finn_id() where finn_id is null;
alter table public.profiles
  alter column finn_id set default private.new_finn_id(),
  alter column finn_id set not null,
  add constraint profiles_finn_id_format check (finn_id ~ '^[2-9A-HJ-NP-Z]{8}$');
create unique index profiles_finn_id_key on public.profiles (finn_id);
comment on column public.profiles.finn_id is 'Public FiNN ID: the only way other users can find this person. Random, unique, never changes.';

-- The API never changes a FiNN ID.
create function private.keep_finn_id() returns trigger
language plpgsql set search_path = '' as $$
begin
  if new.finn_id is distinct from old.finn_id then
    raise exception 'finn_id cannot change' using errcode = '42501';
  end if;
  return new;
end;
$$;
create trigger profiles_keep_finn_id before update of finn_id on public.profiles
  for each row execute function private.keep_finn_id();

-- ---------------------------------------------------------------------------
-- friend_requests / friendships
-- ---------------------------------------------------------------------------

create table public.friend_requests (
  id uuid primary key default gen_random_uuid(),
  requester_id uuid not null references finn_auth.users (id) on delete cascade,
  addressee_id uuid not null references finn_auth.users (id) on delete cascade,
  created_at timestamptz not null default now(),
  constraint friend_requests_not_self check (requester_id <> addressee_id)
);
comment on table public.friend_requests is 'Pending friend requests. Accepting moves the pair to friendships; rejecting or cancelling deletes the row.';
-- One open request per pair, whichever side sent it.
create unique index friend_requests_pair_key on public.friend_requests (least(requester_id, addressee_id), greatest(requester_id, addressee_id));
create index friend_requests_addressee_idx on public.friend_requests (addressee_id, created_at desc);
create index friend_requests_requester_idx on public.friend_requests (requester_id, created_at desc);

create table public.friendships (
  user_low uuid not null references finn_auth.users (id) on delete cascade,
  user_high uuid not null references finn_auth.users (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (user_low, user_high),
  constraint friendships_ordered check (user_low < user_high)
);
comment on table public.friendships is 'Accepted friendships, one row per pair (user_low < user_high). Needed to share a pending item.';
create index friendships_high_idx on public.friendships (user_high);

alter table public.friend_requests enable row level security;
alter table public.friendships enable row level security;
create policy friend_requests_parties on public.friend_requests for select to finn_api
  using ((select private.uid()) in (requester_id, addressee_id));
create policy friend_requests_send on public.friend_requests for insert to finn_api
  with check ((select private.uid()) = requester_id);
create policy friend_requests_close on public.friend_requests for delete to finn_api
  using ((select private.uid()) in (requester_id, addressee_id));
create policy friendships_parties on public.friendships for select to finn_api
  using ((select private.uid()) in (user_low, user_high));
create policy friendships_add on public.friendships for insert to finn_api
  with check ((select private.uid()) in (user_low, user_high));
create policy friendships_remove on public.friendships for delete to finn_api
  using ((select private.uid()) in (user_low, user_high));

revoke all on public.friend_requests from anon, authenticated;
revoke all on public.friendships from anon, authenticated;
grant select, insert, delete on public.friend_requests to finn_api;
grant select, insert, delete on public.friendships to finn_api;

-- ---------------------------------------------------------------------------
-- Directory functions
-- ---------------------------------------------------------------------------

-- Exact FiNN ID only: never a partial, name or handle match.
create function private.find_user_by_finn_id(code text)
returns table (user_id uuid, display_name text, finn_id text)
language sql stable security definer set search_path = '' as $$
  select p.user_id, p.display_name, p.finn_id
  from public.profiles p
  where (select private.uid()) is not null and p.finn_id = code;
$$;

-- Name and FiNN ID of the people the caller has an open request with.
create function private.request_entries()
returns table (user_id uuid, display_name text, finn_id text)
language sql stable security definer set search_path = '' as $$
  select p.user_id, p.display_name, p.finn_id
  from public.friend_requests r
  join public.profiles p
    on p.user_id = case when r.requester_id = (select private.uid()) then r.addressee_id else r.requester_id end
  where (select private.uid()) in (r.requester_id, r.addressee_id);
$$;

create function private.friend_entries()
returns table (user_id uuid, display_name text, handle text, phone_hint text, finn_id text, since timestamptz)
language sql stable security definer set search_path = '' as $$
  select p.user_id, p.display_name, p.handle, p.phone_hint, p.finn_id, f.created_at
  from public.friendships f
  join public.profiles p
    on p.user_id = case when f.user_low = (select private.uid()) then f.user_high else f.user_low end
  where (select private.uid()) in (f.user_low, f.user_high);
$$;

-- Friends only (name, handle or FiNN ID). Kept for compatibility; the API
-- filters private.friend_entries() itself.
create or replace function private.search_users(query text, max_results integer default 10)
returns table (user_id uuid, display_name text, handle text, phone_hint text)
language sql stable security definer set search_path = '' as $$
  select f.user_id, f.display_name, f.handle, f.phone_hint
  from private.friend_entries() f
  where char_length(trim(query)) >= 2
    and (f.handle ilike '%' || replace(replace(replace(trim(query), '\', '\\'), '%', '\%'), '_', '\_') || '%'
         or f.display_name ilike '%' || replace(replace(replace(trim(query), '\', '\\'), '%', '\%'), '_', '\_') || '%')
  order by f.display_name, f.handle
  limit least(greatest(max_results, 1), 20);
$$;

-- Only people the caller is connected to: a friend, an open request, or a
-- shared pending item (either side).
create or replace function private.directory_entries(ids uuid[])
returns table (user_id uuid, display_name text, handle text, phone_hint text)
language sql stable security definer set search_path = '' as $$
  select p.user_id, p.display_name, p.handle, p.phone_hint
  from public.profiles p
  where (select private.uid()) is not null
    and p.user_id = any (ids)
    and (
      p.user_id = (select private.uid())
      or exists (
        select 1 from public.friendships f
        where f.user_low = least(p.user_id, (select private.uid())) and f.user_high = greatest(p.user_id, (select private.uid()))
      )
      or exists (
        select 1 from public.friend_requests r
        where least(r.requester_id, r.addressee_id) = least(p.user_id, (select private.uid()))
          and greatest(r.requester_id, r.addressee_id) = greatest(p.user_id, (select private.uid()))
      )
      or exists (
        select 1 from public.pending_payments pp
        where (pp.user_id = (select private.uid()) and pp.shared_with_user_id = p.user_id)
           or (pp.user_id = p.user_id and pp.shared_with_user_id = (select private.uid()))
      )
    );
$$;

revoke all on function private.new_finn_id() from public, anon, authenticated;
revoke all on function private.keep_finn_id() from public, anon, authenticated;
revoke all on function private.find_user_by_finn_id(text) from public, anon, authenticated;
revoke all on function private.request_entries() from public, anon, authenticated;
revoke all on function private.friend_entries() from public, anon, authenticated;
grant execute on function private.new_finn_id() to finn_api;
grant execute on function private.find_user_by_finn_id(text) to finn_api;
grant execute on function private.request_entries() to finn_api;
grant execute on function private.friend_entries() to finn_api;
