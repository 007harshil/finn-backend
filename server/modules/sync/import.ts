// One-time upload of the records a user kept on the device before signing in
// (POST /api/v1/import). Accepted only while the account has no financial
// records; everything is validated and written in one transaction, keeping the
// client's ids so cross-record references (originRefId, transactionId, …) stay
// intact. Shared-pending links are dropped: sharing is re-established online.

import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { AuthUser } from '../../auth/verify';
import { isIsoDate } from '../../core/dates';
import { AppFailure } from '../../core/failure';
import { withUserTx, type Tx } from '../../db/tx';
import { ACCOUNT_KINDS, ASSET_TYPES, CASH_ACCOUNT_ID, GOAL_CATEGORIES, PENDING_KINDS, SPLIT_METHODS, TRANSACTION_ORIGINS } from '../../finance/models';
import { FREQUENCIES } from '../../core/frequency';
import { isAccountEmpty } from '../account/bootstrap';
import { setCashOpening } from '../accounts/repo';
import { fullSync, type SyncChanges } from './service';

const id = z.string().min(1).max(64);
const paise = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const positive = paise.refine((v) => v > 0, 'Must be greater than zero');
const date = z.string().refine(isIsoDate, 'Expected yyyy-MM-dd');
const instant = z.string().refine((s) => !Number.isNaN(Date.parse(s)), 'Expected an ISO-8601 instant');
const text = (max: number) => z.string().max(max).nullish().transform((v) => v ?? null);
const version = z.number().int().min(1).default(1);
const accountRef = z.string().min(1).max(64).nullish().transform((v) => v ?? null);

const category = z.object({
  id,
  name: z.string().min(2).max(30),
  type: z.enum(['income', 'expense']),
  iconKey: z.string().min(1).max(40),
  colorIndex: z.number().int().min(0).max(63),
  description: z.string().max(120).default(''),
  isSystem: z.boolean().default(false),
  isArchived: z.boolean().default(false),
  isEssential: z.boolean().default(false),
  version,
});

const transaction = z.object({
  id,
  type: z.enum(['income', 'expense']),
  amountPaise: positive,
  categoryId: id,
  date,
  /** Missing = the default account (the Cash account when no accounts are uploaded). */
  accountId: accountRef,
  channel: text(30),
  counterparty: text(80),
  note: text(500),
  origin: z.enum(TRANSACTION_ORIGINS).default('manual'),
  originRefId: z.string().max(64).nullish().transform((v) => v ?? null),
  createdAt: instant,
  updatedAt: instant,
  version,
});

const budget = z.object({
  id,
  categoryId: id,
  limitPaise: positive,
  previousLimits: z.array(z.object({ until: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/), limitPaise: positive })).default([]),
  status: z.enum(['active', 'paused']).default('active'),
  warningThresholdBps: z.number().int().min(5000).max(9500).default(8000),
  note: text(200),
  createdAt: instant,
  updatedAt: instant,
  version,
});

const goal = z.object({
  id,
  name: z.string().min(1).max(50),
  category: z.enum(GOAL_CATEGORIES).default('other'),
  targetPaise: positive,
  targetDate: date.nullish().transform((v) => v ?? null),
  plannedMonthlyPaise: positive.nullish().transform((v) => v ?? null),
  colorIndex: z.number().int().min(0).max(63),
  status: z.enum(['active', 'archived']).default('active'),
  note: text(500),
  createdAt: instant,
  updatedAt: instant,
  version,
});

const movement = z.object({
  id,
  bucketType: z.enum(['goal', 'emergencyFund']),
  bucketId: id,
  kind: z.enum(['contribution', 'withdrawal']),
  amountPaise: positive,
  accountId: z.string().min(1).max(64).nullable().optional(),
  date,
  note: text(500),
  createdAt: instant,
});

