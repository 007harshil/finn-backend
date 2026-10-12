// zod building blocks for action input, matching the Flutter `In` helpers:
// money as rupees (number `1250.5` or string `"1,250.50"`, max 2 decimals,
// never negative) decoded to integer paise; dates as `yyyy-MM-dd`; trimmed
// strings where blank means absent.

import { z } from 'zod';
import { isIsoDate } from '../core/dates';
import { parseRupees } from '../core/money';

const rupees = z.union([z.number(), z.string()]);

/** Rupee amount decoded to paise (>= 0). Use .refine for > 0. */
export const zMoney = rupees.transform((v, ctx) => {
  const parsed = typeof v === 'number' ? (Number.isFinite(v) && v >= 0 ? parseRupees(String(v)) : null) : parseRupees(v);
  if (parsed === null) {
    ctx.addIssue({ code: 'custom', message: 'Expected an amount in rupees with at most 2 decimals' });
    return z.NEVER;
  }
  return parsed;
});

/** Strictly positive rupee amount in paise. */
export const zPositiveMoney = zMoney.refine((p) => p > 0, { message: 'Enter an amount greater than zero' });

export const zMoneyOpt = zMoney.nullish().transform((v) => v ?? null);

export const zDate = z.string().refine(isIsoDate, { message: 'Expected a date formatted yyyy-MM-dd' });
export const zDateOpt = zDate.nullish().transform((v) => v ?? null);

/** Non-empty trimmed string. */
export const zText = z
  .string()
  .transform((s) => s.trim())
  .refine((s) => s.length > 0, { message: 'Expected a non-empty string' });

/** Optional trimmed string; blank becomes null. */
export const zTextOpt = z
  .string()
  .nullish()
  .transform((s) => (s == null || s.trim() === '' ? null : s.trim()));

export const zId = z.string().trim().min(1, 'Expected a record id').max(64);

export const zInt = z.number().int();
export const zIntOpt = zInt.nullish().transform((v) => v ?? null);

export const zBool = (fallback?: boolean) =>
  fallback === undefined ? z.boolean() : z.boolean().nullish().transform((v) => v ?? fallback);

export function zEnum<const T extends readonly [string, ...string[]]>(values: T) {
  return z.enum(values);
}

export function zEnumOpt<const T extends readonly [string, ...string[]]>(values: T) {
  return z.enum(values).nullish().transform((v) => v ?? null);
}

/** Expected record version for optimistic concurrency. */
export const zVersion = z.number().int().min(1);

export const PAYMENT_METHODS = ['upi', 'card', 'cash', 'bankTransfer', 'wallet', 'other'] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];
