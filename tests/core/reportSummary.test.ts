import { describe, expect, test } from "vitest";
import { distributionsToJson, summarizeDistributions } from "../../src/core/reportSummary";
import type { SimEvent } from "../../src/core/sim";

function ev(partial: Partial<SimEvent>): SimEvent {
  return {
    subPhase: "melee",
    type: "attack",
    unitId: "u1",
    text: "",
    ...partial,
  };
}

describe("summarizeDistributions (§11)", () => {
  test("aggregates by type/sub-phase, damage per unit, rout histogram", () => {
    const events: SimEvent[] = [
      ev({ subPhase: "move", type: "move", unitId: "uA", text: "moves" }),
      ev({ unitId: "uA", targetUnitId: "uB", data: { attackers: 10, hits: 4, wounds: 2 } }),
      ev({ unitId: "uB", targetUnitId: "uA", data: { attackers: 8, hits: 3, wounds: 3 } }),
      ev({ unitId: "uA", targetUnitId: "uB", data: { attackers: 10, hits: 1, wounds: 1 } }),
      ev({ subPhase: "morale", type: "rout", unitId: "uB", data: { roll: 5, lossFrac: 0.4 } }),
      ev({ subPhase: "morale", type: "rout", unitId: "uC", data: { roll: 5 } }),
      ev({ subPhase: "supply", type: "attrition", unitId: "uC" }),
    ];
    const d = summarizeDistributions(events);
    expect(d.byType).toEqual({ move: 1, attack: 3, rout: 2, attrition: 1 });
    expect(d.bySubPhase.melee).toBe(3);
    expect(d.totals).toEqual({ hits: 8, wounds: 6, attacks: 3, attrition: 1, routs: 2 });
    // uA dealt 3 wounds, uB 3 wounds — tie broken by hits (uA 5 > uB 3)
    expect(d.damageByUnit[0]?.unitId).toBe("uA");
    expect(d.damageByUnit).toHaveLength(2);
    expect(d.routRolls).toEqual({ "5": 2 });
    // Json round-trip safe
    const json = distributionsToJson(d);
    expect(JSON.parse(JSON.stringify(json))).toBeTruthy();
  });

  test("non-numeric/missing data contributes zeros, never throws", () => {
    const d = summarizeDistributions([
      ev({ unitId: "uA", data: { hits: "many" } }),
      ev({ unitId: "uA" }),
    ]);
    expect(d.totals.attacks).toBe(2);
    expect(d.totals.hits).toBe(0);
    expect(d.damageByUnit[0]).toEqual({ unitId: "uA", hits: 0, wounds: 0, attacks: 0 });
  });

  test("top-N caps at 6 units sorted by wounds", () => {
    const events: SimEvent[] = [];
    for (let i = 0; i < 9; i++) {
      events.push(ev({ unitId: `u${i}`, data: { hits: 1, wounds: i } }));
    }
    const d = summarizeDistributions(events);
    expect(d.damageByUnit).toHaveLength(6);
    expect(d.damageByUnit[0]?.unitId).toBe("u8");
    expect(d.damageByUnit.map((u) => u.wounds)).toEqual([8, 7, 6, 5, 4, 3]);
  });
});
