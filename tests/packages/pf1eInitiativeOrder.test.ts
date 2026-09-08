import { describe, expect, test } from "vitest";
import { resolveInitiativeOrder } from "../../src/packages/pf1e/initiativeOrder";
const entry = (id: string, total: number, modifier = 0) => ({ id, total, modifier });
const dice =
  (...values: number[]) =>
  () =>
    values.shift() ?? NaN;
/** @srd CRB p.178 Initiative (AoN Rules ID=95): totals, total modifiers, then roll tied combatants. */
describe("PF1e initiative tie order", () => {
  test("total modifier, not Dex alone, breaks equal results without another die", () => {
    const input = [
      entry("dex-high", 18, 4),
      entry("feat-and-effects", 18, 7),
      entry("higher-total", 19, -1),
    ];
    const before = structuredClone(input);
    let calls = 0;
    const result = resolveInitiativeOrder(input, () => {
      calls++;
      return 10;
    });
    expect(result.order).toEqual(["higher-total", "feat-and-effects", "dex-high"]);
    expect(calls).toBe(0);
    expect(input).toEqual(before);
  });
  test("equal modifiers roll off without changing initiative totals", () => {
    const input = [entry("a", 17, 7), entry("b", 17, 7)];
    const result = resolveInitiativeOrder(input, dice(3, 18));
    expect(result.order).toEqual(["b", "a"]);
    expect(result.tieRolls).toEqual({ a: [3], b: [18] });
    expect(input.map((x) => x.total)).toEqual([17, 17]);
  });
  test("rerolls only still-tied subgroups, retaining already-resolved relative positions", () => {
    const input = [entry("a", 10), entry("b", 10), entry("c", 10), entry("d", 5)];
    const result = resolveInitiativeOrder(input, dice(20, 4, 4, 2, 19));
    expect(result.error).toBeNull();
    expect(result.order).toEqual(["a", "c", "b", "d"]);
    expect(result.tieRolls).toEqual({ a: [20], b: [4, 2], c: [4, 19], d: [] });
  });
  test("independent groups and negative modifiers resolve deterministically", () => {
    const result = resolveInitiativeOrder(
      [entry("a", -1, -2), entry("b", -1, -2), entry("c", -2, 0), entry("d", -2, 0)],
      dice(2, 3, 4, 1),
    );
    expect(result.order).toEqual(["b", "a", "c", "d"]);
    expect(resolveInitiativeOrder([], dice()).order).toEqual([]);
  });
  test("invalid data/dice fail without a partial order", () => {
    expect(resolveInitiativeOrder([entry("a", 1), entry("a", 2)], dice()).error).toBeTruthy();
    expect(resolveInitiativeOrder([entry("a", NaN)], dice()).error).toBeTruthy();
    for (const value of [0, 21, 2.5, NaN]) {
      const result = resolveInitiativeOrder([entry("a", 1), entry("b", 1)], dice(value));
      expect(result.error).toBeTruthy();
      expect(result.order).toEqual([]);
      expect(result.tieRolls).toEqual({});
    }
  });
  test("pathological repeated ties are bounded, not silently settled by insertion order", () => {
    let calls = 0;
    const result = resolveInitiativeOrder([entry("a", 1), entry("b", 1)], () => {
      calls++;
      return 10;
    });
    expect(calls).toBe(40);
    expect(result.error).toContain("20 roll-offs");
    expect(result.order).toEqual([]);
  });
});
