// Single entry point for every financial operation, whichever channel
// initiates it (lib/actions/dispatcher.dart, made durable):
// * Validation on fresh data inside the same database transaction as the writes.
// * Confirmation: consequential actions (and every agent/voice action) run only
//   with a confirmation whose fingerprint equals the current preview's, so an
//   approval cannot be replayed after the input or the record changed.
// * Idempotency: keys are persisted per user in the same transaction as the
//   operation. A repeated key replays the stored result; a key reused for a
//   different request is a conflict; a failed attempt leaves no key.
//   Concurrent duplicates are serialised by the per-user write lock.
// * Policy per channel, and an audit entry for every executed attempt.

import { sql } from 'kysely';
import type { AuthUser } from '../auth/verify';
import { AppFailure } from '../core/failure';
import { previewFingerprint, requestFingerprint } from '../core/fingerprint';
import { randomIds, type IdGenerator } from '../core/ids';
import { lockUsers, withUserTx, type Tx } from '../db/tx';
import { fromZod, toFailure } from '../core/errors';
import { logger } from '../http/logger';
import { FinanceSnapshot } from '../finance/snapshot';
import { loadPreferences } from '../modules/account/preferences';
import { changesSince, type SyncChanges } from '../modules/sync/service';
import { channelRequiresConfirmation, checkPolicy } from './policy';
import { getAction } from './registry';
import type { ActionContext, ActionPreview, AnyAction, Channel, PreviewSpec } from './types';
import { todayIn } from '../core/dates';

export interface DispatchOptions {
  idempotencyKey: string;
  confirmation?: { fingerprint: string; confirmedBy?: string } | null;
  channel?: Channel;
  /** Include the records this operation changed (for client caches). Default true. */
  includeChanges?: boolean;
}

export type DispatchOutcome =
  | { status: 'completed'; actionId: string; result: unknown; preview: ActionPreview; replayed: boolean; changes?: SyncChanges }
  | { status: 'needsConfirmation'; actionId: string; preview: ActionPreview };

/** Test hooks for deterministic ids and clocks. */
export const dispatcherEnv: { ids: IdGenerator; now: () => Date } = {
  ids: randomIds,
  now: () => new Date(),
};

function decode(action: AnyAction, raw: unknown): unknown {
  const parsed = action.input.safeParse(raw ?? {});
  if (!parsed.success) throw fromZod(parsed.error);
  return parsed.data;
}

export function buildPreview(action: AnyAction, input: unknown, spec: PreviewSpec): ActionPreview {
  return {
    actionId: action.descriptor.id,
    title: spec.title,
    summary: spec.summary,
    lines: spec.lines ?? [],
    warnings: spec.warnings ?? [],
    fingerprint: previewFingerprint(action.descriptor.id, input, spec.basis),
    requiresConfirmation: spec.requiresConfirmation ?? action.descriptor.risk === 'consequential',
  };
}

export async function createContext(tx: Tx, user: AuthUser, channel: Channel): Promise<ActionContext> {
  const prefs = await loadPreferences(tx, user.userId);
  const now = dispatcherEnv.now();
  const today = todayIn(prefs.timeZone, now);
  return {
    tx,
    user,
    userId: user.userId,
    channel,
    today,
    now,
    ids: dispatcherEnv.ids,
    snapshot: new FinanceSnapshot(tx, user.userId, today, prefs),
    touched: [],
    lockUsers: (ids) => lockUsers(tx, ids),
  };
}

/** Validates and previews without executing. */
export async function previewAction(user: AuthUser, actionId: string, rawInput: unknown, channel: Channel = 'ui'): Promise<ActionPreview> {
  const action = getAction(actionId);
  checkPolicy(action.descriptor, channel);
  const input = decode(action, rawInput);
  return withUserTx(user, async (tx) => {
    const ctx = await createContext(tx, user, channel);
    const spec = await action.prepare(input, ctx);
    const preview = buildPreview(action, input, spec);
    if (channelRequiresConfirmation(channel)) preview.requiresConfirmation = true;
    return preview;
  });
}

const KEY_RE = /^[A-Za-z0-9._:\-]{8,128}$/;

