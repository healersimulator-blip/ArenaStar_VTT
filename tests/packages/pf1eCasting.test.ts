/**
 * P5/C02 — tactical casting and saving throws.
 *
 * Expectations are derived from the transcribed rule text (AoN 212 "Saving
 * Throw" / "Saving Throw Difficulty Class", AoN 230 "Saving Throw", and Gap
 * List A.16 for Evasion/SR), never captured from a previous run (V01). The
 * worked DC example — a wizard with Intelligence 18 (+4) casting 3rd-level
 * fireball at DC 17 — is the SRD's own.
 */
import { describe, expect, it } from "vitest";
import {
  PF1E_SAVE_SEVERITIES,
  describeSave,
  magicItemSaveBonus,
  objectSaveBonus,
  resolveSpellSave,
  resolveSpellTarget,
  spellResistanceCheck,
  spellSaveDc,
  spellSaveOutcome,
} from "../../src/packages/pf1e/casting";
import { applyEnergyMitigation } from "../../src/packages/pf1e/mitigation";

describe("AoN 212 — Saving Throw Difficulty Class", () => {
  it("is 10 + the spell level + the relevant ability bonus", () => {
    // The SRD's worked example: Int 18 (+4), 3rd-level fireball.
    expect(spellSaveDc({ spellLevel: 3, keyAbilityMod: 4 })).toEqual({
      dc: 17,
      issues: [],
    });
    // A 0-level spell from a Wisdom 10 cleric (+0).
    expect(spellSaveDc({ spellLevel: 0, keyAbilityMod: 0 }).dc).toBe(10);
    // A 9th-level spell from a Cha 20 sorcerer (+5).
    expect(spellSaveDc({ spellLevel: 9, keyAbilityMod: 5 }).dc).toBe(24);
  });

  it("takes a Spell Focus contribution only when the caller supplies it", () => {
    // Spell Focus is +1 and Greater Spell Focus +1 more, but neither is in the
    // A07 contract yet and no feat is silently activated from authored content.
    expect(
      spellSaveDc({ spellLevel: 3, keyAbilityMod: 4, focusBonus: 1 }).dc,
    ).toBe(18);
    expect(
      spellSaveDc({ spellLevel: 3, keyAbilityMod: 4, focusBonus: 2 }).dc,
    ).toBe(19);
  });

  it("names bad input instead of producing a DC", () => {
    expect(
      spellSaveDc({ spellLevel: 10, keyAbilityMod: 4 }).issues.map(
        (i) => i.field,
      ),
    ).toContain("spellLevel");
    expect(spellSaveDc({ spellLevel: -1, keyAbilityMod: 4 }).dc).toBe(0);
    expect(
      spellSaveDc({ spellLevel: 3, keyAbilityMod: 1.5 }).issues.map(
        (i) => i.field,
      ),
    ).toContain("keyAbilityMod");
    expect(
      spellSaveDc({
        spellLevel: 3,
        keyAbilityMod: 4,
        focusBonus: -1,
      }).issues.map((i) => i.field),
    ).toContain("focusBonus");
  });
});

describe("AoN 230 — automatic failures and successes on a saving throw", () => {
  it("a natural 1 always fails, however large the bonus", () => {
    const r = resolveSpellSave({ die: 1, saveBonus: 50, dc: 10 });
    expect(r.passed).toBe(false);
    expect(r.automatic).toBe("failure");
    expect(r.total).toBe(51);
  });

  it("a natural 20 always succeeds, however large the penalty", () => {
    const r = resolveSpellSave({ die: 20, saveBonus: -50, dc: 40 });
    expect(r.passed).toBe(true);
    expect(r.automatic).toBe("success");
    expect(r.total).toBe(-30);
  });

  it("otherwise passes on a total that equals or exceeds the DC", () => {
    expect(resolveSpellSave({ die: 12, saveBonus: 5, dc: 17 }).passed).toBe(
      true,
    ); // exactly 17
    expect(resolveSpellSave({ die: 11, saveBonus: 5, dc: 17 }).passed).toBe(
      false,
    ); // 16
    expect(
      resolveSpellSave({ die: 11, saveBonus: 5, dc: 17 }).automatic,
    ).toBeNull();
  });

  it("lets a creature voluntarily forego the save", () => {
    // A die that would otherwise succeed is not read at all.
    const r = resolveSpellSave({
      die: 20,
      saveBonus: 30,
      dc: 10,
      foregone: true,
    });
    expect(r.passed).toBe(false);
    expect(r.automatic).toBeNull();
  });

  it("names a die that is not a d20 face", () => {
    for (const die of [0, 21, 1.5, undefined]) {
      expect(
        resolveSpellSave({ die, saveBonus: 0, dc: 10 }).issues.map(
          (i) => i.field,
        ),
      ).toContain("die");
    }
  });
});

