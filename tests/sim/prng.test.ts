import { describe, expect, test } from "vitest";
import { XoshiroPRNG, seedFrom, stepU32 } from "../../src/sim/prng";

describe("xoshiro128** PRNG (§5A)", () => {
  test("same seed → identical sequence", () => {
    const a = new XoshiroPRNG(0xc0ffee);
    const b = new XoshiroPRNG(0xc0ffee);
    for (let i = 0; i < 1000; i++) expect(a.nextU32()).toBe(b.nextU32());
  });

  test("different seeds diverge", () => {
    const a = new XoshiroPRNG(1);
    const b = new XoshiroPRNG(2);
    let same = 0;
    for (let i = 0; i < 100; i++) if (a.nextU32() === b.nextU32()) same++;
    expect(same).toBeLessThan(5);
  });

  test("nextFloat ∈ [0,1) and roughly uniform", () => {
    const rng = new XoshiroPRNG(42);
    let sum = 0;
    const n = 20_000;
    for (let i = 0; i < n; i++) {
      const f = rng.nextFloat();
      expect(f).toBeGreaterThanOrEqual(0);
      expect(f).toBeLessThan(1);
      sum += f;
    }
    expect(sum / n).toBeGreaterThan(0.48);
    expect(sum / n).toBeLessThan(0.52);
  });

  test("seedFrom never yields the all-zero fixed point", () => {
    for (const seed of [0, 1, 0xffffffff, 0xdeadbeef]) {
      const st = seedFrom(seed);
      expect(st.s0 | st.s1 | st.s2 | st.s3).not.toBe(0);
      expect(() => stepU32({ ...st })).not.toThrow();
    }
  });

  test("fork(substream) is deterministic and order-independent (§5A)", () => {
    const turn = new XoshiroPRNG(777);
    // same sub-stream id drawn before/after consuming parent state must differ
    // only via parent state; but re-forking the SAME state is reproducible:
    const st = { ...turn.state };
    const f1 = new XoshiroPRNG(st).fork(3);
    const f2 = new XoshiroPRNG(st).fork(3);
    for (let i = 0; i < 100; i++) expect(f1.nextU32()).toBe(f2.nextU32());

    // unit sub-streams are independent of one another
    const fA = new XoshiroPRNG(st).fork(1);
    const fB = new XoshiroPRNG(st).fork(2);
    let same = 0;
    for (let i = 0; i < 100; i++) if (fA.nextU32() === fB.nextU32()) same++;
    expect(same).toBeLessThan(5);
  });

  test("forked outcomes do not depend on processing order (the §5A guarantee)", () => {
    // Two units resolve with their own sub-streams; simulating them in
    // opposite orders must give each unit the same dice.
    const base = new XoshiroPRNG(2024);
    const unitIds = [10, 20, 30];
    const draw = (order: number[]): Map<number, number[]> => {
      const out = new Map<number, number[]>();
      for (const id of order) out.set(id, []);
      for (const id of order) {
        const sub = new XoshiroPRNG({ ...base.state }).fork(id);
        out.get(id)?.push(sub.nextU32(), sub.nextFloat());
      }
      return out;
    };
    const forward = draw(unitIds);
    const backward = draw([...unitIds].reverse());
    for (const id of unitIds) expect(forward.get(id)).toEqual(backward.get(id));
  });
});
