/**
 * P7/H03/D-206 — rest plan (natural recovery, AoN 170 / CRB p.191).
 * 1 HP/level per night, 2× bed rest, 2× long-term care; ability damage 1/2× similarly; drain never heals.
 */
import { describe, expect, test } from "vitest";
import type { ActorDocument } from "../../src/core/documents";
import { planRest, restLevelOf } from "../../src/ui/combat/pf1eRest";

const actor = (pf1e: Record<string, unknown> = {}): ActorDocument => ({
  _id: "hero",
  type: "actor",
  name: "Hero",
  ownership: { default: 3 },
  flags: {},
  items: [],
  effects: [],
  system: { pf1e: { hp: 4, hpMax: 10, ...pf1e } },
});

describe("D-206 — natural recovery rest plan", () => {
  test("restLevelOf falls back to 1 when hitDice missing", () => {
    expect(restLevelOf(actor({}))).toBe(1);
    expect(restLevelOf(actor({ hitDice: 4 }))).toBe(4);
    expect(restLevelOf(actor({ hitDice: 0 }))).toBe(1);
  });

  test("a night rest recovers 1 per level, capped at hpMax", () => {
    const plan = planRest({ actor: actor({ hp: 4, hpMax: 10, hitDice: 3 }), level: 3, bedRest: false, longTermCare: false });
    expect(plan.ops).toEqual([{ kind: "update", ref: { coll: "actors", id: "hero" }, diff: { "system.pf1e.hp": 7 } }]);
    expect(plan.note).toContain("3 HP");
    const capped = planRest({ actor: actor({ hp: 9, hpMax: 10 }), level: 3, bedRest: false, longTermCare: false });
    expect(capped.ops[0]).toMatchObject({ diff: { "system.pf1e.hp": 10 } });
    const full = planRest({ actor: actor({ hp: 10, hpMax: 10 }), level: 3, bedRest: false, longTermCare: false });
    expect(full.ops.find((o) => (o as unknown as { diff: Record<string, unknown> }).diff["system.pf1e.hp"] !== undefined)).toBeUndefined();
  });

  test("bed rest and long-term care double as expected", () => {
    const bed = planRest({ actor: actor({ hp: 0, hpMax: 20 }), level: 2, bedRest: true, longTermCare: false });
    expect(bed.ops[0]).toMatchObject({ diff: { "system.pf1e.hp": 4 } });
    const care = planRest({ actor: actor({ hp: 0, hpMax: 20 }), level: 2, bedRest: false, longTermCare: true });
    expect(care.ops[0]).toMatchObject({ diff: { "system.pf1e.hp": 4 } });
    const both = planRest({ actor: actor({ hp: 0, hpMax: 20 }), level: 2, bedRest: true, longTermCare: true });
    expect(both.ops[0]).toMatchObject({ diff: { "system.pf1e.hp": 8 } });
  });

  test("ability damage recovers 1 per night (2 bed, ×2 care) and deletes zeroed entries", () => {
    const night = planRest({ actor: actor({ hp: 10, hpMax: 10, abilitiesDamage: { str: 1, dex: 2 } }), level: 1, bedRest: false, longTermCare: false });
    const dmgOps = night.ops.filter((o) => Object.keys((o as unknown as { diff: Record<string, unknown> }).diff).some((k) => k.includes("abilitiesDamage")));
    expect(dmgOps.length).toBe(1);
    const diff = (dmgOps[0] as unknown as { diff: Record<string, unknown> }).diff;
    expect(diff["-=system.pf1e.abilitiesDamage.str"]).toBeNull();
    expect(diff["system.pf1e.abilitiesDamage.dex"]).toBe(1);

    const bedRest = planRest({ actor: actor({ hp: 10, hpMax: 10, abilitiesDamage: { str: 3 } }), level: 1, bedRest: true, longTermCare: false });
    const bedDiff = (bedRest.ops.find((o) => Object.keys((o as unknown as { diff: Record<string, unknown> }).diff).some((k) => k.includes("abilitiesDamage"))) as unknown as { diff: Record<string, unknown> }).diff;
    expect(bedDiff["system.pf1e.abilitiesDamage.str"]).toBe(1);

    const withCare = planRest({ actor: actor({ hp: 10, hpMax: 10, abilitiesDamage: { str: 3 } }), level: 1, bedRest: false, longTermCare: true });
    const careDiff = (withCare.ops.find((o) => Object.keys((o as unknown as { diff: Record<string, unknown> }).diff).some((k) => k.includes("abilitiesDamage"))) as unknown as { diff: Record<string, unknown> }).diff;
    expect(careDiff["system.pf1e.abilitiesDamage.str"]).toBe(1);
  });

  test("drain never heals via rest", () => {
    const plan = planRest({ actor: actor({ hp: 5, hpMax: 10, abilitiesDrain: { str: 2 } }), level: 1, bedRest: true, longTermCare: true });
    const drainKeys = plan.ops.flatMap((o) => Object.keys((o as unknown as { diff: Record<string, unknown> }).diff)).filter((k) => k.includes("abilitiesDrain"));
    expect(drainKeys.length).toBe(0);
  });
});
