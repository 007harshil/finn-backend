// Kysely table types for the FiNN schema (supabase/migrations).
// bigint columns are parsed to JS numbers (see client.ts), `date` columns to
// `yyyy-MM-dd` strings, timestamptz to Date.

import type { ColumnType, Generated } from 'kysely';

type Ts = ColumnType<Date, Date | string | undefined, Date | string>;
type SyncSeq = ColumnType<number, never, never>;

export interface ProfilesTable {
  user_id: string;
  display_name: string;
  handle: string;
  phone_hint: string | null;
  opening_paise: number | null;
  opening_date: string | null;
  monthly_income_estimate_paise: number | null;
  version: Generated<number>;
  created_at: Ts;
  updated_at: Ts;
  sync_seq: SyncSeq;
}

export interface UserPreferencesTable {
  user_id: string;
  month_start_day: Generated<number>;
  emi_reminder_days: Generated<number>;
  subscription_reminder_days: Generated<number>;
  low_emergency_coverage_months: Generated<number>;
  default_budget_warning_bps: Generated<number>;
  disabled_alert_types: Generated<string[]>;
  time_zone: Generated<string>;
  updated_at: Ts;
  sync_seq: SyncSeq;
}

export interface CategoriesTable {
  user_id: string;
  id: string;
  name: string;
  type: 'income' | 'expense';
  icon_key: string;
  color_index: number;
  description: Generated<string>;
  is_system: Generated<boolean>;
  is_archived: Generated<boolean>;
  is_essential: Generated<boolean>;
  version: Generated<number>;
  created_at: Ts;
  updated_at: Ts;
  sync_seq: SyncSeq;
}

export interface TransactionsTable {
  user_id: string;
  id: string;
  type: 'income' | 'expense';
  amount_paise: number;
  category_id: string;
  date: string;
  payment_method: string | null;
  counterparty: string | null;
  note: string | null;
  origin: Generated<string>;
  origin_ref_id: string | null;
  version: Generated<number>;
  created_at: Ts;
  updated_at: Ts;
  sync_seq: SyncSeq;
}

export interface BudgetsTable {
  user_id: string;
  id: string;
  category_id: string;
  limit_paise: number;
  status: Generated<'active' | 'paused'>;
  warning_threshold_bps: Generated<number>;
  note: string | null;
  version: Generated<number>;
  created_at: Ts;
  updated_at: Ts;
  sync_seq: SyncSeq;
}

export interface BudgetLimitChangesTable {
  user_id: string;
  budget_id: string;
  until_month: string;
  limit_paise: number;
}

export interface GoalsTable {
  user_id: string;
  id: string;
  name: string;
  category: string;
  target_paise: number;
  target_date: string | null;
  planned_monthly_paise: number | null;
  color_index: number;
  status: Generated<'active' | 'archived'>;
  note: string | null;
  version: Generated<number>;
  created_at: Ts;
  updated_at: Ts;
  sync_seq: SyncSeq;
}

export interface EmergencyPlansTable {
  user_id: string;
  essential_monthly_paise: number;
  target_months: number;
  target_override_paise: number | null;
  updated_at: Ts;
  sync_seq: SyncSeq;
}

export interface SavingsMovementsTable {
  user_id: string;
  id: string;
  bucket_type: 'goal' | 'emergencyFund';
  bucket_id: string;
  kind: 'contribution' | 'withdrawal';
  amount_paise: number;
  date: string;
  note: string | null;
  created_at: Ts;
  sync_seq: SyncSeq;
  goal_id: ColumnType<string | null, never, never>;
}

export interface LoansTable {
  user_id: string;
  id: string;
  name: string;
  counterparty: string;
  direction: 'borrowed' | 'lent';
  structure: 'amortizing' | 'interestOnly';
  principal_paise: number;
  rate_bps: number;
  start_date: string;
  first_due_date: string;
  frequency: string;
  tenure_installments: number | null;
  maturity_date: string | null;
  prepayment_strategy: Generated<'reduceTenure' | 'reduceEmi'>;
  status: Generated<'active' | 'closed'>;
  disbursement_transaction_id: string | null;
  note: string | null;
  version: Generated<number>;
  created_at: Ts;
  updated_at: Ts;
  sync_seq: SyncSeq;
}

export interface LoanPaymentsTable {
  user_id: string;
  id: string;
  loan_id: string;
  kind: 'installment' | 'interest' | 'principal';
  date: string;
  interest_paise: number;
  principal_paise: number;
  period_number: number | null;
  transaction_id: string | null;
  note: string | null;
  created_at: Ts;
  sync_seq: SyncSeq;
}

