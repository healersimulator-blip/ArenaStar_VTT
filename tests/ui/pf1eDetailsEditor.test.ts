import { describe, expect, test } from "vitest";
import { readFileSync } from "node:fs";
import type { ActorDocument, Json } from "../../src/core/documents";
import { applyDiff } from "../../src/core/diff";
import {
  armorFieldValue,
  pf1eDetailEdit,
  pf1eSheetEdit,
  pf1eSheetView,
  type DetailEdit,
} from "../../src/ui/sheets/pf1eSheetModel";

const owner = { id: "player", role: "PLAYER" as const };
function actor(pf1e: Record<string, Json> = {}): ActorDocument {
  return {
    _id: "hero",
    type: "actor",
    name: "Hero",
    ownership: { default: 2, player: 3 },
    flags: {},
    system: { pf1e, unrelated: { note: "keep" } },
    items: [],
    effects: [],
  };
}
function apply(a: ActorDocument, result: ReturnType<typeof pf1eDetailEdit>): ActorDocument {
  expect(result.error).toBeNull();
  let next = a;
  for (const op of result.ops) {
    if (op.kind !== "update") throw new Error("Expected update");
    const applied = applyDiff(next, op.diff);
    if (!applied.ok) throw new Error(applied.error);
    next = applied.value;
  }
  return next;
}
function edit(a: ActorDocument, request: DetailEdit): ActorDocument {
  return apply(a, pf1eDetailEdit(a, owner, request));
}

