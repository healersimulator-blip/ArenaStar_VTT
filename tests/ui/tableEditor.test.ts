/**
 * D-272 (plan §5.4) — the wizard's model, as pure functions.
 *
 * The claims worth pinning: the `%` column is the *compiled ladder* (so it can never disagree with
 * what the dice do), dice→weighted refuses rather than invents, weighted→dice is exact, pasting
 * reports what it could not read, and a save writes only what moved.
 */
import { describe, expect, test } from "vitest";
import type {
  EncounterEntry,
  EncounterTableDocument,
  SceneDocument,
} from "../../src/core/documents";
import {
  rowPercents,
  rowShares,
  convertTableToDice,
  convertTableToWeighted,
  formulaIsReadable,
  parsePastedRows,
} from "../../src/core/hexcrawl/tables";
import {
  deleteEncounterTableOps,
  detachTableFromCellsOps,
  duplicateEncounterTableOps,
  newEncounterTableId,
  updateEncounterTableOps,
} from "../../src/core/hexcrawl/tableOps";
import {
  addRow,
  attachTableOps,
  attachedTableIds,
  battleSceneChoices,
  detachTableOps,
  draftAsDocument,
  draftOf,
  draftView,
  emptyTableDraft,
  moveRow,
  pasteRows,
  removeRow,
  savePlan,
  switchMode,
  testRoll,
  withCooldown,
  withRowCount,
  withRowRange,
  withRowRefs,
  withRowText,
  withRowWeight,
  withScene,
  withTags,
} from "../../src/ui/hexcrawl/tableEditor";

/** The diff of an update op (the shape almost every assertion here reads). */
function updateDiff(op: unknown): Record<string, unknown> {
  if (typeof op !== "object" || op === null) throw new Error("not an op");
  const record = op as { kind?: unknown; diff?: Record<string, unknown> };
  if (record.kind !== "update" || !record.diff)
    throw new Error("not an update op");
  return record.diff;
}

function at<T>(items: readonly T[], index: number): T {
  const item = items[index];
  if (item === undefined) throw new Error(`no item at ${index}`);
  return item;
}

const entry = (over: Partial<EncounterEntry> = {}): EncounterEntry => ({
  weight: 0,
  text: "row",
  count: 1,
  refs: [],
  ...over,
});

const table = (
  over: Partial<EncounterTableDocument> = {},
): EncounterTableDocument => ({
  _id: "table-1",
  type: "encounterTable",
  name: "Forest road",
  ownership: { default: 0, gm: 3 },
  flags: {},
  system: {},
  mode: "weighted",
  formula: "",
  entries: [entry({ weight: 50, text: "Wolves" })],
  tags: {
    day: true,
    night: true,
    entering: true,
    moving: true,
    exploring: true,
    fighting: true,
  },
  ...over,
});

const scene = (over: Partial<SceneDocument> = {}): SceneDocument =>
  ({
    _id: "scene-1",
    type: "scene",
    name: "Overland",
    ownership: { default: 0, gm: 3 },
    flags: {},
    system: {},
    width: 2000,
    height: 1500,
    grid: { type: "hex", size: 100, offsetX: 0, offsetY: 0 },
    cells: [
      {
        _id: "cell-0-0",
        type: "cell",
        name: "0,0",
        ownership: { default: 0, gm: 3 },
        flags: {},
        system: {},
        key: "0,0",
        tables: ["table-1"],
        features: [],
      },
    ],
    ...over,
  }) as unknown as SceneDocument;

describe("percentages are the compiled ladder, not the weights", () => {
  test("three equal weights show 34/33/33 — the faces the die actually lands on", () => {
    const entries = [
      entry({ weight: 30 }),
      entry({ weight: 30 }),
      entry({ weight: 30 }),
    ];
    expect(rowPercents(entries)).toEqual([34, 33, 33]);
    expect(rowShares(entries).reduce((a, b) => a + b, 0)).toBeCloseTo(100, 6);
  });

  test("the whole-percent column always totals 100 when anything has a weight", () => {
    for (const weights of [
      [1],
      [1, 1],
      [7, 7, 7],
      [10000, 1],
      Array(9).fill(5),
    ]) {
      const entries = weights.map((w: number) => entry({ weight: w }));
      const percents = rowPercents(entries);
      expect(percents.reduce((a, b) => a + b, 0)).toBe(100);
      expect(percents.every((p) => p >= 0)).toBe(true);
    }
  });

  test("a weightless row shows 0 % and never receives the rounding remainder", () => {
    const entries = [
      entry({ weight: 0 }),
      entry({ weight: 1 }),
      entry({ weight: 1 }),
    ];
    const percents = rowPercents(entries);
    expect(at(percents, 0)).toBe(0);
    expect(percents.reduce((a, b) => a + b, 0)).toBe(100);
  });
});