const loan = z.object({
  id,
  name: z.string().min(1).max(60),
  counterparty: z.string().min(1).max(80),
  direction: z.enum(['borrowed', 'lent']),
  structure: z.enum(['amortizing', 'interestOnly']),
  principalPaise: positive,
  rateBps: z.number().int().min(0).max(6000),
  startDate: date,
  firstDueDate: date,
  frequency: z.enum(['monthly', 'quarterly', 'halfYearly', 'yearly']),
  tenureInstallments: z.number().int().min(1).max(480).nullish().transform((v) => v ?? null),
  maturityDate: date.nullish().transform((v) => v ?? null),
  prepaymentStrategy: z.enum(['reduceTenure', 'reduceEmi']).default('reduceTenure'),
  status: z.enum(['active', 'closed']).default('active'),
  disbursementTransactionId: z.string().max(64).nullish().transform((v) => v ?? null),
  note: text(500),
  createdAt: instant,
  updatedAt: instant,
  version,
});

const loanPayment = z.object({
  id,
  loanId: id,
  kind: z.enum(['installment', 'interest', 'principal']),
  date,
  interestPaise: paise,
  principalPaise: paise,
  periodNumber: z.number().int().min(1).nullish().transform((v) => v ?? null),
  transactionId: z.string().max(64).nullish().transform((v) => v ?? null),
  note: text(500),
  createdAt: instant,
});

const subscription = z.object({
  id,
  name: z.string().min(1).max(60),
  amountPaise: positive,
  categoryId: id,
  frequency: z.enum(FREQUENCIES),
  nextDueDate: date,
  startDate: date.nullish().transform((v) => v ?? null),
  status: z.enum(['active', 'paused', 'cancelled']).default('active'),
  autoRenews: z.boolean().default(true),
  accountId: accountRef,
  note: text(500),
  createdAt: instant,
  updatedAt: instant,
  version,
});

const pending = z.object({
  id: id.refine((v) => !v.startsWith('mir_'), 'Mirrored items are not uploaded'),
  counterparty: z.string().min(1).max(60),
  direction: z.enum(['iOwe', 'owedToMe']),
  kind: z.enum(PENDING_KINDS).default('other'),
  originalPaise: positive,
  purpose: z.string().min(1).max(120),
  createdDate: date,
  notes: text(500),
  isCancelled: z.boolean().default(false),
  createdAt: instant,
  updatedAt: instant,
  version,
  split: z
    .object({
      id,
      method: z.enum(SPLIT_METHODS),
      includesMe: z.boolean().default(false),
      mySharePaise: paise.default(0),
      part: z.number().int().nullish().transform((v) => v ?? null),
    })
    .nullish()
    .transform((v) => v ?? null),
});

const settlement = z.object({
  id,
  pendingId: id,
  amountPaise: positive,
  date,
  accountId: accountRef,
  channel: text(30),
  transactionId: z.string().max(64).nullish().transform((v) => v ?? null),
  note: text(500),
  createdAt: instant,
});

const asset = z.object({
  id,
  name: z.string().min(2).max(40),
  type: z.enum(ASSET_TYPES).default('other'),
  valuePaise: paise,
  valuedOn: date,
  note: text(500),
  createdAt: instant,
  updatedAt: instant,
  version,
});

const moneyAccount = z.object({
  id,
  name: z.string().min(1).max(40),
  kind: z.enum(ACCOUNT_KINDS),
  institution: text(40),
  last4: z.string().regex(/^[0-9]{4}$/).nullish().transform((v) => v ?? null),
  openingPaise: paise,
  openingDate: date,
  creditLimitPaise: positive.nullish().transform((v) => v ?? null),
  isDefault: z.boolean().default(false),
  isArchived: z.boolean().default(false),
  sortOrder: z.number().int().default(0),
  note: text(200),
  createdAt: instant,
  updatedAt: instant,
  version,
});

const transfer = z.object({
  id,
  fromAccountId: id,
  toAccountId: id,
  amountPaise: positive,
  date,
  channel: text(30),
  note: text(500),
  createdAt: instant,
  updatedAt: instant,
  version,
});

const list = <T extends z.ZodType>(s: T, max: number) => z.array(s).max(max).default([]);

