// Domain records in exactly the JSON shape of the Flutter DTOs
// (lib/data/dto/dtos.dart): money as integer paise (`...Paise`), calendar
// dates as `yyyy-MM-dd`, instants as ISO-8601, enums by name, `version` on
// mutable records. The API returns these objects as-is, so the app can reuse
// `XxxDto.fromJson` unchanged.

import type { Selectable } from 'kysely';
import type { Frequency } from '../core/frequency';
import type { IsoDate } from '../core/dates';
import type { Paise } from '../core/money';
import type { PaymentMethod } from '../actions/input';
import type {
  AssetsTable,
  BudgetsTable,
  CategoriesTable,
  EmergencyPlansTable,
  GoalsTable,
  LoanPaymentsTable,
  LoansTable,
  PendingPaymentsTable,
  PendingSettlementsTable,
  ProfilesTable,
  SavingsMovementsTable,
  SubscriptionsTable,
  TransactionsTable,
  UserPreferencesTable,
} from '../db/types';

export type Instant = string;
export type TransactionType = 'income' | 'expense';
export const TRANSACTION_ORIGINS = ['manual', 'subscription', 'loanRepayment', 'loanDisbursement', 'pendingSettlement'] as const;
export type TransactionOrigin = (typeof TRANSACTION_ORIGINS)[number];

export const ORIGIN_LABELS: Record<TransactionOrigin, string> = {
  manual: 'Manual entry',
  subscription: 'Subscription payment',
  loanRepayment: 'Loan repayment',
  loanDisbursement: 'Loan disbursement',
  pendingSettlement: 'Pending settlement',
};

export const PAYMENT_METHOD_LABELS: Record<PaymentMethod, string> = {
  upi: 'UPI',
  card: 'Card',
  cash: 'Cash',
  bankTransfer: 'Bank Transfer',
  wallet: 'Wallet',
  other: 'Other',
};

const iso = (v: Date | string): Instant => (v instanceof Date ? v.toISOString() : new Date(v).toISOString());

// ---------------------------------------------------------------------------

export interface Transaction {
  id: string;
  type: TransactionType;
  amountPaise: Paise;
  categoryId: string;
  date: IsoDate;
  paymentMethod: PaymentMethod | null;
  counterparty: string | null;
  note: string | null;
  origin: TransactionOrigin;
  originRefId: string | null;
  createdAt: Instant;
  updatedAt: Instant;
  version: number;
}

export function transactionFromRow(r: Selectable<TransactionsTable>): Transaction {
  return {
    id: r.id,
    type: r.type,
    amountPaise: r.amount_paise,
    categoryId: r.category_id,
    date: r.date,
    paymentMethod: r.payment_method as PaymentMethod | null,
    counterparty: r.counterparty,
    note: r.note,
    origin: r.origin as TransactionOrigin,
    originRefId: r.origin_ref_id,
    createdAt: iso(r.created_at),
    updatedAt: iso(r.updated_at),
    version: r.version,
  };
}

export function transactionToRow(userId: string, t: Transaction) {
  return {
    user_id: userId,
    id: t.id,
    type: t.type,
    amount_paise: t.amountPaise,
    category_id: t.categoryId,
    date: t.date,
    payment_method: t.paymentMethod,
    counterparty: t.counterparty,
    note: t.note,
    origin: t.origin,
    origin_ref_id: t.originRefId,
    created_at: t.createdAt,
    updated_at: t.updatedAt,
    version: t.version,
  };
}

/** Borrowing is not income: disbursements are excluded from cash-flow analytics. */
export const countsInCashFlow = (t: Pick<Transaction, 'origin'>) => t.origin !== 'loanDisbursement';

// ---------------------------------------------------------------------------

export interface Category {
  id: string;
  name: string;
  type: TransactionType;
  iconKey: string;
  colorIndex: number;
  description: string;
  isSystem: boolean;
  isArchived: boolean;
  isEssential: boolean;
  version: number;
}

export function categoryFromRow(r: Selectable<CategoriesTable>): Category {
  return {
    id: r.id,
    name: r.name,
    type: r.type,
    iconKey: r.icon_key,
    colorIndex: r.color_index,
    description: r.description,
    isSystem: r.is_system,
    isArchived: r.is_archived,
    isEssential: r.is_essential,
    version: r.version,
  };
}

// ---------------------------------------------------------------------------

export interface BudgetLimitChange {
  /** Budget month key `yyyy-MM`: the old limit applied up to and including it. */
  until: string;
  limitPaise: Paise;
}

