/**
 * §3.1 (G-39, D-264) — character import, the parts that are rules rather than wiring.
 *
 * The fixtures are not invented shapes. The Foundry weapon is the pf1 system's own **Shortspear**
 * as the vendored pack ships it (`packs/basic-monsters/acolyte.…yaml`, trimmed to the fields this
 * reader touches), the actor around it uses the field spellings the vendored content packs
 * actually write (`system.abilities.<k>.value`, `system.attributes.hp` with no maximum,
 * `naturalAC` as a bare number, `savingThrows.<k>.total`, `skills.<key>.{rank,cs}`,
 * `traits.size: "med"`), and the Hero Lab fixture follows the two shapes public importers read
 * (`attribute[@name]/attrvalue/@modified`, `armorclass/@ac|@touch|@flatfooted`).
 */
import { describe, expect, test } from "vitest";
import {
  characterImportOps,
  characterImportReport,
  detectCharacterFormat,
  characterImportCheck,
  importCharacter,
  importFoundryCharacter,
  importHeroLabCharacter,
  importRoll20Character,
  parseDamage,
  sizeRollToDice,
} from "../../src/packages/pf1e/import";
import { attackEntryFromWeapon } from "../../src/packages/pf1e/consumables";
import { attackLinesFromItems } from "../../src/packages/pf1e/import/types";
import { readInventoryItems } from "../../src/packages/pf1e/inventory";

/** The pf1 system's own Shortspear, as `packs/basic-monsters/acolyte.z9jpxa14KvsDkQrx.yaml` ships it. */
const SHORTSPEAR = {
  name: "Shortspear",
  type: "weapon",
  system: {
    actions: {
      hJ2VecOQMqls0xFH: {
        _id: "hJ2VecOQMqls0xFH",
        ability: {
          attack: "_default",
          critMult: 2,
          critRange: 20,
          damage: "str",
        },
        actionType: "twak",
        activation: { type: "attack" },
        damage: {
          parts: [{ formula: "sizeRoll(1, 6, @size)", types: ["piercing"] }],
        },
        name: "Throw",
        range: { maxIncrements: 5, units: "ft", value: "20" },
        sort: 100000,
      },
      zm0hgspvrs1pzl9h: {
        _id: "zm0hgspvrs1pzl9h",
        ability: {
          attack: "_default",
          critMult: 2,
          critRange: 20,
          damage: "str",
        },
        actionType: "mwak",
        activation: { type: "attack" },
        damage: {
          parts: [{ formula: "sizeRoll(1, 6, @size)", types: ["piercing"] }],
        },
        name: "Melee",
        range: { units: "melee", value: "20" },
        sort: 0,
      },
    },
    subType: "simple",
    weaponSubtype: "1h",
    price: 1,
    weight: { value: 3 },
    hp: { base: 5 },
    hardness: 10,
  },
};

const LONGSWORD = {
  name: "Longsword, +1",
  type: "weapon",
  system: {
    actions: {
      a: {
        ability: { critMult: 2, critRange: 19 },
        actionType: "mwak",
        damage: { parts: [{ formula: "1d8", types: ["slashing"] }] },
        name: "Melee",
      },
    },
    subType: "martial",
    weaponSubtype: "1h",
    properties: ["rch"],
    enh: 1,
    quantity: 1,
    equipped: true,
    price: 2315,
    weight: { value: 4 },
  },
};

const CHAIN_SHIRT = {
  name: "Chain shirt",
  type: "armor",
  system: {
    subType: "armor",
    equipmentSubtype: "lightArmor",
    armor: {
      bonus: 4,
      maximumDexBonus: 4,
      checkPenalty: 2,
      arcaneSpellFailure: 20,
    },
    quantity: 1,
    equipped: true,
    price: 100,
    weight: { value: 25 },
  },
};

const ROPE = {
  name: "Rope, hemp (50 ft.)",
  type: "equipment",
  system: {
    quantity: 1,
    price: 1,
    weight: { value: 10 },
    description: { value: "<p>50 feet of hemp rope.</p>" },
  },
};

