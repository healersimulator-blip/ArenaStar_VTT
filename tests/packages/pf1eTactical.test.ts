import { describe, expect, test } from "vitest";
import {
  PF1E_FEAT_IMPROVED_UNARMED_STRIKE,
  PF1E_FEAT_PRECISE_SHOT,
  PF1E_FEAT_TWO_WEAPON_FIGHTING,
  SPLASH_GRID_INTERSECTION_AC,
  attackEligibility,
  attackModifierParts,
  combinedDamageMultiplier,
  confirmCritical,
  damageModifierParts,
  effectiveCritThreatMin,
  fullAttackPlan,
  meleeReachLegality,
  rangeIncrementsSpanned,
  rangedAttackRange,
  resolveAttackRoll,
  resolveDamageRoll,
  resolveSplashIntersectionRoll,
  selectDefenseAc,
  shootingIntoMeleePenalty,
  splashMissScatter,
  twfPenalties,
} from "../../src/packages/pf1e/tactical";
import { resolvePF1eWeapon } from "../../src/packages/pf1e/weapons";
import {
  acFromBreakdown,
  type AcBreakdown,
} from "../../src/packages/pf1e/rulesTables";

const sword = resolvePF1eWeapon({
  name: "Longsword",
  class: "melee",
  handedness: "one-handed",
  proficiency: "martial",
  damageDice: "1d8",
  damageType: "slashing",
  enhancementBonus: 1,
}).weapon;

const dagger = resolvePF1eWeapon({
  name: "Dagger",
  class: "melee",
  handedness: "light",
  proficiency: "simple",
  damageDice: "1d4",
  damageType: "piercing",
  critThreatMin: 19,
}).weapon;

const bow = resolvePF1eWeapon({
  name: "Longbow",
  class: "projectile",
  handedness: "two-handed",
  proficiency: "martial",
  damageDice: "1d8",
  damageType: "piercing",
  rangeIncrementFt: 100,
}).weapon;

const staff = resolvePF1eWeapon({
  name: "Quarterstaff",
  class: "melee",
  handedness: "two-handed",
  proficiency: "simple",
  damageDice: "1d6",
  damageType: "bludgeoning",
  doubleHead: {
    name: "Other end",
    damageDice: "1d6",
    damageType: "bludgeoning",
  },
}).weapon;

function natural(name: string, secondary = false) {
  return resolvePF1eWeapon({
    name,
    class: "melee",
    natural: true,
    naturalSecondary: secondary,
    damageDice: "1d6",
    damageType: "piercing",
  }).weapon;
}

const fighter = {
  bab: 6,
  strMod: 3,
  dexMod: 2,
  size: "Medium" as const,
  feats: [] as readonly string[],
};

const acBreakdown: AcBreakdown = {
  armor: 6,
  shield: 2,
  dex: 3,
  natural: 2,
  size: 1,
  misc: 1,
  dodge: 1,
};

describe("two-weapon fighting (Table 8-7, CRB p.202)", () => {
  test("normal −6/−10; light off-hand −4/−8; feat −4/−4; feat + light −2/−2", () => {
    expect(twfPenalties({})).toEqual({ primaryHand: -6, offHand: -10 });
    expect(twfPenalties({ offHandLight: true })).toEqual({
      primaryHand: -4,
      offHand: -8,
    });
    expect(twfPenalties({ feat: true })).toEqual({
      primaryHand: -4,
      offHand: -4,
    });
    expect(twfPenalties({ feat: true, offHandLight: true })).toEqual({
      primaryHand: -2,
      offHand: -2,
    });
  });

  test("full attack: penalties apply to every primary iterative; the off hand gets one extra attack", () => {
    // no feat, light off-hand dagger: primary 9/4 → −4 each, off-hand Str attack −8
    const withoutFeat = fullAttackPlan({
      attacker: fighter,
      weapon: sword,
      offHandWeapon: dagger,
    });
    expect(withoutFeat.attacks).toHaveLength(2);
    // +1 longsword: 6+3+1 = 10 before penalties
    expect(withoutFeat.attacks[0]?.attackBonuses).toEqual([6, 1]);
    expect(withoutFeat.attacks[1]?.attackBonuses).toEqual([1]);

    // with the feat: primary 10−2 = 8/3, off-hand 9−2 = 7
    const withFeat = fullAttackPlan({
      attacker: { ...fighter, feats: [PF1E_FEAT_TWO_WEAPON_FIGHTING] },
      weapon: sword,
      offHandWeapon: dagger,
    });
    expect(withFeat.attacks[0]?.attackBonuses).toEqual([8, 3]);
    expect(withFeat.attacks[1]?.attackBonuses).toEqual([7]);

    // a non-light off-hand (a one-handed sword) without the feat: −6 primary, −10 off
    const heavyOffHand = fullAttackPlan({
      attacker: fighter,
      weapon: dagger,
      offHandWeapon: sword,
    });
    expect(heavyOffHand.attacks[0]?.attackBonuses).toEqual([3, -2]);
    expect(heavyOffHand.attacks[1]?.attackBonuses).toEqual([0]); // 6+3+1−10
  });

  test("a double weapon's off-hand end counts as light (CRB p.202)", () => {
    const plan = fullAttackPlan({ attacker: fighter, weapon: staff });
    expect(plan.attacks).toHaveLength(2);
    // light off-head, no feat ⇒ Table 8-7 light row: −4 primary iteratives, −8 off
    expect(plan.attacks[0]?.attackBonuses).toEqual([6 + 3 - 4, 1 + 3 - 4]);
    expect(plan.attacks[1]?.name).toBe("Quarterstaff (off-hand head)");
    expect(plan.attacks[1]?.attackBonuses).toEqual([6 + 3 - 8]);
  });
});

describe("shooting or throwing into a melee (CRB p.182)", () => {
  test("−4 base, −2 two size categories larger, none at three, Precise Shot removes it", () => {
    expect(shootingIntoMeleePenalty({})).toBe(-4);
    expect(shootingIntoMeleePenalty({ sizeCategoriesLarger: 1 })).toBe(-4);
    expect(shootingIntoMeleePenalty({ sizeCategoriesLarger: 2 })).toBe(-2);
    expect(shootingIntoMeleePenalty({ sizeCategoriesLarger: 3 })).toBe(0);
    expect(shootingIntoMeleePenalty({ sizeCategoriesLarger: 5 })).toBe(0);
    expect(shootingIntoMeleePenalty({ preciseShot: true })).toBe(0);
  });

  test("the penalty reaches the modifier stack only for ranged attacks", () => {
    const melee = attackModifierParts({
      attacker: fighter,
      weapon: sword,
      shootingIntoMelee: { sizeCategoriesLarger: 0 },
    });
    expect(melee.parts.some((p) => p.label === "shooting into melee")).toBe(
      false,
    );

    const ranged = attackModifierParts({
      attacker: { ...fighter, dexMod: 3 },
      weapon: bow,
      shootingIntoMelee: { sizeCategoriesLarger: 0 },
    });
    const penalty = ranged.parts.find((p) => p.label === "shooting into melee");
    expect(penalty?.value).toBe(-4);

    const precise = attackModifierParts({
      attacker: { ...fighter, dexMod: 3, feats: [PF1E_FEAT_PRECISE_SHOT] },
      weapon: bow,
      shootingIntoMelee: { sizeCategoriesLarger: 0 },
    });
    expect(precise.parts.some((p) => p.label === "shooting into melee")).toBe(
      false,
    );
  });
});

