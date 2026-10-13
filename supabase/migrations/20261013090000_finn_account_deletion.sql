-- Account deletion is confirmed with an emailed one-time code, like sign-in.
-- A code is only valid for the purpose it was sent for, so a sign-in code can
-- never delete an account and a deletion code can never sign anyone in.
--
-- Deleting the finn_auth.users row erases the account: every user_id foreign
-- key cascades (refresh tokens, profile, preferences and all finance data),
-- and items shared with other people are unlinked from their side
-- (pending_payments.shared_with_user_id ON DELETE SET NULL).

alter table finn_auth.email_otps
  add column purpose text not null default 'sign_in'
  check (purpose in ('sign_in', 'delete_account'));

comment on column finn_auth.email_otps.purpose is 'What the code confirms: sign_in or delete_account.';
