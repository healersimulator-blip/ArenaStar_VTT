/**
 * §5/§16 rate limiting: per-peer token buckets. Ephemeral traffic is capped
 * at 20 Hz per peer (§5); intents and asset requests get per-peer limits
 * enforced by the host (§16). Buckets are injectable-clock for determinism.
 */
import { EPHEMERAL_MAX_HZ } from "./net";

export class TokenBucket {
  readonly capacity: number;
  readonly refillPerSecond: number;

  private tokens: number;
  private lastRefill: number;
  private readonly now: () => number;

  constructor(capacity: number, refillPerSecond: number, now: () => number = () => Date.now()) {
    if (capacity <= 0 || refillPerSecond <= 0) {
      throw new Error("TokenBucket: capacity and refillPerSecond must be > 0");
    }
    this.capacity = capacity;
    this.refillPerSecond = refillPerSecond;
    this.now = now;
    this.tokens = capacity;
    this.lastRefill = now();
  }

  /** Refill according to elapsed time, then try to remove `n` tokens. */
  tryRemove(n = 1): boolean {
    this.refill();
    if (this.tokens < n) return false;
    this.tokens -= n;
    return true;
  }

  /** Tokens available right now (after refill). */
  available(): number {
    this.refill();
    return this.tokens;
  }

  private refill(): void {
    const t = this.now();
    const elapsed = t - this.lastRefill;
    if (elapsed <= 0) return;
    this.tokens = Math.min(this.capacity, this.tokens + (elapsed / 1000) * this.refillPerSecond);
    this.lastRefill = t;
  }
}

/** §5: ephemeral channel, ≤ 20 Hz per peer with a small burst allowance (D-025). */
export function createEphemeralRateLimiter(now: () => number = () => Date.now()): TokenBucket {
  return new TokenBucket(4, EPHEMERAL_MAX_HZ, now);
}

/** §16: per-peer intent rate limit (D-025; wired into HostSync). */
export function createIntentRateLimiter(now: () => number = () => Date.now()): TokenBucket {
  return new TokenBucket(30, 30, now);
}

/** §16: per-peer asset request rate limit (D-025; wired into AssetTransfer). */
export function createAssetRateLimiter(now: () => number = () => Date.now()): TokenBucket {
  return new TokenBucket(20, 10, now);
}