describe("mode conversion (lossless in one direction only)", () => {
  test("1d20 → weighted keeps the faces: 8 faces of 20 is 40 %", () => {
    const doc = {
      formula: "1d20",
      entries: [
        entry({ range: [1, 8], text: "goblins" }),
        entry({ range: [9, 20], text: "wolves" }),
      ],
    };
    const converted = convertTableToWeighted(doc);
    expect(converted.ok).toBe(true);
    expect(at(converted.entries, 0).weight).toBe(40);
    expect(at(converted.entries, 1).weight).toBe(60);
    // …and the ladder it compiles back to is the very same ladder.
    expect(at(rowShares(converted.entries), 0)).toBe(40);
    expect(at(rowShares(converted.entries), 1)).toBe(60);
  });

  test("2d6+1 is refused in the GM's own words — nothing is invented", () => {
    const converted = convertTableToWeighted({
      formula: "2d6+1",
      entries: [entry({ range: [1, 3] })],
    });
    expect(converted.ok).toBe(false);
    expect(converted.error).toContain("2d6+1");
    expect(converted.error).toContain("flat die");
    expect(converted.entries).toEqual([]);
  });

  test("weighted → dice is the compiled ladder as 1d100", () => {
    const converted = convertTableToDice({
      entries: [
        entry({ weight: 30 }),
        entry({ weight: 30 }),
        entry({ weight: 30 }),
      ],
    });
    expect(converted.ok).toBe(true);
    expect(converted.formula).toBe("1d100");
    expect(at(converted.entries, 0).range).toEqual([1, 34]);
    expect(at(converted.entries, 2).range).toEqual([68, 100]);
    // Ranges are the only thing that survived: the table is no longer weighted.
    expect(converted.entries.every((e) => e.weight === 0)).toBe(true);
  });

  test("a weightless draft refuses to become dice, and the formula gate is honest", () => {
    expect(convertTableToDice({ entries: [entry({ weight: 0 })] }).ok).toBe(
      false,
    );
    expect(formulaIsReadable("2d6+1")).toBe(true);
    expect(formulaIsReadable("2d6+1+2")).toBe(false);
  });
});

describe("paste rows", () => {
  test("weight, text, count — and a ref token", () => {
    const parsed = parsePastedRows(
      "30, Goblin bandits, 2, @pack-1/goblin\nA merchant caravan\n25\tWolves, hunting\t1",
      { mode: "weighted" },
    );
    expect(parsed.skipped).toEqual([]);
    expect(parsed.entries).toHaveLength(3);
    expect(at(parsed.entries, 0)).toMatchObject({
      weight: 30,
      text: "Goblin bandits",
      count: 2,
      refs: [{ kind: "compendium", packId: "pack-1", entryId: "goblin" }],
    });
    expect(at(parsed.entries, 1).text).toBe("A merchant caravan");
    expect(at(parsed.entries, 2)).toMatchObject({
      weight: 25,
      text: "Wolves, hunting",
      count: 1,
    });
  });

  test("dice ranges parse as `3-5`, and unreadable lines are reported", () => {
    const parsed = parsePastedRows("1-5, Goblins\n,,,\n7, Wolf", {
      mode: "dice",
    });
    expect(at(parsed.entries, 0).range).toEqual([1, 5]);
    expect(at(parsed.entries, 1).range).toEqual([7, 7]);
    expect(parsed.skipped.map((s) => s.line)).toEqual([2]);
  });

  test("a paste fills the blank row rather than doubling it, and keeps authored rows", () => {
    const draft = {
      ...emptyTableDraft(),
      entries: [
        entry({ weight: 40, text: "Kept" }),
        entry({ weight: 0, text: "" }),
      ],
    };
    const pasted = pasteRows(draft, "10, Goblins\n20, Wolves");
    expect(pasted.draft.entries.map((e) => e.text)).toEqual([
      "Kept",
      "Goblins",
      "Wolves",
    ]);
    expect(pasted.notes).toEqual([]);
    expect(pasteRows(emptyTableDraft(), "   ").error).not.toBeNull();
  });
});

