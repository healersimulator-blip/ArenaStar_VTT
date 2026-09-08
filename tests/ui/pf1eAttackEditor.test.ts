import { describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";
import type { ActorDocument, Json } from "../../src/core/documents";
import { applyDiff } from "../../src/core/diff";
import { normalizePF1eSystem } from "../../src/packages/pf1e/statBlock";
import {
  pf1eSheetEdit,
  pf1eSheetView,
  authoredNumber,
} from "../../src/ui/sheets/pf1eSheetModel";
import {
  pf1eAttackEdit,
  pf1eAttackEditorView,
  type AttackEdit,
  MAX_SHEET_ATTACKS,
} from "../../src/ui/sheets/pf1eAttackEditor";

const owner = { id: "player", role: "PLAYER" as const };
function actor(pf1e: Record<string, Json> = {}): ActorDocument {
  return {
    _id: "hero",
    type: "actor",
    name: "Hero",
    ownership: { default: 2, player: 3 },
    flags: {},
    system: { pf1e, unrelated: "keep" },
    items: [],
    effects: [],
  };
}
function apply(a: ActorDocument, result: ReturnType<typeof pf1eAttackEdit>): ActorDocument {
  expect(result.error).toBeNull();
  let next = a;
  for (const op of result.ops) {
    if (op.kind !== "update") throw new Error("Expected update");
    const r = applyDiff(next, op.diff);
    if (!r.ok) throw new Error(r.error);
    next = r.value;
  }
  return next;
}
function set(
  a: ActorDocument,
  field: string,
  value: string | boolean,
  index = 0,
): ActorDocument {
  return apply(
    a,
    pf1eAttackEdit(a, owner, {
      kind: "set",
      index,
      field,
      value,
      expected: pf1eAttackEditorView(a).rows,
    }),
  );
}

describe("P1 attack authoring", () => {
  test("add, edit and remove actual Ops; derived ability damage is never written back", () => {
    const start = actor({ abilities: { str: 16, dex: 14 }, baseAttack: 6 });
    let a = apply(start, pf1eAttackEdit(start, owner, { kind: "add", expected: [] }));
    a = set(a, "name", "Longsword");
    a = set(a, "damageDice", "1D8");
    a = set(a, "damageBonus", "2");
    a = set(a, "twoHanded", true);
    a = set(a, "critThreatMin", "19");
    const attack = pf1eSheetView(a).derived.attacks[0];
    expect(attack).toMatchObject({
      name: "Longsword",
      attackBonuses: [9, 4],
      damageDice: "1d8",
      damageBonus: 6,
      abilityDamage: 4,
      critThreatMin: 19,
    });
    expect(pf1eAttackEditorView(a).rows[0]?.damageBonus).toBe(2);
    expect(start.system.pf1e).toEqual({ abilities: { str: 16, dex: 14 }, baseAttack: 6 });
    const removed = apply(
      a,
      pf1eAttackEdit(a, owner, {
        kind: "remove",
        index: 0,
        expected: pf1eAttackEditorView(a).rows,
      }),
    );
    expect(pf1eAttackEditorView(removed).rows).toEqual([]);
    expect(pf1eSheetView(removed).derived.attacks[0]?.name).toBe("Unarmed strike");
  });
  test("every shipped weapon retains raw fields and derived math on first tactical materialization", () => {
    const pack = JSON.parse(
      readFileSync(
        new URL("../../systems/pf1e-core/packs/bestiary.json", import.meta.url),
        "utf8",
      ),
    );
    expect(pack.entries).toHaveLength(6);
    for (const entry of pack.entries) {
      const a = {
        ...actor(),
        ...entry.data,
        ownership: { default: 2, player: 3 },
      } as ActorDocument;
      const before = structuredClone(a);
      const view = pf1eAttackEditorView(a);
      expect(view.rows).toHaveLength(1);
      const dice = view.rows[0]?.damageDice;
      if (typeof dice !== "string") throw new Error("Expected weapon dice fixture");
      const next = set(a, "damageDice", dice);
      expect(pf1eSheetView(next).derived.attacks).toEqual(pf1eSheetView(a).derived.attacks);
      expect((next.system.pf1e as Record<string, Json>).weapon).toEqual(
        (a.system.pf1e as Record<string, Json>).weapon,
      );
      expect(a).toEqual(before);
      const removed = apply(
        next,
        pf1eAttackEdit(next, owner, {
          kind: "remove",
          index: 0,
          expected: pf1eAttackEditorView(next).rows,
        }),
      );
      expect(pf1eAttackEditorView(removed).rows).toEqual([]); // does not reactivate the legacy weapon
    }
  });
  test("narrow field Ops preserve other attacks and unknown metadata", () => {
    const rows = [
      { name: "Bite", natural: true, custom: { poison: "prose" } },
      { name: "Claw", damageDice: "1d4" },
    ];
    const a = actor({ attacks: rows, weapon: { isFirearm: true, material: "silver" } });
    const result = pf1eAttackEdit(a, owner, {
      kind: "set",
      index: 1,
      field: "damageBonus",
      value: "-2",
      expected: rows,
    });
    expect(result.ops).toEqual([
      {
        kind: "update",
        ref: { coll: "actors", id: "hero" },
        diff: { "system.pf1e.attacks.1.damageBonus": -2 },
      },
    ]);
    const next = apply(a, result);
    expect(pf1eAttackEditorView(next).rows[0]).toEqual(rows[0]);
    expect(next.system.unrelated).toBe("keep");
    expect((next.system.pf1e as Record<string, Json>).weapon).toEqual({
      isFirearm: true,
      material: "silver",
    });
  });
  test("range is genuinely cleared, natural attacks stop iterating, and included ability damage is not added twice", () => {
    let a = actor({
      abilities: { str: 16, dex: 12 },
      baseAttack: 6,
      attacks: [{ name: "Spear", damageDice: "1d8", damageBonus: 3, rangeIncrementFt: 20 }],
    });
    expect(pf1eSheetView(a).derived.attacks[0]?.ranged).toBe(true);
    a = set(a, "rangeIncrementFt", "");
    expect(pf1eAttackEditorView(a).rows[0]).not.toHaveProperty("rangeIncrementFt");
    expect(pf1eSheetView(a).derived.attacks[0]?.ranged).toBe(false);
    a = set(a, "natural", true);
    expect(pf1eSheetView(a).derived.attacks[0]?.attackBonuses).toEqual([9]);
    a = set(a, "abilityDamageIncluded", true);
    expect(pf1eSheetView(a).derived.attacks[0]?.damageBonus).toBe(3);
    a = set(a, "critMultiplier", "4");
    a = set(a, "critMultiplier", "");
    expect(pf1eSheetView(a).derived.attacks[0]?.critMultiplier).toBe(2);
  });
  test("stale list/index, malformed imports, structured fields and oversize lists are rejected", () => {
    const a = actor({ attacks: [{ name: "Sword", damageDice: { unsupported: true } }] });
    const rows = pf1eAttackEditorView(a).rows;
    expect(
      pf1eAttackEdit(a, owner, { kind: "remove", index: 0, expected: [] }).error,
    ).toContain("changed");
    expect(
      pf1eAttackEdit(a, owner, { kind: "remove", index: -1, expected: rows }).error,
    ).toContain("exists");
    expect(
      pf1eAttackEdit(a, owner, {
        kind: "set",
        index: 0,
        field: "damageDice",
        value: "1d6",
        expected: rows,
      }).error,
    ).toContain("structured");
    for (const block of [{ attacks: "bad" }, { attacks: [null] }, { weapon: 7 }]) {
      const bad = actor(block);
      expect(pf1eAttackEdit(bad, owner, { kind: "add", expected: [] }).ops).toEqual([]);
    }
    const full = actor({
      attacks: Array.from({ length: MAX_SHEET_ATTACKS }, () => ({ name: "Attack" })),
    });
    expect(
      pf1eAttackEdit(full, owner, { kind: "add", expected: pf1eAttackEditorView(full).rows })
        .error,
    ).toContain("100");
  });
  test("validates bounds, dice shape, types and field allowlist; never authors derived totals", () => {
    const a = actor({ attacks: [{}] });
    for (const [field, value] of [
      ["damageDice", "1d8+3"],
      ["damageDice", "101d6"],
      ["damageDice", "1d1"],
      ["damageDice", "1d1001"],
      ["damageBonus", "Infinity"],
      ["damageBonus", "1.5"],
      ["critThreatMin", "21"],
      ["critThreatMin", "0"],
      ["critMultiplier", "5"],
      ["rangeIncrementFt", "0"],
      ["reachSquares", "-1"],
      ["ranged", "true"],
      ["attackBonuses", "9"],
      ["__proto__.x", "0"],
      ["name", "x".repeat(201)],
    ]) {
      expect(
        pf1eAttackEdit(a, owner, {
          kind: "set",
          index: 0,
          field: field ?? "",
          value: value ?? "",
          expected: [{}],
        }).ops,
      ).toEqual([]);
    }
    expect(
      pf1eAttackEdit(a, owner, {
        kind: "set",
        index: 0,
        field: "damageDice",
        value: "100d1000",
        expected: [{}],
      }).error,
    ).toBeNull();
  });
  test("all operations enforce owner permissions", () => {
    const a = actor({ attacks: [{}] });
    const edits: AttackEdit[] = [
      { kind: "add", expected: [{}] },
      { kind: "remove", index: 0, expected: [{}] },
      { kind: "set", index: 0, field: "name", value: "Private", expected: [{}] },
    ];
    for (const edit of edits)
      for (const user of [null, { id: "other", role: "PLAYER" as const }])
        expect(pf1eAttackEdit(a, user, edit).ops).toEqual([]);
  });
});

describe("P1 defensive authored-value plumbing", () => {
  test("canonical numeric DR/regeneration survive normalization alone and mixed with stat-block aliases", () => {
    for (const raw of [
      { dr: 5, regeneration: 3 },
      { hp: 10, bab: 6, dr: 5, regeneration: 3 },
    ]) {
      const normalized = normalizePF1eSystem(raw).system;
      expect(normalized).toMatchObject({ dr: 5, regeneration: 3 });
      expect(normalizePF1eSystem(normalized).system).toEqual(normalized);
      expect(pf1eSheetView(actor(raw)).derived).toMatchObject({ dr: 5, regeneration: 3 });
    }
  });
  test("defense edits use canonical fields or preserve imported objects and their unknown properties", () => {
    const a = actor({
      dr: { val: 5, bypass: ["silver"], custom: "keep" },
      regeneration: { value: 3, suppress: ["fire"], custom: "keep" },
      sr: 12,
    });
    let next = apply(a, pf1eSheetEdit(a, owner, "dr", "7"));
    next = apply(next, pf1eSheetEdit(next, owner, "regeneration", "4"));
    next = apply(next, pf1eSheetEdit(next, owner, "spellResistance", "15"));
    next = apply(next, pf1eSheetEdit(next, owner, "fastHealing", "2"));
    expect(pf1eSheetView(next).derived).toMatchObject({
      dr: 7,
      drBypass: ["silver"],
      regeneration: 4,
      regenerationSuppress: ["fire"],
      spellResistance: 15,
      fastHealing: 2,
    });
    expect((next.system.pf1e as Record<string, Json>).dr).toEqual({
      val: 7,
      bypass: ["silver"],
      custom: "keep",
    });
    expect((next.system.pf1e as Record<string, Json>).regeneration).toEqual({
      value: 4,
      suppress: ["fire"],
      custom: "keep",
    });
    expect(authoredNumber(next, "dr")).toBe(7);
    expect(pf1eSheetEdit(a, owner, "dr", "-1").ops).toEqual([]);
  });
});