/** A character actor in the vendored content packs' own field spellings. */
const FOUNDRY_CHARACTER = {
  _id: "abc123def456",
  name: "Linna Vastel",
  type: "character",
  system: {
    abilities: {
      str: { value: 16, total: 16, mod: 3, base: 10, damage: 0, drain: 0 },
      dex: { value: 14, total: 14, mod: 2, base: 10, damage: 0, drain: 0 },
      con: { value: 12, total: 12, mod: 1, base: 10, damage: 0, drain: 0 },
      int: { value: 10, total: 10, mod: 0, base: 10, damage: 0, drain: 0 },
      wis: { value: 8, total: 8, mod: -1, base: 10, damage: 0, drain: 0 },
      cha: { value: 13, total: 13, mod: 1, base: 10, damage: 0, drain: 0 },
    },
    attributes: {
      hp: { value: 31, temp: 0, nonlethal: 4, offset: 0 },
      ac: {
        normal: { ability: "dex", value: 0 },
        touch: { ability: "dex", value: 0 },
        flatFooted: { value: 0 },
      },
      naturalAC: 3,
      bab: { value: 4, total: 4 },
      savingThrows: {
        fort: { base: 4, ability: "con", total: 8 },
        ref: { base: 1, ability: "dex", total: 3 },
        will: { base: 4, ability: "wis", total: 3 },
      },
      init: { total: 6 },
      speed: { land: { base: 30 }, fly: { base: null }, swim: { base: null } },
    },
    traits: { size: "med", stature: "tall" },
    skills: {
      acr: { ability: "dex", rank: 3, mod: 2, value: 5, cs: true },
      clm: { ability: "str", rank: 1, mod: 3, value: 4, acp: true, cs: true },
      per: { ability: "wis", rank: 0, mod: -1, value: -1, cs: false },
    },
    details: { alignment: "CG", deity: "", gender: "female", age: "27" },
    currency: { pp: 0, gp: 412, sp: 13, cp: 0 },
    spells: { prepared: [] },
  },
  items: [
    SHORTSPEAR,
    LONGSWORD,
    CHAIN_SHIRT,
    ROPE,
    { name: "Power Attack", type: "feat", system: {} },
    { name: "Weapon Focus (longsword)", type: "feat", system: {} },
    { name: "Magic Missile", type: "spell", system: {} },
    { name: "Burning Hands", type: "spell", system: {} },
    { name: "Dwarf", type: "race", system: {} },
  ],
};

const HERO_LAB_PORTFOLIO = `<?xml version="1.0" encoding="UTF-8"?>
<document signature="Hero Lab Data">
  <public>
    <character name="Corvin Ash">
      <attributes>
        <attribute name="Strength"><attrvalue base="14" modified="17" text="17"/></attribute>
        <attribute name="Dexterity"><attrvalue base="12" modified="12" text="12"/></attribute>
        <attribute name="Constitution"><attrvalue base="13" modified="13" text="13"/></attribute>
        <attribute name="Intelligence"><attrvalue base="10" modified="10" text="10"/></attribute>
        <attribute name="Wisdom"><attrvalue base="12" modified="12" text="12"/></attribute>
        <attribute name="Charisma"><attrvalue base="8" modified="8" text="8"/></attribute>
      </attributes>
      <armorclass ac="19" touch="11" flatfooted="18"/>
      <hitpoints value="27"/>
      <hitpointsmax value="41"/>
      <saves fort="7" ref="3" will="6"/>
      <baseattack name="Base Attack Bonus" value="4"/>
      <hitdice name="Total Hit Dice" value="5"/>
      <size name="Medium"/>
      <skills>
        <skill name="Acrobatics" ranks="5" classskill="yes"/>
        <skill name="Climb" ranks="2" classskill="yes"/>
        <skill name="Spellcraft" ranks="4" classskill="no"/>
        <skill name="Piloting" ranks="3" classskill="no"/>
      </skills>
      <weapons>
        <weapon name="Longsword" attack="+8" damage="1d8+4" equipped="yes"/>
        <ranged name="Longbow" attack="+5" damage="1d8"/>
      </weapons>
      <languages><language>Common</language><language>Dwarven</language></languages>
      <alignment name="Lawful good"/>
      <description>Corvin keeps a careful ledger of every debt he owes.</description>
    </character>
    <character name="Second Hero">
      <attributes><attribute name="Strength"><attrvalue modified="8"/></attribute></attributes>
    </character>
  </public>
</document>`;

