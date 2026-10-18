-- Savings sit on an account: a goal or emergency-fund contribution now says
-- which money account the amount is set aside on (docs: finn/docs/SAVINGS_ACCOUNTS.md).
--
-- Setting money aside never changes an account's balance (it is not spending).
-- Per account: balance (total) − set aside = available to spend.
-- Existing movements move to the Cash account every user already has, so no
-- total changes. account_id stays nullable: a null row is an old allocation
-- that sits on no account; it only counts in the overall set-aside figure.

alter table public.savings_movements add column account_id text;

update public.savings_movements s
set account_id = 'acc_cash'
where s.account_id is null
  and exists (select 1 from public.money_accounts m where m.user_id = s.user_id and m.id = 'acc_cash');

alter table public.savings_movements
  add constraint savings_movements_account_fk
  foreign key (user_id, account_id) references public.money_accounts (user_id, id);

create index savings_movements_account_idx on public.savings_movements (user_id, account_id);
