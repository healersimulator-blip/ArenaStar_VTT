import { describe, expect, test } from "vitest";
import {
  PF1E_FEAT_IMPROVED_UNARMED_STRIKE,
  PF1E_FEAT_PRECISE_SHOT,
  PF1E_FEAT_TWO_WEAPON_FIGHTING,
  attackEligibility,
  attackModifierParts,
  fullAttackPlan,
  resolveAttackRoll,
  selectDefenseAc,
  shootingIntoMeleePenalty,
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
      lethal.parts.find((p) => p.label === "unarmed lethal damage")?.value,
    ).toBe(-4);
    const trained = attackModifierParts({
      attacker: { ...fighter, feats: [PF1E_FEAT_IMPROVED_UNARMED_STRIKE] },
      weapon: fist,
      lethalIntent: true,
    });
    expect(trained.parts.some((p) => p.label === "unarmed lethal damage")).toBe(
      false,
    );
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
