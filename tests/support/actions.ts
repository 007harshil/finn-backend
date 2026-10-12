// Runs actions through the real dispatcher (same path as the HTTP API).

import { dispatch, dispatcherEnv, type DispatchOutcome } from '@/server/actions/dispatcher';
import type { Channel } from '@/server/actions/types';
import type { AuthUser } from '@/server/auth/verify';
import { withUserTx } from '@/server/db/tx';
import { createContext } from '@/server/actions/dispatcher';
import type { FinanceSnapshot } from '@/server/finance/snapshot';
import { newKey } from './http';

/** Today = 10 Oct 2026 09:00 IST, like the Flutter test harness. */
export const TODAY = '2026-10-10';
export function fixClock(iso = '2026-10-10T03:30:00.000Z'): void {
  dispatcherEnv.now = () => new Date(iso);
}

/**
 * Dispatches [actionId]; when confirmation is needed and [confirm] is true,
 * approves the returned preview and dispatches again with the same key.
 */
export async function act<T = any>(
  user: AuthUser,
  actionId: string,
  input: Record<string, unknown>,
  opts: { confirm?: boolean; key?: string; channel?: Channel } = {},
): Promise<T> {
  const key = opts.key ?? newKey();
  let outcome: DispatchOutcome = await dispatch(user, actionId, input, { idempotencyKey: key, channel: opts.channel });
  if (outcome.status === 'needsConfirmation') {
    if (opts.confirm === false) throw new Error(`needsConfirmation: ${outcome.preview.summary}`);
    outcome = await dispatch(user, actionId, input, {
      idempotencyKey: key,
      channel: opts.channel,
      confirmation: { fingerprint: outcome.preview.fingerprint },
    });
  }
  if (outcome.status !== 'completed') throw new Error('Action did not complete');
  return outcome.result as T;
}

/** Reads through a fresh snapshot. */
export async function read<T>(user: AuthUser, fn: (s: FinanceSnapshot) => Promise<T>): Promise<T> {
  return withUserTx(user, async (tx) => fn((await createContext(tx, user, 'ui')).snapshot));
}
