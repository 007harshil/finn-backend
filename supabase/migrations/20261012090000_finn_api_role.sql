-- Security hardening: only the FiNN API may touch financial tables.
--
-- Supabase exposes the `public` schema through its Data API, and every
-- signed-in user holds a token for the `authenticated` role. The previous
-- policies were written for `authenticated`, so a user could bypass the API
-- (and its validation) by calling the Data API directly. Now:
-- * the API switches to the dedicated NOLOGIN role `finn_api` per request
--   (still with the caller's JWT claims, so RLS keeps isolating users);
-- * `authenticated` and `anon` have no privileges on FiNN tables/functions;
-- * RLS policies apply to `finn_api` and read the caller from the claims
--   (`private.uid()`);
-- * triggers stop field changes the API never makes (identity of shared
--   pending items, other-party edits beyond bookkeeping/write-off).
-- Future migrations that add tables must grant them to `finn_api` and revoke
-- them from `authenticated` (Supabase's default privileges grant new tables).

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'finn_api') then
    create role finn_api nologin noinherit;
  end if;
end $$;
grant finn_api to postgres;

create or replace function private.uid() returns uuid
language sql stable set search_path = '' as $$
  select nullif(nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub', '')::uuid
$$;

-- Directory and access helpers now read the caller through private.uid().
create or replace function private.can_access_pending(owner uuid, pending text) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.pending_payments p
    where p.user_id = owner and p.id = pending
      and (p.user_id = (select private.uid()) or p.shared_with_user_id = (select private.uid()))
  );
$$;

create or replace function private.search_users(query text, max_results integer default 10)
returns table (user_id uuid, display_name text, handle text, phone_hint text)
language sql stable security definer set search_path = '' as $$
  select p.user_id, p.display_name, p.handle, p.phone_hint
  from public.profiles p
  where (select private.uid()) is not null
    and char_length(trim(query)) >= 2
    and p.user_id <> (select private.uid())
    and (p.handle ilike '%' || replace(replace(replace(trim(query), '\', '\\'), '%', '\%'), '_', '\_') || '%'
         or p.display_name ilike '%' || replace(replace(replace(trim(query), '\', '\\'), '%', '\%'), '_', '\_') || '%')
  order by p.display_name, p.handle
  limit least(greatest(max_results, 1), 20);
$$;

create or replace function private.directory_entries(ids uuid[])
returns table (user_id uuid, display_name text, handle text, phone_hint text)
language sql stable security definer set search_path = '' as $$
  select p.user_id, p.display_name, p.handle, p.phone_hint
  from public.profiles p
  where (select private.uid()) is not null and p.user_id = any (ids);
$$;

-- ---------------------------------------------------------------------------
-- Privileges
-- ---------------------------------------------------------------------------

do $$
declare
  tbl text;
  tables text[] := array[
    'profiles', 'user_preferences', 'categories', 'transactions', 'budgets', 'budget_limit_changes', 'goals',
    'emergency_plans', 'savings_movements', 'loans', 'loan_payments', 'subscriptions', 'assets', 'alert_inbox',
    'idempotency_keys', 'audit_log', 'deleted_records', 'pending_payments', 'pending_settlements'
  ];
begin
  foreach tbl in array tables loop
    execute format('revoke all on public.%I from anon, authenticated', tbl);
    execute format('grant select, insert, update, delete on public.%I to finn_api', tbl);
  end loop;
end $$;

revoke all on sequence public.finn_sync_seq from anon, authenticated;
grant usage, select on all sequences in schema public to finn_api;
grant usage on schema public to finn_api;

revoke all on schema private from authenticated;
grant usage on schema private to finn_api;
revoke all on function private.can_access_pending(uuid, text) from public, anon, authenticated;
revoke all on function private.search_users(text, integer) from public, anon, authenticated;
revoke all on function private.directory_entries(uuid[]) from public, anon, authenticated;
revoke all on function private.uid() from public, anon, authenticated;
grant execute on function private.can_access_pending(uuid, text) to finn_api;
grant execute on function private.search_users(text, integer) to finn_api;
grant execute on function private.directory_entries(uuid[]) to finn_api;
grant execute on function private.uid() to finn_api;

-- ---------------------------------------------------------------------------
-- Policies: same rules, now for finn_api
-- ---------------------------------------------------------------------------

do $$
declare
  pol record;
begin
  for pol in
    select policyname, tablename from pg_policies
    where schemaname = 'public' and tablename in (
      'profiles', 'user_preferences', 'categories', 'transactions', 'budgets', 'budget_limit_changes', 'goals',
      'emergency_plans', 'savings_movements', 'loans', 'loan_payments', 'subscriptions', 'assets', 'alert_inbox',
      'idempotency_keys', 'audit_log', 'deleted_records', 'pending_payments', 'pending_settlements')
  loop
    execute format('drop policy %I on public.%I', pol.policyname, pol.tablename);
  end loop;
end $$;

do $$
declare
  tbl text;
begin
  foreach tbl in array array[
    'profiles', 'user_preferences', 'categories', 'transactions', 'budgets', 'budget_limit_changes', 'goals',
    'emergency_plans', 'savings_movements', 'loans', 'loan_payments', 'subscriptions', 'assets', 'alert_inbox',
    'idempotency_keys'
  ]
  loop
    execute format($p$create policy %I on public.%I for all to finn_api
                     using ((select private.uid()) = user_id) with check ((select private.uid()) = user_id)$p$,
                   tbl || '_owner', tbl);
  end loop;
end $$;

create policy audit_log_read on public.audit_log for select to finn_api using ((select private.uid()) = user_id);
create policy audit_log_insert on public.audit_log for insert to finn_api with check ((select private.uid()) = user_id);
create policy deleted_records_read on public.deleted_records for select to finn_api using ((select private.uid()) = user_id);
create policy deleted_records_insert on public.deleted_records for insert to finn_api with check ((select private.uid()) = user_id);

create policy pending_select on public.pending_payments for select to finn_api
  using ((select private.uid()) = user_id or (select private.uid()) = shared_with_user_id);
create policy pending_insert on public.pending_payments for insert to finn_api
  with check ((select private.uid()) = user_id);
create policy pending_update on public.pending_payments for update to finn_api
  using ((select private.uid()) = user_id or (select private.uid()) = shared_with_user_id)
  with check ((select private.uid()) = user_id or (select private.uid()) = shared_with_user_id);
create policy pending_delete on public.pending_payments for delete to finn_api
  using ((select private.uid()) = user_id);

create policy settlements_select on public.pending_settlements for select to finn_api
  using ((select private.uid()) in (user_id, pending_owner_id, shared_with_user_id));
create policy settlements_insert on public.pending_settlements for insert to finn_api
  with check ((select private.uid()) = user_id and private.can_access_pending(pending_owner_id, pending_id));
-- The item owner shares earlier settlements when the item becomes shared.
create policy settlements_update on public.pending_settlements for update to finn_api
  using ((select private.uid()) = pending_owner_id) with check ((select private.uid()) = pending_owner_id);

-- ---------------------------------------------------------------------------
-- Field guards (defence in depth behind the API's own rules)
-- ---------------------------------------------------------------------------

create function private.guard_pending_update() returns trigger
language plpgsql set search_path = '' as $$
declare
  me uuid := private.uid();
begin
  -- Maintenance without a user context (e.g. account deletion cascades).
  if me is null then
    return new;
  end if;
  if new.user_id <> old.user_id or new.direction <> old.direction
     or (old.shared_id is not null and new.shared_id is distinct from old.shared_id)
     or (old.shared_with_user_id is not null and new.shared_with_user_id is distinct from old.shared_with_user_id) then
    raise exception 'The owner and people of a pending item cannot change.' using errcode = '42501';
  end if;
  if me <> old.user_id then
    -- The other person may only record bookkeeping changes, and write the
    -- item off when they are the one who is owed (the owner owes them).
    if (new.counterparty, new.kind, new.original_paise, new.purpose, new.created_date, new.notes,
        new.shared_id, new.shared_with_user_id, new.shared_with_handle, new.split_id, new.split_method,
        new.split_includes_me, new.split_my_share_paise, new.split_part, new.created_at)
       is distinct from
       (old.counterparty, old.kind, old.original_paise, old.purpose, old.created_date, old.notes,
        old.shared_id, old.shared_with_user_id, old.shared_with_handle, old.split_id, old.split_method,
        old.split_includes_me, old.split_my_share_paise, old.split_part, old.created_at) then
      raise exception 'Only the person who created this item can change it.' using errcode = '42501';
    end if;
    if new.is_cancelled is distinct from old.is_cancelled and (old.direction <> 'iOwe' or not new.is_cancelled) then
      raise exception 'Only the person who is owed can write this off.' using errcode = '42501';
    end if;
  end if;
  return new;
end $$;

create trigger pending_payments_guard before update on public.pending_payments
  for each row execute function private.guard_pending_update();

create function private.guard_settlement_update() returns trigger
language plpgsql set search_path = '' as $$
begin
  if private.uid() is null then
    return new;
  end if;
  if (new.user_id, new.id, new.pending_owner_id, new.pending_id, new.amount_paise, new.date, new.method,
      new.transaction_id, new.note, new.created_at)
     is distinct from
     (old.user_id, old.id, old.pending_owner_id, old.pending_id, old.amount_paise, old.date, old.method,
      old.transaction_id, old.note, old.created_at)
     or old.shared_with_user_id is not null then
    raise exception 'Settlements cannot be changed.' using errcode = '42501';
  end if;
  return new;
end $$;

create trigger pending_settlements_guard before update on public.pending_settlements
  for each row execute function private.guard_settlement_update();

revoke all on function private.guard_pending_update() from public, anon, authenticated;
revoke all on function private.guard_settlement_update() from public, anon, authenticated;