export const importSchema = z.object({
  categories: list(category, 500),
  transactions: list(transaction, 100_000),
  budgets: list(budget, 500),
  goals: list(goal, 500),
  savingsMovements: list(movement, 20_000),
  loans: list(loan, 500),
  loanPayments: list(loanPayment, 20_000),
  subscriptions: list(subscription, 1_000),
  pending: list(pending, 5_000),
  settlements: list(settlement, 20_000),
  assets: list(asset, 1_000),
  moneyAccounts: list(moneyAccount, 100),
  transfers: list(transfer, 20_000),
  profile: z
    .union([
      z.object({ exists: z.literal(false) }),
      z.object({
        exists: z.literal(true),
        displayName: z.string().min(1).max(40),
        openingPaise: paise,
        openingDate: date,
        monthlyIncomeEstimatePaise: positive.nullish().transform((v) => v ?? null),
      }),
    ])
    .default({ exists: false }),
  emergencyPlan: z
    .union([
      z.object({ configured: z.literal(false) }),
      z.object({
        configured: z.literal(true),
        essentialMonthlyPaise: paise,
        targetMonths: z.number().int().min(1).max(24),
        targetOverridePaise: positive.nullish().transform((v) => v ?? null),
        updatedAt: instant,
      }),
    ])
    .default({ configured: false }),
});

export type ImportPayload = z.output<typeof importSchema>;

async function chunked<T>(rows: T[], write: (chunk: T[]) => Promise<unknown>, size = 500): Promise<void> {
  for (let i = 0; i < rows.length; i += size) await write(rows.slice(i, i + size));
}

/** Id of the account that receives records without an explicit one. */
function defaultAccountOf(p: ImportPayload): string {
  if (p.moneyAccounts.length === 0) return CASH_ACCOUNT_ID;
  return (p.moneyAccounts.find((a) => a.isDefault && !a.isArchived) ?? p.moneyAccounts.find((a) => !a.isArchived) ?? p.moneyAccounts[0]!).id;
}

