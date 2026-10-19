// App-store review sign-in. Store reviewers cannot read our emailed codes, so
// one configured address (REVIEW_EMAIL) gets a fixed code (REVIEW_CODE)
// instead of an email. Everything else about the code is unchanged: it is
// stored as a normal one-time code, expires, burns after OTP_MAX_ATTEMPTS
// wrong guesses and counts against the rate limits. Also covers
// account-deletion codes, so reviewers can test deletion.
//
// On first sign-in the review account is filled with a few months of demo
// records (through the import path), so reviewers see a working app.

import type { AuthUser } from './verify';
import { addDays, addMonthsClamped, startOfMonth, todayIn, type IsoDate } from '../core/dates';
import { authEnv } from '../env';
import { CASH_ACCOUNT_ID } from '../finance/models';
import { withUserTx } from '../db/tx';
import { ensureAccount, isAccountEmpty } from '../modules/account/bootstrap';
import { importAccount, importSchema } from '../modules/sync/import';

/** The fixed code for [email] when it is the configured review address, else null. */
export function reviewCodeFor(email: string): string | null {
  const { REVIEW_EMAIL, REVIEW_CODE } = authEnv();
  if (!REVIEW_EMAIL || !REVIEW_CODE) return null;
  return email === REVIEW_EMAIL ? REVIEW_CODE : null;
}

const SEED_KEY = 'review-demo-seed-v1';

/** Fills an empty review account with demo data. Never throws: sign-in must not fail on it. */
export async function seedReviewAccount(user: AuthUser, now = new Date()): Promise<void> {
  try {
    const empty = await withUserTx(
      user,
      async (tx) => {
        await ensureAccount(tx, user);
        return isAccountEmpty(tx, user.userId);
      },
      { write: true },
    );
    if (!empty) return;
    await importAccount(user, importSchema.parse(demoPayload(todayIn('Asia/Kolkata', now), now)), SEED_KEY);
  } catch (err) {
    console.error('Review account seed failed', err instanceof Error ? err.message : err);
  }
}

const rupees = (r: number) => r * 100;

