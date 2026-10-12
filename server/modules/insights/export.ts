// JSON export (lib/features/export/application/export_service.dart buildJson):
// the same document the app writes, built on the server. CSV and PDF stay
// client-side. Dated records (transactions, goal / emergency movements, loan
// payments, settlements) are limited to the range; ongoing records are
// exported in full. Ranges are bounded to 3 years and transactions are capped
// per export with a clear error.

import { z } from 'zod';
import { DateRange, addMonthsClamped, isIsoDate } from '../../core/dates';
import { AppFailure } from '../../core/failure';
import { emergencyPlanDto } from '../../finance/models';
import type { FinanceSnapshot } from '../../finance/snapshot';
import { countTransactions, transactionsOldestFirst } from './queries';

export const EXPORT_MODULES = ['transactions', 'budgets', 'goals', 'emergencyFund', 'loans', 'subscriptions', 'pending', 'assets'] as const;
export type ExportModule = (typeof EXPORT_MODULES)[number];

export const MAX_EXPORT_YEARS = 3;
/** Transactions per export; larger ranges must be split. */
export const MAX_EXPORT_TRANSACTIONS = 20_000;

const csvList = (v: string | undefined) =>
  v === undefined
    ? undefined
    : v
        .split(',')
        .map((x) => x.trim())
        .filter(Boolean);

export const exportQuery = z
  .object({
    from: z.string().refine(isIsoDate, 'Expected a date formatted yyyy-MM-dd'),
    to: z.string().refine(isIsoDate, 'Expected a date formatted yyyy-MM-dd'),
    modules: z
      .string()
      .optional()
      .transform(csvList)
      .pipe(z.array(z.enum(EXPORT_MODULES, { message: `Modules must be among: ${EXPORT_MODULES.join(', ')}.` })).min(1, 'Choose at least one module.').optional()),
    categoryIds: z
      .string()
      .optional()
      .transform(csvList)
      .pipe(z.array(z.string().min(1).max(128)).max(200).optional()),
  })
  .superRefine((q, ctx) => {
    if (!isIsoDate(q.from) || !isIsoDate(q.to)) return;
    if (q.to < q.from) ctx.addIssue({ code: 'custom', path: ['to'], message: 'The end date must be on or after the start date.' });
    else if (q.to >= addMonthsClamped(q.from, 12 * MAX_EXPORT_YEARS)) {
      ctx.addIssue({ code: 'custom', path: ['to'], message: `Export at most ${MAX_EXPORT_YEARS} years at a time.` });
    }
  });
export type ExportQuery = z.output<typeof exportQuery>;

const byDate = <T extends { date: string }>(a: T, b: T) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0);

/** GET /export: `{ fileName, mimeType, recordCount, document }`; `document` is the Flutter JSON export verbatim. */
export async function buildJsonExport(s: FinanceSnapshot, q: ExportQuery, exportedAt: Date) {
  const range = new DateRange(q.from, q.to);
  const modules = new Set<ExportModule>(q.modules ?? EXPORT_MODULES);
  const has = (m: ExportModule) => modules.has(m);
  const categoryIds = q.categoryIds ?? null;
  let count = 0;
  const rows = <T>(items: T[]): T[] => {
    count += items.length;
    return items;
  };
  const inRange = <T extends { date: string }>(items: T[]) => items.filter((x) => range.contains(x.date)).sort(byDate);

  const data: Record<string, unknown> = {};
  if (has('transactions')) {
    const n = await countTransactions(s, range, categoryIds);
    if (n > MAX_EXPORT_TRANSACTIONS) {
      throw AppFailure.validation(
        `This range has ${n} transactions. Export at most ${MAX_EXPORT_TRANSACTIONS} at a time: choose a shorter range.`,
        { to: 'Choose a shorter range.' },
      );
    }
    const txs = await transactionsOldestFirst(s, range, categoryIds);
    const used = new Set(txs.map((t) => t.categoryId));
    data.categories = (await s.categories()).filter((c) => used.has(c.id));
    data.transactions = rows(txs);
  }
  if (has('budgets')) data.budgets = rows(await s.budgets());
  if (has('goals') || has('emergencyFund')) {
    const movements = await s.movements();
    if (has('goals')) {
      data.goals = rows(await s.goals());
      data.goalMovements = rows(inRange(movements.filter((m) => m.bucketType === 'goal')));
    }
    if (has('emergencyFund')) {
      const plan = await s.emergencyPlan();
      if (plan !== null) count++;
      data.emergencyFund = {
        plan: emergencyPlanDto(plan),
        movements: rows(inRange(movements.filter((m) => m.bucketType === 'emergencyFund'))),
      };
    }
  }
  if (has('loans')) {
    data.loans = rows(await s.loans());
    data.loanPayments = rows(inRange(await s.loanPayments()));
  }
  if (has('subscriptions')) data.subscriptions = rows(await s.subscriptions());
  if (has('pending')) {
    data.pending = rows(await s.pending());
    data.settlements = rows(inRange(await s.settlements()));
  }
  if (has('assets')) data.assets = rows(await s.assets());

  const document = {
    exportedAt: exportedAt.toISOString(),
    app: 'FiNN',
    version: 1,
    range: { start: range.start, end: range.end },
    modules: EXPORT_MODULES.filter(has),
    ...(categoryIds !== null ? { categoryIds: [...categoryIds].sort() } : {}),
    conventions: { money: 'integer paise (₹1 = 100 paise)', dates: 'yyyy-MM-dd' },
    data,
  };
  return {
    fileName: `finn_export_${range.start}_to_${range.end}.json`,
    mimeType: 'application/json',
    recordCount: count,
    document,
  };
}
