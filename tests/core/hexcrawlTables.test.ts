/**
 * D-269 (plan §5.2, requirement 5b) — the weighted-percentage compiler and the dice mode.
 *
 * The cases below are the ones a GM actually types: weights that add to 100 (the easy case),
 * weights that add to 95 or to 240 (the common ones), a zero-weight flavour row, and a dice
 * table with a hole in the middle. Each has a *documented* outcome, because "the table silently
 * did something else" is the bug this module exists to prevent.
 */
import { describe, expect, test } from "vitest";
import type {
  EncounterEntry,
  EncounterTableDocument,
} from "../../src/core/documents";
import {
  ALL_TAGS_ON,
  WEIGHT_LADDER_DIE,
  diceRanges,
  dieSizeOf,
  encounterTagsOf,
  entryForRoll,
  entryToJson,
  validateEncounterTable,
  weightsToRanges,
  withTags,
} from "../../src/core/hexcrawl/tables";

const table = (
  over: Partial<EncounterTableDocument> = {},
): EncounterTableDocument => ({
  _id: "t1",
  type: "encounterTable",
  name: "Forest day",
  ownership: { default: 2 },
  flags: {},
  system: {},
  mode: "weighted",
  formula: "",
  entries: [],
  tags: { ...ALL_TAGS_ON },
  ...over,
});

const entry = (over: Partial<EncounterEntry> = {}): EncounterEntry => ({
  weight: 0,
  text: "Something",
  count: 1,
  refs: [],
  ...over,
});

describe("weightsToRanges", () => {
  test("weights that already total 100 are kept exactly, in order, with no gaps", () => {
    const c = weightsToRanges([{ weight: 50 }, { weight: 30 }, { weight: 20 }]);
    expect(c.scaled).toBe(false);
    expect(c.warnings).toEqual([]);
    expect(c.ranges).toEqual([
      { range: [1, 50], index: 0, weight: 50 },
      { range: [51, 80], index: 1, weight: 30 },
      { range: [81, 100], index: 2, weight: 20 },
    ]);
  });

  test("weights under 100 scale up to fill the die rather than leaving a dead zone", () => {
    const c = weightsToRanges([{ weight: 25 }, { weight: 25 }, { weight: 25 }]);
    expect(c.scaled).toBe(true);
    expect(c.total).toBe(75);
    expect(c.warnings[0]).toMatch(/scaled up/);
    // 100/3 each: 33, 33, 34 (the remainder goes to the earlier rows, deterministically).
    expect(c.ranges.map((r) => r.range[1] - r.range[0] + 1)).toEqual([
      34, 33, 33,
    ]);
    expect(c.ranges[0]?.range[0]).toBe(1);
    expect(c.ranges[2]?.range[1]).toBe(100);
  });

  test("weights over 100 scale down and keep the author's ratios", () => {
    const c = weightsToRanges([
      { weight: 200 },
      { weight: 100 },
      { weight: 100 },
    ]);
    expect(c.scaled).toBe(true);
    expect(c.warnings[0]).toMatch(/scaled down/);
    expect(c.ranges.map((r) => r.range[1] - r.range[0] + 1)).toEqual([
      50, 25, 25,
    ]);
  });

  test("a zero weight is a note: it never takes ladder space", () => {
    const c = weightsToRanges([{ weight: 60 }, { weight: 40 }, { weight: 0 }]);
    expect(c.dropped).toEqual([2]);
    expect(c.ranges).toHaveLength(2);
    expect(c.ranges[1]?.range).toEqual([61, 100]);
    for (const r of c.ranges) expect(r.index).not.toBe(2);
  });

  test("a table with no weights at all compiles to nothing, with a reason", () => {
    const c = weightsToRanges([{ weight: 0 }, { weight: -3 }]);
    expect(c.ranges).toEqual([]);
    expect(c.dropped).toEqual([0, 1]);
    expect(c.warnings[0]).toMatch(/only be rolled by hand/);
  });

  test("a tiny weight still gets one face instead of vanishing (a scaled-down table)", () => {
    // 1 against 10 000: proportionally 0.01 of a face — but an unreachable row is a bug a GM
    // cannot see, so it gets exactly one.
    const c = weightsToRanges([{ weight: 10_000 }, { weight: 1 }]);
    expect(c.ranges).toHaveLength(2);
    expect(c.ranges[0]?.range).toEqual([1, 99]);
    expect(c.ranges[1]).toEqual({ range: [100, 100], index: 1, weight: 1 });
    // The face was moved, not added: the ladder still ends at 100.
    expect(
      c.ranges.reduce((n, r) => n + (r.range[1] - r.range[0] + 1), 0),
    ).toBe(100);
  });

  test("the ladder is total and gapless for a fuzz of weight vectors", () => {
    const vectors = [
      [1],
      [1, 1],
      [7, 11, 13],
      [1, 2, 3, 4, 5, 6, 7],
      [99, 1],
      [0.1, 0.2, 0.3],
      [33.33, 33.33, 33.34],
      [1, 0, 1],
      [5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5],
    ];
    for (const vector of vectors) {
      const c = weightsToRanges(vector.map((weight) => ({ weight })));
      expect(c.ranges.length).toBeGreaterThan(0);
      let expectNext = 1;
      for (const r of c.ranges) {
        expect(r.range[0]).toBe(expectNext);
        expect(r.range[1]).toBeGreaterThanOrEqual(r.range[0]);
        expectNext = r.range[1] + 1;
      }
      expect(expectNext).toBe(101);
      // Every roll between 1 and 100 finds an entry.
      for (const roll of [1, 2, 50, 99, 100]) {
        expect(entryForRoll(c.ranges, roll)).not.toBeNull();
      }
    }
  });
});

