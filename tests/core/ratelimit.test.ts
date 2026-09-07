import { describe, expect, test } from "vitest";
import { TokenBucket, createEphemeralRateLimiter } from "../../src/core/ratelimit";

function fakeClock(start = 0) {
  let now = start;
  return { now: () => now, advance: (ms: number) => (now += ms) };
}

describe("TokenBucket (§5/§16)", () => {
  test("allows sustained rate but blocks bursts beyond capacity", () => {
    const clock = fakeClock();
    const bucket = new TokenBucket(4, 20, clock.now);
    // capacity 4 instantly
    expect(bucket.tryRemove()).toBe(true);
    expect(bucket.tryRemove()).toBe(true);
    expect(bucket.tryRemove()).toBe(true);
    expect(bucket.tryRemove()).toBe(true);
    expect(bucket.tryRemove()).toBe(false); // burst exhausted
  });

  test("refills at the configured per-second rate", () => {
    const clock = fakeClock();
    const bucket = new TokenBucket(4, 20, clock.now);
    for (let i = 0; i < 4; i++) expect(bucket.tryRemove()).toBe(true);
    clock.advance(50); // 20/s → 1 token per 50 ms
    expect(bucket.tryRemove()).toBe(true); // exactly one refilled
    expect(bucket.tryRemove()).toBe(false);
    clock.advance(1000); // 20 tokens refilled, capped at capacity 4
    expect(bucket.available()).toBe(4);
  });

  test("sustained 20 Hz stream passes indefinitely (ephemeral limit, §5)", () => {
    const clock = fakeClock();
    const bucket = createEphemeralRateLimiter(clock.now);
    let allowed = 0;
    // 20 messages per second for 5 seconds
    for (let i = 0; i < 100; i++) {
      clock.advance(50);
      if (bucket.tryRemove()) allowed++;
    }
    expect(allowed).toBe(100); // the rate kept up with every 50 ms message
    // burst capacity is nearly refilled by steady pacing: 3 remain, then dry
    expect(bucket.tryRemove()).toBe(true);
    expect(bucket.tryRemove()).toBe(true);
    expect(bucket.tryRemove()).toBe(true);
    expect(bucket.tryRemove()).toBe(false);
  });

  test("never exceeds capacity even after long idle", () => {
    const clock = fakeClock();
    const bucket = new TokenBucket(2, 1000, clock.now);
    clock.advance(60_000);
    expect(bucket.available()).toBe(2);
  });

  test("invalid configuration is rejected", () => {
    expect(() => new TokenBucket(0, 10)).toThrow();
    expect(() => new TokenBucket(10, 0)).toThrow();
  });
});