export interface SubscriptionsTable {
  user_id: string;
  id: string;
  name: string;
  amount_paise: number;
  category_id: string;
  frequency: string;
  next_due_date: string;
  start_date: string | null;
  status: Generated<'active' | 'paused' | 'cancelled'>;
  auto_renews: Generated<boolean>;
  payment_method: string | null;
  note: string | null;
  version: Generated<number>;
  created_at: Ts;
  updated_at: Ts;
  sync_seq: SyncSeq;
}

export interface PendingPaymentsTable {
  user_id: string;
  id: string;
  counterparty: string;
  direction: 'iOwe' | 'owedToMe';
  kind: string;
  original_paise: number;
  purpose: string;
  created_date: string;
  notes: string | null;
  is_cancelled: Generated<boolean>;
  shared_id: string | null;
  shared_with_user_id: string | null;
  shared_with_handle: string | null;
  split_id: string | null;
  split_method: string | null;
  split_includes_me: boolean | null;
  split_my_share_paise: number | null;
  split_part: number | null;
  version: Generated<number>;
  created_at: Ts;
  updated_at: Ts;
  sync_seq: SyncSeq;
}

export interface PendingSettlementsTable {
  user_id: string;
  id: string;
  pending_owner_id: string;
  pending_id: string;
  shared_with_user_id: string | null;
  amount_paise: number;
  date: string;
  method: string | null;
  transaction_id: string | null;
  note: string | null;
  created_at: Ts;
  sync_seq: SyncSeq;
}

export interface AssetsTable {
  user_id: string;
  id: string;
  name: string;
  type: string;
  value_paise: number;
  valued_on: string;
  note: string | null;
  version: Generated<number>;
  created_at: Ts;
  updated_at: Ts;
  sync_seq: SyncSeq;
}

export interface AlertInboxTable {
  user_id: string;
  alert_key: string;
  read_at: Date | string | null;
  dismissed_at: Date | string | null;
  sync_seq: SyncSeq;
}

export interface IdempotencyKeysTable {
  user_id: string;
  key: string;
  action_id: string;
  request_fingerprint: string;
  response: ColumnType<unknown, string, string>;
  created_at: Ts;
}

export interface AuditLogTable {
  user_id: string;
  id: Generated<number>;
  action_id: string;
  summary: string;
  channel: string;
  confirmed_by: string | null;
  succeeded: boolean;
  failure_code: string | null;
  failure_message: string | null;
  record_ids: Generated<string[]>;
  at: Ts;
}

export interface DeletedRecordsTable {
  user_id: string;
  collection: string;
  record_id: string;
  sync_seq: SyncSeq;
  deleted_at: Ts;
}

export interface AuthUsersTable {
  id: Generated<string>;
  email: string;
  created_at: Ts;
  last_sign_in_at: Date | null;
}

export interface AuthEmailOtpsTable {
  id: Generated<number>;
  email: string;
  code_hash: string;
  expires_at: Ts;
  attempts: Generated<number>;
  consumed_at: Date | null;
  created_at: Ts;
  purpose: Generated<OtpPurpose>;
}

export type OtpPurpose = 'sign_in' | 'delete_account';

export interface AuthRefreshTokensTable {
  id: Generated<string>;
  user_id: string;
  family_id: string;
  token_hash: string;
  expires_at: Ts;
  rotated_at: Date | null;
  revoked_at: Date | null;
  created_at: Ts;
}

export interface Database {
  profiles: ProfilesTable;
  user_preferences: UserPreferencesTable;
  categories: CategoriesTable;
  transactions: TransactionsTable;
  budgets: BudgetsTable;
  budget_limit_changes: BudgetLimitChangesTable;
  goals: GoalsTable;
  emergency_plans: EmergencyPlansTable;
  savings_movements: SavingsMovementsTable;
  loans: LoansTable;
  loan_payments: LoanPaymentsTable;
  subscriptions: SubscriptionsTable;
  pending_payments: PendingPaymentsTable;
  pending_settlements: PendingSettlementsTable;
  assets: AssetsTable;
  alert_inbox: AlertInboxTable;
  idempotency_keys: IdempotencyKeysTable;
  audit_log: AuditLogTable;
  deleted_records: DeletedRecordsTable;
  'finn_auth.users': AuthUsersTable;
  'finn_auth.email_otps': AuthEmailOtpsTable;
  'finn_auth.refresh_tokens': AuthRefreshTokensTable;
}