describe("the draft view", () => {
  test("weighted rows carry a percent each and the total reads 100", () => {
    const draft = {
      ...emptyTableDraft(),
      entries: [
        entry({ weight: 3, text: "a" }),
        entry({ weight: 1, text: "b" }),
      ],
    };
    const view = draftView(draft);
    expect(view.rows.map((r) => r.percent)).toEqual([75, 25]);
    expect(view.totalPercent).toBe(100);
    expect(view.check.ok).toBe(true);
    expect(at(view.rows, 0).range).toEqual([1, 75]);
    expect(view.totalWeight).toBe(4);
  });

  test("a dice draft shows its own ranges and reports the gaps the author left", () => {
    const draft = {
      ...emptyTableDraft(),
      mode: "dice" as const,
      formula: "1d20",
      entries: [entry({ range: [1, 5] as [number, number], text: "goblins" })],
    };
    const view = draftView(draft);
    expect(at(view.rows, 0).range).toEqual([1, 5]);
    expect(view.check.ok).toBe(true);
    expect(view.check.warnings.join(" ")).toContain("6–20");
  });

  test("an empty table is an error, not a save with no rows", () => {
    const draft = { ...emptyTableDraft(), entries: [] };
    expect(draftView(draft).check.ok).toBe(false);
    expect(savePlan(draft, { mintId: () => "x" }).error).not.toBeNull();
  });

  test("a ref is written by the picker's write path and read back by the row label", () => {
    let draft = {
      ...emptyTableDraft(),
      entries: [entry({ weight: 10, text: "bandits" })],
    };
    draft = withRowRefs(draft, 0, [
      { kind: "compendium", packId: "bestiary", entryId: "goblin" },
    ]);
    expect(at(draftView(draft).rows, 0).refLabel).toBe("▸ bestiary/goblin");
    expect(at(draft.entries, 0).refs).toEqual([
      { kind: "compendium", packId: "bestiary", entryId: "goblin" },
    ]);
  });
});

describe("row editing", () => {
  test("weights coerce: text, negatives and NaN become 0", () => {
    const draft = emptyTableDraft();
    expect(at(withRowWeight(draft, 0, "12").entries, 0).weight).toBe(12);
    for (const bad of ["", "-4", "abc"]) {
      expect(at(withRowWeight(draft, 0, bad).entries, 0).weight).toBe(0);
    }
  });

  test("counts are positive integers; a bad one falls back to 1", () => {
    const draft = emptyTableDraft();
    expect(at(withRowCount(draft, 0, "7").entries, 0).count).toBe(7);
    expect(at(withRowCount(draft, 0, "2.9").entries, 0).count).toBe(2);
    expect(at(withRowCount(draft, 0, "0").entries, 0).count).toBe(1);
  });

  test("ranges accept `3`, `3-5`, `5-3` (ordered) and blank (dropped)", () => {
    const draft = { ...emptyTableDraft(), mode: "dice" as const };
    expect(at(withRowRange(draft, 0, "3").entries, 0).range).toEqual([3, 3]);
    expect(at(withRowRange(draft, 0, "5-3").entries, 0).range).toEqual([3, 5]);
    expect(at(withRowRange(draft, 0, "").entries, 0).range).toBeUndefined();
    expect(at(withRowRange(draft, 0, "junk").entries, 0).range).toBeUndefined();
  });

  test("add, remove and reorder rows", () => {
    let draft = emptyTableDraft();
    draft = withRowText(draft, 0, "first");
    draft = addRow(draft);
    draft = withRowText(draft, 1, "second");
    expect(draft.entries.map((e) => e.text)).toEqual(["first", "second"]);
    draft = moveRow(draft, 1, -1);
    expect(draft.entries.map((e) => e.text)).toEqual(["second", "first"]);
    expect(moveRow(draft, 0, -1)).toBe(draft);
    draft = removeRow(draft, 0);
    expect(draft.entries.map((e) => e.text)).toEqual(["first"]);
  });

  test("tags, scene link and cooldown are draft fields with `null` = default", () => {
    const draft = withCooldown(
      withScene(withTags(emptyTableDraft(), { night: false }), "battle-1"),
      600,
    );
    expect(draft.tags.night).toBe(false);
    expect(draft.tags.day).toBe(true);
    expect(draft.sceneId).toBe("battle-1");
    expect(draft.cooldownSeconds).toBe(600);
    expect(withCooldown(draft, 0).cooldownSeconds).toBeNull();
  });
});

