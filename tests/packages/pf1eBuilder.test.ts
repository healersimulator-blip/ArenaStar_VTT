import { describe, expect, it } from "vitest";
import {
  calculatePointBuyTotal,
  PF1E_POINT_BUY_COSTS,
  PF1E_CORE_RACES,
  PF1E_CORE_CLASSES,
  aggregateClassProgression,
  calculateSkillPointsPerLevel,
} from "../../src/packages/pf1e/builder";

describe("PF1e Character Builder & Progression (G-02 / T2, T4)", () => {
  it("calculates point buy costs correctly per CRB Table 1-1", () => {
    expect(PF1E_POINT_BUY_COSTS[10]).toBe(0);
    expect(PF1E_POINT_BUY_COSTS[14]).toBe(5);
    expect(PF1E_POINT_BUY_COSTS[18]).toBe(17);
    expect(PF1E_POINT_BUY_COSTS[7]).toBe(-4);

    // Standard 15 point buy example: 14, 14, 13, 12, 10, 10
    // Costs: 5 + 5 + 3 + 2 + 0 + 0 = 15
    const total = calculatePointBuyTotal({
      str: 14,
      dex: 14,
      con: 13,
      int: 12,
      wis: 10,
      cha: 10,
    });
    expect(total).toBe(15);
  });

  it("provides definitions for Core Races and Classes", () => {
    expect(PF1E_CORE_RACES.length).toBe(7);
    const elf = PF1E_CORE_RACES.find((r) => r.id === "elf");
    expect(elf?.abilityMods.dex).toBe(2);
    expect(elf?.abilityMods.con).toBe(-2);
    expect(elf?.abilityMods.int).toBe(2);

    expect(PF1E_CORE_CLASSES.length).toBe(11);
    const fighter = PF1E_CORE_CLASSES.find((c) => c.id === "fighter");
    expect(fighter?.hitDie).toBe(10);
    expect(fighter?.babProgression).toBe("good");
    expect(fighter?.goodSaves).toEqual(["fort"]);
    expect(fighter?.skillPointsPerLevel).toBe(2);
  });

  it("aggregates multiclass progression accurately (T2)", () => {
    // Fighter 3 (good BAB = 3, good Fort = 2 + 1 = 3, poor Ref/Will = 1)
    // Rogue 2 (avg BAB = 1, poor Fort/Will = 1, good Ref = 2 + 1 = 3)
    // Total Level: 5, BAB: 4, Fort: 4, Ref: 4, Will: 2
    const res = aggregateClassProgression([
      { classId: "fighter", level: 3 },
      { classId: "rogue", level: 2 },
    ]);

    expect(res.totalLevel).toBe(5);
    expect(res.hitDice).toBe(5);
    expect(res.bab).toBe(4); // 3 (Ftr 3) + 1 (Rog 2)
    expect(res.baseSaves.fort).toBe(4); // 3 (Ftr) + 1 (Rog)
    expect(res.baseSaves.ref).toBe(4); // 1 (Ftr) + 3 (Rog)
    expect(res.baseSaves.will).toBe(2); // 1 (Ftr) + 1 (Rog)
  });

  it("computes skill points per level with Int modifier and Human bonus", () => {
    const rogue = PF1E_CORE_CLASSES.find((c) => c.id === "rogue");
    expect(rogue).toBeDefined();
    if (!rogue) return;
    // Rogue base = 8, Int mod +2 => 10 points
    expect(calculateSkillPointsPerLevel(rogue, 2, false)).toBe(10);
    // Human rogue with Int mod +2 => 11 points
    expect(calculateSkillPointsPerLevel(rogue, 2, true)).toBe(11);
    // Fighter base = 2, Int mod -3 (penalty) => min 1 point per level!
    const fighter = PF1E_CORE_CLASSES.find((c) => c.id === "fighter");
    expect(fighter).toBeDefined();
    if (!fighter) return;
    expect(calculateSkillPointsPerLevel(fighter, -3, false)).toBe(1);
  });
});