describe("the attack roll (A.2, CRB p.182)", () => {
  test("melee uses Str, ranged uses Dex, size applies, enhancement adds (BAB 6 Str 3 +1 sword = +10)", () => {
    const melee = attackModifierParts({ attacker: fighter, weapon: sword });
    expect(melee.total).toBe(6 + 3 + 0 + 1);
    expect(
      melee.parts.map((p) => `${p.label} ${p.value >= 0 ? "+" : ""}${p.value}`),
    ).toEqual(["BAB +6", "Str +3", "size +0", "enhancement +1"]);

    const ranged = attackModifierParts({
      attacker: { ...fighter, dexMod: 3 },
      weapon: bow,
    });
    expect(ranged.total).toBe(6 + 3 + 0 + 0);
    expect(ranged.parts[1]).toEqual({ label: "Dex", value: 3 });

    const small = attackModifierParts({
      attacker: { ...fighter, size: "Small" as const },
      weapon: dagger,
    });
    expect(small.parts.find((p) => p.label === "size")?.value).toBe(1);
    expect(small.total).toBe(6 + 3 + 1);
  });

  test("natural 1 always misses; natural 20 always hits and threatens", () => {
    const autoMiss = resolveAttackRoll({ die: 1, bonus: 20, ac: 5 });
    expect(
      autoMiss.ok &&
        !autoMiss.hits &&
        !autoMiss.threat &&
        autoMiss.natural === 1,
    ).toBe(true);
    const autoHit = resolveAttackRoll({ die: 20, bonus: 0, ac: 40 });
    expect(
      autoHit.ok && autoHit.hits && autoHit.threat && autoHit.natural === 20,
    ).toBe(true);
  });

  test("an increased threat range is not an automatic hit; a miss is never a threat", () => {
    // rolled 18 on an 18–20 weapon with +0 vs AC 19: a miss, and a miss is never a threat
    const miss = resolveAttackRoll({
      die: 18,
      bonus: 0,
      ac: 19,
      critThreatMin: 18,
    });
    expect(miss.ok && !miss.hits && !miss.threat).toBe(true);
    const hit = resolveAttackRoll({
      die: 18,
      bonus: 2,
      ac: 19,
      critThreatMin: 18,
    });
    expect(hit.ok && hit.hits && hit.threat).toBe(true);
    // a 19 that hits with threatMin 18 threatens
    const nineteen = resolveAttackRoll({
      die: 19,
      bonus: 2,
      ac: 20,
      critThreatMin: 18,
    });
    expect(nineteen.ok && nineteen.hits && nineteen.threat).toBe(true);
  });

  test("a die outside 1–20 is rejected, never guessed", () => {
    expect(resolveAttackRoll({ die: 0, bonus: 1, ac: 10 }).ok).toBe(false);
    expect(resolveAttackRoll({ die: 21, bonus: 1, ac: 10 }).ok).toBe(false);
    expect(resolveAttackRoll({ die: 10.5, bonus: 1, ac: 10 }).ok).toBe(false);
  });

  test("normal/touch/flat-footed defense selection matches the verified AC formulas (A.2)", () => {
    const cached = acFromBreakdown(acBreakdown);
    expect(selectDefenseAc(acBreakdown, {})).toBe(cached.normal);
    expect(selectDefenseAc(acBreakdown, { touch: true })).toBe(cached.touch);
    expect(selectDefenseAc(acBreakdown, { flatFooted: true })).toBe(
      cached.flatFooted,
    );
    // touch + flat-footed: 10 + size + misc only
    expect(
      selectDefenseAc(acBreakdown, { touch: true, flatFooted: true }),
    ).toBe(12);
  });
});

describe("nonproficiency (CRB p.144 weapons, p.153 armor)", () => {
  test("a nonproficient weapon takes −4 but can still attack", () => {
    const parts = attackModifierParts({
      attacker: { ...fighter, proficientWith: ["simple"] },
      weapon: sword, // martial
    });
    expect(parts.total).toBe(6 + 3 + 1 - 4);
    expect(parts.parts.find((p) => p.label === "nonproficient")?.value).toBe(
      -4,
    );
    expect(parts.notes.some((n) => n.includes("−4 on attack rolls"))).toBe(
      true,
    );
  });

  test("nonproficient armor ACP applies to attack rolls and stacks with the weapon penalty", () => {
    const parts = attackModifierParts({
      attacker: {
        ...fighter,
        proficientWith: ["simple"],
        armorNonproficiencyAcp: 8, // full plate 6 + heavy shield 2 (CRB p.153: they stack)
      },
      weapon: sword,
    });
    expect(
      parts.parts.find((p) => p.label === "armor nonproficiency (ACP)")?.value,
    ).toBe(-8);
    expect(parts.total).toBe(6 + 3 + 1 - 4 - 8);
  });

  test("natural weapons and unarmed strikes never take a proficiency group penalty", () => {
    const bite = attackModifierParts({
      attacker: { ...fighter, proficientWith: [] },
      weapon: natural("Bite"),
    });
    expect(bite.parts.some((p) => p.label === "nonproficient")).toBe(false);
    const fist = attackModifierParts({
      attacker: { ...fighter, proficientWith: [] },
      weapon: resolvePF1eWeapon({ name: "Unarmed strike", unarmed: true })
        .weapon,
    });
    expect(fist.parts.some((p) => p.label === "nonproficient")).toBe(false);
  });

  test("a broken weapon attacks at −2 (AoN Rules ID 413)", () => {
    const parts = attackModifierParts({
      attacker: fighter,
      weapon: { ...sword, broken: true },
    });
    expect(parts.parts.find((p) => p.label === "broken weapon")?.value).toBe(
      -2,
    );
    expect(parts.total).toBe(6 + 3 + 1 - 2);
  });
});

describe("unarmed attacks (CRB p.182, AoN Rules ID 131)", () => {
  const fist = resolvePF1eWeapon({
    name: "Unarmed strike",
    unarmed: true,
  }).weapon;

  test("attacking unarmed provokes from the armed target unless armed (IUS or natural weapons)", () => {
    const plain = fullAttackPlan({ attacker: fighter, weapon: fist });
    expect(plain.attacks[0]?.provokes).toBe(true);
    expect(
      plain.notes.some((n) => n.includes("provokes an attack of opportunity")),
    ).toBe(true);

    const ius = fullAttackPlan({
      attacker: { ...fighter, feats: [PF1E_FEAT_IMPROVED_UNARMED_STRIKE] },
      weapon: fist,
    });
    expect(ius.attacks[0]?.provokes).toBe(false);

    const clawed = fullAttackPlan({
      attacker: fighter,
      weapon: fist,
      naturalWeapons: [natural("Claw")],
    });
    expect(clawed.attacks[0]?.provokes).toBe(false);
  });

  test("dealing lethal damage without IUS takes −4; with IUS it is free", () => {
    const lethal = attackModifierParts({
      attacker: fighter,
      weapon: fist,
      lethalIntent: true,
    });
    expect(
      lethal.parts.find(
        (p) => p.label === "lethal damage with a nonlethal weapon",
      )?.value,
    ).toBe(-4);
    const trained = attackModifierParts({
      attacker: { ...fighter, feats: [PF1E_FEAT_IMPROVED_UNARMED_STRIKE] },
      weapon: fist,
      lethalIntent: true,
    });
    expect(
      trained.parts.some(
        (p) => p.label === "lethal damage with a nonlethal weapon",
      ),
    ).toBe(false);
  });
});