async function writeAll(tx: Tx, userId: string, p: ImportPayload): Promise<void> {
  const defaultAccountId = defaultAccountOf(p);
  // Categories: standard ids already exist (bootstrap) — overwrite them with the device's version.
  await chunked(p.categories, (rows) =>
    tx
      .insertInto('categories')
      .values(
        rows.map((c) => ({
          user_id: userId,
          id: c.id,
          name: c.name,
          type: c.type,
          icon_key: c.iconKey,
          color_index: c.colorIndex,
          description: c.description,
          is_system: c.isSystem,
          is_archived: c.isArchived,
          is_essential: c.isEssential,
          version: c.version,
        })),
      )
      .onConflict((oc) =>
        oc.columns(['user_id', 'id']).doUpdateSet((eb) => ({
          name: eb.ref('excluded.name'),
          icon_key: eb.ref('excluded.icon_key'),
          color_index: eb.ref('excluded.color_index'),
          description: eb.ref('excluded.description'),
          is_archived: eb.ref('excluded.is_archived'),
          is_essential: eb.ref('excluded.is_essential'),
        })),
      )
      .execute(),
  );

  if (p.profile.exists) {
    await tx
      .updateTable('profiles')
      .set({
        display_name: p.profile.displayName,
        opening_paise: p.profile.openingPaise,
        opening_date: p.profile.openingDate,
        monthly_income_estimate_paise: p.profile.monthlyIncomeEstimatePaise,
        updated_at: new Date(),
      })
      .where('user_id', '=', userId)
      .execute();
  }
  if (p.emergencyPlan.configured) {
    await tx
      .insertInto('emergency_plans')
      .values({
        user_id: userId,
        essential_monthly_paise: p.emergencyPlan.essentialMonthlyPaise,
        target_months: p.emergencyPlan.targetMonths,
        target_override_paise: p.emergencyPlan.targetOverridePaise,
        updated_at: p.emergencyPlan.updatedAt,
      })
      .execute();
  }

  // Money accounts: device accounts replace the bootstrapped Cash account; without any, Cash takes the profile's opening.
  if (p.moneyAccounts.length === 0) {
    if (p.profile.exists) await setCashOpening(tx, userId, p.profile.openingPaise, p.profile.openingDate);
  } else {
    if (!p.moneyAccounts.some((a) => a.id === CASH_ACCOUNT_ID)) {
      await tx.deleteFrom('money_accounts').where('user_id', '=', userId).where('id', '=', CASH_ACCOUNT_ID).execute();
    } else {
      // Kept (overwritten below); drop its default flag so the device's default can take over.
      await tx.updateTable('money_accounts').set({ is_default: false }).where('user_id', '=', userId).execute();
    }
    await tx
      .insertInto('money_accounts')
      .values(
        p.moneyAccounts.map((a) => ({
          user_id: userId,
          id: a.id,
          name: a.name,
          kind: a.kind,
          institution: a.institution,
          last4: a.last4,
          opening_paise: a.openingPaise,
          opening_date: a.openingDate,
          credit_limit_paise: a.creditLimitPaise,
          is_default: a.id === defaultAccountId,
          is_archived: a.isArchived,
          sort_order: a.sortOrder,
          note: a.note,
          created_at: a.createdAt,
          updated_at: a.updatedAt,
          version: a.version,
        })),
      )
      .onConflict((oc) =>
        oc.columns(['user_id', 'id']).doUpdateSet((eb) => ({
          name: eb.ref('excluded.name'),
          kind: eb.ref('excluded.kind'),
          institution: eb.ref('excluded.institution'),
          last4: eb.ref('excluded.last4'),
          opening_paise: eb.ref('excluded.opening_paise'),
          opening_date: eb.ref('excluded.opening_date'),
          credit_limit_paise: eb.ref('excluded.credit_limit_paise'),
          is_default: eb.ref('excluded.is_default'),
          is_archived: eb.ref('excluded.is_archived'),
          sort_order: eb.ref('excluded.sort_order'),
          note: eb.ref('excluded.note'),
        })),
      )
      .execute();
  }

  await chunked(p.transactions, (rows) =>
    tx
      .insertInto('transactions')
      .values(
        rows.map((t) => ({
          user_id: userId,
          id: t.id,
          type: t.type,
          amount_paise: t.amountPaise,
          category_id: t.categoryId,
          date: t.date,
          account_id: t.accountId ?? defaultAccountId,
          channel: t.channel,
          counterparty: t.counterparty,
          note: t.note,
          origin: t.origin,
          origin_ref_id: t.origin === 'manual' ? null : t.originRefId,
          created_at: t.createdAt,
          updated_at: t.updatedAt,
          version: t.version,
        })),
      )
      .execute(),
  );

  await chunked(p.budgets, async (rows) => {
    await tx
      .insertInto('budgets')
      .values(
        rows.map((b) => ({
          user_id: userId,
          id: b.id,
          category_id: b.categoryId,
          limit_paise: b.limitPaise,
          status: b.status,
          warning_threshold_bps: b.warningThresholdBps,
          note: b.note,
          created_at: b.createdAt,
          updated_at: b.updatedAt,
          version: b.version,
        })),
      )
      .execute();
    const changes = rows.flatMap((b) => b.previousLimits.map((c) => ({ user_id: userId, budget_id: b.id, until_month: c.until, limit_paise: c.limitPaise })));
    if (changes.length > 0) await tx.insertInto('budget_limit_changes').values(changes).execute();
  });

  await chunked(p.goals, (rows) =>
    tx
      .insertInto('goals')
      .values(
        rows.map((g) => ({
          user_id: userId,
          id: g.id,
          name: g.name,
          category: g.category,
          target_paise: g.targetPaise,
          target_date: g.targetDate,
          planned_monthly_paise: g.plannedMonthlyPaise,
          color_index: g.colorIndex,
          status: g.status,
          note: g.note,
          created_at: g.createdAt,
          updated_at: g.updatedAt,
          version: g.version,
        })),
      )
      .execute(),
  );

  await chunked(p.savingsMovements, (rows) =>
    tx
      .insertInto('savings_movements')
      .values(
        rows.map((m) => ({
          user_id: userId,
          id: m.id,
          bucket_type: m.bucketType,
          bucket_id: m.bucketId,
          kind: m.kind,
          amount_paise: m.amountPaise,
          account_id: m.accountId ?? defaultAccountOf(p),
          date: m.date,
          note: m.note,
          created_at: m.createdAt,
        })),
      )
      .execute(),
  );

  await chunked(p.loans, (rows) =>
    tx
      .insertInto('loans')
      .values(
        rows.map((l) => ({
          user_id: userId,
          id: l.id,
          name: l.name,
          counterparty: l.counterparty,
          direction: l.direction,
          structure: l.structure,
          principal_paise: l.principalPaise,
          rate_bps: l.rateBps,
          start_date: l.startDate,
          first_due_date: l.firstDueDate,
          frequency: l.frequency,
          tenure_installments: l.tenureInstallments,
          maturity_date: l.maturityDate,
          prepayment_strategy: l.prepaymentStrategy,
          status: l.status,
          disbursement_transaction_id: l.disbursementTransactionId,
          note: l.note,
          created_at: l.createdAt,
          updated_at: l.updatedAt,
          version: l.version,
        })),
      )
      .execute(),
  );

  await chunked(p.loanPayments, (rows) =>
    tx
      .insertInto('loan_payments')
      .values(
        rows.map((x) => ({
          user_id: userId,
          id: x.id,
          loan_id: x.loanId,
          kind: x.kind,
          date: x.date,
          interest_paise: x.interestPaise,
          principal_paise: x.principalPaise,
          period_number: x.periodNumber,
          transaction_id: x.transactionId,
          note: x.note,
          created_at: x.createdAt,
        })),
      )
      .execute(),
  );

  await chunked(p.subscriptions, (rows) =>
    tx
      .insertInto('subscriptions')
      .values(
        rows.map((s) => ({
          user_id: userId,
          id: s.id,
          name: s.name,
          amount_paise: s.amountPaise,
          category_id: s.categoryId,
          frequency: s.frequency,
          next_due_date: s.nextDueDate,
          start_date: s.startDate,
          status: s.status,
          auto_renews: s.autoRenews,
          account_id: s.accountId,
          note: s.note,
          created_at: s.createdAt,
          updated_at: s.updatedAt,
          version: s.version,
        })),
      )
      .execute(),
  );

  await chunked(p.pending, (rows) =>
    tx
      .insertInto('pending_payments')
      .values(
        rows.map((x) => ({
          user_id: userId,
          id: x.id,
          counterparty: x.counterparty,
          direction: x.direction,
          kind: x.kind,
          original_paise: x.originalPaise,
          purpose: x.purpose,
          created_date: x.createdDate,
          notes: x.notes,
          is_cancelled: x.isCancelled,
          split_id: x.split?.id ?? null,
          split_method: x.split?.method ?? null,
          split_includes_me: x.split?.includesMe ?? null,
          split_my_share_paise: x.split?.mySharePaise ?? null,
          split_part: x.split?.part ?? null,
          created_at: x.createdAt,
          updated_at: x.updatedAt,
          version: x.version,
        })),
      )
      .execute(),
  );

  const ownPending = new Set(p.pending.map((x) => x.id));
  const settlements = p.settlements.filter((s) => ownPending.has(s.pendingId));
  await chunked(settlements, (rows) =>
    tx
      .insertInto('pending_settlements')
      .values(
        rows.map((s) => ({
          user_id: userId,
          id: s.id,
          pending_owner_id: userId,
          pending_id: s.pendingId,
          amount_paise: s.amountPaise,
          date: s.date,
          account_id: s.transactionId ? (s.accountId ?? defaultAccountId) : s.accountId,
          channel: s.channel,
          transaction_id: s.transactionId,
          note: s.note,
          created_at: s.createdAt,
        })),
      )
      .execute(),
  );

  await chunked(p.transfers, (rows) =>
    tx
      .insertInto('transfers')
      .values(
        rows.map((x) => ({
          user_id: userId,
          id: x.id,
          from_account_id: x.fromAccountId,
          to_account_id: x.toAccountId,
          amount_paise: x.amountPaise,
          date: x.date,
          channel: x.channel,
          note: x.note,
          created_at: x.createdAt,
          updated_at: x.updatedAt,
          version: x.version,
        })),
      )
      .execute(),
  );

  await chunked(p.assets, (rows) =>
    tx
      .insertInto('assets')
      .values(
        rows.map((a) => ({
          user_id: userId,
          id: a.id,
          name: a.name,
          type: a.type,
          value_paise: a.valuePaise,
          valued_on: a.valuedOn,
          note: a.note,
          created_at: a.createdAt,
          updated_at: a.updatedAt,
          version: a.version,
        })),
      )
      .execute(),
  );
}

