-- Money accounts: user-owned cash / bank / card accounts replace the fixed
-- payment-method enum (docs: finn/docs/MONEY_ACCOUNTS.md).
--
-- * money_accounts and transfers (sync collections `moneyAccounts`, `transfers`).
-- * transactions gain account_id (required) and channel; subscriptions and
--   pending_settlements gain account_id (+ channel for settlements).
-- * Every existing user gets one Cash account (`acc_cash`) that receives the
--   old opening balance and every old transaction, so totals do not change.
-- * The legacy payment_method / method columns stay (no longer written).
-- Like the other tables, rows are reachable only by the `finn_api` role
-- (RLS keyed on private.uid()); `authenticated` has no policy, so RLS denies it.

-- ---------------------------------------------------------------------------
-- money_accounts
-- ---------------------------------------------------------------------------

create table public.money_accounts (
  user_id uuid not null references finn_auth.users (id) on delete cascade,
  id text not null check (char_length(id) between 1 and 64),
  name text not null check (char_length(name) between 1 and 40),
  kind text not null check (kind in ('cash', 'bank', 'debitCard', 'creditCard', 'promoCard', 'otherCard')),
  institution text check (char_length(institution) <= 40),
  last4 text check (last4 ~ '^[0-9]{4}$'),
  opening_paise bigint not null default 0 check (opening_paise >= 0),
  opening_date date not null,
  credit_limit_paise bigint check (credit_limit_paise > 0),
  is_default boolean not null default false,
  is_archived boolean not null default false,
  sort_order integer not null default 0,
  note text check (char_length(note) <= 200),
  version integer not null default 1 check (version >= 1),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  sync_seq bigint not null default nextval('public.finn_sync_seq'),
  primary key (user_id, id),
  constraint money_accounts_last4_cards check (last4 is null or kind not in ('cash', 'bank')),
  constraint money_accounts_limit_credit check (credit_limit_paise is null or kind = 'creditCard'),
  constraint money_accounts_default_active check (not (is_default and is_archived))
);
comment on table public.money_accounts is 'User-owned money accounts (cash, bank, cards). Credit cards hold an amount owed (opening_paise = owed on opening_date); every other kind holds money.';
create unique index money_accounts_one_default_idx on public.money_accounts (user_id) where is_default;
create index money_accounts_user_sync_idx on public.money_accounts (user_id, sync_seq);

-- ---------------------------------------------------------------------------
-- transfers
-- ---------------------------------------------------------------------------

create table public.transfers (
  user_id uuid not null references finn_auth.users (id) on delete cascade,
  id text not null check (char_length(id) between 1 and 64),
  from_account_id text not null,
  to_account_id text not null,
  amount_paise bigint not null check (amount_paise > 0),
  date date not null,
  channel text check (char_length(channel) <= 30),
  note text check (char_length(note) <= 500),
  version integer not null default 1 check (version >= 1),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  sync_seq bigint not null default nextval('public.finn_sync_seq'),
  primary key (user_id, id),
  foreign key (user_id, from_account_id) references public.money_accounts (user_id, id),
  foreign key (user_id, to_account_id) references public.money_accounts (user_id, id),
  constraint transfers_distinct check (from_account_id <> to_account_id)
);
comment on table public.transfers is 'Money moved between the user''s own accounts (ATM withdrawal, credit-card bill payment). Not income or spending.';
create index transfers_user_date_idx on public.transfers (user_id, date desc, created_at desc, id);
create index transfers_user_from_idx on public.transfers (user_id, from_account_id);
create index transfers_user_to_idx on public.transfers (user_id, to_account_id);
create index transfers_user_sync_idx on public.transfers (user_id, sync_seq);

-- ---------------------------------------------------------------------------
-- Sync seq, tombstones, RLS, grants
-- ---------------------------------------------------------------------------

create trigger money_accounts_bump_sync_seq before update on public.money_accounts
  for each row execute function private.bump_sync_seq();
create trigger money_accounts_tombstone after delete on public.money_accounts
  for each row execute function private.record_tombstone('moneyAccounts');
create trigger transfers_bump_sync_seq before update on public.transfers
  for each row execute function private.bump_sync_seq();
create trigger transfers_tombstone after delete on public.transfers
  for each row execute function private.record_tombstone('transfers');

alter table public.money_accounts enable row level security;
alter table public.transfers enable row level security;
create policy money_accounts_owner on public.money_accounts for all to finn_api
  using ((select private.uid()) = user_id) with check ((select private.uid()) = user_id);
create policy transfers_owner on public.transfers for all to finn_api
  using ((select private.uid()) = user_id) with check ((select private.uid()) = user_id);
grant select, insert, update, delete on public.money_accounts to finn_api;
grant select, insert, update, delete on public.transfers to finn_api;

-- ---------------------------------------------------------------------------
-- New columns on existing tables
-- ---------------------------------------------------------------------------

alter table public.transactions
  add column account_id text,
  add column channel text check (char_length(channel) <= 30);
alter table public.subscriptions add column account_id text;
alter table public.pending_settlements
  add column account_id text,
  add column channel text check (char_length(channel) <= 30);

-- ---------------------------------------------------------------------------
-- Data migration: one Cash account per user holding everything so far
-- ---------------------------------------------------------------------------

insert into public.money_accounts (user_id, id, name, kind, opening_paise, opening_date, is_default, sort_order)
select u.user_id, 'acc_cash', 'Cash', 'cash',
       coalesce(p.opening_paise, 0),
       coalesce(p.opening_date, (select min(t.date) from public.transactions t where t.user_id = u.user_id), current_date),
       true, 0
from (select user_id from public.categories union select user_id from public.profiles) u
left join public.profiles p on p.user_id = u.user_id
on conflict (user_id, id) do nothing;

update public.transactions
set account_id = 'acc_cash',
    channel = case payment_method
      when 'upi' then 'UPI'
      when 'bankTransfer' then 'Bank transfer'
      when 'card' then 'Card'
      when 'wallet' then 'Wallet'
      else null end
where account_id is null;

update public.pending_settlements
set account_id = 'acc_cash',
    channel = case method
      when 'upi' then 'UPI'
      when 'bankTransfer' then 'Bank transfer'
      when 'card' then 'Card'
      when 'wallet' then 'Wallet'
      else null end
where account_id is null;

update public.subscriptions set account_id = 'acc_cash' where payment_method is not null and account_id is null;

-- ---------------------------------------------------------------------------
-- Constraints
-- ---------------------------------------------------------------------------

alter table public.transactions alter column account_id set not null;
alter table public.transactions
  add constraint transactions_account_fk foreign key (user_id, account_id) references public.money_accounts (user_id, id);
alter table public.subscriptions
  add constraint subscriptions_account_fk foreign key (user_id, account_id) references public.money_accounts (user_id, id);
alter table public.pending_settlements
  add constraint pending_settlements_account_fk foreign key (user_id, account_id) references public.money_accounts (user_id, id);

create index transactions_user_account_date_idx on public.transactions (user_id, account_id, date);
create index subscriptions_user_account_idx on public.subscriptions (user_id, account_id) where account_id is not null;
create index pending_settlements_user_account_idx on public.pending_settlements (user_id, account_id) where account_id is not null;
