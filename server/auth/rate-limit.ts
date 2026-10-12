// Per-key sliding-window limiter for the public sign-in endpoints (keyed by
// client IP). In-memory and PER SERVER INSTANCE, like the agent limiter: it
// blunts floods from one client. The durable per-email limits live in the
// database (see service.ts).

const MAX_TRACKED_KEYS = 50_000;

export type LimitDecision = { allowed: true } | { allowed: false; retryAfterSeconds: number };

export class WindowLimiter {
  private readonly hits = new Map<string, number[]>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
  ) {}

  /** Records one hit for [key] if the window allows it. */
  take(key: string, now = Date.now()): LimitDecision {
    const cutoff = now - this.windowMs;
    const list = (this.hits.get(key) ?? []).filter((t) => t > cutoff);
    if (list.length >= this.limit) {
      this.hits.set(key, list);
      return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil((list[0] + this.windowMs - now) / 1000)) };
    }
    list.push(now);
    this.hits.set(key, list);
    if (this.hits.size > MAX_TRACKED_KEYS) this.sweep(now);
    return { allowed: true };
  }

  reset(): void {
    this.hits.clear();
  }

  private sweep(now: number): void {
    for (const [key, list] of this.hits) {
      if (list.length === 0 || list[list.length - 1] <= now - this.windowMs) this.hits.delete(key);
    }
    if (this.hits.size > MAX_TRACKED_KEYS) this.hits.clear();
  }
}
