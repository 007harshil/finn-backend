import { sql } from 'kysely';
import { AppFailure } from '../../core/failure';
import type { Tx } from '../../db/tx';
import type { FinancialProfile, Preferences } from '../../finance/models';

/** Writes the FinancialProfile fields and display name of the caller's (always existing) profile row. */
export async function updateOwnProfile(tx: Tx, userId: string, p: FinancialProfile, now: Date): Promise<void> {
  await tx
    .updateTable('profiles')
    .set({
      display_name: p.displayName,
      opening_paise: p.openingPaise,
      opening_date: p.openingDate,
      monthly_income_estimate_paise: p.monthlyIncomeEstimatePaise,
      version: sql`version + 1`,
      updated_at: now,
    })
    .where('user_id', '=', userId)
    .execute();
}

/**
 * Moves the profile's tracking start back to [date] when a transaction is
 * recorded before it, so the entry counts towards cash (the ledger skips
 * anything dated before the opening date). The opening balance is kept.
 * No-op without a financial profile or when [date] is not earlier.
 */
export async function extendTrackingStart(tx: Tx, userId: string, date: string): Promise<void> {
  await tx
    .updateTable('profiles')
    .set({ opening_date: date, version: sql`version + 1`, updated_at: sql`now()` })
    .where('user_id', '=', userId)
    .where('opening_date', 'is not', null)
    .where('opening_date', '>', date)
    .execute();
}

export async function updateHandle(tx: Tx, userId: string, handle: string, now: Date): Promise<void> {
  try {
    await tx
      .updateTable('profiles')
      .set({ handle, version: sql`version + 1`, updated_at: now })
      .where('user_id', '=', userId)
      .execute();
  } catch (err) {
    if ((err as { code?: string } | null)?.code === '23505') throw AppFailure.conflict('That handle is already taken. Try another.');
    throw err;
  }
}

export async function updatePreferences(tx: Tx, userId: string, p: Preferences, now: Date): Promise<void> {
  await tx
    .updateTable('user_preferences')
    .set({
      month_start_day: p.monthStartDay,
      emi_reminder_days: p.emiReminderDays,
      subscription_reminder_days: p.subscriptionReminderDays,
      low_emergency_coverage_months: p.lowEmergencyCoverageMonths,
      default_budget_warning_bps: p.defaultBudgetWarningBps,
      disabled_alert_types: p.disabledAlertTypes,
      time_zone: p.timeZone,
      updated_at: now,
    })
    .where('user_id', '=', userId)
    .execute();
}
