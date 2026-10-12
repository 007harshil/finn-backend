// Account reads/writes behind GET /me, PATCH /me/handle and /preferences.

import { z } from 'zod';
import type { AuthUser } from '../../auth/verify';
import { AppFailure } from '../../core/failure';
import type { Tx } from '../../db/tx';
import { financialProfileFromRow, profileDto, type Preferences } from '../../finance/models';
import { loadPreferences } from './preferences';
import { updateHandle, updatePreferences } from './repo';

/** AlertType names in lib/features/alerts/domain/alert.dart. */
export const ALERT_TYPES = [
  'emiDue',
  'emiOverdue',
  'pendingOwed',
  'collectOwed',
  'subscriptionRenewal',
  'subscriptionOverdue',
  'budgetNearLimit',
  'budgetBreached',
  'emergencyFundLow',
  'emergencyFundNotSet',
  'goalMilestone',
  'goalAtRisk',
  'monthlyDeficit',
] as const;

export function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

const int = (min: number, max: number, msg: string) => z.number({ error: msg }).int(msg).min(min, msg).max(max, msg);

export const preferencesPatchSchema = z
  .object({
    monthStartDay: int(1, 28, 'Choose a day between 1 and 28.'),
    emiReminderDays: int(0, 30, 'Choose between 0 and 30 days.'),
    subscriptionReminderDays: int(0, 30, 'Choose between 0 and 30 days.'),
    lowEmergencyCoverageMonths: int(1, 24, 'Choose between 1 and 24 months.'),
    defaultBudgetWarningBps: int(5000, 9500, 'Choose between 50% and 95%.'),
    disabledAlertTypes: z.array(z.enum(ALERT_TYPES, { error: 'Unknown alert type.' })).max(ALERT_TYPES.length),
    timeZone: z
      .string()
      .max(64)
      .refine(isValidTimeZone, { message: 'Unknown time zone. Use an IANA name like Asia/Kolkata.' }),
  })
  .partial()
  .strict();

export const handleSchema = z.object({
  handle: z
    .string()
    .transform((s) => s.trim().toLowerCase())
    .refine((s) => /^@[a-z0-9._]{3,30}$/.test(s), { message: 'Use @ followed by 3–30 letters, digits, dots or underscores.' }),
});

export async function patchPreferences(tx: Tx, userId: string, patch: z.output<typeof preferencesPatchSchema>, now: Date): Promise<Preferences> {
  const current = await loadPreferences(tx, userId);
  const next: Preferences = {
    ...current,
    ...Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)),
  } as Preferences;
  if (patch.disabledAlertTypes) next.disabledAlertTypes = [...new Set(patch.disabledAlertTypes)];
  await updatePreferences(tx, userId, next, now);
  return next;
}

export async function loadMe(tx: Tx, user: AuthUser) {
  const row = await tx.selectFrom('profiles').selectAll().where('user_id', '=', user.userId).executeTakeFirst();
  if (!row) throw AppFailure.notFound('Profile not found.');
  return {
    user: { id: row.user_id, name: row.display_name, handle: row.handle, phoneHint: row.phone_hint, email: user.email },
    profile: profileDto(financialProfileFromRow(row)),
    preferences: await loadPreferences(tx, user.userId),
  };
}

export async function changeHandle(tx: Tx, userId: string, handle: string, now: Date): Promise<string> {
  await updateHandle(tx, userId, handle, now);
  return handle;
}
