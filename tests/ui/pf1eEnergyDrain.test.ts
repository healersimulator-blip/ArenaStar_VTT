/**
 * P7/H04/D-207 — negative-level planners (inflict / restoration / 24h save) as ops.
 */
import { describe, expect, test } from "vitest";
import type { ActorDocument } from "../../src/core/documents";
import { planEnergyDrainInflict, planNegativeLevelSave, planRestoration } from "../../src/ui/combat/pf1eEnergyDrain";

const actor = (id: string, pf1e: Record<string, unknown> = {}): ActorDocument =>
  ({
    _id: id,
    type: "actor",
    name: id,
    ownership: { default: 3 },
    flags: {},
    items: [],
    effects: [],
    system: { pf1e: pf1e as unknown as Record<string, import("../../src/core/documents").Json> },
  }) as unknown as ActorDocument;

describe("D-207 — planEnergyDrainInflict", () => {
  test("produces an update op for system.pf1e.negativeLevels and prefixes the note with the attacker", () => {
    const defender = actor("hero", {});
    const res = planEnergyDrainInflict({ defender, count: 2, kind: "temporary", attackerName: "Wight" });
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("failed");
    expect(res.plan.ops[0]).toMatchObject({ kind: "update", ref: { coll: "actors", id: "hero" } });
    const diff = (res.plan.ops[0] as unknown as { diff: Record<string, unknown> }).diff;
    expect(diff["system.pf1e.negativeLevels"]).toEqual({ temporary: 2 });
    expect(res.plan.note).toContain("Wight");
    expect(res.plan.note).toContain("2 temporary");
  });

  test("merges onto existing levels", () => {
    const defender = actor("hero", { negativeLevels: { permanent: 1 } });
    const res = planEnergyDrainInflict({ defender, count: 1, kind: "temporary" });
    if (!res.ok) throw new Error("failed");
    const diff = (res.plan.ops[0] as unknown as { diff: Record<string, unknown> }).diff;
    expect(diff["system.pf1e.negativeLevels"]).toEqual({ temporary: 1, permanent: 1 });
  });

  test("validates count", () => {
    const res = planEnergyDrainInflict({ defender: actor("hero"), count: 0, kind: "temporary" });
    expect(res.ok).toBe(false);
  });
});

describe("D-207 — planRestoration", () => {
  test("any removes temporary first, then permanent; delete marker when empty", () => {
    const a = actor("hero", { negativeLevels: { temporary: 1 } });
    const res = planRestoration({ actor: a, count: 1 });
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("failed");
    const diff = (res.plan.ops[0] as unknown as { diff: Record<string, unknown> }).diff;
    expect(diff["-=system.pf1e.negativeLevels"]).toBeNull();
    expect(res.plan.note).toContain("none remain");
    expect(res.plan.note).toContain("restoration");
  });

  test("kind filter surfaces named errors", () => {
    const a = actor("hero", { negativeLevels: { temporary: 1 } });
    const res = planRestoration({ actor: a, count: 1, kind: "permanent" });
    expect(res.ok).toBe(false);
  });
});

describe("D-207 — planNegativeLevelSave", () => {
  test("temporary success produces an op; temporary failure produces no ops (another save tomorrow)", () => {
    const hero = actor("hero", { negativeLevels: { temporary: 1 } });
    const success = planNegativeLevelSave({ actor: hero, kind: "temporary", die: 18, fortBonus: 5, dc: 15 });
    expect(success.ok).toBe(true);
    if (!success.ok) throw new Error("failed");
    expect(success.plan.ops.length).toBe(1);
    const diff = (success.plan.ops[0] as unknown as { diff: Record<string, unknown> }).diff;
    expect(diff["-=system.pf1e.negativeLevels"]).toBeNull();

    const failure = planNegativeLevelSave({ actor: hero, kind: "temporary", die: 5, fortBonus: 0, dc: 15 });
    if (!failure.ok) throw new Error("failed");
    expect(failure.plan.ops.length).toBe(0);
    expect(failure.plan.note).toContain("a new save comes tomorrow");
  });

  test("energy-drain failure becomes permanent — the op moves the bucket", () => {
    const hero = actor("hero", { negativeLevels: { temporary: 1 } });
    const res = planNegativeLevelSave({ actor: hero, kind: "energy-drain", die: 5, fortBonus: 0, dc: 15 });
    if (!res.ok) throw new Error("failed");
    expect(res.plan.ops.length).toBe(1);
    const diff = (res.plan.ops[0] as unknown as { diff: Record<string, unknown> }).diff;
    expect(diff["system.pf1e.negativeLevels"]).toEqual({ permanent: 1 });
    expect(res.plan.note).toContain("becomes permanent");
  });

  test("validates die", () => {
    const res = planNegativeLevelSave({ actor: actor("hero", { negativeLevels: { temporary: 1 } }), kind: "temporary", die: 22, fortBonus: 0, dc: 10 });
    expect(res.ok).toBe(false);
  });
});