describe("mode switch as the wizard's one toggle", () => {
  test("dice → weighted converts, and the refusal leaves the draft untouched", () => {
    const dice = {
      ...emptyTableDraft(),
      mode: "dice" as const,
      formula: "1d20",
      entries: [entry({ range: [1, 1] as [number, number], text: "rare" })],
    };
    const ok = switchMode(dice, "weighted");
    expect(ok.error).toBeNull();
    expect(at(ok.draft.entries, 0).weight).toBe(5);
    expect(ok.draft.formula).toBe("");

    const refused = switchMode({ ...dice, formula: "2d6" }, "weighted");
    expect(refused.error).not.toBeNull();
    expect(refused.draft.mode).toBe("dice");
    expect(refused.draft.formula).toBe("2d6");
  });

  test("weighted → dice writes 1d100 and the compiled ranges", () => {
    const weighted = {
      ...emptyTableDraft(),
      entries: [
        entry({ weight: 1, text: "a" }),
        entry({ weight: 3, text: "b" }),
      ],
    };
    const changed = switchMode(weighted, "dice");
    expect(changed.error).toBeNull();
    expect(changed.draft.formula).toBe("1d100");
    expect(at(changed.draft.entries, 0).range).toEqual([1, 25]);
    expect(at(changed.draft.entries, 1).range).toEqual([26, 100]);
    expect(switchMode(weighted, "weighted").draft).toBe(weighted);
  });
});

describe("test roll", () => {
  test("draws with the real engine and writes nothing", () => {
    const draft = {
      ...emptyTableDraft(),
      entries: [entry({ weight: 1, text: "wolves" })],
    };
    const roll = testRoll(draft, () => 0.99);
    expect(roll.text).toBe("wolves");
    expect(roll.formula).toBe("1d100");
    expect(roll.die).toBe(100);
    expect(roll.roll).toBe(100);
  });
});

describe("save, duplicate, delete", () => {
  test("a new table saves as one create plus the attach when opened from a hex", () => {
    const draft = { ...emptyTableDraft(), name: "Forest road" };
    const plan = savePlan(draft, {
      mintId: () => "table-new",
      attach: { scene: scene(), key: "0,0" },
    });
    expect(plan.error).toBeNull();
    expect(plan.ops).toHaveLength(2);
    expect(at(plan.ops, 0)).toMatchObject({
      kind: "create",
      coll: "encounterTables",
    });
    expect(at(plan.ops, 1)).toMatchObject({
      kind: "update",
      ref: {
        coll: "cells",
        id: "cell-0-0",
        parent: { coll: "scenes", id: "scene-1" },
      },
    });
  });

  test("attaching on a hex nobody has described creates the cell, not a silent no-op", () => {
    const plan = savePlan(
      { ...emptyTableDraft(), name: "Road" },
      {
        mintId: () => "table-new",
        attach: { scene: scene(), key: "3,-2" },
      },
    );
    expect(plan.error).toBeNull();
    expect(at(plan.ops, 1)).toMatchObject({
      kind: "create",
      coll: "cells",
      parent: { coll: "scenes", id: "scene-1" },
    });
    const cellOp = at(plan.ops, 1);
    if (cellOp.kind !== "create") throw new Error("expected a cell create");
    const created = cellOp.data as unknown as {
      key: string;
      tables: string[];
      name: string;
    };
    expect(created.key).toBe("3,-2");
    expect(created.tables).toEqual(["table-new"]);
    expect(created.name).toBe("3,-2");
  });

  test("saving an unchanged table submits nothing", () => {
    const doc = table();
    expect(
      updateEncounterTableOps(doc, {
        name: doc.name,
        mode: doc.mode,
        formula: "",
        entries: doc.entries,
        tags: doc.tags,
      }),
    ).toEqual([]);
  });

  test("a cleared scene link and cooldown are removals, not stale fields", () => {
    const doc = table({ sceneId: "battle-1", cooldownSeconds: 600 });
    const ops = updateEncounterTableOps(doc, {
      name: doc.name,
      mode: doc.mode,
      formula: "",
      entries: doc.entries,
      tags: doc.tags,
    });
    expect(ops).toHaveLength(1);
    const diff = ops[0] && ops[0].kind === "update" ? ops[0].diff : {};
    expect(diff["-=sceneId"]).toBeNull();
    expect(diff["-=cooldownSeconds"]).toBeNull();
    expect(diff["name"]).toBeUndefined();
  });

  test("ids are slugs with a suffix, so two tables of one name differ", () => {
    const a = newEncounterTableId("Forest road — day", () => 0.5);
    const b = newEncounterTableId("Forest road — day", () => 0.9);
    expect(a.startsWith("table-forest-road-day-")).toBe(true);
    expect(a).not.toBe(b);
  });

  test("duplicate copies the body under a new id and name", () => {
    const ops = duplicateEncounterTableOps(
      table(),
      "table-2",
      "Forest road (night)",
    );
    const createdOp = at(ops, 0);
    if (createdOp.kind !== "create") throw new Error("expected a create");
    const created = createdOp.data as unknown as EncounterTableDocument;
    expect(created._id).toBe("table-2");
    expect(created.name).toBe("Forest road (night)");
    expect(created.entries).toEqual(table().entries);
  });

  test("deleting a table detaches it from every cell that names it", () => {
    const ops = detachTableFromCellsOps(
      [scene(), scene({ _id: "scene-2" })],
      "table-1",
    );
    expect(ops).toHaveLength(2);
    expect(updateDiff(at(ops, 0))["tables"]).toEqual([]);
    expect(deleteEncounterTableOps("table-1")).toMatchObject([
      { kind: "delete", ref: { coll: "encounterTables", id: "table-1" } },
    ]);
  });
});