const ROLL20_EXPORT = {
  schema_version: 1,
  name: "Rhogar",
  avatar: "",
  bio: "",
  attribs: [
    { name: "strength", current: "18", max: "" },
    { name: "dexterity", current: "12", max: "" },
    { name: "constitution", current: "14", max: "" },
    { name: "intelligence", current: "9", max: "" },
    { name: "wisdom", current: "10", max: "" },
    { name: "charisma", current: "13", max: "" },
    { name: "hp", current: "34", max: "34" },
    { name: "ac", current: "18", max: "" },
    { name: "fort", current: "6", max: "" },
    { name: "ref", current: "2", max: "" },
    { name: "will", current: "4", max: "" },
    { name: "bab", current: "3", max: "" },
    { name: "speed", current: "20", max: "" },
    { name: "size", current: "Medium", max: "" },
    { name: "feats", current: "Power Attack, Cleave, Iron Will", max: "" },
    { name: "skill_acrobatics_ranks", current: "3", max: "" },
    { name: "skill_acrobatics_class", current: "yes", max: "" },
    { name: "skill_acrobatics_mod", current: "7", max: "" },
    {
      name: "repeating_melee_-M4dusTPpXLZyuX3dipz_meleeweaponname",
      current: "Battleaxe",
      max: "",
    },
    {
      name: "repeating_melee_-M4dusTPpXLZyuX3dipz_meleedamage",
      current: "1d8+4",
      max: "",
    },
    {
      name: "repeating_melee_-M4dusTPpXLZyuX3dipz_meleeatkmod",
      current: "7",
      max: "",
    },
    { name: "house_rule_favourite_inn", current: "The Laughing Fox", max: "" },
  ],
  abilities: [],
};

const ok = <T>(
  result: { ok: true; value: T } | { ok: false; error: string },
): T => {
  if (!result.ok) throw new Error(result.error);
  return result.value;
};

describe("the dice spellings the exporters use", () => {
  test("Foundry's sizeRoll becomes the dice this app rolls, and nothing else is guessed", () => {
    expect(sizeRollToDice("sizeRoll(1, 6, @size)")).toBe("1d6");
    expect(sizeRollToDice("sizeRoll(2, 4, @size, 1)")).toBe("2d4");
    expect(sizeRollToDice("1d8")).toBe("1d8");
    expect(sizeRollToDice("@abilities.str.mod + 4")).toBeNull();
    expect(sizeRollToDice(undefined)).toBeNull();
  });

  test("a printed damage line splits into dice and a flat bonus", () => {
    expect(parseDamage("1d8+4")).toEqual({ dice: "1d8", bonus: 4 });
    expect(parseDamage("2d6")).toEqual({ dice: "2d6", bonus: 0 });
    expect(parseDamage("+5")).toEqual({ dice: "", bonus: 5 });
    expect(parseDamage("1d8 - 1")).toEqual({ dice: "1d8", bonus: -1 });
    expect(parseDamage("1d8+4 plus 1d6 fire")).toBeNull();
    expect(parseDamage("")).toBeNull();
  });
});

