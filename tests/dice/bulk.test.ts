import { describe, expect, test } from "vitest";
import { BulkDice } from "../../src/dice/bulk";
import { compileFormula, evaluateFormula } from "../../src/dice/engine";

describe("engine data nodes (§11 @path at eval time)", () => {
  test("@paths resolve from rollData without string substitution", () => {
    const res = evaluateFormula("1d20 + @stats.attack", { stats: { attack: 5 } }, () => 0.49);
    expect(res.ok).toBe(true);
    // d20 with rng()=0.49 → floor(9.8)+1 = 10; +5 → 15
    if (res.ok) expect(res.value.total).toBe(15);
  });

  test("same seed + same data → identical totals; varying data reuses the parse", () => {
    const compiled = compileFormula("2d6 + @bonus");
    expect(compiled.ok).toBe(true);
    if (!compiled.ok) return;
    const seq = (): number => 0.25;
    const a = compiled.value.evaluate({ bonus: 1 }, seq);
    const b = compiled.value.evaluate({ bonus: 1 }, seq);
    expect(a).toEqual(b);
    const c = compiled.value.evaluate({ bonus: 9 }, seq);
    if (a.ok && c.ok) expect(c.value.total - a.value.total).toBe(8);
  });

  test("missing rollData / unknown paths error", () => {
    const res = evaluateFormula("1d20 + @bonus", undefined, () => 0.5);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain("@bonus");
    const bad = evaluateFormula("1 + @nope.deep", { nope: {} }, () => 0.5);
    expect(bad.ok).toBe(false);
  });

  test("compile-once: repeated evaluate calls never re-parse (observable via cache)", () => {
    const dice = new BulkDice(1234);
    for (let i = 0; i < 50; i++) void dice.roll("3d6 + @atk", { atk: i });
    expect(dice.parseCount).toBe(1);
    expect(dice.formulaCount).toBe(1);
    void dice.roll("1d20");
    expect(dice.parseCount).toBe(2);
    for (let i = 0; i < 50; i++) void dice.roll("1d20");
    expect(dice.parseCount).toBe(2); // cached
  });
});

describe("BulkDice (§11 bulk sim dice)", () => {
  test("implements the §5A PRNG contract (forkable, deterministic)", () => {
    const a = new BulkDice(4242);
    const b = new BulkDice(4242);
    const drawsA = Array.from({ length: 8 }, () => a.nextFloat());
    const drawsB = Array.from({ length: 8 }, () => b.nextFloat());
    expect(drawsA).toEqual(drawsB);
    const f1 = new BulkDice(99).fork(7).nextU32();
    const f2 = new BulkDice(99).fork(7).nextU32();
    expect(f1).toBe(f2);
    expect(new BulkDice(99).fork(8).nextU32()).not.toBe(f1);
  });

  test("rolls are seeded-deterministic and differ across seeds", () => {
    const roll = (seed: number): number => {
      const dice = new BulkDice(seed);
      const res = dice.roll("1d20 + 2");
      expect(res.ok).toBe(true);
      return res.ok ? res.value.total : -1;
    };
    expect(roll(7)).toBe(roll(7));
    const seen = new Set([roll(1), roll(2), roll(3), roll(4), roll(5)]);
    expect(seen.size).toBeGreaterThan(1);
  });

  test("formula draws advance the shared stream; forkDice shares the cache", () => {
    const dice = new BulkDice(5);
    void dice.roll("1d100");
    const after = dice.nextFloat();
    const fresh = new BulkDice(5);
    expect(fresh.nextFloat()).not.toBe(after); // roll consumed stream state

    const sub = dice.forkDice(3);
    void sub.roll("1d6");
    void sub.roll("1d6");
    void dice.roll("1d6");
    expect(sub.parseCount).toBe(dice.parseCount); // shared per-turn cache
    expect(sub.formulaCount).toBe(dice.formulaCount);
  });

  test("invalid formulas error without polluting the cache", () => {
    const dice = new BulkDice(1);
    const bad = dice.roll("1d20 + + ");
    expect(bad.ok).toBe(false);
    expect(dice.formulaCount).toBe(0);
  });
});
