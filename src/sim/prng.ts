/**
 * §5A PRNG: xoshiro128** with deterministic per-unit sub-streams.
 * Seeded per turn from Turn.seed; fork(substream) derives an independent
 * stream per unit id so processing order cannot alter individual unit
 * outcomes (§5A Determinism).
 */
import type { PRNG } from "../core/sim";

/** xoshiro128** mutable state (four 32-bit lanes). */
export interface XoshiroState {
  s0: number;
  s1: number;
  s2: number;
  s3: number;
}

/** Force into unsigned 32-bit. */
const u32 = (n: number): number => n >>> 0;

const rotl = (x: number, k: number): number => u32((x << k) | (x >>> (32 - k)));

/** splitmix32 — quality seeder; also derives fork sub-streams. */
function splitmix32(seed: number): () => number {
  let a = u32(seed);
  return () => {
    a = u32(a + 0x9e3779b9);
    let z = a;
    z = u32(Math.imul(z ^ (z >>> 16), 0x21f0aaad));
    z = u32(Math.imul(z ^ (z >>> 15), 0x735a2d97));
    return u32(z ^ (z >>> 15));
  };
}

/** Seed four lanes from any 32-bit value; never the all-zero fixed point. */
export function seedFrom(seed: number): XoshiroState {
  const mix = splitmix32(seed);
  const st = { s0: mix(), s1: mix(), s2: mix(), s3: mix() };
  if (st.s0 === 0 && st.s1 === 0 && st.s2 === 0 && st.s3 === 0) st.s0 = 0x9e3779b9;
  return st;
}

/** xoshiro128** step (Blackman & Vigna), mutating `state`. */
export function stepU32(state: XoshiroState): number {
  const result = u32(Math.imul(rotl(u32(Math.imul(state.s1, 5)), 7), 9));
  const t = u32(state.s1 << 9);
  state.s2 = u32(state.s2 ^ state.s0);
  state.s3 = u32(state.s3 ^ state.s1);
  state.s1 = u32(state.s1 ^ state.s2);
  state.s0 = u32(state.s0 ^ state.s3);
  state.s2 = u32(state.s2 ^ t);
  state.s3 = rotl(state.s3, 11);
  return result;
}

/** A forkable xoshiro128** generator implementing §5A PRNG. */
export class XoshiroPRNG implements PRNG {
  readonly state: XoshiroState;

  constructor(seed: number | XoshiroState) {
    this.state = typeof seed === "number" ? seedFrom(seed) : { ...seed };
  }

  nextU32(): number {
    return stepU32(this.state);
  }

  nextFloat(): number {
    // 24-bit mantissa → [0, 1) with uniform spacing.
    return (this.nextU32() >>> 8) * (1 / 0x1000000);
  }

  fork(substream: number): PRNG {
    // Mix the parent state with the sub-stream id so forks of equal ids under
    // different turn seeds differ, and sibling ids are independent.
    const mix = splitmix32(
      u32(this.state.s0 ^ Math.imul(u32(substream) + 1, 0x9e3779b9) ^ this.state.s3),
    );
    return new XoshiroPRNG({ s0: mix(), s1: mix(), s2: mix(), s3: mix() });
  }
}