describe("dice mode", () => {
  test("dieSizeOf reads the first term, with or without a count", () => {
    expect(dieSizeOf("1d20")).toBe(20);
    expect(dieSizeOf("d12")).toBe(12);
    expect(dieSizeOf("2d6+1")).toBe(6);
    expect(dieSizeOf("1d100")).toBe(100);
    expect(dieSizeOf("")).toBe(WEIGHT_LADDER_DIE);
    expect(dieSizeOf(undefined)).toBe(WEIGHT_LADDER_DIE);
    expect(dieSizeOf("nonsense")).toBe(WEIGHT_LADDER_DIE);
  });

  test("stored ranges are clamped to the die and sorted by their lower bound", () => {
    const ranges = diceRanges(
      [
        { range: [15, 20] },
        { range: [1, 5] },
        { range: [-3, 2] },
        { range: [18, 99] },
      ],
      20,
    );
    // Lower bound first; on a tie, the order the GM wrote the rows in.
    expect(ranges).toEqual([
      { range: [1, 5], index: 1 },
      { range: [1, 2], index: 2 },
      { range: [15, 20], index: 0 },
      { range: [18, 20], index: 3 },
    ]);
    expect(diceRanges([{}, {}], 20)).toEqual([]);
  });

  test("validateEncounterTable reports the die, the gaps and the errors", () => {
    const good = validateEncounterTable(
      table({
        mode: "dice",
        formula: "1d20",
        entries: [
          entry({ range: [1, 10], text: "Wolves", weight: 0 }),
          entry({ range: [11, 20], text: "Bandits", weight: 0 }),
        ],
      }),
    );
    expect(good.ok).toBe(true);
    expect(good.die).toBe(20);
    expect(good.warnings).toEqual([]);

    const gappy = validateEncounterTable(
      table({
        mode: "dice",
        formula: "1d20",
        entries: [
          entry({ range: [1, 5], text: "Wolves" }),
          entry({ range: [12, 20], text: "Bandits" }),
        ],
      }),
    );
    expect(gappy.ok).toBe(true);
    expect(gappy.warnings.some((w) => /land on no entry/.test(w))).toBe(true);

    const bad = validateEncounterTable(
      table({ mode: "dice", formula: "roll well", entries: [] }),
    );
    expect(bad.ok).toBe(false);
    expect(bad.errors.some((e) => /not a dice expression/.test(e))).toBe(true);
    expect(bad.errors.some((e) => /no entries/.test(e))).toBe(true);

    const empty = validateEncounterTable(
      table({ mode: "weighted", entries: [] }),
    );
    expect(empty.ok).toBe(false);
    expect(empty.errors.some((e) => /weight above zero/.test(e))).toBe(true);
  });
});

describe("tags", () => {
  test("missing, empty and partial tag bags all default to ON", () => {
    expect(encounterTagsOf({})).toEqual(ALL_TAGS_ON);
    expect(encounterTagsOf({ tags: null })).toEqual(ALL_TAGS_ON);
    expect(encounterTagsOf({ tags: { night: false } })).toEqual({
      ...ALL_TAGS_ON,
      night: false,
    });
    // Only an explicit `false` turns a tag off — a truthy string does not.
    expect(encounterTagsOf({ tags: { day: "no" as never } })).toEqual(
      ALL_TAGS_ON,
    );
  });

  test("withTags applies exactly the GM's patch", () => {
    const tags = withTags(ALL_TAGS_ON, { exploring: false });
    expect(tags.exploring).toBe(false);
    expect(tags.day).toBe(true);
    expect(entryToJson(entry({ text: "Wolves", count: 3 }))).toEqual({
      weight: 0,
      text: "Wolves",
      count: 3,
      refs: [],
    });
  });
});
