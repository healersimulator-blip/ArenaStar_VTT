import { describe, expect, test } from "vitest";
import type { ActorDocument, Json } from "../../src/core/documents";
import type { PermissionUser } from "../../src/core/ownership";
import { applyDiff } from "../../src/core/diff";
import { pf1eSheetView } from "../../src/ui/sheets/pf1eSheetModel";
import {
  pf1eSpellbookEdit,
  pf1eSpellbookView,
  type PF1eSpellbookEdit,
} from "../../src/ui/sheets/pf1eSpellbook";

const owner = { id: "player", role: "PLAYER" as const };

function actor(pf1e: Record<string, Json> = {}): ActorDocument {
  return {
    _id: "wizard",
    type: "actor",
    name: "Wizard",
    ownership: { default: 2, player: 3 },
    flags: {},
    system: { pf1e, unrelated: "keep" },
    items: [],
    effects: [],
  };
}

/** Int 18 prepared caster: Table 1-3 adds +1 at 1st–4th. */
function wizard(spells: Record<string, Json> = {}): ActorDocument {
  return actor({
    abilities: { int: 18 },
    spells: {
      keyAbility: "int",
      mode: "prepared",
      casterLevel: 5,
      slotsPerDay: { 0: 4, 1: 4, 2: 3, 3: 2, 4: 1 },
      ...spells,
    },
  });
}

function derivedOf(a: ActorDocument) {
  return pf1eSheetView(a).derived;
}

function apply(
  a: ActorDocument,
  result: ReturnType<typeof pf1eSpellbookEdit>,
): ActorDocument {
  expect(result.error).toBeNull();
  let next = a;
  for (const op of result.ops) {
    if (op.kind !== "update") throw new Error("Expected update op");
    const r = applyDiff(next, op.diff);
    if (!r.ok) throw new Error(r.error);
    next = r.value;
  }
  return next;
}

function edit(
  a: ActorDocument,
  e: PF1eSpellbookEdit,
  user: PermissionUser | null = owner,
): ReturnType<typeof pf1eSpellbookEdit> {
  return pf1eSpellbookEdit(a, derivedOf(a), user, e);
}

/** The authored `system.pf1e.spells` block after an op round-trip. */
function spellsOf(a: ActorDocument): Record<string, Json> {
  const pf1e = a.system.pf1e as Record<string, Json>;
  return (pf1e.spells ?? {}) as Record<string, Json>;
}

function preparedOf(a: ActorDocument): Json[] {
  return (spellsOf(a).prepared ?? []) as Json[];
}

describe("P5/C04 spellbook: persisted slot ledger", () => {
  test("owner spend writes a dotted slotsUsed diff and preserves sibling levels", () => {
    const a = wizard({ slotsUsed: { 1: 2, 3: 1 } });
    const before = structuredClone(a);
    const result = edit(a, { kind: "spend", level: 1 });
    expect(result).toEqual({
      error: null,
      warning: null,
      ops: [
        {
          kind: "update",
          ref: { coll: "actors", id: "wizard" },
          diff: { "system.pf1e.spells.slotsUsed.1": 3 },
        },
      ],
    });
    const next = apply(a, result);
    expect(spellsOf(next).slotsUsed).toEqual({ 1: 3, 3: 1 });
    expect(a).toEqual(before);
  });

  test("first spend materializes the whole ledger, other levels at zero", () => {
    const a = wizard();
    const result = edit(a, { kind: "spend", level: 2 });
    expect(result.error).toBeNull();
    const next = apply(a, result);
    const used = spellsOf(next).slotsUsed as Record<string, Json>;
    expect(used[2]).toBe(1);
    expect(used[0]).toBe(0);
    expect(used[1]).toBe(0);
  });

  test("restore decrements and clamps at zero as a no-op", () => {
    const a = wizard({ slotsUsed: { 1: 1 } });
    const spent = apply(a, edit(a, { kind: "restore", level: 1 }));
    expect(spellsOf(spent).slotsUsed).toEqual({ 1: 0 });
    const atZero = wizard({ slotsUsed: { 1: 0 } });
    const noop = edit(atZero, { kind: "restore", level: 1 });
    expect(noop).toEqual({ ops: [], error: null, warning: null });
  });

  test("spending past the budget is allowed but surfaced as a warning", () => {
    // 1st-level budget is 4 authored + 1 bonus (Int 18) = 5.
    const a = wizard({ slotsUsed: { 1: 5 } });
    const result = edit(a, { kind: "spend", level: 1 });
    expect(result.error).toBeNull();
    expect(result.ops).toHaveLength(1);
    expect(result.warning).toMatch(/over budget/i);
    const next = apply(a, result);
    expect(spellsOf(next).slotsUsed).toEqual({ 1: 6 });
  });

  test("restore rejects out-of-range levels and spend rejects a non-castable level as error, not warning", () => {
    const a = wizard();
    expect(edit(a, { kind: "spend", level: 12 }).error).toMatch(/0–9/);
    expect(edit(a, { kind: "spend", level: 1.5 }).error).toMatch(/0–9/);
    // Level 9 has no authored slots for this wizard: spending there warns, it is not refused.
    const over = edit(a, { kind: "spend", level: 9 });
    expect(over.error).toBeNull();
    expect(over.warning).toMatch(/no slots granted/i);
  });
});