export async function dispatch(user: AuthUser, actionId: string, rawInput: unknown, opts: DispatchOptions): Promise<DispatchOutcome> {
  const action = getAction(actionId);
  const channel = opts.channel ?? 'ui';
  checkPolicy(action.descriptor, channel);
  if (!KEY_RE.test(opts.idempotencyKey)) {
    throw AppFailure.validation('A valid Idempotency-Key (8-128 characters) is required.', { idempotencyKey: 'Required' });
  }
  const input = decode(action, rawInput);
  const fingerprint = requestFingerprint(action.descriptor.id, input);

  let executing: { preview: ActionPreview } | null = null;
  try {
    return await withUserTx(
      user,
      async (tx) => {
        const extra = action.extraLocks ? await action.extraLocks(input, { tx, userId: user.userId }) : [];
        await lockUsers(tx, [user.userId, ...extra]);
        const existing = await tx
          .selectFrom('idempotency_keys')
          .select(['action_id', 'request_fingerprint', 'response'])
          .where('user_id', '=', user.userId)
          .where('key', '=', opts.idempotencyKey)
          .executeTakeFirst();
        if (existing) {
          if (existing.action_id !== action.descriptor.id || existing.request_fingerprint !== fingerprint) {
            throw AppFailure.conflict('This request id was already used for a different operation.');
          }
          const stored = existing.response as { result: unknown; preview: ActionPreview };
          return { status: 'completed', actionId, result: stored.result, preview: stored.preview, replayed: true } as const;
        }

        const ctx = await createContext(tx, user, channel);
        const spec = await action.prepare(input, ctx);
        const preview = buildPreview(action, input, spec);
        const needsApproval = preview.requiresConfirmation || channelRequiresConfirmation(channel);
        if (needsApproval && opts.confirmation?.fingerprint !== preview.fingerprint) {
          return { status: 'needsConfirmation', actionId, preview: { ...preview, requiresConfirmation: true } } as const;
        }

        const baseline = await sql<{ seq: string | number }>`select nextval('public.finn_sync_seq') as seq`.execute(tx);
        executing = { preview };
        const result = await action.execute(input, ctx);

        await tx
          .insertInto('idempotency_keys')
          .values({
            user_id: user.userId,
            key: opts.idempotencyKey,
            action_id: action.descriptor.id,
            request_fingerprint: fingerprint,
            response: JSON.stringify({ result, preview }),
          })
          .execute();
        // Occasional housekeeping, inside the user's own transaction.
        if (Math.random() < 0.02) await pruneIdempotencyKeys(tx, user.userId);
        await tx
          .insertInto('audit_log')
          .values({
            user_id: user.userId,
            action_id: action.descriptor.id,
            summary: preview.summary,
            channel,
            confirmed_by: needsApproval ? (opts.confirmation?.confirmedBy ?? 'user') : null,
            succeeded: true,
            record_ids: [...new Set(ctx.touched)],
          })
          .execute();

        const changes =
          opts.includeChanges === false ? undefined : await changesSince(tx, user.userId, Number(baseline.rows[0]!.seq));
        return { status: 'completed', actionId, result, preview, replayed: false, changes } as const;
      },
      // Locks are taken inside (caller + extraLocks, sorted) before any read.
      { write: false },
    );
  } catch (err) {
    const failure = toFailure(err);
    const attempted = executing as { preview: ActionPreview } | null;
    if (attempted) {
      // The operation rolled back; record the failed attempt separately.
      await recordFailure(user, action.descriptor.id, attempted.preview.summary, channel, failure).catch((e) =>
        logger.error('audit.write_failed', { actionId, error: e instanceof Error ? e.message : String(e) }),
      );
    }
    throw failure === err ? err : failure;
  }
}

async function recordFailure(user: AuthUser, actionId: string, summary: string, channel: Channel, failure: AppFailure): Promise<void> {
  await withUserTx(user, (tx) =>
    tx
      .insertInto('audit_log')
      .values({
        user_id: user.userId,
        action_id: actionId,
        summary,
        channel,
        succeeded: false,
        failure_code: failure.code,
        failure_message: failure.message,
      })
      .execute(),
  );
}

/** Deletes a user's idempotency keys older than [days] (retries never span that long). */
export async function pruneIdempotencyKeys(tx: Tx, userId: string, days = 30): Promise<void> {
  await sql`delete from public.idempotency_keys
            where user_id = ${userId} and created_at < now() - make_interval(days => ${days})`.execute(tx);
}