describe("AoN 212 — what a successful save does", () => {
  it("Negates: no effect on a success, full effect on a failure", () => {
    expect(
      spellSaveOutcome({ severity: "negates", saveType: "will", passed: true })
        .multiplier,
    ).toBe(0);
    expect(
      spellSaveOutcome({ severity: "negates", saveType: "will", passed: false })
        .multiplier,
    ).toBe(1);
  });

  it("Half: halves on a success, full on a failure", () => {
    expect(
      spellSaveOutcome({ severity: "half", saveType: "ref", passed: true })
        .multiplier,
    ).toBe(0.5);
    expect(
      spellSaveOutcome({ severity: "half", saveType: "ref", passed: false })
        .multiplier,
    ).toBe(1);
  });

  it("None: no save is allowed, so the effect applies in full", () => {
    const o = spellSaveOutcome({
      severity: "none",
      saveType: "fort",
      passed: false,
    });
    expect(o.multiplier).toBe(1);
    expect(o.note).toMatch(/no saving throw is allowed/);
  });

  it("Partial and Disbelief resolve to a spell-defined lesser effect, not an invented number", () => {
    for (const severity of ["partial", "disbelief"] as const) {
      const o = spellSaveOutcome({ severity, saveType: "will", passed: true });
      expect(o.kind).toBe("lesser");
      expect(o.multiplier).toBe(1);
      expect(o.note).toMatch(/no numeric multiplier is invented/);
    }
  });
});

describe("A.16 — Evasion and Improved Evasion", () => {
  it("Evasion: a successful Reflex-half save deals no damage", () => {
    const o = spellSaveOutcome({
      severity: "half",
      saveType: "ref",
      passed: true,
      evasion: true,
    });
    expect(o.multiplier).toBe(0);
    expect(o.note).toMatch(/Evasion/);
  });

  it("Improved Evasion: no damage on success, half on failure", () => {
    const win = spellSaveOutcome({
      severity: "half",
      saveType: "ref",
      passed: true,
      improvedEvasion: true,
    });
    const lose = spellSaveOutcome({
      severity: "half",
      saveType: "ref",
      passed: false,
      improvedEvasion: true,
    });
    expect(win.multiplier).toBe(0);
    expect(lose.multiplier).toBe(0.5);
    expect(lose.note).toMatch(/Improved Evasion/);
  });

  it("does nothing to a save that is not Reflex-half", () => {
    // Evasion is defined against "an attack that normally allows a Reflex
    // saving throw for half damage"; a Fortitude half is not that.
    const fort = spellSaveOutcome({
      severity: "half",
      saveType: "fort",
      passed: true,
      improvedEvasion: true,
    });
    expect(fort.multiplier).toBe(0.5);
    const negates = spellSaveOutcome({
      severity: "negates",
      saveType: "ref",
      passed: true,
      improvedEvasion: true,
    });
    expect(negates.multiplier).toBe(0); // unchanged: negates already zeroes it
    expect(negates.note).not.toMatch(/Evasion/);
  });

  it("publishes exactly the five SRD severities", () => {
    expect(PF1E_SAVE_SEVERITIES).toEqual([
      "negates",
      "partial",
      "half",
      "none",
      "disbelief",
    ]);
  });
});

