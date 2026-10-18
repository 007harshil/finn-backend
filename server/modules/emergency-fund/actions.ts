// emergencyFund.configure / contribute / withdraw
// (lib/features/emergency_fund/application/emergency_actions.dart).
// Contributions and withdrawals are internal allocations: no transactions,
// cash and net worth unchanged.

import { z } from 'zod';
import { zDate, zInt, zMoney, zMoneyOpt, zTextOpt } from '../../actions/input';
import { defineAction, type ActionContext, type AnyAction, type FieldSpec, type PreviewLine } from '../../actions/types';
import { formatDate } from '../../core/dates';
import { throwIfErrors } from '../../core/failure';
import { formatInr } from '../../core/money';
import { EMERGENCY_FUND_BUCKET_ID, emergencyPlanDto, emergencyPlanFromRow, movementFromRow } from '../../finance/models';
import { holdingsOf, notEnoughOn, planRelease, resolveSetAsideAccount } from '../savings/allocation';
import { planTarget } from './calculator';
import { loadEmergencyStatus } from './service';

const MIN_MONTHS = 1;
const MAX_MONTHS = 24;
/** ₹100 crore, guards against typos. */
const MAX_AMOUNT_PAISE = 1_000_000_000 * 100;

export const configureEmergencyFund = defineAction({
  descriptor: {
    id: 'emergencyFund.configure',
    module: 'emergencyFund',
    title: 'Set up the emergency fund plan',
    description: 'Sets essential monthly expenses and the months of cover to aim for. No money moves.',
    risk: 'low',
    movesMoney: false,
    reversible: true,
    fields: [
      { name: 'essentialMonthlyExpenses', kind: 'money', description: 'Essential spending per month', required: true },
      { name: 'targetMonths', kind: 'integer', description: 'Months of cover (1–24)', required: true },
      { name: 'targetOverride', kind: 'money', description: 'Custom target amount', required: false },
    ],
  },
  input: z.object({ essentialMonthlyExpenses: zMoney, targetMonths: zInt, targetOverride: zMoneyOpt }),
  async prepare(input) {
    const e: Record<string, string> = {};
    if (input.essentialMonthlyExpenses <= 0) e.essentialMonthlyExpenses = 'Enter your essential monthly spending.';
    else if (input.essentialMonthlyExpenses > MAX_AMOUNT_PAISE) e.essentialMonthlyExpenses = 'That amount looks too large. Please check it.';
    if (input.targetMonths < MIN_MONTHS || input.targetMonths > MAX_MONTHS) {
      e.targetMonths = `Choose between ${MIN_MONTHS} and ${MAX_MONTHS} months.`;
    }
    const o = input.targetOverride;
    if (o !== null && o <= 0) e.targetOverride = 'Enter a target greater than zero.';
    if (o !== null && o > MAX_AMOUNT_PAISE) e.targetOverride = 'That target looks too large. Please check it.';
    throwIfErrors(e);
    const target = o ?? input.essentialMonthlyExpenses * input.targetMonths;
    return {
      title: 'Save plan',
      summary: `Emergency fund target ${formatInr(target)}`,
      lines: [
        { label: 'Essentials per month', value: formatInr(input.essentialMonthlyExpenses) },
        { label: 'Months of cover', value: String(input.targetMonths) },
        { label: 'Target', value: formatInr(target), emphasis: true },
      ],
    };
  },
  async execute(input, ctx) {
    const now = ctx.now.toISOString();
    const values = {
      essential_monthly_paise: input.essentialMonthlyExpenses,
      target_months: input.targetMonths,
      target_override_paise: input.targetOverride,
      updated_at: now,
    };
    const row = await ctx.tx
      .insertInto('emergency_plans')
      .values({ user_id: ctx.userId, ...values })
      .onConflict((oc) => oc.column('user_id').doUpdateSet(values))
      .returningAll()
      .executeTakeFirstOrThrow();
    ctx.touched.push('emergency_plan');
    return emergencyPlanDto(emergencyPlanFromRow(row));
  },
});