export interface Budget {
  id: string;
  categoryId: string;
  limitPaise: Paise;
  previousLimits: BudgetLimitChange[];
  status: 'active' | 'paused';
  warningThresholdBps: number;
  note: string | null;
  createdAt: Instant;
  updatedAt: Instant;
  version: number;
}

export function budgetFromRow(r: Selectable<BudgetsTable>, changes: BudgetLimitChange[]): Budget {
  return {
    id: r.id,
    categoryId: r.category_id,
    limitPaise: r.limit_paise,
    previousLimits: [...changes].sort((a, b) => a.until.localeCompare(b.until)),
    status: r.status,
    warningThresholdBps: r.warning_threshold_bps,
    note: r.note,
    createdAt: iso(r.created_at),
    updatedAt: iso(r.updated_at),
    version: r.version,
  };
}

// ---------------------------------------------------------------------------

export const GOAL_CATEGORIES = ['travel', 'purchase', 'education', 'investment', 'home', 'vehicle', 'wedding', 'health', 'other'] as const;
export type GoalCategory = (typeof GOAL_CATEGORIES)[number];

export interface Goal {
  id: string;
  name: string;
  category: GoalCategory;
  targetPaise: Paise;
  targetDate: IsoDate | null;
  plannedMonthlyPaise: Paise | null;
  colorIndex: number;
  status: 'active' | 'archived';
  note: string | null;
  createdAt: Instant;
  updatedAt: Instant;
  version: number;
}

export function goalFromRow(r: Selectable<GoalsTable>): Goal {
  return {
    id: r.id,
    name: r.name,
    category: r.category as GoalCategory,
    targetPaise: r.target_paise,
    targetDate: r.target_date,
    plannedMonthlyPaise: r.planned_monthly_paise,
    colorIndex: r.color_index,
    status: r.status,
    note: r.note,
    createdAt: iso(r.created_at),
    updatedAt: iso(r.updated_at),
    version: r.version,
  };
}

export const EMERGENCY_FUND_BUCKET_ID = 'emergency_fund';

export interface SavingsMovement {
  id: string;
  bucketType: 'goal' | 'emergencyFund';
  bucketId: string;
  kind: 'contribution' | 'withdrawal';
  amountPaise: Paise;
  date: IsoDate;
  note: string | null;
  createdAt: Instant;
}

export function movementFromRow(r: Selectable<SavingsMovementsTable>): SavingsMovement {
  return {
    id: r.id,
    bucketType: r.bucket_type,
    bucketId: r.bucket_id,
    kind: r.kind,
    amountPaise: r.amount_paise,
    date: r.date,
    note: r.note,
    createdAt: iso(r.created_at),
  };
}

export const signedMovement = (m: Pick<SavingsMovement, 'kind' | 'amountPaise'>): Paise =>
  m.kind === 'contribution' ? m.amountPaise : -m.amountPaise;

/** Flutter EmergencyPlanDto: `{configured:false}` or the plan. */
export interface EmergencyPlan {
  essentialMonthlyPaise: Paise;
  targetMonths: number;
  targetOverridePaise: Paise | null;
  updatedAt: Instant;
}

export function emergencyPlanFromRow(r: Selectable<EmergencyPlansTable>): EmergencyPlan {
  return {
    essentialMonthlyPaise: r.essential_monthly_paise,
    targetMonths: r.target_months,
    targetOverridePaise: r.target_override_paise,
    updatedAt: iso(r.updated_at),
  };
}

export const emergencyPlanDto = (p: EmergencyPlan | null) => (p ? { configured: true, ...p } : { configured: false });

// ---------------------------------------------------------------------------

export interface Loan {
  id: string;
  name: string;
  counterparty: string;
  direction: 'borrowed' | 'lent';
  structure: 'amortizing' | 'interestOnly';
  principalPaise: Paise;
  rateBps: number;
  startDate: IsoDate;
  firstDueDate: IsoDate;
  frequency: Frequency;
  tenureInstallments: number | null;
  maturityDate: IsoDate | null;
  prepaymentStrategy: 'reduceTenure' | 'reduceEmi';
  status: 'active' | 'closed';
  disbursementTransactionId: string | null;
  note: string | null;
  createdAt: Instant;
  updatedAt: Instant;
  version: number;
}

export function loanFromRow(r: Selectable<LoansTable>): Loan {
  return {
    id: r.id,
    name: r.name,
    counterparty: r.counterparty,
    direction: r.direction,
    structure: r.structure,
    principalPaise: r.principal_paise,
    rateBps: r.rate_bps,
    startDate: r.start_date,
    firstDueDate: r.first_due_date,
    frequency: r.frequency as Frequency,
    tenureInstallments: r.tenure_installments,
    maturityDate: r.maturity_date,
    prepaymentStrategy: r.prepayment_strategy,
    status: r.status,
    disbursementTransactionId: r.disbursement_transaction_id,
    note: r.note,
    createdAt: iso(r.created_at),
    updatedAt: iso(r.updated_at),
    version: r.version,
  };
}

