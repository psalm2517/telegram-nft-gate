/**
 * Fixed-window rate limiter backed by KV.
 *
 * KV is eventually consistent, so this is a best-effort throttle for abuse
 * control rather than a hard quota. Correctness of the verification flow never
 * depends on it: replay protection lives in D1's single-use nonce.
 */
export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  resetAt: number;
}

export class RateLimiter {
  constructor(private readonly kv: KVNamespace) {}

  async check(
    key: string,
    limit: number,
    windowSeconds: number,
    now: number = Date.now(),
  ): Promise<RateLimitResult> {
    const windowStart = Math.floor(now / 1000 / windowSeconds) * windowSeconds;
    const bucketKey = `rl:${key}:${windowStart}`;
    const resetAt = (windowStart + windowSeconds) * 1000;

    const current = Number((await this.kv.get(bucketKey)) ?? '0');
    if (current >= limit) return { allowed: false, remaining: 0, resetAt };

    const next = current + 1;
    // TTL is bumped a little past the window so the key self-cleans.
    await this.kv.put(bucketKey, String(next), { expirationTtl: Math.max(60, windowSeconds + 60) });
    return { allowed: true, remaining: Math.max(0, limit - next), resetAt };
  }
}
