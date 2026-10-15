// Activity list: filtering, search, sorting and keyset pagination
// (TransactionQuery in lib/features/transactions/application/transaction_filter.dart).
// Search matches counterparty, note, category name, or an amount typed as
// digits ("1250" matches ₹1,250; "1250.5" matches by decimal prefix).

import { sql, type SqlBool, type Expression } from 'kysely';
import { z } from 'zod';
import { zDate } from '../../actions/input';
import { AppFailure } from '../../core/failure';
import type { Tx } from '../../db/tx';
import { TRANSACTION_ORIGINS, transactionFromRow, type Transaction } from '../../finance/models';

const csv = <T extends string>(values: readonly T[]) =>
  z
    .string()
    .optional()
    .transform((s, ctx) => {
      if (!s) return [] as T[];
      const parts = s.split(',').map((p) => p.trim()).filter(Boolean);
      for (const p of parts) {
        if (!values.includes(p as T)) {
          ctx.addIssue({ code: 'custom', message: `Unknown value "${p.slice(0, 32)}"` });
          return z.NEVER;
        }
      }
      return parts as T[];
    });

const intParam = z
  .string()
  .regex(/^\d+$/)
  .transform(Number)
  .refine((n) => Number.isSafeInteger(n));

export const listQuerySchema = z
  .object({
    from: zDate.optional(),
    to: zDate.optional(),
    type: z.enum(['income', 'expense']).optional(),
    categoryIds: z
      .string()
      .optional()
      .transform((s) => (s ? s.split(',').map((p) => p.trim()).filter(Boolean).slice(0, 100) : [])),
    accountIds: z
      .string()
      .optional()
      .transform((s) => (s ? s.split(',').map((p) => p.trim()).filter(Boolean).slice(0, 100) : [])),
    channels: z
      .string()
      .optional()
      .transform((s) => (s ? s.split(',').map((p) => p.trim()).filter(Boolean).slice(0, 20) : [])),
    origins: csv(TRANSACTION_ORIGINS),
    minPaise: intParam.optional(),
    maxPaise: intParam.optional(),
    q: z.string().max(100).optional(),
    sort: z.enum(['newest', 'oldest', 'highest', 'lowest']).default('newest'),
    limit: z
      .string()
      .regex(/^\d+$/)
      .transform(Number)
      .pipe(z.number().int().min(1).max(200))
      .default(50),
    cursor: z.string().max(500).optional(),
  })
  .refine((v) => !v.from || !v.to || v.from <= v.to, { message: '"from" must not be after "to"', path: ['from'] })
  .refine((v) => v.minPaise === undefined || v.maxPaise === undefined || v.minPaise <= v.maxPaise, {
    message: 'minPaise must not exceed maxPaise',
    path: ['minPaise'],
  });

export type ListQuery = z.output<typeof listQuerySchema>;

interface CursorKey {
  d: string; // date
  a: number; // amount
  c: string; // created_at ISO
  i: string; // id
}

function encodeCursor(t: Transaction): string {
  const key: CursorKey = { d: t.date, a: t.amountPaise, c: t.createdAt, i: t.id };
  return Buffer.from(JSON.stringify(key)).toString('base64url');
}

function decodeCursor(s: string): CursorKey {
  try {
    const k = JSON.parse(Buffer.from(s, 'base64url').toString('utf8')) as CursorKey;
    if (typeof k.d !== 'string' || typeof k.a !== 'number' || typeof k.c !== 'string' || typeof k.i !== 'string') throw new Error();
    return k;
  } catch {
    throw AppFailure.validation('The page cursor is invalid. Start again from the first page.', { cursor: 'Invalid' });
  }
}

export interface TransactionPage {
  items: Transaction[];
  nextCursor: string | null;
}

