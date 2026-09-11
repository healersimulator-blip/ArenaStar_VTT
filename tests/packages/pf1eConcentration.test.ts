/**
 * P5/C03 — casting legality, components, arcane spell failure and concentration.
 *
 * Every DC below is hand-derived from AoN 203 / CRB Table 9-1 and the Armor table,
 * not captured from a previous run (V01). The running example is a 5th-level wizard
 * (Int 18 ⇒ +4) casting 3rd-level fireball, so the concentration bonus is 5 + 4 = 9.
 */
import { describe, expect, it } from "vitest";
import {
  PF1E_DEAFENED_SPOIL_PERCENT,
  arcaneSpellFailureChance,
  castingAction,
  checkCastingLegality,
  componentNeeds,
  concentrationBonus,
  concentrationDc,
  parseSpellComponents,
  resolveArcaneSpellFailure,
  resolveCastingAttempt,
  resolveConcentration,
  resolveDeafenedSpoilage,
  type PF1eConcentrationTrigger,
} from "../../src/packages/pf1e/concentration";

const freeHands = {
  canSpeak: true,
  hasFreeHand: true,
  componentsInHand: true,
};

describe("Components line", () => {
  it("splits F/DF and M/DF into per-tradition halves", () => {
    const p = parseSpellComponents("V, S, M/DF (a pinch of sulphur)");
    expect(p.ok).toBe(true);
    expect(p.segments).toEqual([
      { arcane: "V", divine: "V" },
      { arcane: "S", divine: "S" },
      { arcane: "M", divine: "DF" },
    ]);
    expect(componentNeeds(p.segments, "arcane").codes).toEqual(["V", "S", "M"]);
    expect(componentNeeds(p.segments, "divine").codes).toEqual([
      "V",
      "S",
      "DF",
    ]);
  });

  it("derives what the caster must physically do", () => {
    const verbalOnly = componentNeeds(
      parseSpellComponents("V").segments,
      "arcane",
    );
    expect(verbalOnly).toEqual({
      codes: ["V"],
      mustSpeak: true,
      needsFreeHand: false,
      mustManipulateComponents: false,
    });
    const focus = componentNeeds(
      parseSpellComponents("V, S, F").segments,
      "arcane",
    );
    expect(focus.needsFreeHand).toBe(true);
    expect(focus.mustManipulateComponents).toBe(true);
  });

  it("names an unrecognised abbreviation instead of guessing", () => {
    expect(parseSpellComponents("V, X").ok).toBe(false);
    expect(parseSpellComponents("V, M/DF/S").ok).toBe(false);
    expect(parseSpellComponents("").ok).toBe(false);
    expect(parseSpellComponents("V, X").issues[0]?.message).toMatch(
      /not a component/,
    );
  });
});

describe("Casting legality", () => {
  const needs = componentNeeds(
    parseSpellComponents("V, S, M").segments,
    "arcane",
  );

  it("refuses each missing prerequisite with a named reason", () => {
    const gagged = checkCastingLegality({
      needs,
      caster: { ...freeHands, canSpeak: false },
      castingTime: "standard",
    });
    expect(gagged.legal).toBe(false);
    expect(gagged.reasons.join(" ")).toMatch(/cannot speak/);

    const noHand = checkCastingLegality({
      needs,
      caster: { ...freeHands, hasFreeHand: false },
      castingTime: "standard",
    });
    expect(noHand.reasons.join(" ")).toMatch(/no free hand/);

    const noComponents = checkCastingLegality({
      needs,
      caster: { ...freeHands, componentsInHand: false },
      castingTime: "standard",
    });
    expect(noComponents.reasons.join(" ")).toMatch(/components not in hand/);
  });

  it("lets a pinned creature cast only spells without somatic components", () => {
    const somatic = componentNeeds(
      parseSpellComponents("V, S").segments,
      "arcane",
    );
    const verbal = componentNeeds(parseSpellComponents("V").segments, "arcane");
    const pinned = { ...freeHands, pinned: true };
    expect(
      checkCastingLegality({
        needs: somatic,
        caster: pinned,
        castingTime: "standard",
      }).legal,
    ).toBe(false);
    expect(
      checkCastingLegality({
        needs: verbal,
        caster: pinned,
        castingTime: "standard",
      }).legal,
    ).toBe(true);
  });

  it("limits casting while grappling to no more than a standard action", () => {
    const grappled = { ...freeHands, grappled: true };
    const verbal = componentNeeds(parseSpellComponents("V").segments, "arcane");
    expect(
      checkCastingLegality({
        needs: verbal,
        caster: grappled,
        castingTime: "standard",
      }).legal,
    ).toBe(true);
    expect(
      checkCastingLegality({
        needs: verbal,
        caster: grappled,
        castingTime: "swift",
      }).legal,
    ).toBe(true);
    const long = checkCastingLegality({
      needs: verbal,
      caster: grappled,
      castingTime: "full-round",
    });
    expect(long.legal).toBe(false);
    expect(long.reasons.join(" ")).toMatch(/grappling/);
  });
});

