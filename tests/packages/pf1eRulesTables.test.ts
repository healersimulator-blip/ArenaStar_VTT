/**
 * PF1e rules tables — the numbers both scales read. Phase P0 of
 * {@link ../../PF1e_ImplementationPlan.md}; every expected value is transcribed from
 * `PF1e_Combat_Fidelity_GapList.md` Appendix A (d20pfsrd Combat chapter), and the test names carry the
 * appendix section so a future re-read of the SRD points straight at what breaks.
 */
import { describe, expect, test } from "vitest";
import {
  abilityMod,
  acFromBreakdown,
  attacksOfOpportunityPerRound,
  cmbFrom,
  cmdFrom,
  combinedCritMultiplier,
  concentrationDc,
  damageAfterDr,
  damageAfterPenalties,
  defensiveCastingDc,
  isPF1eSize,
  iterativeAttackBonuses,
  normalizeSize,
  sizeEntry,
  sizeSteps,
  spellSaveDc,
} from "../../src/packages/pf1e/rulesTables";

describe("size ladder (A.4/A.5)", () => {
  test("attack and AC use the same size number, Small +1 / Medium 0 / Large −1", () => {
    expect(sizeEntry("Small").attackAc).toBe(1);
    expect(sizeEntry("Medium").attackAc).toBe(0);
    expect(sizeEntry("Large").attackAc).toBe(-1);
    expect(sizeEntry("Fine").attackAc).toBe(8);
    expect(sizeEntry("Colossal").attackAc).toBe(-8);
  });

  test("CMB/CMD run the special size ladder, which is the other direction", () => {
    expect(sizeEntry("Fine").cmbCmd).toBe(-8);
    expect(sizeEntry("Tiny").cmbCmd).toBe(-2);
    expect(sizeEntry("Medium").cmbCmd).toBe(0);
    expect(sizeEntry("Large").cmbCmd).toBe(1);
    expect(sizeEntry("Gargantuan").cmbCmd).toBe(4);
    expect(sizeEntry("Colossal").cmbCmd).toBe(8);
  });

  test("an unknown or missing size is Medium, never a bonus", () => {
    expect(sizeEntry(undefined).attackAc).toBe(0);
    expect(sizeEntry("Huge!").size).toBe("Medium");
    expect(isPF1eSize("Large")).toBe(true);
    expect(isPF1eSize(" huge ")).toBe(true); // authored data is sloppy about case
    expect(isPF1eSize("huge!")).toBe(false);
    expect(normalizeSize("colossal")).toBe("Colossal");
  });

  test("space and reach: Large occupies 4 squares with 2 reach, Tiny has 0 reach", () => {
    expect(sizeEntry("Large").spaceSquares).toBe(4);
    expect(sizeEntry("Large").spaceFeet).toBe(10);
    expect(sizeEntry("Large").reachSquares).toBe(2);
    expect(sizeEntry("Tiny").reachSquares).toBe(0);
    expect(sizeEntry("Tiny").cannotFlank).toBe(true);
    expect(sizeEntry("Tiny").dexToCmb).toBe(true);
    expect(sizeEntry("Medium").dexToCmb).toBe(false);
  });

  test("tiny creatures swarm: 4/25/100 per 5-ft square", () => {
    expect(sizeEntry("Tiny").perSquare).toBe(4);
    expect(sizeEntry("Diminutive").perSquare).toBe(25);
    expect(sizeEntry("Fine").perSquare).toBe(100);
  });

  test("Table 8-4's space column in feet: 1/2, 1, 2-1/2, 5, 5, 10, 15, 20, 30 (AoN 179)", () => {
    // Re-verified against AoN Rules ID 179 on 2026-09-12 (P02): the A.5
    // transcription had Fine at "1½ ft", which the table does not print — a Fine
    // creature is 1/2 ft across, and 100 of them fit in a square.
    expect(sizeEntry("Fine").spaceFeet).toBe(0.5);
    expect(sizeEntry("Diminutive").spaceFeet).toBe(1);
    expect(sizeEntry("Tiny").spaceFeet).toBe(2.5);
    expect(sizeEntry("Small").spaceFeet).toBe(5);
    expect(sizeEntry("Medium").spaceFeet).toBe(5);
    expect(sizeEntry("Huge").spaceFeet).toBe(15);
    expect(sizeEntry("Gargantuan").spaceFeet).toBe(20);
    expect(sizeEntry("Colossal").spaceFeet).toBe(30);
  });

  test("space and reach in squares are the feet column ÷ 5, so Colossal is 6 and not the ladder's 5", () => {
    // 30 ft across is six 5-ft squares on a side (36 occupied), and 30 ft of tall
    // reach is six squares. Large 2, Huge 3, Gargantuan 4 and then 5 would be a
    // "+1 per category" guess the table does not support (P02, D-180).
    expect(sizeEntry("Colossal").spaceSquares).toBe(36);
    expect(sizeEntry("Colossal").reachSquares).toBe(6);
    expect(sizeEntry("Gargantuan").spaceSquares).toBe(16);
    expect(sizeEntry("Huge").spaceSquares).toBe(9);
  });

  test("Table 8-4 prints a long column only for the four multi-square sizes", () => {
    // "Large (long) · 10 ft. · 5 ft.", "Huge (long) · 15 ft. · 10 ft.",
    // "Gargantuan (long) · 20 ft. · 15 ft.", "Colossal (long) · 30 ft. · 20 ft."
    expect(sizeEntry("Large").longReachSquares).toBe(1);
    expect(sizeEntry("Huge").longReachSquares).toBe(2);
    expect(sizeEntry("Gargantuan").longReachSquares).toBe(3);
    expect(sizeEntry("Colossal").longReachSquares).toBe(4);
    // Fine through Medium print one reach figure for both body forms, so there is
    // no second number to read — null, never a copy of the first.
    for (const size of [
      "Fine",
      "Diminutive",
      "Tiny",
      "Small",
      "Medium",
    ] as const) {
      expect(sizeEntry(size).longReachSquares, size).toBeNull();
    }
  });

  test("sizeSteps counts categories, sign showing which is larger", () => {
    expect(sizeSteps("Large", "Medium")).toBe(1);
    expect(sizeSteps("Medium", "Colossal")).toBe(-4);
  });
});

