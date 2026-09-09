import { describe, expect, test } from "vitest";
import {
  ADVANCED_FIREARM_MAX_INCREMENTS,
  FIREARM_TOUCH_AC_INCREMENTS,
  MAX_RANGE_INCREMENTS,
  UNARMED_STRIKE_DAMAGE_BY_SIZE,
  brokenWeaponAdjustments,
  resolvePF1eWeapon,
  unarmedStrikeWeapon,
} from "../../src/packages/pf1e/weapons";
import {
  brokenArmorAdjustments,
  isBrokenFromDamage,
  itemHpAfterDamage,
  resolvePF1eArmor,
  sunderVerdict,
} from "../../src/packages/pf1e/items";

describe("weapon descriptors (A01)", () => {
  test("max range increments follow the weapon class (§2.8/§2.9)", () => {
    expect(MAX_RANGE_INCREMENTS).toEqual({
      melee: 0,
      thrown: 5,
      projectile: 10,
      firearm: 5,
    });
    expect(ADVANCED_FIREARM_MAX_INCREMENTS).toBe(10);
    // touch AC window: early firearms only within the 1st increment, advanced through the 5th
    expect(FIREARM_TOUCH_AC_INCREMENTS).toEqual({ early: 1, advanced: 5 });
  });

  test("a thrown dagger resolves with 5 increments, a bow with 10, an advanced rifle with 10 + touch 5", () => {
    const dagger = resolvePF1eWeapon({
      name: "Dagger",
      class: "thrown",
      handedness: "light",
      proficiency: "simple",
      damageDice: "1d4",
      damageType: "piercing",
      critThreatMin: 19,
      critMultiplier: 2,
      rangeIncrementFt: 10,
    });
    expect(dagger.ok).toBe(true);
    expect(dagger.weapon.maxRangeIncrements).toBe(5);
    expect(dagger.weapon.firearmTouchIncrements).toBeNull();

    const bow = resolvePF1eWeapon({
      name: "Longbow",
      class: "projectile",
      handedness: "two-handed",
      proficiency: "martial",
      damageDice: "1d8",
      damageType: "piercing",
      rangeIncrementFt: 100,
      ammo: { type: "arrows", loadActionId: "draw-weapon" },
    });
    expect(bow.ok).toBe(true);
    expect(bow.weapon.maxRangeIncrements).toBe(10);
    expect(bow.weapon.ammo?.type).toBe("arrows");

    const rifle = resolvePF1eWeapon({
      name: "Rifle",
      class: "firearm",
      firearmGeneration: "advanced",
      handedness: "two-handed",
      proficiency: "exotic",
      damageDice: "1d8",
      damageType: "piercing",
      rangeIncrementFt: 80,
      misfireMinimum: 1,
    });
    expect(rifle.ok).toBe(true);
    expect(rifle.weapon.maxRangeIncrements).toBe(10);
    expect(rifle.weapon.firearmTouchIncrements).toBe(5);

    const musket = resolvePF1eWeapon({
      name: "Musket",
      class: "firearm",
      damageDice: "1d12",
      rangeIncrementFt: 40,
      misfireMinimum: 1,
    });
    expect(musket.weapon.firearmGeneration).toBe("early");
    expect(musket.weapon.maxRangeIncrements).toBe(5);
    expect(musket.weapon.firearmTouchIncrements).toBe(1);
  });

  test("the unarmed strike is a light simple nonlethal bludgeoning weapon (AoN ID 131)", () => {
    const fist = unarmedStrikeWeapon("Medium");
    expect(fist.name).toBe("Unarmed strike");
    expect(fist.class).toBe("melee");
    expect(fist.handedness).toBe("light");
    expect(fist.proficiency).toBe("simple");
    expect(fist.damageDice).toBe("1d3");
    expect(fist.damageType).toBe("bludgeoning");
    expect(fist.nonlethal).toBe(true);
    expect(fist.critThreatMin).toBe(20);
    expect(fist.critMultiplier).toBe(2);
    expect(fist.natural).toBe(false);
    expect(fist.reach).toBe(false);
  });

  test("unarmed damage ladder: Small 1d2, Medium 1d3, Large 1d4, Huge 1d6 … (corrected)", () => {
    expect(UNARMED_STRIKE_DAMAGE_BY_SIZE.Small).toBe("1d2");
    expect(UNARMED_STRIKE_DAMAGE_BY_SIZE.Medium).toBe("1d3");
    expect(UNARMED_STRIKE_DAMAGE_BY_SIZE.Large).toBe("1d4");
    expect(UNARMED_STRIKE_DAMAGE_BY_SIZE.Huge).toBe("1d6");
    expect(UNARMED_STRIKE_DAMAGE_BY_SIZE.Gargantuan).toBe("1d8");
    expect(UNARMED_STRIKE_DAMAGE_BY_SIZE.Colossal).toBe("2d6");
    expect(unarmedStrikeWeapon("Tiny").damageDice).toBe("1");
    // unknown size falls back to Medium, never to a guessed die
    expect(unarmedStrikeWeapon("gargantuan ").damageDice).toBe("1d8");
  });

  test("a broken weapon: -2 attack and damage, critical only on a natural 20 at x2 (AoN ID 413)", () => {
    const intact = resolvePF1eWeapon({
      name: "Rapier",
      class: "melee",
      handedness: "one-handed",
      proficiency: "martial",
      damageDice: "1d6",
      damageType: "piercing",
      critThreatMin: 18,
      critMultiplier: 2,
    });
    expect(brokenWeaponAdjustments(intact.weapon)).toEqual({
      attack: 0,
      damage: 0,
      critThreatMin: 18,
      critMultiplier: 2,
    });
    const broken = resolvePF1eWeapon({ ...intact, broken: true } as never);
    expect(broken.weapon.broken).toBe(true);
    expect(brokenWeaponAdjustments(broken.weapon)).toEqual({
      attack: -2,
      damage: -2,
      critThreatMin: 20,
      critMultiplier: 2,
    });
    // a x4 weapon still only crits x2 while broken
    const scythe = resolvePF1eWeapon({
      name: "Scythe",
      class: "melee",
      handedness: "two-handed",
      damageDice: "2d4",
      damageType: "slashing",
      critThreatMin: 20,
      critMultiplier: 4,
      broken: true,
    });
    expect(brokenWeaponAdjustments(scythe.weapon).critMultiplier).toBe(2);
  });

  test("misfire value rises +4 while broken (§2.9b)", () => {
    const ok = resolvePF1eWeapon({
      name: "Pistol",
      class: "firearm",
      damageDice: "1d8",
      rangeIncrementFt: 20,
      misfireMinimum: 1,
    });
    expect(ok.weapon.misfireValue).toBe(1);
    const broken = resolvePF1eWeapon({
      name: "Pistol",
      class: "firearm",
      damageDice: "1d8",
      rangeIncrementFt: 20,
      misfireMinimum: 1,
      broken: true,
    });
    expect(broken.weapon.misfireValue).toBe(5);
    expect(
      broken.issues.some((i) => i.includes("misfire value from 1 to 5")),
    ).toBe(true);
    // 0 = never misfires, broken or not
    const club = resolvePF1eWeapon({
      name: "Club",
      class: "melee",
      broken: true,
    });
    expect(club.weapon.misfireValue).toBe(0);
  });

  test("DR-relevant properties: enhancement, material, alignment, epic total (A.17)", () => {
    const holyIce = resolvePF1eWeapon({
      name: "Holy axiomatic greatsword",
      class: "melee",
      handedness: "two-handed",
      damageDice: "2d6",
      damageType: "slashing",
      enhancementBonus: 4,
      specialAbilityBonus: 3,
      alignment: ["good", "lawful", "nonsense"],
    });
    // the total effective bonus (4 + 3 = 7) reaches the /epic threshold of 6;
    // the special-ability part never counts toward the +1/+3/+4/+5 ladder
    expect(holyIce.weapon.enhancementBonus).toBe(4);
    expect(holyIce.weapon.specialAbilityBonus).toBe(3);
    expect(holyIce.weapon.effectiveBonusTotal).toBe(7);
    expect(holyIce.weapon.alignment).toEqual(["good", "lawful"]);
    expect(holyIce.issues.some((i) => i.includes("unknown components"))).toBe(
      true,
    );

    const coldIron = resolvePF1eWeapon({
      name: "Cold iron longsword",
      class: "melee",
      handedness: "one-handed",
      damageDice: "1d8",
      material: "cold iron",
    });
    expect(coldIron.weapon.material).toBe("cold iron");
    expect(coldIron.weapon.effectiveBonusTotal).toBe(0);
  });

  test("double weapons carry a second head; light/one-handed doubles are flagged", () => {
    const dw = resolvePF1eWeapon({
      name: "Orc double axe",
      class: "melee",
      handedness: "two-handed",
      proficiency: "exotic",
      damageDice: "1d8",
      damageType: "slashing",
      critThreatMin: 20,
      critMultiplier: 3,
      doubleHead: {
        name: "Off-hand head",
        damageDice: "1d8",
        damageType: "slashing",
        critThreatMin: 20,
        critMultiplier: 3,
      },
    });
    expect(dw.ok).toBe(true);
    expect(dw.weapon.doubleHead?.damageDice).toBe("1d8");
    expect(dw.weapon.doubleHead?.critMultiplier).toBe(3);

    const wrong = resolvePF1eWeapon({
      name: "Odd stick",
      class: "melee",
      handedness: "one-handed",
      damageDice: "1d6",
      doubleHead: { damageDice: "1d4" },
    });
    expect(wrong.ok).toBe(false);
    expect(
      wrong.issues.some((i) => i.includes("double weapons are two-handed")),
    ).toBe(true);
  });

  test("validation is total: garbage yields the unarmed fallback with named issues", () => {
    const nothing = resolvePF1eWeapon(null);
    expect(nothing.ok).toBe(false);
    expect(nothing.weapon.unarmed).toBe(true);
    expect(nothing.weapon.damageDice).toBe("1d3");
    expect(nothing.issues.some((i) => i.includes("not an object"))).toBe(true);

    const garbage = resolvePF1eWeapon({
      class: "laser",
      handedness: "three-handed",
      proficiency: "legendary",
      damageDice: "lots",
      damageType: "psychic",
      critThreatMin: 25,
      critMultiplier: 1,
      rangeIncrementFt: -5,
      enhancementBonus: -2,
      material: "cardboard",
      alignment: "good",
      misfireMinimum: 99,
    });
    expect(garbage.ok).toBe(false);
    // every malformed field is named
    for (const needle of [
      "class = laser is not one of",
      "handedness = three-handed",
      "proficiency = legendary",
      "damageDice = lots",
      "damageType = psychic",
      "critThreatMin = 25 is outside 1–20",
      "critMultiplier = 1 is below 2",
      "rangeIncrementFt = -5",
      "enhancementBonus = -2",
      "material = cardboard",
      "alignment is not an array",
      "misfireMinimum = 99",
    ]) {
      expect(
        garbage.issues.some((i) => i.includes(needle)),
        needle,
      ).toBe(true);
    }
    // and the result stays usable: a melee weapon with sane clamped values
    expect(garbage.weapon.class).toBe("melee");
    expect(garbage.weapon.critThreatMin).toBe(25); // kept, never inverted — caller treats 20 as the only face
    expect(garbage.weapon.critMultiplier).toBe(2);
    expect(garbage.weapon.rangeIncrementFt).toBeNull();
    expect(garbage.weapon.enhancementBonus).toBe(0);
    expect(garbage.weapon.alignment).toEqual([]);
    expect(garbage.weapon.damageDice).toBeNull();
  });

  test("a ranged weapon without an increment cannot attack at range; firearmGeneration on a bow is flagged", () => {
    const bowless = resolvePF1eWeapon({
      name: "Bow",
      class: "projectile",
      damageDice: "1d8",
      rangeIncrementFt: 0,
    });
    expect(bowless.ok).toBe(false);
    expect(bowless.weapon.maxRangeIncrements).toBe(0);
    expect(bowless.issues.some((i) => i.includes("no ranged use"))).toBe(true);

    const confused = resolvePF1eWeapon({
      name: "Crossbow",
      class: "projectile",
      damageDice: "1d10",
      rangeIncrementFt: 80,
      firearmGeneration: "early",
    });
    expect(confused.weapon.firearmGeneration).toBeNull();
    expect(confused.weapon.firearmTouchIncrements).toBeNull();
    expect(
      confused.issues.some((i) =>
        i.includes("firearmGeneration is authored on a non-firearm"),
      ),
    ).toBe(true);
  });

  test("ammo on a melee weapon is carried but flagged", () => {
    const odd = resolvePF1eWeapon({
      name: "Spear",
      class: "melee",
      damageDice: "1d8",
      ammo: { type: "spears" },
    });
    expect(odd.weapon.ammo?.type).toBe("spears");
    expect(
      odd.issues.some((i) =>
        i.includes("ammunition data is consumed by projectile/firearm"),
      ),
    ).toBe(true);
  });
});

