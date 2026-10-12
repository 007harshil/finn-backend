// budgets.create / update / setPaused / delete
// (lib/features/budgets/application/budget_actions.dart).

import { z } from 'zod';
import { zBool, zId, zIntOpt, zMoney, zTextOpt, zVersion } from '../../actions/input';
import { defineAction, type ActionContext, type AnyAction, type FieldSpec, type PreviewLine } from '../../actions/types';
import { formatDate } from '../../core/dates';
import { AppFailure, throwIfErrors } from '../../core/failure';
import { formatInr } from '../../core/money';
import type { Budget, BudgetLimitChange } from '../../finance/models';
import type { FinanceSnapshot } from '../../finance/snapshot';
import {
  DEFAULT_BUDGET_WARNING_BPS,
  MAX_BUDGET_LIMIT_PAISE,
  MAX_BUDGET_WARNING_BPS,
  MIN_BUDGET_WARNING_BPS,
  budgetStartMonth,
} from './calculator';
import { currentBudgetMonth, currentBudgetPeriod } from './service';

const dataShape = {
  categoryId: zId,
  limit: zMoney,
  warningThresholdBps: zIntOpt,
  note: zTextOpt,
};
const budgetInput = z.object(dataShape);
type BudgetInput = z.output<typeof budgetInput>;

const fields: FieldSpec[] = [
  { name: 'categoryId', kind: 'id', description: 'Expense category id', required: true },
  { name: 'limit', kind: 'money', description: 'Monthly spending limit in rupees, greater than zero', required: true },
  { name: 'warningThresholdBps', kind: 'integer', description: 'Warning threshold in basis points (5000–9500)', required: false },
  { name: 'note', kind: 'string', description: 'Note', required: false },
];

/** An active budget (other than [exceptId]) for [categoryId], if any. */
export function conflictingMonthlyBudget(budgets: Budget[], categoryId: string, exceptId?: string): Budget | undefined {
  return budgets.find((b) => b.id !== exceptId && b.categoryId === categoryId && b.status === 'active');
}

async function validateBudget(i: BudgetInput, s: FinanceSnapshot, exceptId?: string, active = true): Promise<Record<string, string>> {
  const e: Record<string, string> = {};
  const cat = await s.category(i.categoryId);
  if (!cat || cat.isArchived) {
    e.categoryId = 'Choose a category.';
  } else if (cat.type !== 'expense') {
    e.categoryId = 'Budgets work with spending categories only.';
  } else if (active && conflictingMonthlyBudget(await s.budgets(), i.categoryId, exceptId)) {
    e.categoryId = `${cat.name} already has a monthly budget. Edit that one instead.`;
  }
  if (i.limit <= 0) e.limit = 'Enter a limit greater than zero.';
  if (i.limit > MAX_BUDGET_LIMIT_PAISE) e.limit = 'That limit looks too large. Please check it.';
  const w = i.warningThresholdBps;
  if (w !== null && (w < MIN_BUDGET_WARNING_BPS || w > MAX_BUDGET_WARNING_BPS)) {
    e.warningThresholdBps = 'Choose a warning level between 50% and 95%.';
  }
  if ((i.note?.length ?? 0) > 200) e.note = 'Keep the note under 200 characters.';
  return e;
}

/** formatBps(bps, decimals: 0). */
const formatBps0 = (bps: number) => `${(bps / 100).toFixed(0)}%`;

async function lines(i: BudgetInput, s: FinanceSnapshot): Promise<PreviewLine[]> {
  return [
    { label: 'Category', value: (await s.category(i.categoryId))?.name ?? '—' },
    { label: 'Limit', value: formatInr(i.limit), emphasis: true },
    { label: 'Period', value: `Every month, from ${formatDate(currentBudgetPeriod(s).start)}` },
    { label: 'Warn at', value: formatBps0(i.warningThresholdBps ?? DEFAULT_BUDGET_WARNING_BPS) },
  ];
}

/**
 * [b]'s limit history after changing its limit to [next] today: months before
 * this one keep the old limit, this month onwards uses [next].
 */