describe("ability modifiers", () => {
  test("floor((score − 10) / 2) in both directions", () => {
    expect(abilityMod(10)).toBe(0);
    expect(abilityMod(11)).toBe(0);
    expect(abilityMod(12)).toBe(1);
    expect(abilityMod(9)).toBe(-1);
    expect(abilityMod(1)).toBe(-5);
    expect(abilityMod(20)).toBe(5);
  });
});

describe("iterative attacks (A.2)", () => {
  test("BAB 11 is +11/+6/+1, BAB 16 is four attacks", () => {
    expect(iterativeAttackBonuses(11)).toEqual([11, 6, 1]);
    expect(iterativeAttackBonuses(16)).toEqual([16, 11, 6, 1]);
  });

  test("the ladder stops at +1 and never adds a zero-th attack", () => {
    expect(iterativeAttackBonuses(5)).toEqual([5]);
    expect(iterativeAttackBonuses(6)).toEqual([6, 1]);
    expect(iterativeAttackBonuses(0)).toEqual([0]);
    expect(iterativeAttackBonuses(-3)).toEqual([0]);
  });
});

describe("armor class composition (A.2)", () => {
  const b = {
    armor: 6,
    shield: 2,
    dex: 4,
    natural: 1,
    dodge: 2,
    misc: 1,
    size: 1,
  };

  test("normal AC counts everything", () => {
    expect(acFromBreakdown(b).normal).toBe(10 + 6 + 2 + 4 + 1 + 1 + 1 + 2);
  });

  test("touch AC drops armor, shield and natural", () => {
    expect(acFromBreakdown(b).touch).toBe(10 + 4 + 1 + 1 + 2);
  });

  test("flat-footed AC drops Dexterity and dodge", () => {
    expect(acFromBreakdown(b).flatFooted).toBe(10 + 6 + 2 + 1 + 1 + 1);
  });

  test("no components is 10 + Dexterity + size, matching the sim's no-breakdown fallback", () => {
    const bare = acFromBreakdown({ dex: 3, size: -1 });
    expect(bare.normal).toBe(12);
    expect(bare.touch).toBe(12);
    expect(bare.flatFooted).toBe(9);
  });
});