export interface LoanPayment {
  id: string;
  loanId: string;
  kind: 'installment' | 'interest' | 'principal';
  date: IsoDate;
  interestPaise: Paise;
  principalPaise: Paise;
  periodNumber: number | null;
  transactionId: string | null;
  note: string | null;
  createdAt: Instant;
}

export function loanPaymentFromRow(r: Selectable<LoanPaymentsTable>): LoanPayment {
  return {
    id: r.id,
    loanId: r.loan_id,
    kind: r.kind,
    date: r.date,
    interestPaise: r.interest_paise,
    principalPaise: r.principal_paise,
    periodNumber: r.period_number,
    transactionId: r.transaction_id,
    note: r.note,
    createdAt: iso(r.created_at),
  };
}

// ---------------------------------------------------------------------------

export interface Subscription {
  id: string;
  name: string;
  amountPaise: Paise;
  categoryId: string;
  frequency: Frequency;
  nextDueDate: IsoDate;
  startDate: IsoDate | null;
  status: 'active' | 'paused' | 'cancelled';
  autoRenews: boolean;
  paymentMethod: PaymentMethod | null;
  note: string | null;
  createdAt: Instant;
  updatedAt: Instant;
  version: number;
}

export function subscriptionFromRow(r: Selectable<SubscriptionsTable>): Subscription {
  return {
    id: r.id,
    name: r.name,
    amountPaise: r.amount_paise,
    categoryId: r.category_id,
    frequency: r.frequency as Frequency,
    nextDueDate: r.next_due_date,
    startDate: r.start_date,
    status: r.status,
    autoRenews: r.auto_renews,
    paymentMethod: r.payment_method as PaymentMethod | null,
    note: r.note,
    createdAt: iso(r.created_at),
    updatedAt: iso(r.updated_at),
    version: r.version,
  };
}

// ---------------------------------------------------------------------------

export const PENDING_KINDS = ['borrowed', 'lent', 'sharedExpense', 'reimbursement', 'other'] as const;
export type PendingKind = (typeof PENDING_KINDS)[number];
export const SPLIT_METHODS = ['equally', 'exact', 'percent', 'shares', 'adjustment'] as const;
export type SplitMethod = (typeof SPLIT_METHODS)[number];

export interface PendingLink {
  /** The other person. */
  userId: string;
  handle: string;
  sharedId: string;
  createdByMe: boolean;
}

export interface PendingSplit {
  id: string;
  method: SplitMethod;
  includesMe: boolean;
  mySharePaise: Paise;
  part: number | null;
}

export interface PendingPayment {
  id: string;
  counterparty: string;
  direction: 'iOwe' | 'owedToMe';
  kind: PendingKind;
  originalPaise: Paise;
  purpose: string;
  createdDate: IsoDate;
  notes: string | null;
  isCancelled: boolean;
  createdAt: Instant;
  updatedAt: Instant;
  version: number;
  link: PendingLink | null;
  split: PendingSplit | null;
}

export interface PendingSettlement {
  id: string;
  pendingId: string;
  amountPaise: Paise;
  date: IsoDate;
  method: PaymentMethod | null;
  transactionId: string | null;
  note: string | null;
  createdAt: Instant;
}

export const MIRROR_PREFIX = 'mir_';

const mirrorKind = (k: PendingKind): PendingKind => (k === 'borrowed' ? 'lent' : k === 'lent' ? 'borrowed' : k);

/**
 * A pending row as seen by [viewerId]. The creator sees it as stored; the
 * person it is shared with sees the mirrored view (id `mir_<sharedId>`,
 * direction and borrowed/lent reversed, counterparty = creator's name).
 */