export function limitHistoryAfterEdit(b: Budget, next: number, s: FinanceSnapshot): BudgetLimitChange[] {
  const until = currentBudgetMonth(s).previous;
  const started = budgetStartMonth(b, s.monthStartDay, s.prefs.timeZone);
  if (next === b.limitPaise || started.compareTo(until) > 0) return b.previousLimits;
  // Already recorded for last month (e.g. a second edit this month).
  if (b.previousLimits.some((c) => c.until >= until.id)) return b.previousLimits;
  return [...b.previousLimits, { until: until.id, limitPaise: b.limitPaise }];
}

async function existing(ctx: ActionContext, id: string): Promise<Budget> {
  const b = (await ctx.snapshot.budgets()).find((x) => x.id === id);
  if (!b) throw AppFailure.notFound('This budget no longer exists.');
  return b;
}

async function reload(ctx: ActionContext, id: string): Promise<Budget> {
  ctx.snapshot.invalidate();
  return existing(ctx, id);
}

export const createBudget = defineAction({
  descriptor: {
    id: 'budgets.create',
    module: 'budgets',
    title: 'Create a budget',
    description: 'Sets a spending limit for an expense category. Budgets hold no money; spending is derived from transactions.',
    risk: 'low',
    movesMoney: false,
    reversible: true,
    fields,
  },
  input: budgetInput,
  async prepare(input, ctx) {
    throwIfErrors(await validateBudget(input, ctx.snapshot));
    const name = (await ctx.snapshot.category(input.categoryId))?.name ?? 'category';
    return {
      title: 'Create budget',
      summary: `Budget for ${name} · ${formatInr(input.limit)}`,
      lines: await lines(input, ctx.snapshot),
    };
  },
  async execute(input, ctx) {
    const now = ctx.now.toISOString();
    const id = ctx.ids.next('bud');
    await ctx.tx
      .insertInto('budgets')
      .values({
        user_id: ctx.userId,
        id,
        category_id: input.categoryId,
        limit_paise: input.limit,
        status: 'active',
        warning_threshold_bps: input.warningThresholdBps ?? DEFAULT_BUDGET_WARNING_BPS,
        note: input.note,
        version: 1,
        created_at: now,
        updated_at: now,
      })
      .execute();
    ctx.touched.push(id);
    return reload(ctx, id);
  },
});

export const updateBudget = defineAction({
  descriptor: {
    id: 'budgets.update',
    module: 'budgets',
    title: 'Edit a budget',
    description: "Changes a budget's category, monthly limit or warning level. Earlier months keep the limit they had.",
    risk: 'low',
    movesMoney: false,
    reversible: true,
    fields: [
      { name: 'id', kind: 'id', description: 'Budget id', required: true },
      { name: 'expectedVersion', kind: 'integer', description: 'Version that was read', required: true },
      ...fields,
    ],
  },
  input: z.object({ id: zId, expectedVersion: zVersion, ...dataShape }),
  async prepare(input, ctx) {
    const b = await existing(ctx, input.id);
    if (b.version !== input.expectedVersion) throw AppFailure.stale('This budget changed since you opened it. Reload and try again.');
    throwIfErrors(await validateBudget(input, ctx.snapshot, b.id, b.status !== 'paused'));
    const name = (await ctx.snapshot.category(input.categoryId))?.name ?? 'category';
    return {
      title: 'Save changes',
      summary: `Update ${name} budget to ${formatInr(input.limit)}`,
      lines: await lines(input, ctx.snapshot),
    };
  },
  async execute(input, ctx) {
    const b = await existing(ctx, input.id);
    const history = limitHistoryAfterEdit(b, input.limit, ctx.snapshot);
    const row = await ctx.tx
      .updateTable('budgets')
      .set({
        category_id: input.categoryId,
        limit_paise: input.limit,
        warning_threshold_bps: input.warningThresholdBps ?? b.warningThresholdBps,
        note: input.note,
        updated_at: ctx.now.toISOString(),
        version: b.version + 1,
      })
      .where('user_id', '=', ctx.userId)
      .where('id', '=', b.id)
      .where('version', '=', b.version)
      .returning('id')
      .executeTakeFirst();
    if (!row) throw AppFailure.stale('This budget changed since you opened it. Reload and try again.');
    for (const c of history.filter((h) => !b.previousLimits.some((p) => p.until === h.until))) {
      await ctx.tx
        .insertInto('budget_limit_changes')
        .values({ user_id: ctx.userId, budget_id: b.id, until_month: c.until, limit_paise: c.limitPaise })
        .onConflict((oc) => oc.columns(['user_id', 'budget_id', 'until_month']).doUpdateSet({ limit_paise: c.limitPaise }))
        .execute();
    }
    ctx.touched.push(b.id);
    return reload(ctx, b.id);
  },
});