describe("P5/C04 spellbook: prepared list", () => {
  test("prepare appends a row and replace-array keeps prior rows intact", () => {
    const a = wizard({
      prepared: [{ name: "Magic Missile", level: 1 }],
    });
    const result = edit(a, {
      kind: "prepare",
      name: "Shield",
      level: 1,
    });
    const next = apply(a, result);
    expect(preparedOf(next)).toEqual([
      { name: "Magic Missile", level: 1 },
      { name: "Shield", level: 1 },
    ]);
  });

  test("prepare with an explicit slot level records the slotLevel", () => {
    const a = wizard();
    const next = apply(
      a,
      edit(a, {
        kind: "prepare",
        name: "Burning Hands",
        level: 1,
        slotLevel: 2,
      }),
    );
    expect(preparedOf(next)).toEqual([
      { name: "Burning Hands", level: 1, slotLevel: 2 },
    ]);
  });

  test("toggle flips expended without touching other rows", () => {
    const a = wizard({
      prepared: [
        { name: "Magic Missile", level: 1 },
        { name: "Shield", level: 1 },
      ],
    });
    const next = apply(a, edit(a, { kind: "preparedToggle", index: 0 }));
    expect(preparedOf(next)).toEqual([
      { name: "Magic Missile", level: 1, expended: true },
      { name: "Shield", level: 1 },
    ]);
    const back = apply(next, edit(next, { kind: "preparedToggle", index: 0 }));
    expect(preparedOf(back)).toEqual([
      { name: "Magic Missile", level: 1, expended: false },
      { name: "Shield", level: 1 },
    ]);
  });

  test("remove drops a single row and preserves the rest", () => {
    const a = wizard({
      prepared: [
        { name: "Magic Missile", level: 1 },
        { name: "Shield", level: 1 },
      ],
    });
    const next = apply(a, edit(a, { kind: "preparedRemove", index: 0 }));
    expect(preparedOf(next)).toEqual([{ name: "Shield", level: 1 }]);
  });

  test("invalid prepare inputs are named errors, not silent drops", () => {
    const a = wizard();
    expect(edit(a, { kind: "prepare", name: "   ", level: 1 }).error).toMatch(
      /name/i,
    );
    expect(
      edit(a, { kind: "prepare", name: "X".repeat(121), level: 1 }).error,
    ).toMatch(/120/);
    expect(
      edit(a, { kind: "prepare", name: "Shield", level: 11 }).error,
    ).toMatch(/0–9/);
    expect(
      edit(a, { kind: "prepare", name: "Shield", level: 1, slotLevel: -1 })
        .error,
    ).toMatch(/0–9/);
    expect(edit(a, { kind: "preparedRemove", index: 42 }).error).toMatch(
      /no longer exists/i,
    );
  });

  test("spontaneous casters keep no prepared list", () => {
    const sorcerer = actor({
      abilities: { cha: 18 },
      spells: {
        keyAbility: "cha",
        mode: "spontaneous",
        casterLevel: 5,
        slotsPerDay: { 1: 4 },
      },
    });
    const result = edit(sorcerer, {
      kind: "prepare",
      name: "Shield",
      level: 1,
    });
    expect(result.ops).toEqual([]);
    expect(result.error).toMatch(/spontaneous/i);
  });
});

describe("P5/C04 spellbook: authorization and view", () => {
  test("denies unauthenticated and non-owner edits", () => {
    const a = wizard();
    for (const user of [null, { id: "other", role: "PLAYER" as const }]) {
      const result = edit(a, { kind: "spend", level: 1 }, user);
      expect(result.ops).toEqual([]);
      expect(result.error).toMatch(/own/i);
    }
  });

  test("an actor with no spellcasting data cannot open the spellbook", () => {
    const a = actor({ abilities: { str: 16 } });
    const result = edit(a, { kind: "spend", level: 1 });
    expect(result.ops).toEqual([]);
    expect(result.error).toMatch(/no spellcasting/i);
  });

  test("view projects the persisted ledger and prepared counts onto the readout", () => {
    const a = wizard({
      slotsUsed: { 1: 2 },
      prepared: [
        { name: "Magic Missile", level: 1 },
        { name: "Magic Missile", level: 1 },
        { name: "Invisibility", level: 2 },
      ],
    });
    const view = pf1eSpellbookView(a, derivedOf(a));
    expect(view.casting).toBe(true);
    expect(view.mode).toBe("prepared");
    // Int 18: 1st = 4 base + 1 bonus = 5 total; 2 spent.
    const first = view.ledger.rows.find((r) => r.level === 1);
    expect(first).toMatchObject({ total: 5, spent: 2 });
    expect(view.prepared).toHaveLength(3);
    // Prepared counts ride the per-row text, not the one-line summary.
    expect(view.ledger.summary).toContain("1st 2/5");
    expect(first?.text).toBe("2/5 · 2 prepared");
  });

  test("view surfaces over-preparation as a warning, not a refusal", () => {
    const a = wizard({
      prepared: Array.from({ length: 6 }, (_, i) => ({
        name: `Spell ${i}`,
        level: 1,
      })),
    });
    const view = pf1eSpellbookView(a, derivedOf(a));
    // 6 prepared at level 1 but only 5 slots (4 + 1 bonus).
    expect(view.preparationWarnings.join(" ")).toMatch(
      /exceeding the 5 slots/i,
    );
  });
});