describe("natural attacks (CRB p.182 + Bestiary UMR)", () => {
  test("primary at full BAB, secondary at −5, never iterative", () => {
    const plan = fullAttackPlan({
      attacker: fighter, // BAB 6, Str 3
      weapon: natural("Bite"),
      naturalWeapons: [natural("Claw"), natural("Wing", true)],
    });
    expect(plan.attacks[0]?.attackBonuses).toEqual([6 + 3]);
    expect(plan.attacks[1]?.attackBonuses).toEqual([6 + 3]);
    expect(plan.attacks[2]?.attackBonuses).toEqual([6 + 3 - 5]);
  });

  test("the sole natural attack is always full BAB with the 1½ Str flag (two claws do not qualify)", () => {
    const sole = fullAttackPlan({ attacker: fighter, weapon: natural("Bite") });
    expect(sole.attacks[0]?.attackBonuses).toEqual([9]);
    expect(sole.attacks[0]?.oneAndHalfStr).toBe(true);

    const twoClaws = fullAttackPlan({
      attacker: fighter,
      weapon: natural("Claw"),
      naturalWeapons: [natural("Claw")],
    });
    expect(twoClaws.attacks.every((a) => a.oneAndHalfStr === false)).toBe(true);

    // a sole SECONDARY-authored natural is still full BAB (UMR: "always")
    const soleHoof = fullAttackPlan({
      attacker: fighter,
      weapon: natural("Hoof", true),
    });
    expect(soleHoof.attacks[0]?.attackBonuses).toEqual([9]);
    expect(soleHoof.attacks[0]?.oneAndHalfStr).toBe(true);
  });

  test("one type of attack, multiple attacks: all primary regardless of type (UMR)", () => {
    const plan = fullAttackPlan({
      attacker: fighter,
      weapon: natural("Hoof", true), // authored secondary
      naturalWeapons: [natural("Hoof", true)],
    });
    expect(plan.attacks[0]?.attackBonuses).toEqual([9]);
    expect(plan.attacks[1]?.attackBonuses).toEqual([9]);
    expect(plan.notes.some((n) => n.includes("treated as primary"))).toBe(true);
  });

  test("mixed with a manufactured weapon, all natural attacks become secondary", () => {
    const plan = fullAttackPlan({
      attacker: fighter,
      weapon: sword,
      naturalWeapons: [natural("Bite")],
    });
    expect(plan.attacks[0]?.attackBonuses).toEqual([10, 5]); // weapon unaffected (+1 sword)
    expect(plan.attacks[1]?.hand).toBe("natural");
    expect(plan.attacks[1]?.attackBonuses).toEqual([6 + 3 - 5]);
    expect(plan.attacks[1]?.oneAndHalfStr).toBe(false);
  });
});

describe("situational modifiers (verified in the Gap List)", () => {
  test("flanking +2, charge +2, invisible attacker +2, squeezing −4", () => {
    const base = attackModifierParts({
      attacker: fighter,
      weapon: sword,
    }).total;
    expect(
      attackModifierParts({
        attacker: fighter,
        weapon: sword,
        situational: { flanking: true },
      }).total,
    ).toBe(base + 2);
    expect(
      attackModifierParts({
        attacker: fighter,
        weapon: sword,
        situational: { charging: true },
      }).total,
    ).toBe(base + 2);
    expect(
      attackModifierParts({
        attacker: fighter,
        weapon: sword,
        situational: { attackerInvisible: true },
      }).total,
    ).toBe(base + 2);
    expect(
      attackModifierParts({
        attacker: fighter,
        weapon: sword,
        situational: { squeezing: true },
      }).total,
    ).toBe(base - 4);
  });

  test("a caller-supplied misc modifier is carried and labeled", () => {
    const parts = attackModifierParts({
      attacker: fighter,
      weapon: sword,
      misc: -1, // e.g. a verified-by-caller circumstance the contract does not name
    });
    expect(parts.parts.find((p) => p.label === "misc")?.value).toBe(-1);
  });
});

describe("attack eligibility (weapon-side; distance is A04)", () => {
  test("a ranged weapon without a range increment cannot attack at range", () => {
    const brokenBow = resolvePF1eWeapon({
      name: "Bow",
      class: "projectile",
      damageDice: "1d8",
      // no rangeIncrementFt — A01 already flags it; maxRangeIncrements resolves to 0
    });
    const result = attackEligibility({
      weapon: brokenBow.weapon,
      mode: "ranged",
    });
    expect(result.canAttack).toBe(false);
    expect(result.refusals.some((r) => r.includes("no ranged use"))).toBe(true);
  });

  test("a sound bow attacks at range; melee use of a bow is noted, not refused", () => {
    expect(attackEligibility({ weapon: bow, mode: "ranged" }).canAttack).toBe(
      true,
    );
    const meleeNote = attackEligibility({ weapon: bow, mode: "melee" });
    expect(meleeNote.canAttack).toBe(true);
    expect(meleeNote.notes.some((n) => n.includes("improvised"))).toBe(true);
  });

  test("unarmed attacks are eligible and note the provoke", () => {
    const result = attackEligibility({
      weapon: resolvePF1eWeapon({ name: "Unarmed strike", unarmed: true })
        .weapon,
      feats: [],
    });
    expect(result.canAttack).toBe(true);
    expect(result.notes.some((n) => n.includes("provokes"))).toBe(true);
  });
});

// ======================================================================================
// A03 — damage and critical arithmetic (CRB pp.179/182/191, AoN Rules IDs 100/131/172/377)
// ======================================================================================

const greatsword = resolvePF1eWeapon({
  name: "Greatsword",
  class: "melee",
  handedness: "two-handed",
  proficiency: "martial",
  damageDice: "2d6",
  damageType: "slashing",
}).weapon;

const battleaxe = resolvePF1eWeapon({
  name: "Battleaxe",
  class: "melee",
  handedness: "one-handed",
  proficiency: "martial",
  damageDice: "1d8",
  damageType: "slashing",
  critMultiplier: 3,
}).weapon;

const scimitar = resolvePF1eWeapon({
  name: "Scimitar",
  class: "melee",
  handedness: "one-handed",
  proficiency: "martial",
  damageDice: "1d6",
  damageType: "slashing",
  critThreatMin: 18,
}).weapon;

const sap = resolvePF1eWeapon({
  name: "Sap",
  class: "melee",
  handedness: "light",
  proficiency: "martial",
  damageDice: "1d6",
  damageType: "bludgeoning",
  nonlethal: true,
}).weapon;

const throwingDagger = resolvePF1eWeapon({
  name: "Dagger",
  class: "melee",
  handedness: "light",
  proficiency: "simple",
  damageDice: "1d4",
  damageType: "piercing",
  critThreatMin: 19,
  rangeIncrementFt: 10,
}).weapon;

const javelin = resolvePF1eWeapon({
  name: "Javelin",
  class: "thrown",
  handedness: "light",
  proficiency: "simple",
  damageDice: "1d6",
  damageType: "piercing",
  rangeIncrementFt: 30,
}).weapon;

const sling = resolvePF1eWeapon({
  name: "Sling",
  class: "projectile",
  handedness: "one-handed",
  proficiency: "simple",
  damageDice: "1d4",
  damageType: "bludgeoning",
  rangeIncrementFt: 50,
}).weapon;

const fist = resolvePF1eWeapon({
  name: "Unarmed strike",
  unarmed: true,
}).weapon;

const weakling = { bab: 2, strMod: -3, dexMod: 0, size: "Medium" as const };

describe("critical hits: confirmation (CRB p.182, AoN Rules ID 131)", () => {
  test("a natural 20 on the confirmation always confirms; a natural 1 never does", () => {
    const twenty = confirmCritical({ die: 20, attackBonus: 1, ac: 30 });
    expect(twenty).toMatchObject({ ok: true, confirmed: true, natural: 20 });
    const one = confirmCritical({ die: 1, attackBonus: 20, ac: 5 });
    expect(one).toMatchObject({ ok: true, confirmed: false, natural: 1 });
  });

  test("otherwise the confirmation is an attack roll that must hit — it does not need to be a 20 again", () => {
    const hit = confirmCritical({ die: 14, attackBonus: 10, ac: 24 });
    expect(hit).toMatchObject({ ok: true, confirmed: true, natural: null });
    const miss = confirmCritical({ die: 13, attackBonus: 10, ac: 24 });
    expect(miss).toMatchObject({ ok: true, confirmed: false, natural: null });
  });

  test("a die outside 1–20 is rejected, never guessed", () => {
    expect(confirmCritical({ die: 0, attackBonus: 0, ac: 10 }).ok).toBe(false);
    expect(confirmCritical({ die: 21, attackBonus: 0, ac: 10 }).ok).toBe(false);
  });
});