/** Cross-record checks the database cannot express (settlements never exceed their item). */
function validateReferences(p: ImportPayload): void {
  const accountIds = new Set(p.moneyAccounts.length === 0 ? [CASH_ACCOUNT_ID] : p.moneyAccounts.map((a) => a.id));
  if (accountIds.size !== (p.moneyAccounts.length === 0 ? 1 : p.moneyAccounts.length)) {
    throw AppFailure.validation('Two accounts share the same id.', { moneyAccounts: 'Duplicate id' });
  }
  if (p.moneyAccounts.length > 0 && p.moneyAccounts.every((a) => a.isArchived)) {
    throw AppFailure.validation('At least one account must be active.', { moneyAccounts: 'No active account' });
  }
  const known = (ref: string | null, field: string) => {
    if (ref !== null && !accountIds.has(ref)) throw AppFailure.validation('A record refers to an account that is not included.', { [field]: ref });
  };
  for (const t of p.transactions) known(t.accountId, 'transactions');
  for (const s of p.subscriptions) known(s.accountId, 'subscriptions');
  for (const s of p.settlements) known(s.accountId, 'settlements');
  for (const m of p.savingsMovements) known(m.accountId ?? null, 'savingsMovements');
  for (const t of p.transfers) {
    known(t.fromAccountId, 'transfers');
    known(t.toAccountId, 'transfers');
    if (t.fromAccountId === t.toAccountId) throw AppFailure.validation('A transfer needs two different accounts.', { transfers: t.id });
  }
  for (const a of p.moneyAccounts) {
    if ((a.creditLimitPaise !== null && a.kind !== 'creditCard') || (a.last4 !== null && (a.kind === 'cash' || a.kind === 'bank'))) {
      throw AppFailure.validation('An account has details its kind does not allow.', { moneyAccounts: a.id });
    }
  }
  const settled = new Map<string, number>();
  for (const s of p.settlements) settled.set(s.pendingId, (settled.get(s.pendingId) ?? 0) + s.amountPaise);
  for (const x of p.pending) {
    if ((settled.get(x.id) ?? 0) > x.originalPaise) {
      throw AppFailure.validation(`Pending item "${x.purpose}" has settlements larger than its amount.`, { pending: x.id });
    }
  }
  const goalIds = new Set(p.goals.map((g) => g.id));
  for (const m of p.savingsMovements) {
    if (m.bucketType === 'goal' && !goalIds.has(m.bucketId)) {
      throw AppFailure.validation('A savings movement refers to a goal that is not included.', { savingsMovements: m.id });
    }
  }
}