const movementShape = { amount: zMoney, accountId: zTextOpt, date: zDate, note: zTextOpt };
const movementFields: FieldSpec[] = [
  { name: 'amount', kind: 'money', description: 'Amount in rupees', required: true },
  {
    name: 'accountId',
    kind: 'id',
    description:
      'Account the money is set aside on (contribution: default account when omitted) or released from (withdrawal: the accounts holding the most when omitted)',
    required: false,
  },
  { name: 'date', kind: 'date', description: 'Date (not in the future)', required: true },
  { name: 'note', kind: 'string', description: 'Note', required: false },
];

function movementAction(kind: 'contribution' | 'withdrawal') {
  const isContribution = kind === 'contribution';
  return defineAction({
    descriptor: {
      id: isContribution ? 'emergencyFund.contribute' : 'emergencyFund.withdraw',
      module: 'emergencyFund',
      title: isContribution ? 'Add to the emergency fund' : 'Withdraw from the emergency fund',
      description: isContribution
        ? 'Sets money aside for emergencies on an account. Not an expense: the account balance and net worth are unchanged, but the money can no longer be spent.'
        : 'Releases emergency money back to spendable. Not income.',
      risk: 'consequential',
      movesMoney: false,
      reversible: true,
      fields: movementFields,
    },
    input: z.object(movementShape),
    async prepare(input, ctx) {
      const status = await loadEmergencyStatus(ctx.snapshot, { withSuggestion: false });
      const saved = status.saved;
      const available = (await ctx.snapshot.balance()).availablePaise;
      const e: Record<string, string> = {};
      if (input.amount <= 0) e.amount = 'Enter an amount greater than zero.';
      if (input.date > ctx.today) e.date = 'The date cannot be in the future.';
      if ((input.note?.length ?? 0) > 200) e.note = 'Keep the note under 200 characters.';
      const plan = await accountPlan(ctx, input, saved, e);
      throwIfErrors(e);
      const savedAfter = isContribution ? saved + input.amount : saved - input.amount;
      const availAfter = isContribution ? available - input.amount : available + input.amount;
      const target = planTarget(status.plan);
      const warnings: string[] = [];
      if (isContribution && target > 0 && saved < target && savedAfter >= target) warnings.push('This fully funds your emergency target!');
      if (!isContribution) warnings.push('Using your safety net is okay — that is what it is for. You can top it up later.');
      return {
        title: isContribution ? 'Add to emergency fund' : 'Withdraw from emergency fund',
        summary: isContribution
          ? `Set aside ${formatInr(input.amount)} for emergencies`
          : `Release ${formatInr(input.amount)} from your emergency fund`,
        lines: [
          { label: 'Amount', value: formatInr(input.amount), emphasis: true },
          ...plan.lines,
          { label: 'Emergency fund', value: `${formatInr(saved)} → ${formatInr(savedAfter)}` },
          { label: 'Available to spend (total)', value: `${formatInr(available)} → ${formatInr(availAfter)}` },
          { label: 'Date', value: formatDate(input.date) },
          { label: 'Net worth', value: 'Unchanged' },
        ],
        warnings,
        basis: { saved },
      };
    },
    async execute(input, ctx) {
      const status = await loadEmergencyStatus(ctx.snapshot, { withSuggestion: false });
      const plan = await accountPlan(ctx, input, status.saved, {});
      let first: ReturnType<typeof movementFromRow> | null = null;
      for (const r of plan.releases) {
        const row = await ctx.tx
          .insertInto('savings_movements')
          .values({
            user_id: ctx.userId,
            id: ctx.ids.next('sv'),
            bucket_type: 'emergencyFund',
            bucket_id: EMERGENCY_FUND_BUCKET_ID,
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
    input: { amount: number; accountId: string | null },
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
    if (input.amount > saved) e.amount = `Only ${formatInr(saved)} is in your emergency fund.`;
    const names = new Map((await ctx.snapshot.moneyAccounts()).map((a) => [a.id, a.name]));
    if (input.accountId !== null && !names.has(input.accountId)) e.accountId = 'This account does not exist.';
    const held = holdingsOf(await ctx.snapshot.movements(), 'emergencyFund', EMERGENCY_FUND_BUCKET_ID, ctx.today);
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

export const contributeEmergencyFund = movementAction('contribution');
export const withdrawEmergencyFund = movementAction('withdrawal');

export const emergencyFundActions: AnyAction[] = [configureEmergencyFund, contributeEmergencyFund, withdrawEmergencyFund] as AnyAction[];