describe("combat manœuvres (A.9)", () => {
  test("CMB = BAB + Str + special size, and Dex instead for Tiny or smaller", () => {
    expect(cmbFrom({ bab: 6, strMod: 3, dexMod: 1, size: "Medium" })).toBe(9);
    expect(cmbFrom({ bab: 6, strMod: 3, dexMod: 1, size: "Large" })).toBe(10);
    expect(cmbFrom({ bab: 2, strMod: -2, dexMod: 4, size: "Tiny" })).toBe(4);
  });

  test("CMB honours an authored size modifier when no category is known (stat blocks)", () => {
    expect(
      cmbFrom({
        bab: 6,
        strMod: 3,
        dexMod: 1,
        size: "Medium",
        sizeModOverride: 1,
      }),
    ).toBe(10);
  });

  test("CMD = 10 + BAB + Str + Dex + special size, and loses Dex when flat-footed", () => {
    const cmd = cmdFrom({ bab: 4, strMod: 2, dexMod: 3, size: "Medium" });
    expect(cmd.normal).toBe(10 + 4 + 2 + 3);
    expect(cmd.flatFooted).toBe(10 + 4 + 2);
  });

  test("transferable AC bonuses raise CMD; armor, shield and natural do not", () => {
    const withDodge = cmdFrom({
      bab: 0,
      strMod: 0,
      dexMod: 0,
      size: "Medium",
      acTransfer: 6,
    });
    expect(withDodge.normal).toBe(16);
    // armor/shield/natural are excluded by the caller, which sums only CMD-transferable types
    const armorOnly = cmdFrom({
      bab: 0,
      strMod: 0,
      dexMod: 0,
      size: "Medium",
      acTransfer: 0,
    });
    expect(armorOnly.normal).toBe(10);
  });

  test("AC penalties always transfer to CMD", () => {
    expect(
      cmdFrom({ bab: 0, strMod: 0, dexMod: 0, size: "Medium", acPenalties: -2 })
        .normal,
    ).toBe(8);
  });

  test("a negative Dexterity modifier is not punished further while flat-footed", () => {
    const cmd = cmdFrom({ bab: 0, strMod: 0, dexMod: -2, size: "Medium" });
    expect(cmd.normal).toBe(8);
    expect(cmd.flatFooted).toBe(10);
  });
});

describe("attacks of opportunity (A.10)", () => {
  test("one, plus one more only for a positive Dexterity modifier", () => {
    expect(attacksOfOpportunityPerRound(-1)).toBe(1);
    expect(attacksOfOpportunityPerRound(0)).toBe(1);
    expect(attacksOfOpportunityPerRound(1)).toBe(2);
    // The SRD grants +1 total here, not "+Dex" — the sim's `1 + dexMod` deviation stays recorded.
    expect(attacksOfOpportunityPerRound(3)).toBe(2);
  });

  test("Combat Reflexes adds one per point of Dexterity modifier", () => {
    expect(attacksOfOpportunityPerRound(3, true)).toBe(5);
    expect(attacksOfOpportunityPerRound(0, true)).toBe(1);
    expect(attacksOfOpportunityPerRound(-1, true)).toBe(1);
  });
});

describe("concentration and spell DCs (A.16/A.19)", () => {
  test("concentration after damage = 10 + damage + spell level", () => {
    expect(concentrationDc({ damageTaken: 7, spellLevel: 2 })).toBe(19);
    expect(concentrationDc({ damageTaken: 0, spellLevel: 0 })).toBe(10);
  });

  test("casting defensively = 10 + attacker's BAB + spell level", () => {
    expect(defensiveCastingDc({ attackerBab: 6, spellLevel: 3 })).toBe(19);
  });

  test("spell save DC = 10 + level + key ability modifier (+ focus)", () => {
    expect(spellSaveDc({ spellLevel: 0, keyMod: 4 })).toBe(14);
    expect(spellSaveDc({ spellLevel: 3, keyMod: 4, focus: 2 })).toBe(19);
    expect(spellSaveDc({ spellLevel: 1, keyMod: -1 })).toBe(10);
  });
});

describe("damage (A.3)", () => {
  test("a penalty that drives damage below 1 leaves 1 nonlethal, not 0", () => {
    expect(damageAfterPenalties(0)).toEqual({ lethal: 0, nonlethal: 1 });
    expect(damageAfterPenalties(-3)).toEqual({ lethal: 0, nonlethal: 1 });
    expect(damageAfterPenalties(1)).toEqual({ lethal: 1, nonlethal: 0 });
  });

  test("damage reduction reduces to zero, it never converts to nonlethal", () => {
    expect(damageAfterDr(3, 5)).toBe(0);
    expect(damageAfterDr(8, 5)).toBe(3);
    expect(damageAfterDr(8, -1)).toBe(8);
  });

  test("critical multipliers add rather than multiply", () => {
    expect(combinedCritMultiplier([2, 2])).toBe(3);
    expect(combinedCritMultiplier([3])).toBe(3);
    expect(combinedCritMultiplier([])).toBe(1);
    expect(combinedCritMultiplier([2, 3])).toBe(4);
  });
});