export const setBudgetPaused = defineAction({
  descriptor: {
    id: 'budgets.setPaused',
    module: 'budgets',
    title: 'Pause or resume a budget',
    description: 'A paused budget keeps its settings but stops tracking warnings and alerts.',
    risk: 'low',
    movesMoney: false,
    reversible: true,
    fields: [
      { name: 'id', kind: 'id', description: 'Budget id', required: true },
      { name: 'paused', kind: 'boolean', description: 'true to pause, false to resume', required: true },
    ],
  },
  input: z.object({ id: zId, paused: zBool() }),
  async prepare(input, ctx) {
    const b = await existing(ctx, input.id);
    const name = (await ctx.snapshot.category(b.categoryId))?.name ?? 'Budget';
    if (!input.paused && conflictingMonthlyBudget(await ctx.snapshot.budgets(), b.categoryId, b.id)) {
      throw AppFailure.conflict(`${name} already has an active monthly budget. Pause or delete it first.`);
    }
    return {
      title: input.paused ? 'Pause budget' : 'Resume budget',
      summary: input.paused ? `${name} budget paused` : `${name} budget resumed`,
      basis: { v: b.version, status: b.status },
    };
  },
  async execute(input, ctx) {
    const b = await existing(ctx, input.id);
    const target = input.paused ? 'paused' : 'active';
    if (b.status === target) return b;
    const row = await ctx.tx
      .updateTable('budgets')
      .set({ status: target, updated_at: ctx.now.toISOString(), version: b.version + 1 })
      .where('user_id', '=', ctx.userId)
      .where('id', '=', b.id)
      .where('version', '=', b.version)
      .returning('id')
      .executeTakeFirst();
    if (!row) throw AppFailure.stale('This budget changed since you opened it. Reload and try again.');
    ctx.touched.push(b.id);
    return reload(ctx, b.id);
  },
});

export const deleteBudget = defineAction({
  descriptor: {
    id: 'budgets.delete',
    module: 'budgets',
    title: 'Delete a budget',
    description: 'Removes a spending limit. Transactions and balances are not affected.',
    risk: 'consequential',
    movesMoney: false,
    reversible: false,
    fields: [{ name: 'id', kind: 'id', description: 'Budget id', required: true }],
  },
  input: z.object({ id: zId }),
  async prepare(input, ctx) {
    const b = await existing(ctx, input.id);
    const name = (await ctx.snapshot.category(b.categoryId))?.name ?? 'this category';
    return {
      title: 'Delete budget?',
      summary: `Delete the ${name} budget`,
      lines: [
        { label: 'Category', value: name },
        { label: 'Limit', value: formatInr(b.limitPaise), emphasis: true },
        { label: 'Period', value: 'Monthly' },
      ],
      warnings: ['Your transactions stay exactly as they are. Only the limit is removed.'],
      basis: { v: b.version },
    };
  },
  async execute(input, ctx) {
    const b = await existing(ctx, input.id);
    await ctx.tx.deleteFrom('budgets').where('user_id', '=', ctx.userId).where('id', '=', b.id).execute();
    ctx.touched.push(b.id);
    return b;
  },
});

export const budgetsActions: AnyAction[] = [createBudget, updateBudget, setBudgetPaused, deleteBudget] as AnyAction[];
