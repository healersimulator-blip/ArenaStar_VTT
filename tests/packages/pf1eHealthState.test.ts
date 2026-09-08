import { describe, expect, test } from "vitest";
import type { ActorDocument, Json } from "../../src/core/documents";
import { applyDiff } from "../../src/core/diff";
import { readPF1eHealth } from "../../src/packages/pf1e/healthState";
import { derivePF1eActor } from "../../src/packages/pf1e/actor";
import { pf1eSheetEdit, pf1eSheetView } from "../../src/ui/sheets/pf1eSheetModel";
const owner = { id: "p", role: "PLAYER" as const };
function actor(raw: Record<string, Json>): ActorDocument {
  return {
    _id: "hero",
    type: "actor",
    name: "Hero",
    ownership: { default: 2, p: 3 },
    flags: {},
    system: { pf1e: raw },
    items: [],
    effects: [],
  };
}
describe("P1 manual health/defense contracts", () => {
  /** @srd Injury and Death > Temporary Hit Points (CRB p.191, aonprd Rules ID=171). */
  test("temporary HP stay separate from current/max HP and Constitution changes", () => {
    const base = { hp: 7, hpMax: 20, tempHp: 8, abilities: { con: 14 } };
    const before = structuredClone(base);
    const d = derivePF1eActor({ system: base });
    expect(d).toMatchObject({ hp: 7, hpMax: 20, tempHp: 8 });
    expect(
      derivePF1eActor({ system: { ...base, hp: 3, abilities: { con: 18 } } }),
    ).toMatchObject({ hp: 3, hpMax: 20, tempHp: 8 });
    expect(base).toEqual(before); // no absorption, expiry or Con-HP automation in this slice
  });
  /** @srd Special Abilities > Energy Resistance: type/value pair, not a temporary HP pool. */
  test("energy resistance remains per-type, not stacked or consumed by a read", () => {
    const raw = { hp: 12, energyResistance: { fire: 10, cold: 5 } };
    const d = derivePF1eActor({ system: raw });
    expect(d.energyResistance).toEqual({
      acid: 0,
      cold: 5,
      electricity: 0,
      fire: 10,
      sonic: 0,
    });
    expect(d.hp).toBe(12);
    expect(derivePF1eActor({ system: raw }).energyResistance).toEqual(d.energyResistance);
    expect(raw.energyResistance).toEqual({ fire: 10, cold: 5 });
  });
  test("malformed and unsupported imports are reported without mutation", () => {
    const raw = {
      tempHp: -1,
      energyResistance: { fire: "10", cold: -2, sonic: 2.5, force: 9 },
    };
    const before = structuredClone(raw);
    const d = readPF1eHealth(raw);
    expect(d.tempHp).toBe(0);
    expect(Object.values(d.energyResistance)).toEqual([0, 0, 0, 0, 0]);
    expect(d.issues).toHaveLength(5);
    expect(raw).toEqual(before);
    expect(readPF1eHealth({ energyResistance: [10] }).issues).toHaveLength(1);
    expect(readPF1eHealth({ tempHp: Infinity }).issues).toHaveLength(1);
  });
  test("editor Ops materialize first resistance group, preserve siblings, and never change real HP", () => {
    let a = actor({ hp: 7, hpMax: 20 });
    for (const [field, value] of [
      ["tempHp", "8"],
      ["energyResistance.fire", "10"],
      ["energyResistance.cold", "5"],
    ] as const) {
      const result = pf1eSheetEdit(a, owner, field, value);
      expect(result.error).toBeNull();
      for (const op of result.ops) {
        if (op.kind !== "update") throw new Error("Expected update");
        const next = applyDiff(a, op.diff);
        if (!next.ok) throw new Error(next.error);
        a = next.value;
      }
    }
    expect(pf1eSheetView(a).derived).toMatchObject({
      hp: 7,
      hpMax: 20,
      tempHp: 8,
      energyResistance: { fire: 10, cold: 5 },
    });
    expect(pf1eSheetEdit(a, owner, "tempHp", "-1").ops).toEqual([]);
    expect(pf1eSheetEdit(a, owner, "energyResistance.fire", "-1").ops).toEqual([]);
    expect(pf1eSheetEdit(a, { id: "other", role: "PLAYER" }, "tempHp", "9").ops).toEqual([]);
    expect(
      pf1eSheetEdit(actor({ energyResistance: [10] }), owner, "energyResistance.fire", "10")
        .ops,
    ).toEqual([]);
    expect(
      pf1eSheetEdit(actor({ tempHp: { source: "spell" } }), owner, "tempHp", "10").ops,
    ).toEqual([]);
  });
});