describe("increased threat range (CRB p.182; Improved Critical/keen)", () => {
  test("doubling re-anchors the range: 20 → 19–20, 19–20 → 17–20, 18–20 → 15–20", () => {
    expect(effectiveCritThreatMin(sword)).toBe(20);
    expect(effectiveCritThreatMin(sword, { threatRangeExpanded: true })).toBe(
      19,
    );
    expect(effectiveCritThreatMin(dagger, { threatRangeExpanded: true })).toBe(
      17,
    );
    expect(
      effectiveCritThreatMin(scimitar, { threatRangeExpanded: true }),
    ).toBe(15);
  });

  test("a broken weapon threatens on a natural 20 only — no expansion re-widens it (AoN Rules ID 413)", () => {
    const brokenDagger = { ...dagger, broken: true };
    expect(effectiveCritThreatMin(brokenDagger)).toBe(20);
    expect(
      effectiveCritThreatMin(brokenDagger, { threatRangeExpanded: true }),
    ).toBe(20);
  });
});

describe("multiplying damage (CRB p.179, AoN Rules ID 100)", () => {
  test("a ×2 crit rolls the damage twice with all modifiers: (dice + Str + enhancement) twice", () => {
    // fighter with the +1 longsword: static = Str 3 + enhancement 1 = 4
    const statics = damageModifierParts({ attacker: fighter, weapon: sword });
    expect(statics.parts).toEqual([
      { label: "Str", value: 3 },
      { label: "enhancement", value: 1 },
    ]);
    const crit = resolveDamageRoll({
      weapon: sword,
      staticDamage: statics.total,
      weaponDamageRolls: [6, 4],
      confirmedCrit: true,
    });
    expect(crit).toMatchObject({
      ok: true,
      multiplier: 2,
      weaponDamage: 18,
      lethal: 18,
      nonlethal: 0,
    });
    // The same hit without the crit rolls once: 6 + 4 = 10.
    const normal = resolveDamageRoll({
      weapon: sword,
      staticDamage: statics.total,
      weaponDamageRolls: [6],
    });
    expect(normal).toMatchObject({ ok: true, multiplier: 1, lethal: 10 });
  });

  test("extra damage dice and precision damage are added exactly once on a critical hit", () => {
    const crit = resolveDamageRoll({
      weapon: sword,
      staticDamage: 4,
      weaponDamageRolls: [6, 4],
      confirmedCrit: true,
      bonusLines: [
        { label: "flaming 1d6 fire", roll: 6 },
        { label: "sneak attack 2d6", roll: 9, precision: true },
      ],
    });
    expect(crit).toMatchObject({ ok: true, lethal: 18 + 6 + 9 });
    if (crit.ok) {
      expect(crit.bonusContributions).toEqual([
        {
          label: "flaming 1d6 fire",
          amount: 6,
          nonlethal: false,
          precision: false,
          energyType: null,
        },
        {
          label: "sneak attack 2d6",
          amount: 9,
          nonlethal: false,
          precision: true,
          energyType: null,
        },
      ]);
    }
  });

  test("multipliers are never multiplied together — each adds one less than its value", () => {
    // ×2 weapon crit + ×2 charge ⇒ ×3 (1 + 1 + 1)
    expect(
      combinedDamageMultiplier({
        weapon: sword,
        confirmedCrit: true,
        extraMultipliers: [2],
      }),
    ).toEqual({ ok: true, multiplier: 3 });
    // ×3 battleaxe crit + ×2 charge ⇒ ×4
    expect(
      combinedDamageMultiplier({
        weapon: battleaxe,
        confirmedCrit: true,
        extraMultipliers: [2],
      }),
    ).toEqual({ ok: true, multiplier: 4 });
    // ×3 lance under a ×3 spirited charge with a ×3 crit ⇒ ×5
    expect(
      combinedDamageMultiplier({
        weapon: battleaxe,
        confirmedCrit: true,
        extraMultipliers: [3],
      }),
    ).toEqual({ ok: true, multiplier: 5 });
    // A charge multiplier without a critical still doubles (×2)
    expect(
      combinedDamageMultiplier({ weapon: sword, extraMultipliers: [2] }),
    ).toEqual({ ok: true, multiplier: 2 });
    expect(combinedDamageMultiplier({ weapon: sword })).toEqual({
      ok: true,
      multiplier: 1,
    });
  });

  test("the resolver demands one roll per multiplier step and rejects garbage", () => {
    const under = resolveDamageRoll({
      weapon: sword,
      staticDamage: 4,
      weaponDamageRolls: [6],
      confirmedCrit: true,
    });
    expect(under).toMatchObject({ ok: false });
    if (!under.ok) expect(under.error).toContain("×2");
    const badExtra = resolveDamageRoll({
      weapon: sword,
      staticDamage: 4,
      weaponDamageRolls: [6, 6],
      confirmedCrit: true,
      extraMultipliers: [1.5],
    });
    expect(badExtra).toMatchObject({ ok: false });
    const negative = resolveDamageRoll({
      weapon: sword,
      staticDamage: 4,
      weaponDamageRolls: [-1],
    });
    expect(negative).toMatchObject({ ok: false });
    const threeRolls = resolveDamageRoll({
      weapon: sword,
      staticDamage: 4,
      weaponDamageRolls: [6, 4, 2],
      confirmedCrit: true,
      extraMultipliers: [2],
    });
    // (6+4) + (4+4) + (2+4) = 24 — each step adds the full static stack
    expect(threeRolls).toMatchObject({ ok: true, multiplier: 3, lethal: 24 });
  });

  test("a broken weapon's confirmed critical is ×2 whatever its authored multiplier (AoN Rules ID 413)", () => {
    const brokenAxe = { ...battleaxe, broken: true };
    expect(
      combinedDamageMultiplier({ weapon: brokenAxe, confirmedCrit: true }),
    ).toEqual({ ok: true, multiplier: 2 });
  });

  test("a defender immune to critical hits takes normal damage — but charge multipliers are not criticals", () => {
    const crit = resolveDamageRoll({
      weapon: battleaxe,
      staticDamage: 4,
      weaponDamageRolls: [5],
      confirmedCrit: true,
      defender: { immuneToCriticalHits: true },
    });
    expect(crit).toMatchObject({ ok: true, multiplier: 1, lethal: 9 });
    if (crit.ok) {
      expect(
        crit.notes.some((n) => n.includes("immune to critical hits")),
      ).toBe(true);
    }
    expect(
      combinedDamageMultiplier({
        weapon: sword,
        confirmedCrit: true,
        extraMultipliers: [2],
        defender: { immuneToCriticalHits: true },
      }),
    ).toEqual({ ok: true, multiplier: 2 });
  });
});