describe("P1 authored detail editors (no new rules)", () => {
  test("first ability/save edits on partial and imported actors produce valid FlatDiff Ops", () => {
    const empty = actor();
    const filled = apply(empty, pf1eSheetEdit(empty, owner, "abilities.str", "18"));
    expect(pf1eSheetView(filled).derived.abilities.str).toBe(18);
    expect(empty.system.pf1e).toEqual({});
    const saved = apply(empty, pf1eSheetEdit(empty, owner, "saves.ref", "3"));
    expect(pf1eSheetView(saved).derived.saves.ref).toBe(3);
    const legacy = actor({ strMod: 3, dexMod: 2, notes: "import" });
    const changed = apply(legacy, pf1eSheetEdit(legacy, owner, "abilities.str", "18"));
    expect(pf1eSheetView(changed).derived.abilities).toMatchObject({ str: 18, dex: 14 });
    expect(changed.system.unrelated).toEqual(legacy.system.unrelated);
    expect((changed.system.pf1e as Record<string, Json>).notes).toBe("import");
  });
  test("all shipped bestiary actors accept a first ability edit without losing their weapon or traits", () => {
    const pack = JSON.parse(
      readFileSync(
        new URL("../../systems/pf1e-core/packs/bestiary.json", import.meta.url),
        "utf8",
      ),
    );
    expect(pack.entries).toHaveLength(6);
    for (const entry of pack.entries) {
      const original = {
        ...actor(),
        ...entry.data,
        ownership: { default: 2, player: 3 },
      } as ActorDocument;
      const next = apply(original, pf1eSheetEdit(original, owner, "abilities.str", "18"));
      expect(pf1eSheetView(next).derived.abilities.str).toBe(18);
      const before = original.system.pf1e as Record<string, Json>;
      const after = next.system.pf1e as Record<string, Json>;
      expect(after.weapon).toEqual(before.weapon);
      expect(after.traits).toEqual(before.traits);
      expect(after.dr).toEqual(before.dr);
    }
  });
  test("armor editors show authored aliases, preserve unrelated components, and support clearing a cap", () => {
    const a = actor({
      abilities: { dex: 16 },
      armorClass: { armor: 5, shield: 0, natural: 0, notes: "custom" },
    });
    expect(armorFieldValue(a, "armor.armorBonus")).toBe(5);
    const armored = edit(a, { kind: "armor", field: "armor.armorBonus", raw: "7" });
    expect(pf1eSheetView(armored).derived.ac).toEqual({
      normal: 20,
      touch: 13,
      flatFooted: 17,
    });
    expect((armored.system.pf1e as Record<string, Json>).armorClass).toEqual(
      (a.system.pf1e as Record<string, Json>).armorClass,
    );
    const capped = edit(armored, { kind: "armor", field: "armor.maxDexBonus", raw: "1" });
    expect(pf1eSheetView(capped).derived.ac).toEqual({ normal: 18, touch: 11, flatFooted: 17 });
    const cleared = edit(capped, { kind: "armor", field: "armor.maxDexBonus", raw: "" });
    expect(pf1eSheetView(cleared).derived.ac).toEqual(pf1eSheetView(armored).derived.ac);
    expect(armorFieldValue(cleared, "armor.maxDexBonus")).toBeNull();
    expect(edit(actor(), { kind: "armor", field: "armor.maxDexBonus", raw: "" })).toEqual(
      actor(),
    );
  });
  test("published AC totals cannot be silently replaced or edited through ineffective components", () => {
    for (const a of [
      actor({ ac: 22, touchAc: 16, flatFootedAc: 17 }),
      actor({ acTotals: { normal: 22, touch: 16, flatFooted: 17 } }),
    ]) {
      const before = structuredClone(a);
      const result = pf1eDetailEdit(a, owner, {
        kind: "armor",
        field: "armor.armorBonus",
        raw: "7",
      });
      expect(result.ops).toEqual([]);
      expect(result.error).toContain("published AC totals");
      expect(pf1eSheetView(a).derived.ac.normal).toBe(22);
      expect(a).toEqual(before);
    }
  });
  test("armor limits and unknown paths are rejected", () => {
    for (const [field, raw] of [
      ["armor.spellFailure", "101"],
      ["armor.checkPenalty", "1"],
      ["armor.armorBonus", "-1"],
      ["armor.armorBonus", ""],
      ["armor.armorBonus", "Infinity"],
      ["armor.armorBonus", "1.2"],
      ["__proto__.value", "1"],
    ]) {
      expect(
        pf1eDetailEdit(actor(), owner, { kind: "armor", field: field ?? "", raw: raw ?? "" })
          .ops,
      ).toEqual([]);
    }
    expect(
      pf1eDetailEdit(actor(), owner, { kind: "armor", field: "armor.checkPenalty", raw: "-3" })
        .error,
    ).toBeNull();
    expect(
      pf1eDetailEdit(actor(), owner, { kind: "armor", field: "armor.spellFailure", raw: "100" })
        .error,
    ).toBeNull();
  });
  test("feats/traits use trimmed lines, preserve other data, and guard stale or structured imports", () => {
    const a = actor({ feats: ["Dodge"], traits: ["Brave"], special: { opaque: 123 } });
    const next = edit(a, {
      kind: "list",
      field: "feats",
      raw: "Dodge\r\nCombat Reflexes\n\n",
      expected: ["Dodge"],
    });
    expect(next.system.pf1e).toEqual({
      feats: ["Dodge", "Combat Reflexes"],
      traits: ["Brave"],
      special: { opaque: 123 },
    });
    expect(
      pf1eDetailEdit(next, owner, {
        kind: "list",
        field: "feats",
        raw: "Toughness",
        expected: ["Dodge"],
      }).error,
    ).toContain("changed");
    const structured = actor({ feats: [{ name: "Dodge", notes: "keep this" }] });
    expect(
      pf1eDetailEdit(structured, owner, {
        kind: "list",
        field: "feats",
        raw: "Dodge",
        expected: [{ name: "Dodge", notes: "keep this" }],
      }).error,
    ).toContain("structured");
    expect(
      pf1eDetailEdit(a, owner, {
        kind: "list",
        field: "traits",
        raw: "x".repeat(201),
        expected: ["Brave"],
      }).ops,
    ).toEqual([]);
    const cleared = edit(a, { kind: "list", field: "traits", raw: "", expected: ["Brave"] });
    expect((cleared.system.pf1e as Record<string, Json>).traits).toEqual([]);
  });
  test("monster details are explicit metadata; editing preserves unrecognized and structured fields", () => {
    const a = edit(actor(), { kind: "monster-start" });
    const named = edit(a, { kind: "monster", field: "cr", raw: " 1/3 ", expected: undefined });
    expect((named.system.pf1e as Record<string, Json>).creature).toEqual({ cr: "1/3" });
    const source = actor({
      creature: {
        cr: 4,
        type: "dragon",
        senses: ["darkvision 60 ft"],
        custom: { habitat: "desert" },
      },
    });
    const changed = edit(source, {
      kind: "monster",
      field: "type",
      raw: "magical beast",
      expected: "dragon",
    });
    expect((changed.system.pf1e as Record<string, Json>).creature).toEqual({
      cr: 4,
      type: "magical beast",
      senses: ["darkvision 60 ft"],
      custom: { habitat: "desert" },
    });
    expect(pf1eDetailEdit(source, owner, { kind: "monster-start" }).ops).toEqual([]);
    expect(
      pf1eDetailEdit(source, owner, {
        kind: "monster",
        field: "senses",
        raw: "blindsight",
        expected: ["darkvision 60 ft"],
      }).error,
    ).toContain("structured");
    expect(
      pf1eDetailEdit(changed, owner, {
        kind: "monster",
        field: "type",
        raw: "humanoid",
        expected: "dragon",
      }).error,
    ).toContain("changed");
  });
  test("all detail operations enforce ownership", () => {
    const requests: DetailEdit[] = [
      { kind: "armor", field: "armor.armorBonus", raw: "5" },
      { kind: "list", field: "feats", raw: "Dodge", expected: undefined },
      { kind: "monster-start" },
      { kind: "monster", field: "cr", raw: "1", expected: undefined },
    ];
    for (const request of requests) {
      expect(pf1eDetailEdit(actor(), null, request).ops).toEqual([]);
      expect(pf1eDetailEdit(actor(), { id: "other", role: "PLAYER" }, request).ops).toEqual([]);
    }
  });
});