describe("Arcane spell failure", () => {
  it("adds armour and shield together, per item before summing", () => {
    // Chain shirt 20% + buckler 5% = 25%.
    const r = arcaneSpellFailureChance({
      armor: { chance: 20 },
      shield: { chance: 5 },
      hasSomatic: true,
    });
    expect(r.chance).toBe(25);
    expect(r.applies).toBe(true);
    expect(r.issues).toEqual([]);
  });

  it("does not apply at all to a spell with no somatic component", () => {
    const r = arcaneSpellFailureChance({
      armor: { chance: 35 },
      hasSomatic: false,
    });
    expect(r.chance).toBe(0);
    expect(r.applies).toBe(false);
  });

  it("applies an exemption per item, not to the total", () => {
    // A bard in light armour and shield ignores both for bard spells.
    const exempt = arcaneSpellFailureChance({
      armor: { chance: 10, exempt: true },
      shield: { chance: 5, exempt: true },
      hasSomatic: true,
    });
    expect(exempt.chance).toBe(0);
    // Mithral chain shirt (20 → 10) with a normal buckler.
    const mithral = arcaneSpellFailureChance({
      armor: { chance: 10 },
      shield: { chance: 5 },
      hasSomatic: true,
    });
    expect(mithral.chance).toBe(15);
  });

  it("fails on a percentile roll equal to or below the chance", () => {
    expect(resolveArcaneSpellFailure({ die: 25, chance: 25 }).failed).toBe(
      true,
    );
    expect(resolveArcaneSpellFailure({ die: 26, chance: 25 }).failed).toBe(
      false,
    );
    expect(resolveArcaneSpellFailure({ die: 1, chance: 0 }).failed).toBe(false);
    expect(
      resolveArcaneSpellFailure({ die: 0, chance: 25 }).issues,
    ).toHaveLength(1);
  });

  it("spoils a verbal component 20% of the time when deafened", () => {
    expect(PF1E_DEAFENED_SPOIL_PERCENT).toBe(20);
    expect(resolveDeafenedSpoilage(20).spoiled).toBe(true);
    expect(resolveDeafenedSpoilage(21).spoiled).toBe(false);
  });
});

