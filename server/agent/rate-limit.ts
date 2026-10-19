// Per-user sliding-window limiter for the agent relay.
//
// In-memory and PER SERVER INSTANCE: serverless instances (and multiple
// processes) do not share it, so the effective limit across a deployment is
// up to N x the configured value. It protects the provider bill from a single
// runaway client loop; it is not a billing-grade quota. The durable daily
// budgets (per user and global) are in usage.ts.

const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;
const MAX_TRACKED_USERS = 50_000;

export interface RateLimits {
  perMinute: number;
  perDay: number;
}

export type RateDecision = { allowed: true } | { allowed: false; retryAfterSeconds: number };

function prune(list: number[], now: number): number[] {
  const cutoff = now - DAY_MS;
  let i = 0;
  while (i < list.length && list[i] <= cutoff) i++;
  return i === 0 ? list : list.slice(i);
}

export interface KeyedLimiter {
  /** Records one request for [userId] if both windows allow it. */
  take(userId: string, limits: RateLimits, now?: number): RateDecision;
  /** Test-only: forget every recorded request. */
  reset(): void;
}

const limiters = new Set<KeyedLimiter>();

/** An independent limiter with its own per-user request history. */
export function createLimiter(): KeyedLimiter {
  /** Request timestamps (ms, ascending) per user within the last 24 hours. */
  const hits = new Map<string, number[]>();

  function sweep(now: number): void {
    for (const [user, list] of hits) {
      if (list.length === 0 || list[list.length - 1] <= now - DAY_MS) hits.delete(user);
    }
    // Still too many active users: evict the longest-tracked ones (Map keeps
    // insertion order) rather than grow unbounded or reset everyone's window.
    for (const user of hits.keys()) {
      if (hits.size < MAX_TRACKED_USERS) break;
      hits.delete(user);
    }
  }

  const limiter: KeyedLimiter = {
    take(userId, limits, now = Date.now()) {
      const list = prune(hits.get(userId) ?? [], now);

      const minuteStart = now - MINUTE_MS;
      let firstInMinute = list.length;
      while (firstInMinute > 0 && list[firstInMinute - 1] > minuteStart) firstInMinute--;
      const inMinute = list.length - firstInMinute;

      let blockedUntil = 0;
      if (inMinute >= limits.perMinute) {
        // Oldest hit that must leave the window before another fits.
        blockedUntil = list[list.length - limits.perMinute] + MINUTE_MS;
      }
      if (list.length >= limits.perDay) {
        blockedUntil = Math.max(blockedUntil, list[list.length - limits.perDay] + DAY_MS);
      }
      if (blockedUntil > 0) {
        hits.set(userId, list);
        return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil((blockedUntil - now) / 1000)) };
      }

      list.push(now);
      if (!hits.has(userId) && hits.size >= MAX_TRACKED_USERS) sweep(now);
      hits.set(userId, list);
      return { allowed: true };
    },
    reset() {
      hits.clear();
    },
  };
  limiters.add(limiter);
  return limiter;
}

const completionsLimiter = createLimiter();

/** Records one completions request for [userId] if both windows allow it. */
export function takeAgentRequest(userId: string, limits: RateLimits, now = Date.now()): RateDecision {
  return completionsLimiter.take(userId, limits, now);
}


/**
 * When each upstream model may be called again after the provider rate limited
 * it (epoch ms). Per server instance, like the limiters above: it only saves a
 * call that would certainly fail; the provider stays the authority.
 */
const modelCooldowns = new Map<string, number>();

/** Records that the provider asked to wait [seconds] before using [model] again. */
export function noteModelRateLimited(model: string, seconds: number, now = Date.now()): void {
  modelCooldowns.set(model, now + seconds * 1000);
}

/** Whole seconds until [model] may be called again; 0 when it is available. */
export function modelCooldownSeconds(model: string, now = Date.now()): number {
  const until = modelCooldowns.get(model);
  if (until === undefined) return 0;
  if (until <= now) {
    modelCooldowns.delete(model);
    return 0;
  }
  return Math.ceil((until - now) / 1000);
}

/** Test-only: forget every recorded request, in every limiter, and every model cooldown. */
export function resetAgentRateLimits(): void {
  for (const l of limiters) l.reset();
  modelCooldowns.clear();
}
