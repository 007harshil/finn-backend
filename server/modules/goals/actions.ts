// goals.create / update / contribute / withdraw / toggleArchive / delete
// (lib/features/goals/application/goal_actions.dart). Contributions and
// withdrawals are internal allocations: they never create transactions and
// never change cash or net worth.

import { z } from 'zod';
import { zDate, zDateOpt, zId, zInt, zMoney, zMoneyOpt, zTextOpt, zVersion } from '../../actions/input';
import { defineAction, type ActionContext, type AnyAction, type FieldSpec, type PreviewLine } from '../../actions/types';
import { MonthKey, formatMonthYear } from '../../core/dates';
import { AppFailure, throwIfErrors } from '../../core/failure';
import { formatInr } from '../../core/money';
import { GOAL_CATEGORIES, goalFromRow, movementFromRow, type Goal } from '../../finance/models';
import { holdingsOf, notEnoughOn, planRelease, resolveSetAsideAccount } from '../savings/allocation';
import { loadOneGoalProgress } from './service';

/** ₹100 crore, guards against typos. */
const MAX_TARGET_PAISE = 1_000_000_000 * 100;

const goalShape = {
  name: z.string(),
  category: z
    .enum(GOAL_CATEGORIES)
    .nullish()
    .transform((v) => v ?? 'other'),
  target: zMoney,
  colorIndex: zInt.nullish().transform((v) => v ?? 5),
  targetDate: zDateOpt,
  plannedMonthlyContribution: zMoneyOpt,
  initialAllocation: zMoneyOpt,
  accountId: zTextOpt,
  note: zTextOpt,
};
const goalInput = z.object(goalShape);
type GoalInput = z.output<typeof goalInput>;

const goalFields: FieldSpec[] = [
  { name: 'name', kind: 'string', description: 'Goal name, up to 50 characters, unique among active goals', required: true },
  { name: 'category', kind: 'enumeration', description: 'Goal type', required: false, allowedValues: GOAL_CATEGORIES },
  { name: 'target', kind: 'money', description: 'Target amount', required: true },
  { name: 'targetDate', kind: 'date', description: 'Target date (in the future)', required: false },
  { name: 'plannedMonthlyContribution', kind: 'money', description: 'Planned monthly amount', required: false },
  { name: 'initialAllocation', kind: 'money', description: 'Amount to set aside now (create only; ignored on update)', required: false },
  { name: 'accountId', kind: 'id', description: 'Account the starting amount is set aside on (default account when omitted)', required: false },
  { name: 'colorIndex', kind: 'integer', description: 'Colour swatch index (default 5)', required: false },
  { name: 'note', kind: 'string', description: 'Free-text note', required: false },
];

async function validateGoal(i: GoalInput, ctx: ActionContext, exceptId?: string): Promise<Record<string, string>> {
  const e: Record<string, string> = {};
  const name = i.name.trim();
  if (name === '') e.name = 'Give your goal a name.';
  if (name.length > 50) e.name = 'Keep the name under 50 characters.';
  const clash = (await ctx.snapshot.goals()).some(
    (g) => g.id !== exceptId && g.status === 'active' && g.name.toLowerCase() === name.toLowerCase(),
  );
  if (clash) e.name = 'You already have an active goal with this name.';
  if (i.target <= 0) e.target = 'Enter a target greater than zero.';
  if (i.target > MAX_TARGET_PAISE) e.target = 'That target looks too large. Please check it.';
  if (i.targetDate !== null && i.targetDate <= ctx.today) e.targetDate = 'Pick a date in the future.';
  if (i.plannedMonthlyContribution !== null && i.plannedMonthlyContribution <= 0) {
    e.plannedMonthlyContribution = 'Enter a positive amount.';
  }
  if (i.colorIndex < 0 || i.colorIndex > 63) e.colorIndex = 'Choose a colour.';
  if ((i.note?.length ?? 0) > 500) e.note = 'Keep the note under 500 characters.';
  const init = i.initialAllocation;
  if (init !== null && init > 0) {
    try {
      const here = await resolveSetAsideAccount(ctx, i.accountId);
      if (init > here.available) e.initialAllocation = notEnoughOn(here.account, here.available);
    } catch (err) {
      if (!(err instanceof AppFailure) || Object.keys(err.fieldErrors).length === 0) throw err;
      Object.assign(e, err.fieldErrors);
    }
  }
  return e;
}