describe("strength bonus to damage (CRB p.179, AoN Rules ID 100)", () => {
  test("one-handed adds full Str; two-handed adds 1½ (rounded down)", () => {
    const one = damageModifierParts({ attacker: fighter, weapon: sword });
    expect(one.parts.find((p) => p.label === "Str")?.value).toBe(3);
    const two = damageModifierParts({ attacker: fighter, weapon: greatsword });
    expect(two.parts.find((p) => p.label === "Str (×1½)")?.value).toBe(4);
  });

  test("a light weapon in two hands never gains the 1½ increase", () => {
    const gripped = damageModifierParts({
      attacker: fighter,
      weapon: dagger,
      wieldingTwoHanded: true,
    });
    expect(gripped.parts.find((p) => p.label === "Str")?.value).toBe(3);
  });

  test("off-hand adds half the bonus rounded down; the entire penalty applies", () => {
    const off = damageModifierParts({
      attacker: fighter,
      weapon: sword,
      hand: "off-hand",
    });
    expect(off.parts.find((p) => p.label === "Str (×½)")?.value).toBe(1);
    const weakOff = damageModifierParts({
      attacker: weakling,
      weapon: sword,
      hand: "off-hand",
    });
    expect(weakOff.parts.find((p) => p.label === "Str (×½)")?.value).toBe(-3);
  });

  test("a two-handed wielder's Strength penalty is not multiplied", () => {
    const weak = damageModifierParts({
      attacker: weakling,
      weapon: greatsword,
    });
    expect(weak.parts.find((p) => p.label === "Str (×1½)")?.value).toBe(-3);
  });

  test("ranged: thrown weapons add Str; a melee weapon thrown adds Str; bows do not", () => {
    const thrown = damageModifierParts({ attacker: fighter, weapon: javelin });
    expect(thrown.parts.find((p) => p.label === "Str")?.value).toBe(3);
    const thrownMelee = damageModifierParts({
      attacker: fighter,
      weapon: throwingDagger,
      mode: "ranged",
    });
    expect(thrownMelee.parts.find((p) => p.label === "Str")?.value).toBe(3);
    const shot = damageModifierParts({ attacker: fighter, weapon: bow });
    expect(shot.parts.find((p) => p.label === "Str")).toBeUndefined();
  });

  test("a non-composite bow applies the penalty, but not a bonus; a sling adds the full modifier", () => {
    const weakBow = damageModifierParts({
      attacker: weakling,
      weapon: bow,
      rangedStrRule: "penalty-only",
    });
    expect(weakBow.parts.find((p) => p.label === "Str (penalty)")?.value).toBe(
      -3,
    );
    expect(
      weakBow.notes.some((n) => n.includes("penalty, but not a bonus")),
    ).toBe(true);
    const strongBow = damageModifierParts({
      attacker: fighter,
      weapon: bow,
      rangedStrRule: "penalty-only",
    });
    expect(strongBow.parts.find((p) => p.label === "Str")).toBeUndefined();
    const hurled = damageModifierParts({
      attacker: fighter,
      weapon: sling,
      rangedStrRule: "full",
    });
    expect(hurled.parts.find((p) => p.label === "Str")?.value).toBe(3);
  });

  test("natural attacks: primary full Str, secondary half, the sole natural attack 1½", () => {
    const bite = damageModifierParts({
      attacker: fighter,
      weapon: natural("Bite"),
    });
    expect(bite.parts.find((p) => p.label === "Str")?.value).toBe(3);
    const wing = damageModifierParts({
      attacker: fighter,
      weapon: natural("Wing", true),
    });
    expect(wing.parts.find((p) => p.label === "Str (×½)")?.value).toBe(1);
    const mixed = damageModifierParts({
      attacker: fighter,
      weapon: natural("Claw"),
      naturalAsSecondary: true,
    });
    expect(mixed.parts.find((p) => p.label === "Str (×½)")?.value).toBe(1);
    const sole = damageModifierParts({
      attacker: fighter,
      weapon: natural("Bite"),
      oneAndHalfStr: true,
    });
    expect(sole.parts.find((p) => p.label === "Str (×1½)")?.value).toBe(4);
  });

  test("the sole-natural 1½ flag flows from fullAttackPlan into the damage stack", () => {
    const plan = fullAttackPlan({ attacker: fighter, weapon: natural("Bite") });
    const bite = plan.attacks[0];
    expect(bite?.oneAndHalfStr).toBe(true);
    if (bite === undefined) throw new Error("the bite attack is missing");
    const statics = damageModifierParts({
      attacker: fighter,
      weapon: bite.weapon,
      oneAndHalfStr: bite.oneAndHalfStr,
    });
    expect(statics.parts.find((p) => p.label === "Str (×1½)")?.value).toBe(4);
  });

  test("enhancement adds to damage; the special-ability equivalent never does; broken is −2", () => {
    const enhanced = resolvePF1eWeapon({
      name: "Sword",
      class: "melee",
      handedness: "one-handed",
      proficiency: "martial",
      damageDice: "1d8",
      enhancementBonus: 2,
      specialAbilityBonus: 1,
    }).weapon;
    const parts = damageModifierParts({ attacker: fighter, weapon: enhanced });
    expect(parts.parts.find((p) => p.label === "enhancement")?.value).toBe(2);
    const brokenSword = { ...sword, broken: true };
    const brokenParts = damageModifierParts({
      attacker: fighter,
      weapon: brokenSword,
    });
    expect(
      brokenParts.parts.find((p) => p.label === "broken weapon")?.value,
    ).toBe(-2);
    expect(brokenParts.total).toBe(2);
  });
});

describe("minimum damage (CRB p.179, AoN Rules ID 100)", () => {
  test("penalties below 1 still deal 1 point of nonlethal damage", () => {
    // 1d8 rolled 2 with a −4 stack (Str −3 + misc −1): 2 − 4 = −2 < 1
    const hit = resolveDamageRoll({
      weapon: sword,
      staticDamage: -4,
      weaponDamageRolls: [2],
    });
    expect(hit).toMatchObject({ ok: true, lethal: 0, nonlethal: 1 });
    if (hit.ok) {
      expect(hit.notes.some((n) => n.includes("1 point of nonlethal"))).toBe(
        true,
      );
    }
  });

  test("a result of exactly 0 is still below 1", () => {
    const zero = resolveDamageRoll({
      weapon: sword,
      staticDamage: -3,
      weaponDamageRolls: [3],
    });
    expect(zero).toMatchObject({ ok: true, lethal: 0, nonlethal: 1 });
  });

  test("bonus dice lifting the total to 1 or more avoid the minimum", () => {
    const lifted = resolveDamageRoll({
      weapon: sword,
      staticDamage: -2,
      weaponDamageRolls: [2],
      bonusLines: [{ label: "sneak attack 2d6", roll: 7, precision: true }],
    });
    expect(lifted).toMatchObject({ ok: true, lethal: 7 });
    if (lifted.ok) {
      expect(lifted.notes.some((n) => n.includes("1 point of nonlethal"))).toBe(
        false,
      );
    }
  });

  test("a nonlethal weapon driven below 1 still deals 1 nonlethal", () => {
    // Unarmed strike (1d3, nonlethal) with Str −3: roll 1 − 3 = −2
    const punch = resolveDamageRoll({
      weapon: fist,
      staticDamage: -3,
      weaponDamageRolls: [1],
    });
    expect(punch).toMatchObject({ ok: true, lethal: 0, nonlethal: 1 });
  });
});

describe("nonlethal and lethal damage swap (CRB p.191, AoN Rules ID 172)", () => {
  test("unarmed damage is nonlethal by default; a lethal intent moves it to the lethal bucket", () => {
    const statics = damageModifierParts({ attacker: fighter, weapon: fist });
    expect(statics.parts.find((p) => p.label === "Str")?.value).toBe(3);
    const punch = resolveDamageRoll({
      weapon: fist,
      staticDamage: statics.total,
      weaponDamageRolls: [3],
    });
    expect(punch).toMatchObject({ ok: true, lethal: 0, nonlethal: 6 });
    const hammerFist = resolveDamageRoll({
      weapon: fist,
      staticDamage: statics.total,
      weaponDamageRolls: [3],
      lethalIntent: true,
    });
    expect(hammerFist).toMatchObject({ ok: true, lethal: 6, nonlethal: 0 });
  });

  test("a lethal weapon can deal nonlethal instead at −4 on the attack roll", () => {
    const attack = attackModifierParts({
      attacker: fighter,
      weapon: sword,
      nonlethalIntent: true,
    });
    expect(
      attack.parts.find(
        (p) => p.label === "nonlethal damage with a lethal weapon",
      )?.value,
    ).toBe(-4);
    const merciful = resolveDamageRoll({
      weapon: sword,
      staticDamage: 4,
      weaponDamageRolls: [6],
      nonlethalIntent: true,
    });
    expect(merciful).toMatchObject({ ok: true, lethal: 0, nonlethal: 10 });
  });

  test("a nonlethal weapon dealing lethal takes −4 — Improved Unarmed Strike waives it for unarmed strikes only", () => {
    // The A02 correction: the rule covers every nonlethal weapon, not just the
    // unarmed strike; IUS never exempts a sap.
    const sapLethal = attackModifierParts({
      attacker: { ...fighter, feats: [PF1E_FEAT_IMPROVED_UNARMED_STRIKE] },
      weapon: sap,
      lethalIntent: true,
    });
    expect(
      sapLethal.parts.find(
        (p) => p.label === "lethal damage with a nonlethal weapon",
      )?.value,
    ).toBe(-4);
    const fistLethalTrained = attackModifierParts({
      attacker: { ...fighter, feats: [PF1E_FEAT_IMPROVED_UNARMED_STRIKE] },
      weapon: fist,
      lethalIntent: true,
    });
    expect(
      fistLethalTrained.parts.some(
        (p) => p.label === "lethal damage with a nonlethal weapon",
      ),
    ).toBe(false);
    const sapDefault = resolveDamageRoll({
      weapon: sap,
      staticDamage: 3,
      weaponDamageRolls: [4],
    });
    expect(sapDefault).toMatchObject({ ok: true, lethal: 0, nonlethal: 7 });
  });

  test("both intents at once are rejected rather than guessed", () => {
    const both = resolveDamageRoll({
      weapon: sword,
      staticDamage: 4,
      weaponDamageRolls: [6],
      lethalIntent: true,
      nonlethalIntent: true,
    });
    expect(both).toMatchObject({ ok: false });
  });
});

