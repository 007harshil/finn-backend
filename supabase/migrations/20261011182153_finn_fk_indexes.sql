-- Covering indexes for composite foreign keys flagged by the Supabase
-- performance advisor (category edits/deletes, goal deletes, loan deletes
-- check these keys).

create index transactions_user_category_type_idx on public.transactions (user_id, category_id, type);
create index subscriptions_user_category_idx on public.subscriptions (user_id, category_id);
create index savings_movements_user_goal_idx on public.savings_movements (user_id, goal_id) where goal_id is not null;
create index loans_user_disbursement_idx on public.loans (user_id, disbursement_transaction_id) where disbursement_transaction_id is not null;
