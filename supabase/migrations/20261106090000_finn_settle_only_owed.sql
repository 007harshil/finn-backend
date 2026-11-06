-- Only the person who is owed records settlements on a shared pending item,
-- whoever created it, so the payer can never clear it without the lender
-- knowing. Private items (no shared_with_user_id) are settled by their owner.
-- Directions are stored from the owner's (user_id's) point of view.

create or replace function private.can_settle_pending(owner uuid, pending text) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.pending_payments p
    where p.user_id = owner and p.id = pending
      and (
        (p.shared_with_user_id is null and p.user_id = (select private.uid()))
        or (p.user_id = (select private.uid()) and p.direction = 'owedToMe')
        or (p.shared_with_user_id = (select private.uid()) and p.direction = 'iOwe')
      )
  );
$$;

revoke all on function private.can_settle_pending(uuid, text) from public, anon, authenticated;
grant execute on function private.can_settle_pending(uuid, text) to finn_api;

drop policy settlements_insert on public.pending_settlements;
create policy settlements_insert on public.pending_settlements for insert to finn_api
  with check ((select private.uid()) = user_id and private.can_settle_pending(pending_owner_id, pending_id));