describe("Foundry PF1e actor JSON", () => {
  test("the system's own weapon becomes an item whose attack line the sheet's own rule authors", () => {
    const character = ok(importFoundryCharacter(FOUNDRY_CHARACTER));
    const spear = character.items.find((item) => item.name === "Shortspear");
    expect(spear).toBeDefined();
    expect(spear?.system).toMatchObject({
      category: "weapon",
      quantity: 1,
      value: 1,
      weight: 3,
      hardness: 10,
    });
    // the thrown action wins (its melee line is the same dice with no range), as the converter reads it
    expect(spear?.system.weapon).toMatchObject({
      class: "thrown",
      handedness: "one-handed",
      proficiency: "simple",
      damageDice: "1d6",
      damageType: "piercing",
      critMultiplier: 2,
      critThreatMin: 20,
      rangeIncrementFt: 20,
    });

    // …and the line the actor ends up with is the one `attackEntryFromWeapon` authors for that item
    const read = readInventoryItems([
      { _id: "i1", type: "item", name: "Shortspear", system: spear?.system },
    ]).items;
    const expectedItem = read[0];
    if (expectedItem === undefined)
      throw new Error("the weapon item did not resolve");
    const expected = attackEntryFromWeapon({
      item: expectedItem,
      size: "Medium",
    });
    const attacks = character.system.attacks as Array<Record<string, unknown>>;
    expect(attacks).toHaveLength(2);
    expect(attacks[0]).toMatchObject({
      name: expected.name,
      ranged: expected.ranged,
      damageDice: expected.damageDice,
      critMultiplier: expected.critMultiplier,
    });
    // the line carries no flat damage bonus: the ability contribution is *derived* from the
    // character's own Strength, so baking a number in here would count it twice
    expect(attacks[0]?.damageBonus).toBeUndefined();
    expect(character.read.join("\n")).toContain(
      "attack lines authored from weapons: Shortspear",
    );
    // an enhancement bonus and a reach property ride the weapon block; damage dice stay the dice
    const sword = character.items.find((item) => item.name === "Longsword, +1");
    expect(sword?.system).toMatchObject({ equipped: true, value: 2315 });
    expect(sword?.system.weapon).toMatchObject({
      damageDice: "1d8",
      damageType: "slashing",
      reach: true,
      critThreatMin: 19,
    });
  });

  test("armor/shield items carry the slot the AC path needs, and gear keeps its description", () => {
    const character = ok(importFoundryCharacter(FOUNDRY_CHARACTER));
    const shirt = character.items.find((item) => item.name === "Chain shirt");
    expect(shirt?.system).toMatchObject({
      category: "armor",
      equipped: true,
      value: 100,
      weight: 25,
      armor: {
        slot: "armor",
        proficiency: "light",
        armorBonus: 4,
        maxDexBonus: 4,
        checkPenalty: 2,
        spellFailure: 20,
      },
    });
    const rope = character.items.find(
      (item) => item.name === "Rope, hemp (50 ft.)",
    );
    expect(rope?.system.description).toBe("50 feet of hemp rope.");
  });

  test("the actor's own numbers arrive as components, never as totals it can recompute", () => {
    const { system, read } = ok(importFoundryCharacter(FOUNDRY_CHARACTER));
    expect(system.abilities).toEqual({
      str: 16,
      dex: 14,
      con: 12,
      int: 10,
      wis: 8,
      cha: 13,
    });
    // the content packs state a hit-point pool and no maximum (0 of 597 sampled): authored as
    // both, and the report says so rather than leaving a character with no maximum
    expect(system.hp).toBe(31);
    expect(system.hpMax).toBe(31);
    expect(system.nonlethalDamage).toBe(4);
    // naturalAC is a bare number in these packs; the published triple is all zeroes here, so the
    // component path is the one that carries a real fact
    expect(system.armorClass).toEqual({ natural: 3 });
    expect(system.acTotals).toBeUndefined();
    expect(system.acMode).toBeUndefined();
    expect(system.saves).toEqual({ fort: 8, ref: 3, will: 3 });
    // a stored save total already contains its ability modifier
    expect(system.savesAsTotal).toBe(true);
    expect(system.baseAttack).toBe(4);
    expect(system.speedFt).toBe(30);
    // The pack spelling is a short key ("med"), normalized on read: authoring it raw would fail
    // the actor validator, and the character would derive as a blank sheet.
    expect(system.size).toBe("Medium");
    expect(system.skills).toEqual({
      acrobatics: { ranks: 3, classSkill: true },
      climb: { ranks: 1, classSkill: true },
    });
    expect(system.feats).toEqual(["Power Attack", "Weapon Focus (longsword)"]);
    expect(system.currency).toEqual({ gp: 412, sp: 13 });
    expect(read.join("\n")).toContain("abilities: str 16, dex 14");
  });

  test("what it could not place is reported, in the source's own words", () => {
    const { warnings } = ok(importFoundryCharacter(FOUNDRY_CHARACTER));
    const text = warnings.join("\n");
    expect(text).toContain("no hit-point maximum");
    expect(text).toContain("2 spell item(s) were not imported");
    expect(text).toContain("spell lists are authored on the Casting tab");
    expect(text).toContain("1 race item(s)");
    expect(text).toContain("initiative total 6 was not imported");
    expect(text).toMatch(/\d+ personal-detail field\(s\)/);
    expect(text).toContain("skill totals were not imported");
  });

  test("a source that states nothing leaves the field unauthored (never a default)", () => {
    const bare = ok(
      importFoundryCharacter({
        name: "Nameless",
        type: "character",
        system: { abilities: { str: { value: 12 } } },
        items: [],
      }),
    );
    expect(bare.system.abilities).toEqual({ str: 12 });
    expect("hp" in bare.system).toBe(false);
    expect("hpMax" in bare.system).toBe(false);
    expect("armorClass" in bare.system).toBe(false);
    expect("saves" in bare.system).toBe(false);
    expect(bare.system.attacks).toBeUndefined();
    expect(bare.warnings.join("\n")).toContain(
      "no weapon was found in the export",
    );
  });

  test("an actor with nothing recognisable is refused rather than imported empty", () => {
    const result = importFoundryCharacter({
      name: "Empty",
      type: "character",
      system: {},
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("nothing recognisable");
  });
});

describe("Hero Lab XML", () => {
  test("abilities come from attrvalue/@modified, the way MapTool's own importer reads them", () => {
    const { system, name } = ok(importHeroLabCharacter(HERO_LAB_PORTFOLIO));
    expect(name).toBe("Corvin Ash");
    expect(system.abilities).toEqual({
      str: 17,
      dex: 12,
      con: 13,
      int: 10,
      wis: 12,
      cha: 8,
    });
  });

  test("the saves are read by label, however the portfolio spells them", () => {
    const xml = `<document><character name="Labeled Saves">
      <attributes><attribute name="Strength"><attrvalue modified="12"/></attribute></attributes>
      <saves fortitude="7" reflex="3" willpower="9" />
    </character></document>`;
    const { system } = ok(importHeroLabCharacter(xml));
    expect(system.saves).toEqual({ fort: 7, ref: 3, will: 9 });
    expect(system.savesAsTotal).toBe(true);
  });

  test("AC and the saves come across as published totals, flagged as such", () => {
    const { system, read, warnings } = ok(
      importHeroLabCharacter(HERO_LAB_PORTFOLIO),
    );
    expect(system.acTotals).toEqual({ normal: 19, touch: 11, flatFooted: 18 });
    expect(system.acMode).toBe("published");
    expect(system.saves).toEqual({ fort: 7, ref: 3, will: 6 });
    expect(system.savesAsTotal).toBe(true);
    expect(read.join("\n")).toContain(
      "AC (published): 19 / touch 11 / flat-footed 18",
    );
    expect(warnings.join("\n")).toContain(
      "will not follow a change of armor or Dexterity",
    );
  });

  test("hp, BAB, hit dice, size and the skill ranks are read; unknown skills are named", () => {
    const { system, warnings } = ok(importHeroLabCharacter(HERO_LAB_PORTFOLIO));
    expect(system.hp).toBe(27);
    expect(system.hpMax).toBe(41);
    expect(system.baseAttack).toBe(4);
    expect(system.hitDice).toBe(5);
    expect(system.size).toBe("Medium");
    expect(system.skills).toEqual({
      acrobatics: { ranks: 5, classSkill: true },
      climb: { ranks: 2, classSkill: true },
      spellcraft: { ranks: 4 },
    });
    expect(warnings.join("\n")).toContain("Piloting");
  });

  test("a printed damage total is decomposed: the dice and only the remainder are kept", () => {
    const { items, read, warnings } = ok(
      importHeroLabCharacter(HERO_LAB_PORTFOLIO),
    );
    expect(items.map((item) => item.name)).toEqual(["Longsword", "Longbow"]);
    // Strength 17 (+3) and a printed `1d8+4`: the +3 is this app's to derive from the character's
    // own scores, so the weapon keeps the +1 that is left — flagged, because that remainder
    // already contains the ability contribution and the derivation must not add it twice.
    expect(items[0]?.system.weapon).toMatchObject({
      class: "melee",
      damageDice: "1d8",
      damageBonus: 1,
      abilityDamageIncluded: true,
    });
    expect(items[0]?.system).toMatchObject({ equipped: true });
    expect(items[1]?.system.weapon).toMatchObject({
      class: "projectile",
      damageDice: "1d8",
    });
    expect(items[1]?.system.weapon).not.toHaveProperty("damageBonus");
    expect(read.join("\n")).toContain("kept on the weapon");
    expect(warnings.join("\n")).toContain("printed were not imported");
  });

  test("the printed damage total reaches the attack line, not only the item", () => {
    const { items } = ok(importHeroLabCharacter(HERO_LAB_PORTFOLIO));
    const { attacks } = attackLinesFromItems(items, "Medium", []);
    expect(attacks[0]).toMatchObject({
      name: "Longsword",
      damageDice: "1d8",
      damageBonus: 1,
      abilityDamageIncluded: true,
    });
  });

  test("a portfolio is a set of characters: the first is imported and the rest are named", () => {
    const { name, warnings } = ok(importHeroLabCharacter(HERO_LAB_PORTFOLIO));
    expect(name).toBe("Corvin Ash");
    expect(warnings.join("\n")).toContain("the portfolio holds 2 characters");
  });

  test("hit dice stated as dice are read as a count", () => {
    // Portfolios write `<hitdice>5d8</hitdice>` as readily as a bare number; the count is the
    // leading integer and the die size is not a fact this app's actor shape keeps.
    const xml = `<document><character name="Dice Form">
      <attributes><attribute name="Strength"><attrvalue modified="12"/></attribute></attributes>
      <hitpoints value="20" max="20" />
      <hitdice>5d8</hitdice>
    </character></document>`;
    const { system } = ok(importHeroLabCharacter(xml));
    expect(system.hitDice).toBe(5);
  });

  test("the element-text shape of an attribute is read too", () => {
    const xml = `<document><character name="Text Form"><attributes>
      <attribute name="Strength"><text>18</text></attribute>
      <attribute name="Dexterity"><attrvalue value="14"/></attribute>
    </attributes><hitpoints value="12" max="12"/></character></document>`;
    const { system } = ok(importHeroLabCharacter(xml));
    expect(system.abilities).toEqual({ str: 18, dex: 14 });
    expect(system.hp).toBe(12);
  });

  test("what the format does not carry is said, not faked", () => {
    const xml = `<document><character name="Sparse"><attributes>
      <attribute name="Strength"><attrvalue modified="10"/></attribute>
    </attributes></character></document>`;
    const { warnings, items } = ok(importHeroLabCharacter(xml));
    const text = warnings.join("\n");
    expect(items).toEqual([]);
    expect(text).toContain("hit points were not found");
    expect(text).toContain("no armor class");
    expect(text).toContain("saving throws were not found");
    expect(text).toContain("lists no weapons");
  });

  test("other documents are refused with the reason a user needs", () => {
    expect(importHeroLabCharacter("<html><body>hello</body></html>").ok).toBe(
      false,
    );
    expect(importHeroLabCharacter("").ok).toBe(false);
  });
});

describe("Roll20 character sheet JSON", () => {
  test("the sheet's own field names are read through the alias table", () => {
    const { name, system, read } = ok(importRoll20Character(ROLL20_EXPORT));
    expect(name).toBe("Rhogar");
    expect(system.abilities).toEqual({
      str: 18,
      dex: 12,
      con: 14,
      int: 9,
      wis: 10,
      cha: 13,
    });
    expect(system.hp).toBe(34);
    expect(system.hpMax).toBe(34);
    expect(system.acTotals).toEqual({ normal: 18 });
    expect(system.acMode).toBe("published");
    expect(system.saves).toEqual({ fort: 6, ref: 2, will: 4 });
    expect(system.baseAttack).toBe(3);
    expect(system.speedFt).toBe(20);
    expect(system.size).toBe("Medium");
    expect(system.skills).toEqual({
      acrobatics: { ranks: 3, classSkill: true },
    });
    expect(read.join("\n")).toContain("hit points: 34/34");
  });

  test("a repeating row becomes a weapon item, and its stored attack modifier is refused", () => {
    const { items, read, warnings } = ok(importRoll20Character(ROLL20_EXPORT));
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ name: "Battleaxe" });
    // Strength 18 (+4) against a stored `1d8+4`: nothing of the printed total is the weapon's
    // own, so the item carries the dice alone and the sheet's own arithmetic regenerates the +4.
    expect(items[0]?.system.weapon).toMatchObject({ damageDice: "1d8" });
    expect(items[0]?.system.weapon).not.toHaveProperty("damageBonus");
    expect(read.join("\n")).toContain(
      "Strength (+4) is derived from the character's own scores",
    );
    const text = warnings.join("\n");
    expect(text).toContain(
      "attack modifiers stored on the sheet's weapon rows were not imported",
    );
    expect(text).toContain("house_rule_favourite_inn");
    expect(text).toContain("skill modifiers were not imported");
  });

  test("free text the sheet keeps for feats splits into the names the sheet shows", () => {
    const { system } = ok(importRoll20Character(ROLL20_EXPORT));
    expect(system.feats).toEqual(["Power Attack", "Cleave", "Iron Will"]);
  });

  test("a JSON export with no attribs is refused with the export path to use", () => {
    const result = importRoll20Character({ name: "No attribs" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("attribs");
  });
});

describe("the front door", () => {
  test("structure decides the format, not the file name", () => {
    expect(
      detectCharacterFormat(JSON.stringify(FOUNDRY_CHARACTER), "sheet.json"),
    ).toBe("foundry");
    expect(
      detectCharacterFormat(JSON.stringify(ROLL20_EXPORT), "foundry.json"),
    ).toBe("roll20");
    expect(detectCharacterFormat(HERO_LAB_PORTFOLIO, "notes.txt")).toBe(
      "herolab",
    );
    expect(detectCharacterFormat("{}", "x.json")).toBeNull();
    expect(detectCharacterFormat("not json at all")).toBeNull();
    expect(detectCharacterFormat("", "x.json")).toBeNull();
  });

  test("everything the three readers author is a block this app can play", () => {
    // The invariant behind the gate: a reader may be tolerant, but its product must pass the same
    // validator the sheet derives with. Checked for each fixture, so a reader that starts authoring
    // a value this app's own actor shape refuses fails here rather than at a table.
    for (const read of [
      importFoundryCharacter(FOUNDRY_CHARACTER),
      importRoll20Character(ROLL20_EXPORT),
      importHeroLabCharacter(HERO_LAB_PORTFOLIO),
    ]) {
      const checked = characterImportCheck(ok(read));
      expect(checked.ok).toBe(true);
    }
  });

  test("a block this app cannot play refuses the import instead of creating a blank sheet", () => {
    // The failure this gate exists for: an actor block the validator refuses derives as a blank
    // 10-in-everything sheet, which looks plausible and is worse than a refusal. The shape that
    // actually reached it was a *reader* bug — the short Foundry size key `"med"`, authored raw
    // before `foundry.ts` normalized it — so the gate is pinned with that exact block.
    const result = characterImportCheck({
      format: "foundry",
      name: "Unplayable",
      system: { abilities: { str: 10 }, size: "med" },
      items: [],
      read: [],
      warnings: [],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("cannot play the character");
      expect(result.error).toContain("size");
      expect(result.error).toContain("Nothing was imported");
    }
  });

  test("an unknown size is reported, not authored as a size category", () => {
    const weird = {
      name: "Odd One",
      system: {
        abilities: { str: { value: 10 } },
        traits: { size: "elephant" },
      },
    };
    const result = importFoundryCharacter(weird);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.system).not.toHaveProperty("size");
      expect(result.value.warnings.join("\n")).toContain("elephant");
    }
  });

  test("a .por archive is explained rather than mis-parsed", () => {
    const result = importCharacter("PK\u0003\u0004binary", {
      fileName: "Corvin.por",
    });
    expect(result.ok).toBe(false);
    if (!result.ok)
      expect(result.error).toContain("a .por file is a zip archive");
  });

  test("every route lands on the same report shape", () => {
    for (const [text, file] of [
      [JSON.stringify(FOUNDRY_CHARACTER), "foundry.json"],
      [HERO_LAB_PORTFOLIO, "hero.xml"],
      [JSON.stringify(ROLL20_EXPORT), "roll20.json"],
    ] as const) {
      const parsed = importCharacter(text, { fileName: file });
      expect(parsed.ok).toBe(true);
      if (!parsed.ok) continue;
      const report = characterImportReport(parsed.value);
      expect(report.name.length).toBeGreaterThan(0);
      expect(report.read.length).toBeGreaterThan(0);
      expect(report.counts.attackLines).toBeGreaterThan(0);
    }
  });

  test("the create op carries the whole character: one actor document, items embedded", () => {
    const character = ok(importCharacter(JSON.stringify(FOUNDRY_CHARACTER)));
    const ops = characterImportOps(character, {
      id: "a-import1",
      gmId: "gm-1",
    });
    expect(ops).toHaveLength(1);
    const op = ops[0];
    if (op === undefined) throw new Error("no op");
    expect(op.kind).toBe("create");
    expect(op.kind === "create" && op.coll).toBe("actors");
    const data =
      op.kind === "create"
        ? (op.data as unknown as Record<string, unknown>)
        : {};
    expect(data.name).toBe("Linna Vastel");
    expect(data.ownership).toEqual({ default: 0, "gm-1": 3 });
    expect((data.flags as Record<string, unknown>).core).toEqual({
      importedFrom: "foundry",
    });
    const items = data.items as Array<Record<string, unknown>>;
    expect(items).toHaveLength(4);
    expect(items[0]?._id).toBe("a-import1-i1");
    expect((data.system as Record<string, unknown>).pf1e).toMatchObject({
      baseAttack: 4,
    });
  });
});
