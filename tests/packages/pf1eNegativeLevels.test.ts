/**
 * P7/H04/D-204 — negative levels (`negativeLevels.ts`), derived from the
 * verified texts: AoN Rules ID 427 (CRB p.562) and the Energy Drain
 * universal monster rule — each re-verified before encoding.
 */
import { describe, expect, test } from "vitest";
import {
  energyDrainSaveDC,
  negativeLevelDeath,
  negativeLevelPenalties,
  negativeLevelSaveVerdict,
  negativeLevelTotalsOf,
} from "../../src/packages/pf1e/negativeLevels";

describe("H04 — the authored counts", () => {
  test("temporary and permanent normalize; invalid input is named, never guessed", () => {
    expect(negativeLevelTotalsOf(undefined)).toEqual({
      temporary: 0,
      permanent: 0,
      total: 0,
      issues: [],
    });
    expect(
      negativeLevelTotalsOf({ temporary: 2, permanent: 1 }),
    ).toEqual({ temporary: 2, permanent: 1, total: 3, issues: [] });
    const bad = negativeLevelTotalsOf({ temporary: -1, permanent: "x" });
    expect(bad.total).toBe(0);
    expect(bad.issues.join("\n")).toContain(
      'negativeLevels.temporary = -1 is not a whole number ≥ 0 — treated as 0',
    );
    expect(bad.issues.join("\n")).toContain(
      'negativeLevels.permanent = "x" is not a whole number ≥ 0 — treated as 0',
    );
    expect(negativeLevelTotalsOf("drained").issues.join("\n")).toContain(
      "negativeLevels must be an object — ignored",
    );
  });
});

describe("H04 — the cumulative penalties (AoN 427)", () => {
  test("−1 per level on the listed statistics, −5 HP per level, one level lower", () => {
    expect(negativeLevelPenalties(0)).toEqual({
      attack: 0,
      saves: 0,
      skills: 0,
      abilityChecks: 0,
      cmb: 0,
      cmd: 0,
      hp: 0,
      effectiveLevelDelta: 0,
    });
    expect(negativeLevelPenalties(2)).toEqual({
      attack: -2,
      saves: -2,
      skills: -2,
      abilityChecks: -2,
      cmb: -2,
      cmd: -2,
      hp: -10,
      effectiveLevelDelta: -2,
    });
    expect(negativeLevelPenalties(-3)).toEqual(negativeLevelPenalties(0));
  });

  test("death when negative levels equal or exceed total Hit Dice", () => {
    expect(negativeLevelDeath({ levels: 3, hitDice: 4 })).toBe(false);
    expect(negativeLevelDeath({ levels: 4, hitDice: 4 })).toBe(true);
    expect(negativeLevelDeath({ levels: 5, hitDice: 4 })).toBe(true);
    // No authored Hit Dice ⇒ the check cannot fire (never guessed).
    expect(negativeLevelDeath({ levels: 9, hitDice: 0 })).toBe(false);
  });
});

describe("H04 — the removal saves", () => {
  test("the energy drain DC: 10 + half racial HD + Charisma", () => {
    expect(energyDrainSaveDC({ racialHd: 10, chaMod: 4 })).toBe(19);
    expect(energyDrainSaveDC({ racialHd: 7, chaMod: 2 })).toBe(15);
  });

  test("temporary levels retry each day; energy-drain levels become permanent on a failure", () => {
    const removed = negativeLevelSaveVerdict({
      kind: "temporary",
      die: 12,
      fortBonus: 5,
      dc: 17,
    });
    expect(removed).toMatchObject({ removed: true, becomesPermanent: false });
    expect(removed.note).toContain("goes away with no harm");

    const failedTemporary = negativeLevelSaveVerdict({
      kind: "temporary",
      die: 11,
      fortBonus: 5,
      dc: 17,
    });
    expect(failedTemporary).toMatchObject({
      removed: false,
      becomesPermanent: false,
    });
    expect(failedTemporary.note).toContain("a new save comes tomorrow");

    const failedDrain = negativeLevelSaveVerdict({
      kind: "energy-drain",
      die: 11,
      fortBonus: 5,
      dc: 17,
    });
    expect(failedDrain).toMatchObject({
      removed: false,
      becomesPermanent: true,
    });
    expect(failedDrain.note).toContain("becomes permanent");

    const badDie = negativeLevelSaveVerdict({
      kind: "temporary",
      die: 0,
      fortBonus: 5,
      dc: 17,
    });
    expect(badDie.note).toContain("must be a natural d20 face");
  });
});
