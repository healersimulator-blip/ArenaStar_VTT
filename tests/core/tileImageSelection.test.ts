import { describe, expect, test } from "vitest";
import { resolveTileImageIndex, tileImageNumbers, tileImageSelectionError, type TileImageList } from "../../src/core/tileImageSelection";

const images = ["a", "b", "c", "d", "e"];
const list = (fields: Partial<TileImageList>): TileImageList => ({ images, selection: "first", ...fields });

describe("bounded tile image selection expressions", () => {
  test.each([
    ["1", [1]], ["1-3", [1, 2, 3]], ["1-3, 5", [1, 2, 3, 5]],
    ["[5, 1, 3-4]", [5, 1, 3, 4]], [" [ 1 - 2 , 4 ] ", [1, 2, 4]],
  ])("expands %s as inclusive 1-based image slots", (input, expected) => {
    expect(tileImageNumbers(input, 5)).toEqual({ ok: true, value: expected });
  });

  test.each(["", "[]", "0", "6", "5-2", "1,1", "1-3,3-5", "1,", ",1", "1.5", "-1", "1d4", "1+2", "[1,2", "1,2]", "[[1]]", "1;2", "Infinity", "1".repeat(129), null, [1, 2]])
    ("rejects malformed, out-of-list or overlapping numbers %j", (input) => {
      expect(tileImageNumbers(input, 5).ok).toBe(false);
    });

  test("number lists use host randomness uniformly over the expanded slots; singleton is deterministic", () => {
    expect(resolveTileImageIndex(list({ selection: "numbers", numbers: "1, 3-5" }), 0, () => 0.25))
      .toEqual({ ok: true, value: 2 });
    expect(resolveTileImageIndex(list({ selection: "numbers", numbers: "[2]" }), -1, () => { throw new Error("unexpected RNG"); }))
      .toEqual({ ok: true, value: 1 });
  });

  test.each([
    ["1d4+1", 0, 1], ["1d4+1", 0.999, 4], ["floor(5 / 2)", 0, 1],
    ["min(5, 2 + 1)", 0, 2], ["2d4kh1", 0.5, 2], ["max(1, abs(-3))", 0, 2],
  ] as const)("resolves dice/math %s without JavaScript evaluation", (formula, rng, expected) => {
    expect(resolveTileImageIndex(list({ selection: "formula", formula }), -1, () => rng))
      .toEqual({ ok: true, value: expected });
  });

  test.each(["@actor.hp", "{{value}}", "globalThis.alert(1)", "(() => 1)()", "Math.max(1,2)", "1;2", "", "1".repeat(129)])
    ("rejects scripts, paths and invalid grammar at authoring: %s", (formula) => {
      expect(tileImageSelectionError({ selection: "formula", formula }, 5)).not.toBeNull();
    });

  test.each(["0", "6", "3 / 2", "1 / 0", "sqrt(-1)", "pow(10, 1000)"])
    ("rejects invalid evaluated image numbers without rounding/clamping: %s", (formula) => {
      expect(resolveTileImageIndex(list({ selection: "formula", formula }), 0, () => 0).ok).toBe(false);
    });

  test.each(["65d1-64", "1d2x"])("bounds dice work including modifiers: %s", (formula) => {
    let draws = 0;
    const result = resolveTileImageIndex(list({ selection: "formula", formula }), 0, () => { draws++; return 0.999; });
    expect(result).toMatchObject({ ok: false, error: expect.stringContaining("64 random draws") });
    expect(draws).toBe(64);
  });

  test.each([-1, 1, NaN, Infinity])("invalid host RNG %s cannot choose a slot", (rng) => {
    for (const selection of [list({ selection: "formula", formula: "1d4" }), list({ selection: "numbers", numbers: "1-5" })])
      expect(resolveTileImageIndex(selection, 0, () => rng)).toMatchObject({ ok: false, error: expect.stringContaining("RNG") });
  });

  test("fields cannot leak between selection modes and unknown/current slots fail closed", () => {
    for (const fields of [
      { selection: "first", numbers: "1" }, { selection: "numbers", numbers: "1", index: 1 },
      { selection: "formula", formula: "1", numbers: "1" }, { selection: "index", index: 1, formula: "1" },
      { selection: "numbers" }, { selection: "formula" }, { selection: "unknown" },
    ]) expect(tileImageSelectionError(fields, 5)).not.toBeNull();
    for (const current of [-2, 5, NaN, 0.5]) expect(resolveTileImageIndex(list({}), current, () => 0).ok).toBe(false);
  });
});
