// emergencyFund.configure / contribute / withdraw
// (lib/features/emergency_fund/application/emergency_actions.dart).
// Contributions and withdrawals are internal allocations: no transactions,
// cash and net worth unchanged.

import { z } from 'zod';
import { zDate, zInt, zMoney, zMoneyOpt, zTextOpt } from '../../actions/input';
import { defineAction, type AnyAction, type FieldSpec } from '../../actions/types';
import { formatDate } from '../../core/dates';
import { throwIfErrors } from '../../core/failure';
import { formatInr } from '../../core/money';
import { EMERGENCY_FUND_BUCKET_ID, emergencyPlanDto, emergencyPlanFromRow, movementFromRow } from '../../finance/models';
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

const movementShape = { amount: zMoney, date: zDate, note: zTextOpt };
const movementFields: FieldSpec[] = [
  { name: 'amount', kind: 'money', description: 'Amount in rupees', required: true },
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
        ? 'Earmarks available cash for emergencies. Not an expense; net worth is unchanged.'
        : 'Releases earmarked emergency money back to available cash. Not income.',
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
      if (isContribution && input.amount > available) {
        e.amount = available > 0 ? `Only ${formatInr(available)} is available to set aside.` : 'There is no available money to set aside right now.';
      }
      if (!isContribution && input.amount > saved) e.amount = `Only ${formatInr(saved)} is in your emergency fund.`;
      if ((input.note?.length ?? 0) > 200) e.note = 'Keep the note under 200 characters.';
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
          { label: 'Emergency fund', value: `${formatInr(saved)} → ${formatInr(savedAfter)}` },
          { label: 'Available to spend', value: `${formatInr(available)} → ${formatInr(availAfter)}` },
          { label: 'Date', value: formatDate(input.date) },
          { label: 'Net worth', value: 'Unchanged' },
        ],
        warnings,
        basis: { saved },
      };
    },
    async execute(input, ctx) {
      const row = await ctx.tx
        .insertInto('savings_movements')
        .values({
          user_id: ctx.userId,
          id: ctx.ids.next('sv'),
          bucket_type: 'emergencyFund',
          bucket_id: EMERGENCY_FUND_BUCKET_ID,
          kind,
          amount_paise: input.amount,
          date: input.date,
          note: input.note,
          created_at: ctx.now.toISOString(),
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      ctx.touched.push(row.id);
      return movementFromRow(row);
    },
  });
}

export const contributeEmergencyFund = movementAction('contribution');
export const withdrawEmergencyFund = movementAction('withdrawal');

export const emergencyFundActions: AnyAction[] = [configureEmergencyFund, contributeEmergencyFund, withdrawEmergencyFund] as AnyAction[];