describe("A.16 — spell resistance has no natural-die special cases", () => {
  it("a natural 20 that does not reach SR still fails", () => {
    const r = spellResistanceCheck({
      die: 20,
      casterLevel: 5,
      spellResistance: 30,
    });
    expect(r.total).toBe(25);
    expect(r.resisted).toBe(true);
  });

  it("a natural 1 that reaches SR still overcomes it", () => {
    const r = spellResistanceCheck({
      die: 1,
      casterLevel: 20,
      spellResistance: 10,
    });
    expect(r.total).toBe(21);
    expect(r.resisted).toBe(false);
  });

  it("equal to SR overcomes it", () => {
    expect(
      spellResistanceCheck({ die: 5, casterLevel: 10, spellResistance: 15 })
        .resisted,
    ).toBe(false);
    expect(
      spellResistanceCheck({ die: 4, casterLevel: 10, spellResistance: 15 })
        .resisted,
    ).toBe(true);
  });

  it("is overcome once per spell per round, so no second roll is read", () => {
    const r = spellResistanceCheck({
      die: 1,
      casterLevel: 1,
      spellResistance: 30,
      alreadyOvercomeThisRound: true,
    });
    expect(r.resisted).toBe(false);
    expect(r.reused).toBe(true);
    expect(r.total).toBeNull();
  });

  it("makes no check for a creature without SR", () => {
    const r = spellResistanceCheck({
      die: 1,
      casterLevel: 1,
      spellResistance: 0,
    });
    expect(r.resisted).toBe(false);
    expect(r.total).toBeNull();
  });
});