describe("Table 9-1 — concentration check DCs", () => {
  const dc = (t: PF1eConcentrationTrigger, level = 3) =>
    concentrationDc(t, level).dc;

  it("doubles the spell level only for casting defensively", () => {
    expect(dc({ situation: "castDefensively", die: 1 })).toBe(21); // 15 + 2*3
    // At level 0 the doubling is invisible, so level 9 pins it: 15 + 18 = 33.
    expect(dc({ situation: "castDefensively", die: 1 }, 9)).toBe(33);
    expect(dc({ situation: "entangled", die: 1 })).toBe(18); // 15 + 3, not doubled
  });

  it("covers every row of the table", () => {
    expect(dc({ situation: "injured", damage: 10, die: 1 })).toBe(23); // 10 + 10 + 3
    expect(dc({ situation: "continuousDamage", damage: 10, die: 1 })).toBe(18); // 10 + 5 + 3
    expect(dc({ situation: "nonDamagingSpell", spellDc: 15, die: 1 })).toBe(18);
    expect(dc({ situation: "grappledOrPinned", grapplerCmb: 12, die: 1 })).toBe(
      25,
    );
    expect(dc({ situation: "vigorousMotion", die: 1 })).toBe(13);
    expect(dc({ situation: "violentMotion", die: 1 })).toBe(18);
    expect(dc({ situation: "extremelyViolentMotion", die: 1 })).toBe(23);
    expect(dc({ situation: "windRainSleet", die: 1 })).toBe(8);
    expect(dc({ situation: "windHailDebris", die: 1 })).toBe(13);
  });

  it("names malformed input", () => {
    expect(
      concentrationDc({ situation: "injured", damage: 1.5, die: 1 }, 3).issues,
    ).toHaveLength(1);
    expect(
      concentrationDc({ situation: "injured", damage: 5, die: 1 }, 10).issues,
    ).toHaveLength(1);
  });

  it("adds caster level and the key ability modifier, plus caller-supplied feats", () => {
    expect(concentrationBonus({ casterLevel: 5, keyAbilityMod: 4 }).bonus).toBe(
      9,
    );
    // Combat Casting is +4, but it is supplied rather than inferred from authored data.
    expect(
      concentrationBonus({ casterLevel: 5, keyAbilityMod: 4, featBonus: 4 })
        .bonus,
    ).toBe(13);
    expect(
      concentrationBonus({ casterLevel: 0, keyAbilityMod: 4 }).issues,
    ).toHaveLength(1);
  });
});

describe("Concentration resolution", () => {
  it("passes when the total equals the DC", () => {
    const r = resolveConcentration({
      triggers: [{ situation: "castDefensively", die: 12 }],
      spellLevel: 3,
      casterLevel: 5,
      keyAbilityMod: 4,
    });
    expect(r.checks[0]?.total).toBe(21);
    expect(r.checks[0]?.passed).toBe(true);
    expect(r.lost).toBe(false);
  });

  it("requires every applicable check to pass — casting defensively while injured is two rolls", () => {
    const r = resolveConcentration({
      triggers: [
        { situation: "castDefensively", die: 12 }, // 21 vs DC 21
        { situation: "injured", damage: 5, die: 8 }, // 17 vs DC 18
      ],
      spellLevel: 3,
      casterLevel: 5,
      keyAbilityMod: 4,
    });
    expect(r.checks).toHaveLength(2);
    expect(r.checks[0]?.passed).toBe(true);
    expect(r.checks[1]?.passed).toBe(false);
    expect(r.lost).toBe(true);
  });

  it("names a die that is not a d20 face", () => {
    const r = resolveConcentration({
      triggers: [{ situation: "castDefensively", die: 0 }],
      spellLevel: 3,
      casterLevel: 5,
      keyAbilityMod: 4,
    });
    expect(r.issues).toHaveLength(1);
    expect(r.checks).toEqual([]);
  });
});

describe("Casting time to action (reuses Table 7-2)", () => {
  it("a 1-standard-action spell provokes, a swift one does not", () => {
    const std = castingAction({ castingTime: "standard" });
    expect(std.actionId).toBe("cast-spell");
    expect(std.provokes).toBe("yes");
    const swift = castingAction({ castingTime: "swift" });
    expect(swift.actionId).toBe("cast-quickened");
    expect(swift.provokes).toBe("no");
  });

  it("casts a free-action spell as a swift action", () => {
    const free = castingAction({ castingTime: "free" });
    expect(free.actionId).toBe("cast-quickened");
    expect(free.category).toBe("swift");
    expect(free.provokes).toBe("no");
  });

  it("makes metamagic a full-round action for a spontaneous caster", () => {
    const meta = castingAction({
      castingTime: "standard",
      metamagic: true,
      spontaneousCaster: true,
    });
    expect(meta.category).toBe("full-round");
    expect(meta.notes.join(" ")).toMatch(/spontaneous/);
    // A prepared caster does not pay extra time.
    expect(
      castingAction({ castingTime: "standard", metamagic: true }).actionId,
    ).toBe("cast-spell");
    // Quicken Spell overrides it back to a swift action.
    expect(
      castingAction({
        castingTime: "standard",
        metamagic: true,
        quickened: true,
      }).actionId,
    ).toBe("cast-quickened");
  });

  it("refuses to invent a provocation for a full-round casting time", () => {
    const full = castingAction({ castingTime: "full-round" });
    expect(full.actionId).toBeNull();
    expect(full.provokes).toBeNull();
    expect(full.notes.join(" ")).toMatch(/not encoded/);
  });
});

