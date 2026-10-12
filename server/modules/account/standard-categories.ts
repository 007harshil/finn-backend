// Categories every account starts with (SeedData.standardCategories in the
// Flutter app). Ids are fixed so linked transactions can use the system
// categories (SystemCategories) without a lookup.

export const SystemCategories = {
  loanEmi: 'cat_sys_emi',
  loanReceived: 'cat_sys_loan_in',
  loanGiven: 'cat_sys_loan_out',
  loanRepaymentReceived: 'cat_sys_loan_repay_in',
  settlementPaid: 'cat_sys_settle_out',
  settlementReceived: 'cat_sys_settle_in',
  uncategorizedExpense: 'cat_sys_other_out',
  uncategorizedIncome: 'cat_sys_other_in',
} as const;

export interface StandardCategory {
  id: string;
  name: string;
  type: 'income' | 'expense';
  iconKey: string;
  colorIndex: number;
  description: string;
  isSystem: boolean;
  isEssential: boolean;
}

const e = (id: string, name: string, iconKey: string, colorIndex: number, description: string, isEssential = false): StandardCategory => ({
  id, name, type: 'expense', iconKey, colorIndex, description, isSystem: false, isEssential,
});
const i = (id: string, name: string, iconKey: string, colorIndex: number, description: string): StandardCategory => ({
  id, name, type: 'income', iconKey, colorIndex, description, isSystem: false, isEssential: false,
});
const sys = (id: string, name: string, type: 'income' | 'expense', iconKey: string, colorIndex: number, description: string): StandardCategory => ({
  id, name, type, iconKey, colorIndex, description, isSystem: true, isEssential: false,
});

export const STANDARD_CATEGORIES: readonly StandardCategory[] = [
  e('cat_food', 'Food & Dining', 'utensils', 12, 'Restaurants, cafés, Swiggy, Zomato'),
  e('cat_groceries', 'Groceries', 'shoppingCart', 2, 'BigBasket, DMart, kirana, vegetables', true),
  e('cat_rent', 'Rent & Housing', 'home', 9, 'Rent, maintenance, society charges', true),
  e('cat_utilities', 'Bills & Utilities', 'zap', 3, 'Electricity, water, gas, broadband, mobile', true),
  e('cat_transport', 'Transport', 'car', 0, 'Fuel, Uber, Ola, metro, parking', true),
  e('cat_shopping', 'Shopping', 'shoppingBag', 1, 'Amazon, Flipkart, Myntra, electronics'),
  e('cat_entertainment', 'Entertainment', 'clapperboard', 13, 'Movies, concerts, events, games'),
  e('cat_health', 'Health & Medical', 'heartPulse', 4, 'Doctor, pharmacy, diagnostics', true),
  e('cat_education', 'Education', 'graduationCap', 5, 'Courses, books, fees'),
  e('cat_travel', 'Travel', 'plane', 10, 'Flights, trains, hotels, holidays'),
  e('cat_personal_care', 'Personal Care', 'sparkles', 8, 'Salon, grooming, Urban Company'),
  e('cat_gifts', 'Gifts & Donations', 'gift', 4, 'Gifts, festivals, charity'),
  e('cat_insurance', 'Insurance', 'shieldCheck', 11, 'Health, term and vehicle insurance', true),
  e('cat_subscriptions', 'Subscriptions', 'repeat', 1, 'OTT, music, cloud storage, apps'),
  e('cat_family', 'Family Support', 'users', 7, 'Money sent to parents and family', true),
  e('cat_fitness', 'Fitness', 'dumbbell', 2, 'Gym, yoga, sports'),
  i('cat_salary', 'Salary', 'briefcase', 11, 'Monthly salary and bonuses'),
  i('cat_freelance', 'Freelance', 'laptop', 5, 'Side projects and consulting'),
  i('cat_interest', 'Interest & Dividends', 'percent', 2, 'Savings interest, FD payouts, dividends'),
  i('cat_refunds', 'Refunds & Cashback', 'receipt', 0, 'Refunds, cashback, rewards'),
  i('cat_gifts_in', 'Gifts Received', 'gift', 8, 'Money received as gifts'),
  i('cat_rental', 'Rental Income', 'building', 9, 'Rent received'),
  sys(SystemCategories.loanEmi, 'EMI & Loan Repayment', 'expense', 'scale', 10, 'Recorded from the Loans module'),
  sys(SystemCategories.loanGiven, 'Loan Given', 'expense', 'handCoins', 6, 'Money lent, recorded from Loans'),
  sys(SystemCategories.settlementPaid, 'Settlement Paid', 'expense', 'handshake', 13, 'Recorded from Pending payments'),
  sys(SystemCategories.uncategorizedExpense, 'Other Expense', 'expense', 'circleDot', 6, 'Anything else'),
  sys(SystemCategories.loanReceived, 'Loan Received', 'income', 'landmark', 6, 'Loan disbursement, recorded from Loans'),
  sys(SystemCategories.loanRepaymentReceived, 'Loan Repayment Received', 'income', 'handCoins', 11, 'Repayments of money you lent'),
  sys(SystemCategories.settlementReceived, 'Settlement Received', 'income', 'handshake', 2, 'Recorded from Pending payments'),
  sys(SystemCategories.uncategorizedIncome, 'Other Income', 'income', 'circleDot', 6, 'Anything else'),
];