export async function listTransactions(tx: Tx, userId: string, query: ListQuery): Promise<TransactionPage> {
  let q = tx.selectFrom('transactions as t').selectAll('t').where('t.user_id', '=', userId);
  if (query.from) q = q.where('t.date', '>=', query.from);
  if (query.to) q = q.where('t.date', '<=', query.to);
  if (query.type) q = q.where('t.type', '=', query.type);
  if (query.categoryIds.length > 0) q = q.where('t.category_id', 'in', query.categoryIds);
  if (query.accountIds.length > 0) q = q.where('t.account_id', 'in', query.accountIds);
  if (query.channels.length > 0) q = q.where('t.channel', 'in', query.channels);
  if (query.origins.length > 0) q = q.where('t.origin', 'in', query.origins);
  if (query.minPaise !== undefined) q = q.where('t.amount_paise', '>=', query.minPaise);
  if (query.maxPaise !== undefined) q = q.where('t.amount_paise', '<=', query.maxPaise);

  const text = query.q?.trim().toLowerCase() ?? '';
  if (text) {
    const like = `%${text.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
    const digits = text.replace(/[₹,\s]/g, '');
    const amountDigits = /^\d+(\.\d{0,2})?$/.test(digits) ? digits : null;
    q = q.where((eb) => {
      const ors: Expression<SqlBool>[] = [
        sql<SqlBool>`lower(coalesce(t.counterparty, '')) like ${like}`,
        sql<SqlBool>`lower(coalesce(t.note, '')) like ${like}`,
        sql<SqlBool>`exists (select 1 from public.categories c where c.user_id = t.user_id and c.id = t.category_id and lower(c.name) like ${like})`,
      ];
      if (amountDigits) {
        ors.push(
          amountDigits.includes('.')
            ? sql<SqlBool>`(trunc(t.amount_paise / 100)::text || '.' || lpad((t.amount_paise % 100)::text, 2, '0')) like ${`${amountDigits}%`}`
            : sql<SqlBool>`trunc(t.amount_paise / 100)::text like ${`%${amountDigits}%`}`,
        );
      }
      return eb.or(ors);
    });
  }

  const after = query.cursor ? decodeCursor(query.cursor) : null;
  switch (query.sort) {
    case 'newest':
      if (after) q = q.where(sql<SqlBool>`(t.date, t.created_at, t.id) < (${after.d}::date, ${after.c}::timestamptz, ${after.i})`);
      q = q.orderBy('t.date', 'desc').orderBy('t.created_at', 'desc').orderBy('t.id', 'desc');
      break;
    case 'oldest':
      if (after) q = q.where(sql<SqlBool>`(t.date, t.created_at, t.id) > (${after.d}::date, ${after.c}::timestamptz, ${after.i})`);
      q = q.orderBy('t.date', 'asc').orderBy('t.created_at', 'asc').orderBy('t.id', 'asc');
      break;
    case 'highest':
      if (after) q = q.where(sql<SqlBool>`(t.amount_paise, t.date, t.id) < (${after.a}::bigint, ${after.d}::date, ${after.i})`);
      q = q.orderBy('t.amount_paise', 'desc').orderBy('t.date', 'desc').orderBy('t.id', 'desc');
      break;
    case 'lowest':
      if (after) q = q.where(sql<SqlBool>`(t.amount_paise, t.date, t.id) > (${after.a}::bigint, ${after.d}::date, ${after.i})`);
      q = q.orderBy('t.amount_paise', 'asc').orderBy('t.date', 'asc').orderBy('t.id', 'asc');
      break;
  }

  const rows = await q.limit(query.limit + 1).execute();
  const items = rows.slice(0, query.limit).map(transactionFromRow);
  const nextCursor = rows.length > query.limit ? encodeCursor(items[items.length - 1]!) : null;
  return { items, nextCursor };
}

export async function getTransaction(tx: Tx, userId: string, id: string): Promise<Transaction> {
  const row = await tx.selectFrom('transactions').selectAll().where('user_id', '=', userId).where('id', '=', id).executeTakeFirst();
  if (!row) throw AppFailure.notFound('This transaction no longer exists.');
  return transactionFromRow(row);
}