describe("attaching a table to a hex", () => {
  test("attach appends, is idempotent, and detach is its inverse", () => {
    const s = scene();
    const added = attachTableOps(s, "0,0", "table-2");
    expect(added).toHaveLength(1);
    expect(updateDiff(at(added, 0))["tables"]).toEqual(["table-1", "table-2"]);
    expect(attachTableOps(s, "0,0", "table-1")).toEqual([]);
    expect(detachTableOps(s, "0,0", "table-9")).toEqual([]);
    const removed = detachTableOps(s, "0,0", "table-1");
    expect(updateDiff(at(removed, 0))["tables"]).toEqual([]);
  });

  test("detaching what was never there is a no-op, and the read-back agrees", () => {
    expect(detachTableOps(scene(), "0,0", "table-9")).toEqual([]);
    expect(detachTableOps(scene(), "9,9", "table-1")).toEqual([]);
    expect(attachedTableIds(scene(), "0,0")).toEqual(["table-1"]);
    expect(attachedTableIds(scene(), "9,9")).toEqual([]);
  });
});

describe("battle scene choices and round trip", () => {
  test("scenes sort by name and the wizard's own scene is excluded", () => {
    const choices = battleSceneChoices(
      [
        { _id: "s2", name: "Ziggurat" },
        { _id: "s1", name: "Ambush clearing" },
        { _id: "s3", name: "Overland" },
      ],
      "s3",
    );
    expect(choices.map((c) => c.name)).toEqual(["Ambush clearing", "Ziggurat"]);
  });

  test("a document round-trips through the draft unchanged (no silent field loss)", () => {
    const doc = table({
      mode: "dice",
      formula: "1d20",
      entries: [
        entry({ range: [1, 10], weight: 0, text: "goblins", count: 2 }),
      ],
      sceneId: "battle-1",
      cooldownSeconds: 3600,
    });
    const draft = draftOf(doc);
    const back = draftAsDocument(draft);
    expect(back.formula).toBe("1d20");
    expect(back.entries).toEqual(doc.entries);
    expect(back.sceneId).toBe("battle-1");
    expect(back.cooldownSeconds).toBe(3600);
    // The same document, drafted and saved, writes no ops at all.
    const plan = savePlan(draft, { mintId: () => "unused", existing: doc });
    expect(plan.error).toBeNull();
    expect(plan.ops).toEqual([]);
  });
});
