import { describe, expect, test } from "vitest";
import {
  armorReducesSpeed,
  arcaneSpellFailureForCategory,
  babAtLevel,
  coverEntry,
  PF1E_CONCEALMENT_MISS_CHANCE,
  PF1E_COVER,
  PF1E_COVER_GRADES,
  PF1E_ARMORED_SPEED,
  PF1E_TWF_PENALTY_TABLE,
  saveBonusAtLevel,
  speedAfterArmor,
  twfPenalties,
} from "../../src/packages/pf1e/rulesTables";
import { COVER_AC_BONUS } from "../../src/packages/pf1e/resolve";
import {
  CONCEALMENT_MISS_CHANCE,
  TOTAL_CONCEALMENT_MISS_CHANCE,
} from "../../src/packages/pf1e/positional";
import { twfPenalties as tacticalTwfPenalties } from "../../src/packages/pf1e/tactical";

/**
 * M17 — shared SRD table coverage.
 *
 * The Gap List's warning (§6/P5, and again in §7) is that a table *existing* gets read as data
 * *being covered*. So this file does three things: pin every row of every shared table against
 * the appendix section it claims to transcribe, prove the consumers read these rows rather than
 * their own copy, and state what is deliberately NOT here. Coverage is measured by rows, not by
 * file count.
 */
describe("PF1e shared SRD tables (M17)", () => {
  test("Table 8-7 is four rows, and both scales read those four", () => {
    expect(
      PF1E_TWF_PENALTY_TABLE.map((r) => [
        r.feat,
        r.offHandLight,
        r.primaryHand,
        r.offHand,
      ]),
    ).toEqual([
      [false, false, -6, -10],
      [false, true, -4, -8],
      [true, false, -4, -4],
      [true, true, -2, -2],
    ]);
    // The rows are the whole table: every combination resolves, so no caller can fall through
    // to a default that flatters the attacker.
    for (const feat of [true, false]) {
      for (const offHandLight of [true, false]) {
        const row = PF1E_TWF_PENALTY_TABLE.find(
          (r) => r.feat === feat && r.offHandLight === offHandLight,
        );
        expect(
          row,
          `row for feat=${String(feat)} light=${String(offHandLight)}`,
        ).toBeDefined();
        expect(twfPenalties({ feat, offHandLight })).toEqual({
          primaryHand: row?.primaryHand,
          offHand: row?.offHand,
        });
      }
    }
    // D-135's tactical entry point is a re-export, not a second copy of the numbers.
    expect(tacticalTwfPenalties).toBe(twfPenalties);
    expect(tacticalTwfPenalties({ offHandLight: true })).toEqual({
      primaryHand: -4,
      offHand: -8,
    });
  });

  test("A.8's cover grades are the five published rows, and resolve() folds AC from them", () => {
    expect(PF1E_COVER.map((c) => c.cover)).toEqual([...PF1E_COVER_GRADES]);
    expect(PF1E_COVER.map((c) => [c.cover, c.acBonus, c.reflexBonus])).toEqual([
      ["partial", 2, 1],
      ["soft", 4, 0],
      ["standard", 4, 2],
      ["improved", 8, 4],
      ["total", 0, 0],
    ]);
    // soft cover is AC-only; total cover is a refusal, not a bonus; improved is the only row
    // with a Stealth bonus and the only one improved evasion still applies behind.
    expect(coverEntry("soft")?.reflexBonus).toBe(0);
    expect(coverEntry("total")?.blocksLineOfEffect).toBe(true);
    expect(coverEntry("improved")?.stealthBonus).toBe(10);
    expect(coverEntry("improved")?.improvedEvasionHalves).toBe(true);
    expect(coverEntry("  STANDARD ")).not.toBeNull();
    expect(coverEntry("half cover")).toBeNull();
    expect(coverEntry(null)).toBeNull();

    // The tactical resolution's AC fold is this table's acBonus column, key for key.
    for (const grade of PF1E_COVER_GRADES) {
      expect(COVER_AC_BONUS[grade]).toBe(coverEntry(grade)?.acBonus);
    }
  });

  test("A.8's concealment percentages: one roll, never stacking, both scales agree", () => {
    expect(PF1E_CONCEALMENT_MISS_CHANCE).toEqual({
      concealment: 20,
      total: 50,
    });
    expect(CONCEALMENT_MISS_CHANCE).toBe(
      PF1E_CONCEALMENT_MISS_CHANCE.concealment,
    );
    expect(TOTAL_CONCEALMENT_MISS_CHANCE).toBe(
      PF1E_CONCEALMENT_MISS_CHANCE.total,
    );
  });

  test("§6/P5's armored-speed rows are encoded as pairs, and unknown pairs are not invented", () => {
    expect(PF1E_ARMORED_SPEED).toEqual({ 30: 20, 20: 15 });
    expect(speedAfterArmor(30, "medium")).toBe(20);
    expect(speedAfterArmor(30, "Heavy")).toBe(20);
    expect(speedAfterArmor(20, "medium")).toBe(15);
    expect(speedAfterArmor(30, "light")).toBe(30);
    expect(speedAfterArmor(30, undefined)).toBe(30);
    // A 25-ft. or 50-ft. base has no transcribed row: it comes back unchanged rather than
    // being extrapolated, which is the difference between a table and a guess.
    expect(speedAfterArmor(25, "heavy")).toBe(25);
    expect(speedAfterArmor(50, "heavy")).toBe(50);
    expect(armorReducesSpeed("medium") && armorReducesSpeed("heavy")).toBe(
      true,
    );
    expect(armorReducesSpeed("light") || armorReducesSpeed("shield")).toBe(
      false,
    );
  });

  test("the CRB armor-category cross-checks exist so a pack row cannot drift alone", () => {
    expect(arcaneSpellFailureForCategory("light")).toBe(5);
    expect(arcaneSpellFailureForCategory("medium")).toBe(10);
    expect(arcaneSpellFailureForCategory("heavy")).toBe(15);
    expect(arcaneSpellFailureForCategory("shield")).toBe(0);
    // Shields and no armor fail no spell; an unrecognized category is treated as no armor,
    // never as the worst case.
    expect(arcaneSpellFailureForCategory("elven chain")).toBe(0);
  });

  test("class progressions are arithmetic, so a class pack row is checkable", () => {
    // Levels 1-20 of each ladder, spot-checked where the printed tables step.
    expect([1, 2, 3, 4, 5, 6, 20].map((lv) => babAtLevel("good", lv))).toEqual([
      1, 2, 3, 4, 5, 6, 20,
    ]);
    expect(
      [1, 2, 3, 4, 5, 6, 20].map((lv) => babAtLevel("average", lv)),
    ).toEqual([0, 1, 2, 3, 3, 4, 15]);
    expect([1, 2, 3, 4, 5, 6, 20].map((lv) => babAtLevel("poor", lv))).toEqual([
      0, 1, 1, 2, 2, 3, 10,
    ]);
    expect(
      [1, 2, 3, 4, 5, 6, 20].map((lv) => saveBonusAtLevel("good", lv)),
    ).toEqual([2, 3, 3, 4, 4, 5, 12]);
    expect(
      [1, 2, 3, 4, 5, 6, 20].map((lv) => saveBonusAtLevel("poor", lv)),
    ).toEqual([0, 1, 1, 2, 2, 3, 10]);
    // An unknown progression is a programmer error, not a silent 0.
    expect(() => babAtLevel("heroic" as "good", 1)).toThrow(
      /unknown bab progression/,
    );
  });
});
