-- One payment split across several accounts stays one transaction: the parts
-- live on the row as [{"accountId": text, "amountPaise": bigint}, ...]
-- (two or more, adding up to amount_paise; account_id is the first part's
-- account). Null when one account carried the whole amount. Balances count
-- each part on its own account (server/finance/ledger.ts).

alter table public.transactions
  add column account_splits jsonb
  constraint transactions_account_splits_shape check (
    account_splits is null
    or (jsonb_typeof(account_splits) = 'array' and jsonb_array_length(account_splits) >= 2)
  );

comment on column public.transactions.account_splits is
  'Parts of a payment split across accounts: [{accountId, amountPaise}], two or more, summing to amount_paise. Null for single-account transactions.';

-- Finds the transactions that touch an account through a split part.
create index transactions_account_splits_idx on public.transactions using gin (account_splits jsonb_path_ops)
  where account_splits is not null;

-- Deleting an account unlinks the settlements paid through it (account_id and
-- transaction_id -> null) so the pending balance does not change. The guard
-- refused that unlink, so deleting an account with a settlement failed.
-- Unlinking is now the one change allowed; everything else stays frozen.
create or replace function private.guard_settlement_update() returns trigger
language plpgsql set search_path = '' as $$
begin
  if private.uid() is null then
    return new;
  end if;
  if (new.user_id, new.id, new.pending_owner_id, new.pending_id, new.amount_paise, new.date, new.method,
      new.note, new.created_at)
     is distinct from
     (old.user_id, old.id, old.pending_owner_id, old.pending_id, old.amount_paise, old.date, old.method,
      old.note, old.created_at)
     or (new.transaction_id is distinct from old.transaction_id and new.transaction_id is not null)
     or (new.account_id is distinct from old.account_id and new.account_id is not null)
     or (old.shared_with_user_id is not null
         and (new.shared_with_user_id is distinct from old.shared_with_user_id or new.channel is distinct from old.channel)) then
    raise exception 'Settlements cannot be changed.' using errcode = '42501';
  end if;
  return new;
end $$;