async function existingGoal(ctx: ActionContext, id: string) {
  const p = await loadOneGoalProgress(ctx.snapshot, id);
  if (!p) throw AppFailure.notFound('This goal no longer exists.');
  return p;
}

async function updateGoal(ctx: ActionContext, g: Goal, values: Partial<Record<string, unknown>>): Promise<Goal> {
  const row = await ctx.tx
    .updateTable('goals')
    .set({ ...values, version: g.version + 1, updated_at: ctx.now.toISOString() })
    .where('user_id', '=', ctx.userId)
    .where('id', '=', g.id)
    .where('version', '=', g.version)
    .returningAll()
    .executeTakeFirst();
  if (!row) throw AppFailure.stale('This goal changed since you opened it. Reload and try again.');
  return goalFromRow(row);
}

export const createGoal = defineAction({
  descriptor: {
    id: 'goals.create',
    module: 'goals',
    title: 'Create a savings goal',
    description: 'Creates a goal. An optional starting amount is earmarked from available cash (not spent).',
    risk: 'low',
    movesMoney: false,
    reversible: true,
    fields: goalFields,
  },
  input: goalInput,
  async prepare(input, ctx) {
    throwIfErrors(await validateGoal(input, ctx));
    const init = input.initialAllocation ?? 0;
    const name = input.name.trim();
    const lines: PreviewLine[] = [{ label: 'Target', value: formatInr(input.target), emphasis: true }];
    if (input.targetDate) lines.push({ label: 'By', value: formatMonthYear(MonthKey.of(input.targetDate)) });
    if (init > 0) {
      const available = (await ctx.snapshot.balance()).availablePaise;
      const here = await resolveSetAsideAccount(ctx, input.accountId);
      lines.push({ label: 'Set aside now', value: formatInr(init) });
      lines.push({ label: 'Set aside on', value: here.account.name });
      lines.push({ label: `Free to spend in ${here.account.name}`, value: `${formatInr(here.available)} → ${formatInr(here.available - init)}` });
      lines.push({ label: 'Available to spend (total)', value: `${formatInr(available)} → ${formatInr(available - init)}` });
    }
    return {
      title: `Create ${name}`,
      summary: `New goal: ${name} · ${formatInr(input.target)}`,
      lines,
      requiresConfirmation: init > 0,
    };
  },
  async execute(input, ctx) {
    const now = ctx.now.toISOString();
    const row = await ctx.tx
      .insertInto('goals')
      .values({
        user_id: ctx.userId,
        id: ctx.ids.next('goal'),
        name: input.name.trim(),
        category: input.category,
        target_paise: input.target,
        target_date: input.targetDate,
        planned_monthly_paise: input.plannedMonthlyContribution,
        color_index: input.colorIndex,
        note: input.note,
        created_at: now,
        updated_at: now,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    ctx.touched.push(row.id);
    const init = input.initialAllocation ?? 0;
    if (init > 0) {
      const here = await resolveSetAsideAccount(ctx, input.accountId);
      const mv = await ctx.tx
        .insertInto('savings_movements')
        .values({
          user_id: ctx.userId,
          id: ctx.ids.next('sv'),
          bucket_type: 'goal',
          bucket_id: row.id,
          kind: 'contribution',
          amount_paise: init,
          account_id: here.account.id,
          date: ctx.today,
          note: 'Starting amount',
          created_at: now,
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      ctx.touched.push(mv.id);
    }
    return goalFromRow(row);
  },
});

export const updateGoalAction = defineAction({
  descriptor: {
    id: 'goals.update',
    module: 'goals',
    title: 'Edit a goal',
    description: 'Changes goal details. The saved amount only changes through contributions and withdrawals.',
    risk: 'low',
    movesMoney: false,
    reversible: true,
    fields: [
      { name: 'id', kind: 'id', description: 'Goal id', required: true },
      { name: 'expectedVersion', kind: 'integer', description: 'Version read', required: true },
      ...goalFields,
    ],
  },
  // initialAllocation is ignored on update (create only).
  input: z.object({ id: zId, expectedVersion: zVersion, ...goalShape, initialAllocation: z.unknown().optional() }),
  async prepare(input, ctx) {
    const g = (await existingGoal(ctx, input.id)).goal;
    if (g.version !== input.expectedVersion) throw AppFailure.stale('This goal changed since you opened it. Reload and try again.');
    throwIfErrors(await validateGoal({ ...input, initialAllocation: null }, ctx, input.id));
    return { title: 'Save changes', summary: `Update ${g.name}` };
  },
  async execute(input, ctx) {
    const g = (await existingGoal(ctx, input.id)).goal;
    const updated = await updateGoal(ctx, g, {
      name: input.name.trim(),
      category: input.category,
      target_paise: input.target,
      target_date: input.targetDate,
      planned_monthly_paise: input.plannedMonthlyContribution,
      color_index: input.colorIndex,
      note: input.note,
    });
    ctx.touched.push(updated.id);
    return updated;
  },
});

const movementShape = { goalId: zId, amount: zMoney, accountId: zTextOpt, date: zDate, note: zTextOpt };
const movementFields: FieldSpec[] = [
  { name: 'goalId', kind: 'id', description: 'Goal id', required: true },
  { name: 'amount', kind: 'money', description: 'Amount in rupees', required: true },
  {
    name: 'accountId',
    kind: 'id',
    description:
      'Account the money is set aside on (contribution: default account when omitted) or released from (withdrawal: the accounts holding the most when omitted)',
    required: false,
  },
  { name: 'date', kind: 'date', description: 'Date', required: true },
  { name: 'note', kind: 'string', description: 'Note', required: false },
];

function movementAction(kind: 'contribution' | 'withdrawal') {
  const isContribution = kind === 'contribution';
  return defineAction({
    descriptor: {
      id: isContribution ? 'goals.contribute' : 'goals.withdraw',
      module: 'goals',
      title: isContribution ? 'Add money to a goal' : 'Withdraw from a goal',
      description: isContribution
        ? 'Sets money aside for a goal on an account. Not an expense: the account balance and net worth are unchanged, but the money can no longer be spent.'
        : 'Releases money set aside for a goal back to spendable. Not income.',
      risk: 'consequential',
      movesMoney: false,
      reversible: true,
      fields: movementFields,
    },
    input: z.object(movementShape),
    async prepare(input, ctx) {
      const p = await existingGoal(ctx, input.goalId);
      if (p.goal.status !== 'active') throw AppFailure.validation('This goal is archived.');
      const available = (await ctx.snapshot.balance()).availablePaise;
      const e: Record<string, string> = {};
      if (input.amount <= 0) e.amount = 'Enter an amount greater than zero.';
      if (input.date > ctx.today) e.date = 'The date cannot be in the future.';
      if ((input.note?.length ?? 0) > 500) e.note = 'Keep the note under 500 characters.';
      const plan = await accountPlan(ctx, input, p.saved, e);
      throwIfErrors(e);
      const name = p.goal.name;
      const savedAfter = isContribution ? p.saved + input.amount : p.saved - input.amount;
      const availAfter = isContribution ? available - input.amount : available + input.amount;
      return {
        title: isContribution ? `Add to ${name}` : `Withdraw from ${name}`,
        summary: isContribution ? `Set aside ${formatInr(input.amount)} for ${name}` : `Release ${formatInr(input.amount)} from ${name}`,
        lines: [
          { label: 'Amount', value: formatInr(input.amount), emphasis: true },
          ...plan.lines,
          { label: 'Saved in goal', value: `${formatInr(p.saved)} → ${formatInr(savedAfter)}` },
          { label: 'Available to spend (total)', value: `${formatInr(available)} → ${formatInr(availAfter)}` },
          { label: 'Net worth', value: 'Unchanged' },
        ],
        warnings: isContribution && savedAfter >= p.goal.targetPaise && !p.isAchieved ? ['This completes your goal!'] : [],
        basis: { v: p.goal.version, saved: p.saved },
      };
    },
    async execute(input, ctx) {
      const p = await existingGoal(ctx, input.goalId);
      const plan = await accountPlan(ctx, input, p.saved, {});
      let first: ReturnType<typeof movementFromRow> | null = null;
      for (const r of plan.releases) {
        const row = await ctx.tx
          .insertInto('savings_movements')
          .values({
            user_id: ctx.userId,
            id: ctx.ids.next('sv'),
            bucket_type: 'goal',
            bucket_id: input.goalId,
            kind,
            amount_paise: r.amountPaise,
            account_id: r.accountId,
            date: input.date,
            note: input.note,
            created_at: ctx.now.toISOString(),
          })
          .returningAll()
          .executeTakeFirstOrThrow();
        ctx.touched.push(row.id);
        first ??= movementFromRow(row);
      }
      return first!;
    },
  });

  /** Which account(s) the amount lands on or leaves, with preview lines; problems go into [e]. */
  async function accountPlan(
    ctx: ActionContext,
    input: { goalId: string; amount: number; accountId: string | null },
    saved: number,
    e: Record<string, string>,
  ): Promise<{ releases: { accountId: string | null; amountPaise: number }[]; lines: PreviewLine[] }> {
    if (isContribution) {
      const here = await resolveSetAsideAccount(ctx, input.accountId);
      if (input.amount > here.available) e.amount = notEnoughOn(here.account, here.available);
      return {
        releases: [{ accountId: here.account.id, amountPaise: input.amount }],
        lines: [
          { label: 'Set aside on', value: here.account.name },
          { label: `Free to spend in ${here.account.name}`, value: `${formatInr(here.available)} → ${formatInr(here.available - input.amount)}` },
        ],
      };
    }
    if (input.amount > saved) e.amount = `Only ${formatInr(saved)} is saved in this goal.`;
    const names = new Map((await ctx.snapshot.moneyAccounts()).map((a) => [a.id, a.name]));
    if (input.accountId !== null && !names.has(input.accountId)) e.accountId = 'This account does not exist.';
    const held = holdingsOf(await ctx.snapshot.movements(), 'goal', input.goalId, ctx.today);
    const out = planRelease(held, input.amount, input.accountId, names);
    if (out.error !== null) {
      e.amount ??= out.error;
      return { releases: [], lines: [] };
    }
    return {
      releases: out.releases,
      lines: out.releases.map((r) => ({
        label: `Released on ${r.accountId ? (names.get(r.accountId) ?? 'account') : 'no account'}`,
        value: formatInr(r.amountPaise),
      })),
    };
  }
}

export const contributeGoal = movementAction('contribution');
export const withdrawGoal = movementAction('withdrawal');

export const toggleArchiveGoal = defineAction({
  descriptor: {
    id: 'goals.toggleArchive',
    module: 'goals',
    title: 'Archive or restore a goal',
    description: 'Hides a goal from the active list (or restores it). Earmarked money is unaffected.',
    risk: 'low',
    movesMoney: false,
    reversible: true,
    fields: [{ name: 'id', kind: 'id', description: 'Goal id', required: true }],
  },
  input: z.object({ id: zId }),
  async prepare(input, ctx) {
    const g = (await existingGoal(ctx, input.id)).goal;
    const archiving = g.status === 'active';
    return {
      title: archiving ? `Archive ${g.name}?` : `Restore ${g.name}?`,
      summary: `${archiving ? 'Archive' : 'Restore'} ${g.name}`,
    };
  },
  async execute(input, ctx) {
    const g = (await existingGoal(ctx, input.id)).goal;
    const updated = await updateGoal(ctx, g, { status: g.status === 'active' ? 'archived' : 'active' });
    ctx.touched.push(updated.id);
    return updated;
  },
});

export const deleteGoal = defineAction({
  descriptor: {
    id: 'goals.delete',
    module: 'goals',
    title: 'Delete a goal',
    description: 'Deletes a goal. Any saved amount is released back to available cash.',
    risk: 'consequential',
    movesMoney: false,
    reversible: false,
    fields: [{ name: 'id', kind: 'id', description: 'Goal id', required: true }],
  },
  input: z.object({ id: zId }),
  async prepare(input, ctx) {
    const p = await existingGoal(ctx, input.id);
    return {
      title: `Delete ${p.goal.name}?`,
      summary: `Delete ${p.goal.name}`,
      lines: p.saved > 0 ? [{ label: 'Returned to available cash', value: formatInr(p.saved), emphasis: true }] : [],
      warnings: ['Contribution history for this goal will be removed.'],
      basis: { v: p.goal.version, saved: p.saved },
    };
  },
  async execute(input, ctx) {
    const g = (await existingGoal(ctx, input.id)).goal;
    // savings_movements.goal_id cascades, so every movement of this goal
    // (including future-dated ones) goes with it and no earmark is orphaned.
    await ctx.tx.deleteFrom('goals').where('user_id', '=', ctx.userId).where('id', '=', g.id).execute();
    ctx.touched.push(g.id);
    return g;
  },
});

export const goalsActions: AnyAction[] = [createGoal, updateGoalAction, contributeGoal, withdrawGoal, toggleArchiveGoal, deleteGoal] as AnyAction[];
