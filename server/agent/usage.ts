// Durable daily budgets for the operator-paid agent providers.
//
// The in-memory limiters (rate-limit.ts) are per server instance and only stop
// a runaway client loop. These counters live in the database, so every
// instance shares them:
// - each user has a daily request and request-byte budget per kind;
// - accounts younger than a few days share one daily pool, so throwaway
//   accounts can neither multiply spend nor use up anyone else's budget;
// - all users together have an overall ceiling, set well above normal use.

import { sql } from 'kysely';
import { AppFailure } from '../core/failure';
import { getDb } from '../db/client';
import type { AgentUsageKind } from '../db/types';

export interface UsageBudget {
  /** Requests per user per UTC day. */
  perUserRequests: number;
  /** Request body bytes per user per UTC day. */
  perUserBytes: number;
  /** Requests per UTC day shared by all accounts younger than [newAccountDays]. */
  newAccountRequests: number;
  /** Account age in days below which the new-account pool applies. */
  newAccountDays: number;
  /** Requests across all users per UTC day. */
  globalRequests: number;
}

export type UsageScope = 'user' | 'newAccounts' | 'global';

export type UsageDecision = { allowed: true } | { allowed: false; scope: UsageScope; retryAfterSeconds: number };

function utcDay(now: Date): string {
  return now.toISOString().slice(0, 10);
}

function secondsToNextUtcDay(now: Date): number {
  const next = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1);
  return Math.max(1, Math.ceil((next - now.getTime()) / 1000));
}

class OverBudget extends Error {
  constructor(readonly scope: UsageScope) {
    super(scope);
  }
}

/**
 * Records one [kind] request of [bytes] for [userId] if the user's, the
 * new-account and the overall daily budgets allow it. A refused request is
 * not counted.
 */
export async function takeDailyUsage(
  userId: string,
  kind: AgentUsageKind,
  bytes: number,
  budget: UsageBudget,
  now = new Date(),
): Promise<UsageDecision> {
  const day = utcDay(now);
  const newSince = new Date(now.getTime() - budget.newAccountDays * 86_400_000);
  try {
    await getDb()
      .transaction()
      .execute(async (tx) => {
        const row = await tx
          .insertInto('finn_auth.agent_usage')
          .values({ user_id: userId, day, kind, requests: 1, bytes })
          .onConflict((oc) =>
            oc.columns(['user_id', 'day', 'kind']).doUpdateSet({
              requests: sql<number>`finn_auth.agent_usage.requests + 1`,
              bytes: sql<number>`finn_auth.agent_usage.bytes + ${bytes}`,
            }),
          )
          .returning(['requests', 'bytes'])
          .executeTakeFirstOrThrow();
        if (row.requests > budget.perUserRequests || row.bytes > budget.perUserBytes) throw new OverBudget('user');

        const account = await tx.selectFrom('finn_auth.users').select('created_at').where('id', '=', userId).executeTakeFirst();
        const isNew = !account || new Date(account.created_at).getTime() > newSince.getTime();
        const totals = await tx
          .selectFrom('finn_auth.agent_usage as a')
          .innerJoin('finn_auth.users as u', 'u.id', 'a.user_id')
          .select([
            sql<number>`coalesce(sum(a.requests), 0)::int`.as('all'),
            sql<number>`coalesce(sum(a.requests) filter (where u.created_at > ${newSince}), 0)::int`.as('fresh'),
          ])
          .where('a.day', '=', day)
          .where('a.kind', '=', kind)
          .executeTakeFirstOrThrow();
        if (isNew && totals.fresh > budget.newAccountRequests) throw new OverBudget('newAccounts');
        if (totals.all > budget.globalRequests) throw new OverBudget('global');
      });
  } catch (err) {
    // Rolled back: the refused request is not counted.
    if (err instanceof OverBudget) return { allowed: false, scope: err.scope, retryAfterSeconds: secondsToNextUtcDay(now) };
    throw err;
  }
  return { allowed: true };
}

/** [takeDailyUsage], throwing the relay's rate-limit failure when a budget is spent. */
export async function enforceDailyUsage(userId: string, kind: AgentUsageKind, bytes: number, budget: UsageBudget): Promise<void> {
  const decision = await takeDailyUsage(userId, kind, bytes, budget);
  if (decision.allowed) return;
  const message =
    decision.scope === 'user'
      ? "You've reached today's assistant limit. Please try again tomorrow."
      : 'The assistant is at capacity today. Please try again later.';
  throw new AppFailure('unavailable', message, {
    retryable: true,
    details: { reason: 'rateLimited', scope: decision.scope, retryAfterSeconds: decision.retryAfterSeconds },
  });
}