describe("one target end to end", () => {
  it("fireball: Reflex half, then energy resistance applies to what is taken", () => {
    // 28 fire damage, DC 17, Ref +4, die 15 → total 19 passes → half → 14,
    // then fire resistance 10 absorbs 10 → 4 dealt.
    const r = resolveSpellTarget({
      damage: 28,
      energyType: "fire",
      severity: "half",
      saveType: "ref",
      dc: 17,
      saveBonus: 4,
      saveDie: 15,
      defender: { energyResistance: { fire: 10 } },
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.passed).toBe(true);
    expect(r.saveReduced).toBe(14);
    expect(r.erApplied).toEqual({ fire: 10 });
    expect(r.dealt).toBe(4);
  });

  it("halving rounds down before anything else", () => {
    const r = resolveSpellTarget({
      damage: 27,
      severity: "half",
      saveType: "ref",
      dc: 10,
      saveBonus: 20,
      saveDie: 10,
    });
    if (!r.ok) throw new Error(r.error);
    expect(r.dealt).toBe(13); // floor(27 / 2), not 14
  });

  it("a resisted creature is unaffected and gets no save", () => {
    const sr = spellResistanceCheck({
      die: 2,
      casterLevel: 3,
      spellResistance: 20,
    });
    const r = resolveSpellTarget({
      damage: 40,
      energyType: "fire",
      severity: "half",
      saveType: "ref",
      dc: 17,
      saveBonus: 4,
      saveDie: 20, // would have saved anyway
      sr,
    });
    if (!r.ok) throw new Error(r.error);
    expect(r.resisted).toBe(true);
    expect(r.dealt).toBe(0);
  });

  it("a natural 1 forfeits the save even with a huge bonus", () => {
    const r = resolveSpellTarget({
      damage: 20,
      severity: "negates",
      saveType: "will",
      dc: 15,
      saveBonus: 30,
      saveDie: 1,
    });
    if (!r.ok) throw new Error(r.error);
    expect(r.passed).toBe(false);
    expect(r.automatic).toBe("failure");
    expect(r.dealt).toBe(20);
  });

  it("energy immunity drops the damage entirely", () => {
    const r = resolveSpellTarget({
      damage: 30,
      energyType: "cold",
      severity: "none",
      saveType: "ref",
      dc: 20,
      saveBonus: 0,
      defender: { immuneEnergy: ["cold"] },
    });
    if (!r.ok) throw new Error(r.error);
    expect(r.dealt).toBe(0);
    expect(r.notes.join(" ")).toMatch(/immunity to cold/);
  });

  it("vulnerability adds 50%, rounded down", () => {
    const r = resolveSpellTarget({
      damage: 10,
      energyType: "cold",
      severity: "none",
      saveType: "ref",
      dc: 20,
      saveBonus: 0,
      defender: { vulnerableEnergy: ["cold"] },
    });
    if (!r.ok) throw new Error(r.error);
    expect(r.dealt).toBe(15);
  });

  it("never applies DR to spell damage", () => {
    // DR reduces weapon and natural-attack damage (CRB p.561); a spell that
    // deals untyped damage is not reduced by it.
    const r = resolveSpellTarget({
      damage: 25,
      severity: "none",
      saveType: "fort",
      dc: 20,
      saveBonus: 0,
      defender: { dr: [{ value: 20, bypass: [] }] },
    });
    if (!r.ok) throw new Error(r.error);
    expect(r.dealt).toBe(25);
  });

  it("requires no die for a spell with no saving throw", () => {
    const r = resolveSpellTarget({
      damage: 12,
      severity: "none",
      saveType: "fort",
      dc: 0,
      saveBonus: 0,
    });
    if (!r.ok) throw new Error(r.error);
    expect(r.dealt).toBe(12);
    expect(r.notes.join(" ")).toMatch(/no saving throw is allowed/);
  });

  it("rejects malformed input with a named error", () => {
    const bad = resolveSpellTarget({
      damage: -1,
      severity: "half",
      saveType: "ref",
      dc: 15,
      saveBonus: 0,
      saveDie: 5,
    });
    expect(bad.ok).toBe(false);
    const unknown = resolveSpellTarget({
      damage: 5,
      energyType: "sonic-blast" as never,
      severity: "half",
      saveType: "ref",
      dc: 15,
      saveBonus: 0,
      saveDie: 5,
    });
    expect(unknown.ok).toBe(false);
  });
});

describe("AoN 230 — objects and magic items", () => {
  it("a magic item saves at 2 + half its caster level, rounded down", () => {
    expect(magicItemSaveBonus(0)).toBe(2);
    expect(magicItemSaveBonus(1)).toBe(2);
    expect(magicItemSaveBonus(5)).toBe(4);
    expect(magicItemSaveBonus(10)).toBe(7);
    expect(magicItemSaveBonus(-1)).toBeNull();
  });

  it("uses the holder's bonus when that is better, and no save at all for an unattended mundane object", () => {
    // Unattended and non-magical: no save.
    expect(objectSaveBonus({ attended: false, magical: false })).toBeNull();
    // Magical, unattended: its own bonus.
    expect(objectSaveBonus({ magical: true, itemCasterLevel: 4 })).toBe(4);
    // Magical and attended: the better of the two.
    expect(
      objectSaveBonus({
        magical: true,
        itemCasterLevel: 4,
        attended: true,
        holderBonus: 1,
      }),
    ).toBe(4);
    expect(
      objectSaveBonus({
        magical: true,
        itemCasterLevel: 0,
        attended: true,
        holderBonus: 7,
      }),
    ).toBe(7);
    // Mundane but attended: the holder's bonus.
    expect(objectSaveBonus({ attended: true, holderBonus: 3 })).toBe(3);
  });
});

describe("the extracted energy pipeline is shared, not duplicated", () => {
  it("spends energy resistance once per type across several components", () => {
    const r = applyEnergyMitigation(
      [
        { label: "a", amount: 6, kind: "energy", energyType: "fire" },
        { label: "b", amount: 6, kind: "energy", energyType: "fire" },
      ],
      { energyResistance: { fire: 8 } },
    );
    // 8 absorbed across the two components: 0 left on the first, 4 on the second.
    expect(r.erApplied).toEqual({ fire: 8 });
    expect(r.components.map((c) => c.amount)).toEqual([0, 4]);
  });
});

describe("UI labels", () => {
  it("describes each save entry", () => {
    expect(describeSave("half", "ref")).toBe("Reflex half");
    expect(describeSave("negates", "will")).toBe("Will negates");
    expect(describeSave("partial", "fort")).toBe("Fortitude partial");
    expect(describeSave("none", "ref")).toBe("no save");
    expect(describeSave("disbelief", "will")).toBe("Will disbelief");
  });
});