describe("the whole gate", () => {
  const base = {
    components: "V, S, M",
    tradition: "arcane" as const,
    caster: freeHands,
    castingTime: "standard" as const,
    spellLevel: 3,
    casterLevel: 5,
    keyAbilityMod: 4,
  };

  it("casts when every stage passes", () => {
    const r = resolveCastingAttempt({
      ...base,
      armor: { chance: 10 }, // leather
      arcaneDie: 20,
      triggers: [{ situation: "castDefensively", die: 12 }],
    });
    expect(r.ok).toBe(true);
    expect(r.outcome).toBe("cast");
    expect(r.asfChance).toBe(10);
    expect(r.asfFailed).toBe(false);
    expect(r.concentration.lost).toBe(false);
  });

  it("is ruined by arcane spell failure", () => {
    const r = resolveCastingAttempt({
      ...base,
      armor: { chance: 10 },
      arcaneDie: 5,
      triggers: [{ situation: "castDefensively", die: 20 }],
    });
    expect(r.outcome).toBe("lost");
    expect(r.asfFailed).toBe(true);
    // The concentration check still passed and is still reported.
    expect(r.concentration.lost).toBe(false);
    expect(r.notes.join(" ")).toMatch(/arcane spell failure/);
  });

  it("is lost to a failed concentration check", () => {
    const r = resolveCastingAttempt({
      ...base,
      triggers: [{ situation: "castDefensively", die: 5 }], // 5 + 9 = 14 vs DC 21
    });
    expect(r.outcome).toBe("lost");
    expect(r.asfFailed).toBeNull(); // no armour, so never rolled
    expect(r.notes.join(" ")).toMatch(
      /concentration failed on castDefensively \(14 vs DC 21\)/,
    );
  });

  it("blocks a gagged caster before any roll", () => {
    const r = resolveCastingAttempt({
      ...base,
      caster: { ...freeHands, canSpeak: false },
      arcaneDie: 1,
    });
    expect(r.outcome).toBe("blocked");
    expect(r.legal).toBe(false);
    expect(r.reasons.join(" ")).toMatch(/cannot speak/);
    expect(r.asfFailed).toBeNull();
  });

  it("ignores armour entirely for a verbal-only spell", () => {
    const r = resolveCastingAttempt({
      ...base,
      components: "V",
      armor: { chance: 35 }, // full plate
    });
    expect(r.asfChance).toBe(0);
    expect(r.outcome).toBe("cast");
  });

  it("applies deafened spoilage only to a spell with a verbal component", () => {
    const spoken = resolveCastingAttempt({
      ...base,
      caster: { ...freeHands, deafened: true },
      deafenedDie: 10,
    });
    expect(spoken.deafenedFailed).toBe(true);
    expect(spoken.outcome).toBe("lost");
    const silent = resolveCastingAttempt({
      ...base,
      components: "S, M",
      caster: { ...freeHands, deafened: true },
      deafenedDie: 10,
    });
    expect(silent.deafenedFailed).toBeNull();
    expect(silent.outcome).toBe("cast");
  });

  it("names malformed input rather than returning a result", () => {
    expect(resolveCastingAttempt({ ...base, components: "V, X" }).ok).toBe(
      false,
    );
    expect(
      resolveCastingAttempt({ ...base, castingTime: "bonus" as never }).ok,
    ).toBe(false);
  });
});