describe("precision and critical immunities (rogue's Precision Damage & Critical Hits sidebar)", () => {
  test("precision-immune defenders drop sneak attack lines but keep extra damage dice", () => {
    const hit = resolveDamageRoll({
      weapon: sword,
      staticDamage: 4,
      weaponDamageRolls: [6, 4],
      confirmedCrit: true,
      defender: { immuneToPrecisionDamage: true },
      bonusLines: [
        { label: "sneak attack 2d6", roll: 9, precision: true },
        { label: "flaming 1d6 fire", roll: 6 },
      ],
    });
    // ×2 weapon crit: (6+4) + (4+4) = 18, plus 6 fire — the sneak line is dropped
    expect(hit).toMatchObject({ ok: true, lethal: 18 + 6 });
    if (hit.ok) {
      expect(hit.precisionDropped).toEqual(["sneak attack 2d6"]);
      expect(hit.notes.some((n) => n.includes("precision-based attacks"))).toBe(
        true,
      );
    }
  });

  test("a swarm takes precision damage but no extra critical damage; an elemental takes neither", () => {
    const swarm = resolveDamageRoll({
      weapon: battleaxe,
      staticDamage: 3,
      weaponDamageRolls: [5],
      confirmedCrit: true,
      defender: { immuneToCriticalHits: true },
      bonusLines: [{ label: "sneak attack 2d6", roll: 8, precision: true }],
    });
    expect(swarm).toMatchObject({ ok: true, multiplier: 1, lethal: 5 + 3 + 8 });
    const elemental = resolveDamageRoll({
      weapon: battleaxe,
      staticDamage: 3,
      weaponDamageRolls: [5],
      confirmedCrit: true,
      defender: {
        immuneToCriticalHits: true,
        immuneToPrecisionDamage: true,
      },
      bonusLines: [{ label: "sneak attack 2d6", roll: 8, precision: true }],
    });
    expect(elemental).toMatchObject({ ok: true, multiplier: 1, lethal: 8 });
    if (elemental.ok) {
      expect(elemental.precisionDropped).toEqual(["sneak attack 2d6"]);
    }
  });
});

describe("the SRD's worked critical composition (CRB pp.179/182)", () => {
  test("+1 flaming longsword, Str 14: the ×2 crit is 2d8 + 2×(Str+enh) + 1d6 fire once", () => {
    const str14 = { bab: 2, strMod: 2, dexMod: 2, size: "Medium" as const };
    const statics = damageModifierParts({ attacker: str14, weapon: sword });
    expect(statics.total).toBe(3);
    const crit = resolveDamageRoll({
      weapon: sword,
      staticDamage: statics.total,
      weaponDamageRolls: [5, 5],
      confirmedCrit: true,
      bonusLines: [{ label: "flaming 1d6 fire", roll: 4 }],
    });
    expect(crit).toMatchObject({
      ok: true,
      weaponDamage: 5 + 5 + 2 * 3,
      lethal: 16 + 4,
    });
    const normal = resolveDamageRoll({
      weapon: sword,
      staticDamage: statics.total,
      weaponDamageRolls: [5],
      bonusLines: [{ label: "flaming 1d6 fire", roll: 4 }],
    });
    expect(normal).toMatchObject({ ok: true, lethal: 8 + 4 });
  });

  test("a negative weapon total against a positive nonlethal rider is clamped, never healing", () => {
    const odd = resolveDamageRoll({
      weapon: sword,
      staticDamage: -4,
      weaponDamageRolls: [2],
      bonusLines: [
        { label: "stunning rider", roll: 6, precision: true, nonlethal: true },
      ],
    });
    expect(odd).toMatchObject({ ok: true, lethal: 0, nonlethal: 6 });
    if (odd.ok) {
      expect(odd.notes.some((n) => n.includes("clamped"))).toBe(true);
    }
  });
});

// ======================================================================================
// A04 — range penalties/legality, melee reach, and splash weapons (CRB pp.144/182/202)
// ======================================================================================

const alchemistFire = resolvePF1eWeapon({
  name: "Alchemist's fire",
  class: "thrown",
  handedness: "light",
  damageDice: "1d6",
  damageType: "fire",
  rangeIncrementFt: 10,
  splash: true,
}).weapon;

const longspear = resolvePF1eWeapon({
  name: "Longspear",
  class: "melee",
  handedness: "two-handed",
  proficiency: "simple",
  damageDice: "1d8",
  damageType: "piercing",
  reach: true,
}).weapon;

const earlyPistol = resolvePF1eWeapon({
  name: "Pistol",
  class: "firearm",
  handedness: "one-handed",
  proficiency: "exotic",
  damageDice: "1d8",
  damageType: "piercing",
  rangeIncrementFt: 20,
}).weapon;

const advancedRifle = resolvePF1eWeapon({
  name: "Rifle",
  class: "firearm",
  firearmGeneration: "advanced",
  handedness: "two-handed",
  proficiency: "exotic",
  damageDice: "1d10",
  damageType: "piercing",
  rangeIncrementFt: 20,
}).weapon;

const meleeDagger = resolvePF1eWeapon({
  name: "Dagger",
  class: "melee",
  handedness: "light",
  proficiency: "simple",
  damageDice: "1d4",
  damageType: "piercing",
  rangeIncrementFt: 10,
}).weapon;

