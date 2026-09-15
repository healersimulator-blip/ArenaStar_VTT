import { describe, expect, test } from "vitest";
import rawFixtures from "./pf1eFixtures.json";
import {
  sizeEntry,
  abilityMod,
  babAtLevel,
  saveBonusAtLevel,
  twfPenalties,
  coverEntry,
  spellSaveDc,
  defensiveCastingDc,
  concentrationDc,
  cmbFrom,
  iterativeAttackBonuses,
  combinedCritMultiplier,
  damageAfterDr,
  attacksOfOpportunityPerRound,
  type PF1eSize,
  type PF1eBabProgression,
  type PF1eSaveProgression,
} from "../../src/packages/pf1e/rulesTables";
import { sizeStealthModifier } from "../../src/packages/pf1e/stealthPerception";

interface FixtureItem {
  category: string;
  heading: string;
  input: Record<string, unknown>;
  expected: Record<string, unknown>;
}

const fixtures = rawFixtures as unknown as FixtureItem[];

describe("V01 — Heading-cited rule fixtures (500+ worked examples)", () => {
  test("fixtures corpus contains over 500 independently cited examples", () => {
    expect(fixtures.length).toBeGreaterThanOrEqual(500);
  });

  test("size fixtures match sizeEntry and sizeStealthModifier", () => {
    const sizeFixtures = fixtures.filter((f) => f.category === "size");
    expect(sizeFixtures.length).toBe(9);
    for (const f of sizeFixtures) {
      const sz = f.input.size as PF1eSize;
      const entry = sizeEntry(sz);
      expect(entry.attackAc).toBe(f.expected.attackAc);
      expect(entry.cmbCmd).toBe(f.expected.cmbCmd);
      expect(entry.spaceFeet).toBe(f.expected.spaceFeet);
      expect(entry.reachSquares).toBe(f.expected.reachSquares);
      expect(sizeStealthModifier(sz)).toBe(f.expected.stealthMod);
    }
  });

  test("ability modifier fixtures match abilityMod", () => {
    const abilityFixtures = fixtures.filter((f) => f.category === "abilityModifier");
    expect(abilityFixtures.length).toBe(30);
    for (const f of abilityFixtures) {
      expect(abilityMod(f.input.score as number)).toBe(f.expected.mod);
    }
  });

  test("BAB progression fixtures match babAtLevel", () => {
    const babFixtures = fixtures.filter((f) => f.category === "bab");
    for (const f of babFixtures) {
      expect(
        babAtLevel(f.input.progression as PF1eBabProgression, f.input.level as number),
      ).toBe(f.expected.bab);
    }
  });

  test("save progression fixtures match saveBonusAtLevel", () => {
    const saveFixtures = fixtures.filter((f) => f.category === "save");
    for (const f of saveFixtures) {
      expect(
        saveBonusAtLevel(f.input.progression as PF1eSaveProgression, f.input.level as number),
      ).toBe(f.expected.baseSave);
    }
  });

  test("two-weapon fighting penalties match twfPenalties", () => {
    const twfFixtures = fixtures.filter((f) => f.category === "twf");
    for (const f of twfFixtures) {
      const p = twfPenalties({
        feat: f.input.twoWeaponFightingFeat as boolean,
        offHandLight: f.input.offHandIsLight as boolean,
      });
      expect(p.primaryHand).toBe(f.expected.primary);
      expect(p.offHand).toBe(f.expected.offhand);
    }
  });

  test("cover fixtures match coverEntry", () => {
    const coverFixtures = fixtures.filter((f) => f.category === "cover");
    for (const f of coverFixtures) {
      const entry = coverEntry(f.input.cover as "partial" | "soft" | "standard" | "improved" | "total");
      expect(entry?.acBonus).toBe(f.expected.acBonus);
      expect(entry?.reflexBonus).toBe(f.expected.reflexBonus);
      expect(entry?.stealthBonus).toBe(f.expected.stealthBonus);
    }
  });

  test("spell DC fixtures match spellSaveDc", () => {
    const dcFixtures = fixtures.filter((f) => f.category === "spellDc");
    for (const f of dcFixtures) {
      expect(
        spellSaveDc({
          spellLevel: f.input.spellLevel as number,
          keyMod: f.input.abilityMod as number,
        }),
      ).toBe(f.expected.dc);
    }
  });

  test("defensive casting DC fixtures match defensiveCastingDc", () => {
    const defFixtures = fixtures.filter((f) => f.category === "defensiveCastingDc");
    for (const f of defFixtures) {
      expect(
        defensiveCastingDc({
          spellLevel: f.input.spellLevel as number,
          attackerBab: f.input.attackerBab as number,
        }),
      ).toBe(f.expected.dc);
    }
  });

  test("injured casting DC fixtures match concentrationDc", () => {
    const injFixtures = fixtures.filter((f) => f.category === "injuredConcentrationDc");
    for (const f of injFixtures) {
      expect(
        concentrationDc({
          spellLevel: f.input.spellLevel as number,
          damageTaken: f.input.damageDealt as number,
        }),
      ).toBe(f.expected.dc);
    }
  });

  test("CMB calculation fixtures match cmbFrom", () => {
    const cmbFixtures = fixtures.filter((f) => f.category === "cmb");
    for (const f of cmbFixtures) {
      expect(
        cmbFrom({
          bab: f.input.bab as number,
          strMod: f.input.strMod as number,
          dexMod: 0,
          size: f.input.size as PF1eSize,
        }),
      ).toBe(f.expected.cmb);
    }
  });

  test("iterative attack fixtures match iterativeAttackBonuses", () => {
    const iterFixtures = fixtures.filter((f) => f.category === "iterativeAttacks");
    for (const f of iterFixtures) {
      expect(iterativeAttackBonuses(f.input.bab as number)).toEqual(f.expected.bonuses);
    }
  });

  test("combined critical multiplier fixtures match combinedCritMultiplier", () => {
    const critFixtures = fixtures.filter((f) => f.category === "critMultipliers");
    for (const f of critFixtures) {
      expect(combinedCritMultiplier(f.input.multipliers as readonly number[])).toBe(
        f.expected.combined,
      );
    }
  });

  test("damage reduction fixtures match damageAfterDr", () => {
    const drFixtures = fixtures.filter((f) => f.category === "damageReduction");
    for (const f of drFixtures) {
      expect(damageAfterDr(f.input.damage as number, f.input.dr as number)).toBe(
        f.expected.damageTaken,
      );
    }
  });

  test("AoO budget fixtures match attacksOfOpportunityPerRound", () => {
    const aooFixtures = fixtures.filter((f) => f.category === "aooBudget");
    for (const f of aooFixtures) {
      expect(
        attacksOfOpportunityPerRound(
          f.input.dexMod as number,
          f.input.combatReflexes as boolean,
        ),
      ).toBe(f.expected.budget);
    }
  });
});
