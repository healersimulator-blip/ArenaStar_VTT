/**
 * P7/H01/D-206 — coup de grâce plan (full-round, provokes, auto hit & crit,
 * Fort DC 10+damage, crit immune waives).
 */
import { describe, expect, test } from "vitest";
import type { ActorDocument } from "../../src/core/documents";
import { planCoupGrace } from "../../src/ui/combat/pf1eCoupGrace";

const defender = (pf1e: Record<string, unknown> = {}): ActorDocument => ({
  _id: "victim",
  type: "actor",
  name: "Victim",
  ownership: { default: 3 },
  flags: {},
  items: [],
  effects: [],
  system: { pf1e: { hp: -1, abilities: { con: 12 }, conditions: ["Helpless"], ...pf1e } },
});

describe("D-206 — coup de grâce plan", () => {
  test("survives when Fort save made, dies when failed", () => {
    const survived = planCoupGrace({
      attackerName: "Attacker",
      defender: defender(),
      damageDealt: 8,
      saveDie: 18,
      fortBonus: 2,
      conScore: 12,
    });
    expect(survived.ok).toBe(true);
    if (survived.ok) {
      expect(survived.plan.dead).toBe(false);
      expect(survived.plan.ops[0]).toMatchObject({ diff: { "system.pf1e.hp": -9 } });
      expect(survived.plan.note).toContain("survives the coup");
    }

    const died = planCoupGrace({
      attackerName: "Attacker",
      defender: defender(),
      damageDealt: 8,
      saveDie: 2,
      fortBonus: 0,
      conScore: 12,
    });
    expect(died.ok).toBe(true);
    if (died.ok) {
      expect(died.plan.dead).toBe(true);
      expect(died.plan.ops[0]).toMatchObject({ diff: { "system.pf1e.hp": -12 } });
      expect(died.plan.note).toContain("dies to the coup");
    }
  });

  test("damage alone kills — save is moot but still recorded", () => {
    const victim = defender({ hp: 1 });
    const r = planCoupGrace({
      attackerName: "Attacker",
      defender: victim,
      damageDealt: 20,
      saveDie: 20,
      fortBonus: 10,
      conScore: 10,
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.plan.dead).toBe(true);
      expect(r.plan.ops[0]).toMatchObject({ diff: { "system.pf1e.hp": -19 } });
      expect(r.plan.note).toContain("damage alone killed");
    }
  });

  test("crit immune waives save, missing saveDie refuses", () => {
    const immune = planCoupGrace({
      attackerName: "Attacker",
      defender: defender(),
      damageDealt: 8,
      saveDie: 1,
      fortBonus: 0,
      conScore: 12,
      critImmune: true,
    });
    expect(immune.ok).toBe(true);
    if (immune.ok) {
      expect(immune.plan.note).toContain("immune to critical");
      expect(immune.plan.ops[0]).toMatchObject({ diff: { "system.pf1e.hp": -9 } });
      expect(immune.plan.dead).toBe(false);
    }

    const missing = planCoupGrace({
      attackerName: "Attacker",
      defender: defender(),
      damageDealt: 8,
      // saveDie omitted
      fortBonus: 2,
      conScore: 12,
    });
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.error).toContain("Fortitude save");
  });
});
