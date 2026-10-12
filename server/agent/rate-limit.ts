// Per-user sliding-window limiter for the agent relay.
//
// In-memory and PER SERVER INSTANCE: serverless instances (and multiple
// processes) do not share it, so the effective limit across a deployment is
// up to N x the configured value. It protects the provider bill from a single
// runaway client loop; it is not a billing-grade quota.

const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;
const MAX_TRACKED_USERS = 50_000;

/** Request timestamps (ms, ascending) per user within the last 24 hours. */
const hits = new Map<string, number[]>();

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

function sweep(now: number): void {
  for (const [user, list] of hits) {
    if (list.length === 0 || list[list.length - 1] <= now - DAY_MS) hits.delete(user);
  }
  // Still too many active users: drop everything rather than grow unbounded.
  if (hits.size > MAX_TRACKED_USERS) hits.clear();
}

/** Records one request for [userId] if both windows allow it. */
export function takeAgentRequest(userId: string, limits: RateLimits, now = Date.now()): RateDecision {
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
}

/** Test-only: forget every recorded request. */
export function resetAgentRateLimits(): void {
  hits.clear();
}