describe("range increments and the range penalty (CRB p.144)", () => {
  test("fractions count as a full increment — the SRD's dagger example: 10-ft increment, 25 ft ⇒ −4", () => {
    expect(rangeIncrementsSpanned(25, 10)).toBe(3);
    const throw_ = rangedAttackRange({
      weapon: meleeDagger,
      distanceFt: 25,
    });
    expect(throw_).toMatchObject({
      ok: true,
      increments: 3,
      penalty: -4,
      withinFirearmTouchWindow: false,
    });
  });

  test("within the first increment there is no penalty; each increment beyond adds −2", () => {
    const bow = resolvePF1eWeapon({
      name: "Longbow",
      class: "projectile",
      handedness: "two-handed",
      proficiency: "martial",
      damageDice: "1d8",
      damageType: "piercing",
      rangeIncrementFt: 100,
    }).weapon;
    expect(rangedAttackRange({ weapon: bow, distanceFt: 100 })).toMatchObject({
      ok: true,
      increments: 1,
      penalty: 0,
    });
    expect(rangedAttackRange({ weapon: bow, distanceFt: 100.5 })).toMatchObject(
      { ok: true, increments: 2, penalty: -2 },
    );
    expect(rangedAttackRange({ weapon: bow, distanceFt: 1000 })).toMatchObject({
      ok: true,
      increments: 10,
      penalty: -18,
    });
  });

  test("a thrown weapon maxes at 5 increments — alchemist's fire at 45 ft is the 5th increment at −8", () => {
    expect(
      rangedAttackRange({ weapon: alchemistFire, distanceFt: 45 }),
    ).toMatchObject({ ok: true, increments: 5, penalty: -8 });
    const beyond = rangedAttackRange({
      weapon: alchemistFire,
      distanceFt: 51,
    });
    expect(beyond).toMatchObject({ ok: false });
    if (!beyond.ok) {
      expect(beyond.error).toContain("out of range");
    }
  });

  test("a melee weapon with an increment is thrown at range: 5 increments, no penalty at 10 ft", () => {
    expect(meleeDagger.class).toBe("melee");
    expect(meleeDagger.maxRangeIncrements).toBe(5);
    expect(
      rangedAttackRange({ weapon: meleeDagger, distanceFt: 10 }),
    ).toMatchObject({ ok: true, penalty: 0 });
    expect(
      rangedAttackRange({ weapon: meleeDagger, distanceFt: 50 }),
    ).toMatchObject({ ok: true, increments: 5, penalty: -8 });
    expect(
      rangedAttackRange({ weapon: meleeDagger, distanceFt: 50.1 }),
    ).toMatchObject({ ok: false });
  });

  test("beyond maximum range there is no attack at all, not a bigger penalty (CRB p.182)", () => {
    const longswordOnly = resolvePF1eWeapon({
      name: "Longsword",
      class: "melee",
      handedness: "one-handed",
      proficiency: "martial",
      damageDice: "1d8",
      damageType: "slashing",
    }).weapon;
    expect(
      rangedAttackRange({ weapon: longswordOnly, distanceFt: 5 }),
    ).toMatchObject({ ok: false });
    const bow = resolvePF1eWeapon({
      name: "Longbow",
      class: "projectile",
      damageDice: "1d8",
      rangeIncrementFt: 100,
    }).weapon;
    expect(rangedAttackRange({ weapon: bow, distanceFt: 1001 })).toMatchObject({
      ok: false,
    });
    expect(rangedAttackRange({ weapon: bow, distanceFt: -1 })).toMatchObject({
      ok: false,
    });
  });

  test("firearms: early touch AC only within the 1st increment, advanced through the 5th; the −2/increment applies regardless (§2.9)", () => {
    expect(
      rangedAttackRange({ weapon: earlyPistol, distanceFt: 20 }),
    ).toMatchObject({
      ok: true,
      increments: 1,
      penalty: 0,
      withinFirearmTouchWindow: true,
    });
    expect(
      rangedAttackRange({ weapon: earlyPistol, distanceFt: 21 }),
    ).toMatchObject({
      ok: true,
      increments: 2,
      penalty: -2,
      withinFirearmTouchWindow: false,
    });
    expect(
      rangedAttackRange({ weapon: earlyPistol, distanceFt: 100 }),
    ).toMatchObject({ ok: true, increments: 5, penalty: -8 });
    expect(
      rangedAttackRange({ weapon: earlyPistol, distanceFt: 101 }),
    ).toMatchObject({ ok: false });
    expect(
      rangedAttackRange({ weapon: advancedRifle, distanceFt: 100 }),
    ).toMatchObject({
      ok: true,
      increments: 5,
      penalty: -8,
      withinFirearmTouchWindow: true,
    });
    expect(
      rangedAttackRange({ weapon: advancedRifle, distanceFt: 101 }),
    ).toMatchObject({
      ok: true,
      increments: 6,
      penalty: -10,
      withinFirearmTouchWindow: false,
    });
    expect(
      rangedAttackRange({ weapon: advancedRifle, distanceFt: 200 }),
    ).toMatchObject({ ok: true, increments: 10, penalty: -18 });
    expect(
      rangedAttackRange({ weapon: advancedRifle, distanceFt: 201 }),
    ).toMatchObject({ ok: false });
  });

  test("spanning helpers reject unusable input rather than guessing", () => {
    expect(rangeIncrementsSpanned(25, 0)).toBeNull();
    expect(rangeIncrementsSpanned(-1, 10)).toBeNull();
    expect(rangeIncrementsSpanned(Number.NaN, 10)).toBeNull();
  });
});

describe("melee reach legality (CRB p.182 + A.5)", () => {
  test("a normal weapon strikes within natural reach", () => {
    expect(
      meleeReachLegality({ weapon: sword, naturalReachFt: 5, distanceFt: 5 }),
    ).toMatchObject({ canStrike: true });
    expect(
      meleeReachLegality({ weapon: sword, naturalReachFt: 5, distanceFt: 0 }),
    ).toMatchObject({ canStrike: true });
    const far = meleeReachLegality({
      weapon: sword,
      naturalReachFt: 5,
      distanceFt: 10,
    });
    expect(far.canStrike).toBe(false);
    expect(far.refusals.some((r) => r.includes("natural reach"))).toBe(true);
  });

  test("a reach weapon strikes up to double natural reach but never adjacent (the dead zone)", () => {
    const adjacent = meleeReachLegality({
      weapon: longspear,
      naturalReachFt: 5,
      distanceFt: 5,
    });
    expect(adjacent.canStrike).toBe(false);
    expect(
      adjacent.refusals.some((r) => r.includes("cannot strike within")),
    ).toBe(true);
    expect(
      meleeReachLegality({
        weapon: longspear,
        naturalReachFt: 5,
        distanceFt: 7.5,
      }),
    ).toMatchObject({ canStrike: true });
    expect(
      meleeReachLegality({
        weapon: longspear,
        naturalReachFt: 5,
        distanceFt: 10,
      }),
    ).toMatchObject({ canStrike: true });
    const far = meleeReachLegality({
      weapon: longspear,
      naturalReachFt: 5,
      distanceFt: 15,
    });
    expect(far.canStrike).toBe(false);
    expect(far.refusals.some((r) => r.includes("double natural reach"))).toBe(
      true,
    );
  });

  test("Large tall reach: the band is (10, 20] — 10 ft is dead, 15 and 20 strike", () => {
    expect(
      meleeReachLegality({
        weapon: longspear,
        naturalReachFt: 10,
        distanceFt: 10,
      }),
    ).toMatchObject({ canStrike: false });
    expect(
      meleeReachLegality({
        weapon: longspear,
        naturalReachFt: 10,
        distanceFt: 15,
      }),
    ).toMatchObject({ canStrike: true });
    expect(
      meleeReachLegality({
        weapon: longspear,
        naturalReachFt: 10,
        distanceFt: 20,
      }),
    ).toMatchObject({ canStrike: true });
    expect(
      meleeReachLegality({
        weapon: longspear,
        naturalReachFt: 10,
        distanceFt: 25,
      }),
    ).toMatchObject({ canStrike: false });
  });

  test("zero natural reach strikes only inside the target's square, and the provoke rule is named", () => {
    const inside = meleeReachLegality({
      weapon: natural("Bite"),
      naturalReachFt: 0,
      distanceFt: 0,
    });
    expect(inside.canStrike).toBe(true);
    expect(
      inside.notes.some((n) => n.includes("inside the target's square")),
    ).toBe(true);
    expect(
      meleeReachLegality({
        weapon: natural("Bite"),
        naturalReachFt: 0,
        distanceFt: 5,
      }),
    ).toMatchObject({ canStrike: false });
    const reachTiny = meleeReachLegality({
      weapon: longspear,
      naturalReachFt: 0,
      distanceFt: 5,
    });
    expect(reachTiny.canStrike).toBe(false);
    expect(reachTiny.notes.some((n) => n.includes("no invented rule"))).toBe(
      true,
    );
  });

  test("negative inputs are refused, never guessed", () => {
    const bad = meleeReachLegality({
      weapon: sword,
      naturalReachFt: -5,
      distanceFt: 5,
    });
    expect(bad.canStrike).toBe(false);
    expect(bad.refusals[0]).toContain("non-negative");
  });
});