export async function importAccount(user: AuthUser, payload: ImportPayload, idempotencyKey: string): Promise<SyncChanges & { replayed: boolean }> {
  const fingerprint = createHash('sha256').update(JSON.stringify(payload)).digest('hex');
  validateReferences(payload);
  return withUserTx(
    user,
    async (tx) => {
      const previous = await tx
        .selectFrom('idempotency_keys')
        .select(['action_id', 'request_fingerprint'])
        .where('user_id', '=', user.userId)
        .where('key', '=', idempotencyKey)
        .executeTakeFirst();
      if (previous) {
        if (previous.action_id !== 'account.import' || previous.request_fingerprint !== fingerprint) {
          throw AppFailure.conflict('This request id was already used for a different operation.');
        }
        return { ...(await fullSync(tx, user.userId)), replayed: true };
      }
      if (!(await isAccountEmpty(tx, user.userId))) {
        throw AppFailure.conflict('This account already has records, so device data cannot be uploaded into it.');
      }
      await writeAll(tx, user.userId, payload);
      await tx
        .insertInto('idempotency_keys')
        .values({
          user_id: user.userId,
          key: idempotencyKey,
          action_id: 'account.import',
          request_fingerprint: fingerprint,
          response: JSON.stringify({ imported: true }),
        })
        .execute();
      await tx
        .insertInto('audit_log')
        .values({
          user_id: user.userId,
          action_id: 'account.import',
          summary: `Uploaded ${payload.transactions.length} transactions and related records from this device`,
          channel: 'import',
          succeeded: true,
        })
        .execute();
      return { ...(await fullSync(tx, user.userId)), replayed: false };
    },
    { write: true },
  );
}