describe("armor and item-wear descriptors (A01)", () => {
  test("a full armor authoring resolves cleanly", () => {
    const r = resolvePF1eArmor({
      name: "Breastplate",
      slot: "armor",
      proficiency: "medium",
      armorBonus: 4,
      maxDexBonus: 3,
      checkPenalty: 4,
      spellFailure: 25,
      itemHp: 25,
      itemHardness: 5,
    });
    expect(r.ok).toBe(true);
    expect(r.issues).toEqual([]);
    expect(r.armor).toMatchObject({
      name: "Breastplate",
      slot: "armor",
      proficiency: "medium",
      armorBonus: 4,
      maxDexBonus: 3,
      checkPenalty: 4,
      spellFailure: 25,
      itemHp: 25,
      itemHardness: 5,
    });
  });

  test("defaults and garbage are total with named issues", () => {
    const empty = resolvePF1eArmor(undefined);
    expect(empty.ok).toBe(false);
    expect(empty.armor).toMatchObject({
      slot: "armor",
      proficiency: "none",
      armorBonus: 0,
      checkPenalty: 0,
      spellFailure: 0,
    });
    expect(empty.issues.some((i) => i.includes("not an object"))).toBe(true);

    const garbage = resolvePF1eArmor({
      slot: "gloves",
      proficiency: "pajamas",
      armorBonus: -3,
      maxDexBonus: "lots",
      spellFailure: 200,
    });
    expect(garbage.ok).toBe(false);
    for (const needle of [
      'slot = gloves is not "armor" | "shield"',
      "proficiency = pajamas",
      "armorBonus = -3",
      "maxDexBonus = lots",
      "spellFailure = 200",
    ]) {
      expect(
        garbage.issues.some((i) => i.includes(needle)),
        needle,
      ).toBe(true);
    }
  });

  test("broken armor: AC bonus halved rounding down, check penalty doubled; no ASF change (AoN ID 413)", () => {
    const armor = resolvePF1eArmor({
      name: "Full plate",
      slot: "armor",
      armorBonus: 9,
      checkPenalty: 6,
      spellFailure: 35,
    }).armor;
    expect(brokenArmorAdjustments(armor)).toEqual({
      armorBonus: 9,
      shieldBonus: 0,
      checkPenalty: 6,
    });
    expect(brokenArmorAdjustments({ ...armor, broken: true })).toEqual({
      armorBonus: 4, // 9/2 = 4.5 rounds down
      shieldBonus: 0,
      checkPenalty: 12,
    });
    const shield = resolvePF1eArmor({
      name: "Heavy steel shield",
      slot: "shield",
      shieldBonus: 2,
      checkPenalty: 2,
      broken: true,
    }).armor;
    expect(brokenArmorAdjustments(shield).shieldBonus).toBe(1);
  });

  test("slot mismatches are carried with an issue, not silently dropped", () => {
    const shieldWithArmorBonus = resolvePF1eArmor({
      slot: "shield",
      shieldBonus: 2,
      armorBonus: 1,
    });
    expect(shieldWithArmorBonus.armor.armorBonus).toBe(1);
    expect(
      shieldWithArmorBonus.issues.some((i) =>
        i.includes('armorBonus authored on slot "shield"'),
      ),
    ).toBe(true);
  });

  test("object damage: hardness first, then HP; the result may reach zero and below (A.17)", () => {
    expect(itemHpAfterDamage(9, 10, 20)).toBe(20); // hardness eats it all
    expect(itemHpAfterDamage(15, 10, 20)).toBe(15); // 5 through
    expect(itemHpAfterDamage(30, 10, 20)).toBe(0);
    expect(itemHpAfterDamage(45, 10, 20)).toBe(-15); // destroyed — the caller decides
  });

  test("the broken threshold is damage in EXCESS of half — exact half is not broken (AoN ID 413)", () => {
    expect(isBrokenFromDamage(5, 10)).toBe(false); // exactly half: not broken
    expect(isBrokenFromDamage(4, 10)).toBe(true);
    expect(isBrokenFromDamage(10, 10)).toBe(false);
    expect(isBrokenFromDamage(1, 0)).toBe(false); // no HP budget: never broken by damage
  });

  test("sunder verdict (A.9): destroyed at <= 0, broken below half, intact otherwise", () => {
    expect(sunderVerdict({ hpMax: 20, hpAfter: 20 })).toEqual({
      broken: false,
      destroyed: false,
      destroyedOrBroken: false,
    });
    expect(sunderVerdict({ hpMax: 20, hpAfter: 12 })).toEqual({
      broken: false,
      destroyed: false,
      destroyedOrBroken: false,
    });
    expect(sunderVerdict({ hpMax: 20, hpAfter: 9 })).toEqual({
      broken: true,
      destroyed: false,
      destroyedOrBroken: false,
    });
    expect(sunderVerdict({ hpMax: 20, hpAfter: 0 })).toEqual({
      broken: true,
      destroyed: true,
      destroyedOrBroken: true,
    });
    // full chain: 22 damage vs hardness 10, 20 HP: 12 through, 8 left of 20 — below half
    const hpAfter = itemHpAfterDamage(22, 10, 20);
    expect(hpAfter).toBe(8);
    expect(sunderVerdict({ hpMax: 20, hpAfter }).broken).toBe(true);
    expect(sunderVerdict({ hpMax: 20, hpAfter }).destroyed).toBe(false);
  });
});