export function pendingFromRow(
  r: Selectable<PendingPaymentsTable>,
  viewerId: string,
  owner?: { name: string; handle: string },
): PendingPayment {
  const split: PendingSplit | null =
    r.split_id && r.split_method
      ? {
          id: r.split_id,
          method: r.split_method as SplitMethod,
          includesMe: r.split_includes_me ?? false,
          mySharePaise: r.split_my_share_paise ?? 0,
          part: r.split_part,
        }
      : null;
  const base = {
    originalPaise: r.original_paise,
    purpose: r.purpose,
    createdDate: r.created_date,
    notes: r.notes,
    isCancelled: r.is_cancelled,
    createdAt: iso(r.created_at),
    updatedAt: iso(r.updated_at),
    version: r.version,
  };
  if (r.user_id === viewerId) {
    return {
      id: r.id,
      counterparty: r.counterparty,
      direction: r.direction,
      kind: r.kind as PendingKind,
      ...base,
      link:
        r.shared_id && r.shared_with_handle
          ? { userId: r.shared_with_user_id ?? '', handle: r.shared_with_handle, sharedId: r.shared_id, createdByMe: true }
          : null,
      split,
    };
  }
  return {
    id: `${MIRROR_PREFIX}${r.shared_id}`,
    counterparty: owner?.name ?? 'FiNN user',
    direction: r.direction === 'iOwe' ? 'owedToMe' : 'iOwe',
    kind: mirrorKind(r.kind as PendingKind),
    ...base,
    link: { userId: r.user_id, handle: owner?.handle ?? '', sharedId: r.shared_id ?? '', createdByMe: false },
    // A split describes the creator's bill; the other person only sees their own item.
    split: null,
  };
}

/** A settlement as seen by [viewerId]: other people's settlements are `mir_` prefixed and never carry a transaction. */
export function settlementFromRow(r: Selectable<PendingSettlementsTable>, viewerId: string, pendingViewId: string): PendingSettlement {
  const own = r.user_id === viewerId;
  return {
    id: own ? r.id : `${MIRROR_PREFIX}${r.id}`,
    pendingId: pendingViewId,
    amountPaise: r.amount_paise,
    date: r.date,
    method: r.method as PaymentMethod | null,
    transactionId: own ? r.transaction_id : null,
    note: r.note,
    createdAt: iso(r.created_at),
  };
}

// ---------------------------------------------------------------------------

export const ASSET_TYPES = ['bankDeposit', 'investment', 'retirement', 'gold', 'property', 'vehicle', 'other'] as const;
export type AssetType = (typeof ASSET_TYPES)[number];

export interface Asset {
  id: string;
  name: string;
  type: AssetType;
  valuePaise: Paise;
  valuedOn: IsoDate;
  note: string | null;
  createdAt: Instant;
  updatedAt: Instant;
  version: number;
}

export function assetFromRow(r: Selectable<AssetsTable>): Asset {
  return {
    id: r.id,
    name: r.name,
    type: r.type as AssetType,
    valuePaise: r.value_paise,
    valuedOn: r.valued_on,
    note: r.note,
    createdAt: iso(r.created_at),
    updatedAt: iso(r.updated_at),
    version: r.version,
  };
}

// ---------------------------------------------------------------------------

/** FinancialProfile (Flutter ProfileDto: `{exists:false}` or the profile). */
export interface FinancialProfile {
  displayName: string;
  openingPaise: Paise;
  openingDate: IsoDate;
  monthlyIncomeEstimatePaise: Paise | null;
}

export function financialProfileFromRow(r: Selectable<ProfilesTable>): FinancialProfile | null {
  if (r.opening_paise === null || r.opening_date === null) return null;
  return {
    displayName: r.display_name,
    openingPaise: r.opening_paise,
    openingDate: r.opening_date,
    monthlyIncomeEstimatePaise: r.monthly_income_estimate_paise,
  };
}

export const profileDto = (p: FinancialProfile | null) => (p ? { exists: true, ...p } : { exists: false });

export interface Preferences {
  monthStartDay: number;
  emiReminderDays: number;
  subscriptionReminderDays: number;
  lowEmergencyCoverageMonths: number;
  defaultBudgetWarningBps: number;
  disabledAlertTypes: string[];
  timeZone: string;
}

export const DEFAULT_PREFERENCES: Preferences = {
  monthStartDay: 1,
  emiReminderDays: 5,
  subscriptionReminderDays: 3,
  lowEmergencyCoverageMonths: 3,
  defaultBudgetWarningBps: 8000,
  disabledAlertTypes: [],
  timeZone: 'Asia/Kolkata',
};

export function preferencesFromRow(r: Selectable<UserPreferencesTable>): Preferences {
  return {
    monthStartDay: r.month_start_day,
    emiReminderDays: r.emi_reminder_days,
    subscriptionReminderDays: r.subscription_reminder_days,
    lowEmergencyCoverageMonths: r.low_emergency_coverage_months,
    defaultBudgetWarningBps: r.default_budget_warning_bps,
    disabledAlertTypes: r.disabled_alert_types,
    timeZone: r.time_zone,
  };
}

export { iso as toInstant };
