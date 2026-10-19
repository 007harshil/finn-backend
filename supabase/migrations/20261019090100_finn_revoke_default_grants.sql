-- Defence in depth: tables created after 20261012090000_finn_api_role.sql
-- inherit Supabase's default grants to anon and authenticated. RLS (finn_api
-- policies only) already denies those roles every row; revoking the grants
-- keeps the Data API from seeing the tables at all, as the core migration
-- requires for every new table.

do $$
declare
  r text;
begin
  foreach r in array array['anon', 'authenticated'] loop
    if exists (select 1 from pg_roles where rolname = r) then
      execute format('revoke all on table public.money_accounts, public.transfers from %I', r);
    end if;
  end loop;
  foreach r in array array['anon', 'authenticated', 'service_role', 'finn_api'] loop
    if exists (select 1 from pg_roles where rolname = r) then
      execute format('revoke all on table finn_auth.agent_usage from %I', r);
    end if;
  end loop;
end $$;