describe("splash weapons (CRB p.202, AoN Rules ID 197)", () => {
  test("a splash weapon derives its ranged touch delivery and never takes the nonproficiency penalty", () => {
    expect(alchemistFire.touch).toBe(true);
    expect(alchemistFire.splash).toBe(true);
    // Not proficient with "simple" (the derived default group) — no penalty anyway.
    const untrained = attackModifierParts({
      attacker: { ...fighter, proficientWith: ["martial"] },
      weapon: alchemistFire,
      mode: "ranged",
    });
    expect(untrained.parts.some((p) => p.label === "nonproficient")).toBe(
      false,
    );
    // The same non-proficiency against a non-splash weapon does penalize.
    const bow = resolvePF1eWeapon({
      name: "Longbow",
      class: "projectile",
      handedness: "two-handed",
      proficiency: "martial",
      damageDice: "1d8",
      damageType: "piercing",
      rangeIncrementFt: 100,
    }).weapon;
    const penalized = attackModifierParts({
      attacker: { ...fighter, proficientWith: ["simple"] },
      weapon: bow,
      mode: "ranged",
    });
    expect(
      penalized.parts.find((p) => p.label === "nonproficient")?.value,
    ).toBe(-4);
  });

  test("splash weapons cannot deal precision-based damage — rejected, not dropped", () => {
    const sneaky = resolveDamageRoll({
      weapon: alchemistFire,
      staticDamage: 0,
      weaponDamageRolls: [4],
      bonusLines: [{ label: "sneak attack 2d6", roll: 9, precision: true }],
    });
    expect(sneaky).toMatchObject({ ok: false });
    if (!sneaky.ok) {
      expect(sneaky.error).toContain("precision-based damage");
    }
    const plain = resolveDamageRoll({
      weapon: alchemistFire,
      staticDamage: 0,
      weaponDamageRolls: [4],
      bonusLines: [{ label: "splash 1 fire", roll: 1 }],
    });
    expect(plain).toMatchObject({ ok: true, lethal: 5 });
  });

  test("the grid-intersection attack is a ranged attack against AC 5 with no threat", () => {
    expect(SPLASH_GRID_INTERSECTION_AC).toBe(5);
    expect(resolveSplashIntersectionRoll({ die: 5, bonus: 0 })).toMatchObject({
      ok: true,
      hits: true,
      natural: null,
    });
    expect(resolveSplashIntersectionRoll({ die: 4, bonus: 0 })).toMatchObject({
      ok: true,
      hits: false,
    });
    expect(
      resolveSplashIntersectionRoll({ die: 20, bonus: -30 }),
    ).toMatchObject({ ok: true, hits: true, natural: 20 });
    expect(resolveSplashIntersectionRoll({ die: 1, bonus: 30 })).toMatchObject({
      ok: true,
      hits: false,
      natural: 1,
    });
    expect(resolveSplashIntersectionRoll({ die: 0, bonus: 0 })).toMatchObject({
      ok: false,
    });
  });

  test("scatter: die 1 falls short toward the thrower; 2–8 rotate clockwise (screen coordinates)", () => {
    const target = { x: 5, y: 5 };
    // Thrower due east of the target ⇒ direction 1 is east.
    const throwerEast = { x: 10, y: 5 };
    expect(
      splashMissScatter({
        target,
        thrower: throwerEast,
        die: 1,
        throwIncrements: 1,
      }),
    ).toMatchObject({
      ok: true,
      landing: { x: 6, y: 5 },
      direction: "E",
      fallingShort: true,
    });
    // Clockwise from east: 2 = SE, 3 = S, 4 = SW, 5 = W, 6 = NW, 7 = N, 8 = NE.
    expect(
      splashMissScatter({
        target,
        thrower: throwerEast,
        die: 2,
        throwIncrements: 1,
      }),
    ).toMatchObject({ landing: { x: 6, y: 6 }, direction: "SE" });
    expect(
      splashMissScatter({
        target,
        thrower: throwerEast,
        die: 3,
        throwIncrements: 1,
      }),
    ).toMatchObject({ landing: { x: 5, y: 6 }, direction: "S" });
    expect(
      splashMissScatter({
        target,
        thrower: throwerEast,
        die: 4,
        throwIncrements: 1,
      }),
    ).toMatchObject({ landing: { x: 4, y: 6 }, direction: "SW" });
    expect(
      splashMissScatter({
        target,
        thrower: throwerEast,
        die: 5,
        throwIncrements: 1,
      }),
    ).toMatchObject({ landing: { x: 4, y: 5 }, direction: "W" });
    expect(
      splashMissScatter({
        target,
        thrower: throwerEast,
        die: 6,
        throwIncrements: 1,
      }),
    ).toMatchObject({ landing: { x: 4, y: 4 }, direction: "NW" });
    expect(
      splashMissScatter({
        target,
        thrower: throwerEast,
        die: 7,
        throwIncrements: 1,
      }),
    ).toMatchObject({ landing: { x: 5, y: 4 }, direction: "N" });
    expect(
      splashMissScatter({
        target,
        thrower: throwerEast,
        die: 8,
        throwIncrements: 1,
      }),
    ).toMatchObject({
      landing: { x: 6, y: 4 },
      direction: "NE",
      fallingShort: false,
    });
  });

  test("scatter distance = the range increments of the throw — the 25-ft/20-ft-increment example lands 2 squares off", () => {
    // 25 ft with a 20-ft increment spans 2 increments (fraction counts).
    const throw_ = rangedAttackRange({
      weapon: advancedRifle,
      distanceFt: 25,
    });
    expect(throw_).toMatchObject({ ok: true, increments: 2 });
    if (!throw_.ok) throw new Error("unreachable");
    // Thrower due north of the target; die 1 falls short northward, 2 squares.
    const scatter = splashMissScatter({
      target: { x: 3, y: 3 },
      thrower: { x: 3, y: 0 },
      die: 1,
      throwIncrements: throw_.increments,
    });
    expect(scatter).toMatchObject({
      ok: true,
      landing: { x: 3, y: 1 },
      squaresMoved: 2,
      direction: "N",
      fallingShort: true,
    });
  });

  test("an angled thrower snaps to the nearest compass direction for die 1", () => {
    // Thrower at (+2, +1) from the target: 26.6° — nearest compass is SE (45°),
    // not E (0°), because 26.6 is closer to 45 than to 0.
    const scatter = splashMissScatter({
      target: { x: 0, y: 0 },
      thrower: { x: 2, y: 1 },
      die: 1,
      throwIncrements: 1,
    });
    expect(scatter).toMatchObject({
      ok: true,
      landing: { x: 1, y: 1 },
      direction: "SE",
    });
    // A diagonal thrower is exactly NE.
    const diagonal = splashMissScatter({
      target: { x: 0, y: 0 },
      thrower: { x: 3, y: -3 },
      die: 1,
      throwIncrements: 1,
    });
    expect(diagonal).toMatchObject({
      direction: "NE",
      landing: { x: 1, y: -1 },
    });
  });

  test("scatter input validation: die 1–8, increments ≥ 1, distinct squares", () => {
    expect(
      splashMissScatter({
        target: { x: 0, y: 0 },
        thrower: { x: 5, y: 5 },
        die: 9,
        throwIncrements: 1,
      }),
    ).toMatchObject({ ok: false });
    expect(
      splashMissScatter({
        target: { x: 0, y: 0 },
        thrower: { x: 5, y: 5 },
        die: 1,
        throwIncrements: 0,
      }),
    ).toMatchObject({ ok: false });
    expect(
      splashMissScatter({
        target: { x: 2, y: 2 },
        thrower: { x: 2, y: 2 },
        die: 1,
        throwIncrements: 1,
      }),
    ).toMatchObject({ ok: false });
  });
});
