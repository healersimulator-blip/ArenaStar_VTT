import { describe, expect, test } from "vitest";
import {
  deadlyAimStep,
  featAttackParts,
  featDamageParts,
  featDefenseParts,
  hasPF1eFeat,
  improvedCriticalApplies,
  validatePF1eFeatSelection,
  offHandAttackCount,
  manyshotPlan,
  powerAttackStep,
} from "../../src/packages/pf1e/feats";

describe("PF1e A07 feat arithmetic", () => {
  test("normalizes pack feat spelling without treating a missing feat as active", () => {
    expect(hasPF1eFeat(["power_attack"], "Power Attack")).toBe(true);
    expect(hasPF1eFeat(["Power Attack"], "Deadly Aim")).toBe(false);
  });

  test("Power Attack and Deadly Aim scale at BAB breakpoints", () => {
    expect(powerAttackStep(3)).toBe(1);
    expect(powerAttackStep(4)).toBe(2);
    expect(powerAttackStep(20)).toBe(5);
    expect(deadlyAimStep(8)).toBe(3);
    expect(powerAttackStep(0)).toBe(0);
    expect(featAttackParts({ feats: ["Power Attack"], bab: 8, ranged: false, powerAttack: true })).toEqual([
      { label: "Power Attack", value: -3 },
    ]);
    expect(featDamageParts({ feats: ["Power Attack"], bab: 8, ranged: false, powerAttack: true, twoHanded: true })).toEqual([
      { label: "Power Attack damage", value: 9 },
    ]);
  });

  test("stances are explicit and defensive bonuses are separate from attack penalties", () => {
    expect(featAttackParts({ feats: ["Combat Expertise"], bab: 12, ranged: false })).toEqual([]);
    expect(featAttackParts({ feats: ["Combat Expertise"], bab: 12, ranged: false, combatExpertise: true })).toEqual([
      { label: "Combat Expertise", value: -4 },
    ]);
    expect(featDefenseParts({ fightingDefensively: true })).toEqual([
      { label: "fighting defensively AC", value: 2 },
    ]);
    expect(featDefenseParts({ totalDefense: true, fightingDefensively: true })).toEqual([
      { label: "total defense", value: 4 },
    ]);
  });

  test("Point-Blank Shot has its 30-foot boundary and weapon feats are scoped", () => {
    expect(featAttackParts({ feats: ["Point-Blank Shot"], bab: 1, ranged: true, pointBlankShot: true, distanceFt: 30 })).toEqual([
      { label: "Point-Blank Shot", value: 1 },
    ]);
    expect(featAttackParts({ feats: ["Point-Blank Shot"], bab: 1, ranged: true, pointBlankShot: true, distanceFt: 35 })).toEqual([]);
    expect(improvedCriticalApplies({ feats: ["Improved Critical (longsword)"], weaponName: "longsword" })).toBe(true);
    expect(improvedCriticalApplies({ feats: ["Improved Critical (longsword)"], weaponName: "rapier" })).toBe(false);
  });

  test("prerequisite warnings preserve authored selections", () => {
    expect(validatePF1eFeatSelection(["Manyshot", "Precise Shot"], {
      bab: 6,
      abilities: { dex: 15, int: 10, str: 10 },
    })).toEqual([
      "Precise Shot: unmet prerequisite (Point-Blank Shot)",
      "Manyshot: unmet prerequisite (Dex 17, BAB +6, Point-Blank Shot, and Rapid Shot)",
    ]);
  });

  test("the Two-Weapon Fighting tree adds the correct off-hand attacks", () => {
    expect(offHandAttackCount(["Two-Weapon Fighting"])).toBe(1);
    expect(offHandAttackCount(["Improved Two-Weapon Fighting"])).toBe(2);
    expect(offHandAttackCount(["Greater Two-Weapon Fighting"])).toBe(3);
  });

  test("Manyshot produces a standard-action volley at the first bonus", () => {
    expect(manyshotPlan({ feats: ["Manyshot"], bab: 6, ranged: true })).toEqual({
      ok: true,
      arrows: 2,
      attackPenalty: -4,
    });
    expect(manyshotPlan({ feats: ["Manyshot"], bab: 16, ranged: true })).toEqual({
      ok: true,
      arrows: 4,
      attackPenalty: -4,
    });
    expect(manyshotPlan({ feats: ["Manyshot"], bab: 6, ranged: false })).toEqual({
      ok: false,
      reason: "Manyshot requires a ranged attack",
    });
  });
});