/** About three months of an ordinary salaried household, ending [today]. */
export function demoPayload(today: IsoDate, now: Date): unknown {
  const at = now.toISOString();
  const start = addMonthsClamped(startOfMonth(today), -2);
  const stamp = { createdAt: at, updatedAt: at };
  const bank = 'acc_demo_bank';
  const card = 'acc_demo_card';

  const transactions: object[] = [];
  let n = 0;
  const tx = (date: IsoDate, type: 'income' | 'expense', categoryId: string, amount: number, counterparty: string, accountId: string, channel: string | null = null) => {
    if (date > today) return;
    transactions.push({ id: `txn_demo_${++n}`, type, amountPaise: rupees(amount), categoryId, date, accountId, channel, counterparty, note: null, ...stamp });
  };
  for (let m = 0; m < 3; m++) {
    const month = addMonthsClamped(start, m);
    const day = (d: number) => addDays(month, d - 1);
    tx(day(1), 'income', 'cat_salary', 78_000, 'Acme Pvt Ltd', bank, 'Bank transfer');
    tx(day(3), 'expense', 'cat_rent', 22_000, 'Landlord', bank, 'UPI');
    tx(day(5), 'expense', 'cat_utilities', 1_850, 'Electricity board', bank, 'UPI');
    tx(day(6), 'expense', 'cat_groceries', 2_340, 'DMart', card, 'Card');
    tx(day(9), 'expense', 'cat_food', 640, 'Swiggy', bank, 'UPI');
    tx(day(11), 'expense', 'cat_transport', 1_200, 'Fuel', card, 'Card');
    tx(day(14), 'expense', 'cat_groceries', 1_980, 'BigBasket', bank, 'UPI');
    tx(day(16), 'expense', 'cat_entertainment', 900, 'PVR Cinemas', card, 'Card');
    tx(day(18), 'expense', 'cat_food', 1_150, 'Dinner out', CASH_ACCOUNT_ID, 'Cash');
    tx(day(20), 'expense', 'cat_health', 760, 'Pharmacy', CASH_ACCOUNT_ID, 'Cash');
    tx(day(22), 'expense', 'cat_shopping', 2_499, 'Amazon', card, 'Card');
    tx(day(25), 'expense', 'cat_family', 5_000, 'Parents', bank, 'UPI');
    tx(day(27), 'expense', 'cat_groceries', 1_420, 'Local kirana', CASH_ACCOUNT_ID, 'Cash');
  }

  const goalId = 'goal_demo_trip';
  const movements = [0, 1, 2]
    .map((m) => addDays(addMonthsClamped(start, m), 1))
    .filter((d) => d <= today)
    .map((date, i) => ({
      id: `mov_demo_${i + 1}`,
      bucketType: 'goal',
      bucketId: goalId,
      kind: 'contribution',
      amountPaise: rupees(5_000),
      accountId: bank,
      date,
      note: null,
      createdAt: at,
    }));

  return {
    profile: { exists: true, displayName: 'Play Reviewer', openingPaise: rupees(90_000), openingDate: start, monthlyIncomeEstimatePaise: rupees(78_000) },
    moneyAccounts: [
      { id: CASH_ACCOUNT_ID, name: 'Cash', kind: 'cash', openingPaise: rupees(4_000), openingDate: start, sortOrder: 0, ...stamp },
      { id: bank, name: 'Salary account', kind: 'bank', institution: 'Demo Bank', openingPaise: rupees(86_000), openingDate: start, isDefault: true, sortOrder: 1, ...stamp },
      { id: card, name: 'Credit card', kind: 'creditCard', institution: 'Demo Bank', last4: '4242', openingPaise: 0, openingDate: start, creditLimitPaise: rupees(150_000), sortOrder: 2, ...stamp },
    ],
    transactions,
    transfers: [{ id: 'trf_demo_1', fromAccountId: bank, toAccountId: CASH_ACCOUNT_ID, amountPaise: rupees(3_000), date: addDays(start, 7), channel: 'ATM', note: 'Cash withdrawal', ...stamp }],
    budgets: [
      { id: 'bud_demo_groceries', categoryId: 'cat_groceries', limitPaise: rupees(7_000), ...stamp },
      { id: 'bud_demo_food', categoryId: 'cat_food', limitPaise: rupees(3_000), ...stamp },
      { id: 'bud_demo_shopping', categoryId: 'cat_shopping', limitPaise: rupees(4_000), ...stamp },
    ],
    goals: [{ id: goalId, name: 'Goa trip', category: 'travel', targetPaise: rupees(45_000), targetDate: addMonthsClamped(today, 6), colorIndex: 10, ...stamp }],
    savingsMovements: movements,
    subscriptions: [
      { id: 'sub_demo_ott', name: 'Streaming plan', amountPaise: rupees(649), categoryId: 'cat_subscriptions', frequency: 'monthly', nextDueDate: addDays(today, 6), startDate: start, accountId: card, ...stamp },
      { id: 'sub_demo_gym', name: 'Gym membership', amountPaise: rupees(1_500), categoryId: 'cat_fitness', frequency: 'monthly', nextDueDate: addDays(today, 12), startDate: start, accountId: bank, ...stamp },
    ],
    pending: [
      { id: 'pen_demo_dinner', counterparty: 'Rahul', direction: 'owedToMe', kind: 'sharedExpense', originalPaise: rupees(1_200), purpose: 'Dinner split', createdDate: addDays(today, -4), ...stamp },
    ],
    assets: [{ id: 'ast_demo_fd', name: 'Fixed deposit', type: 'bankDeposit', valuePaise: rupees(100_000), valuedOn: start, ...stamp }],
    emergencyPlan: { configured: true, essentialMonthlyPaise: rupees(32_000), targetMonths: 6, updatedAt: at },
  };
}
