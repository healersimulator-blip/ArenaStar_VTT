/**
 * M15/M16/M18 — the content packs, checked against the code they claim to describe.
 *
 * `systems/pf1e-core/packs/*.json` is content: nothing imports it, it reaches the app as a file
 * inside a package record in IndexedDB, and the moment a number in it is *also* a number in a
 * rule the pair has to be pinned. That is what this file is. Each section reads the shipped file
 * from disk, then recomputes it against the table or function the pack says it mirrors, so the
 * packs and the code cannot drift apart silently (Gap List §6/P5's last bullet: the tables, not
 * the hand-typed numbers, are the source of truth).
 *
 * It also enforces the platform's own guard — `COMPENDIUM_MAX_ENTRIES` — the manifest declaration
 * rule for every pack file in the folder, and the invariant that makes "load on demand" more than a
 * phrase: no file in `src/` may reach into `systems/` at all.
 */
import { describe, expect, test } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  COMPENDIUM_MAX_ENTRIES,
  indexPack,
  parseCompendiumPack,
  searchCompendia,
} from "../../src/core/compendium";
import {
  armorReducesSpeed,
  arcaneSpellFailureForCategory,
  attacksOfOpportunityPerRound,
  babAtLevel,
  PF1E_TWF_PENALTY_TABLE,
  saveBonusAtLevel,
  speedAfterArmor,
} from "../../src/packages/pf1e/rulesTables";
import {
  ADVANCED_FIREARM_MAX_INCREMENTS,
  brokenWeaponAdjustments,
  FIREARM_TOUCH_AC_INCREMENTS,
  MAX_RANGE_INCREMENTS,
  UNARMED_STRIKE_DAMAGE_BY_SIZE,
} from "../../src/packages/pf1e/weapons";
import { brokenArmorAdjustments } from "../../src/packages/pf1e/items";
import {
  deadlyAimStep,
  featAttackParts,
  improvedCriticalApplies,
  manyshotPlan,
  offHandAttackCount,
  powerAttackStep,
} from "../../src/packages/pf1e/feats";
import {
  compilePF1eProfile,
  PRECREATED_PF1E_UNITS,
} from "../../src/packages/pf1e/schema";
import { PF1E_MASS_SPELLS } from "../../src/packages/massBattlePf1e";
import {
  parsePackSpellOrder,
  spellRangeFeet,
} from "../../src/packages/pf1e/spellPacks";

const packsDir = fileURLToPath(
  new URL("../../systems/pf1e-core/packs", import.meta.url),
);
const manifestPath = fileURLToPath(
  new URL("../../systems/pf1e-core/manifest.json", import.meta.url),
);

type Block = Record<string, unknown>;
type PackEntry = {
  id: string;
  name: string;
  data: { type: string; name: string; system: Block };
};
type PackFile = {
  name: string;
  type: string;
  note?: string;
  entries: PackEntry[];
};

function readPack(file: string): PackFile {
  return JSON.parse(readFileSync(join(packsDir, file), "utf8")) as PackFile;
}

/** A `system` sub-block. Absent is a failure, so the tests below can stay readable. */
const block = (system: Block, key: string): Block => {
  const value = system[key];
  expect(value, `missing "${key}"`).toBeTypeOf("object");
  return value as Block;
};
const num = (source: Block, key: string): number => {
  const value = source[key];
  expect(typeof value, `${key} is not a number`).toBe("number");
  return value as number;
};
const str = (source: Block, key: string): string => {
  const value = source[key];
  expect(typeof value, `${key} is not a string`).toBe("string");
  return value as string;
};
const bool = (source: Block, key: string): boolean => {
  const value = source[key];
  expect(typeof value, `${key} is not a boolean`).toBe("boolean");
  return value as boolean;
};
const list = (source: Block, key: string): string[] => {
  const value = source[key];
  expect(Array.isArray(value), `${key} is not an array`).toBe(true);
  return value as string[];
};

describe("pf1e-core content packs (M15/M16/M18)", () => {
  test("every pack file in the folder is declared in the manifest, and vice versa", () => {
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
      packs: Array<{ name: string; type: string; file: string }>;
    };
    const declared = manifest.packs.map((p) => p.file).sort();
    const onDisk = readdirSync(packsDir)
      .filter((f) => f.endsWith(".json"))
      .map((f) => `packs/${f}`)
      .sort();
    // A file no manifest entry names is invisible to the importer — exactly the "present but not
    // covered" failure §6 warns about — and a declared file that is missing fails the build.
    expect(declared).toEqual(onDisk);
    for (const descriptor of manifest.packs) {
      const pack = readPack(descriptor.file.replace("packs/", ""));
      expect(pack.name).toBe(descriptor.name);
      expect(pack.type).toBe(descriptor.type);
      // M18: the note is what tells a reader these are content, not code, and where the checks live.
      expect(typeof pack.note).toBe("string");
      expect(str(pack as unknown as Block, "note")).toContain(
        "pf1eContentPacks.test.ts",
      );
    }
  });

  test("the bestiary pack's derived numbers recompute from the shared tables (M16/M17)", () => {
    const pack = readPack("bestiary.json");
    expect(pack.entries.length).toBeGreaterThanOrEqual(30);
    let derived = 0;
    for (const entry of pack.entries) {
      const system = entry.data.system;
      if (system["mirror"] === undefined) continue; // the six originals predate the mirror block
      const pf1e = block(system, "pf1e");
      const mirror = block(system, "mirror");
      derived++;
      const size = str(pf1e, "size");
      // Table 8-4's attack/AC column — the same ladder `rulesTables.ts` publishes, spelled out
      // here on purpose: if the pack's size string ever stops mapping to a row, this fails first.
      const acSize = {
        Fine: 8,
        Diminutive: 4,
        Tiny: 2,
        Small: 1,
        Medium: 0,
        Large: -1,
        Huge: -2,
        Gargantuan: -4,
        Colossal: -8,
      }[size];
      expect(
        acSize,
        `bestiary entry "${entry.id}" authors an unknown size "${size}"`,
      ).toBeDefined();
      const dex =
        typeof pf1e["dexMod"] === "number" ? (pf1e["dexMod"] as number) : 0;
      const nat =
        typeof pf1e["naturalArmor"] === "number"
          ? (pf1e["naturalArmor"] as number)
          : 0;
      const armor =
        typeof pf1e["armorBonus"] === "number"
          ? (pf1e["armorBonus"] as number)
          : 0;
      const shield =
        typeof pf1e["shieldBonus"] === "number"
          ? (pf1e["shieldBonus"] as number)
          : 0;
      // AC = 10 + size + Dex + natural + armor + shield, and touch AC drops the worn bonuses.
      expect(10 + (acSize ?? 0) + dex + nat + armor + shield).toBe(
        num(pf1e, "ac"),
      );
      expect(10 + (acSize ?? 0) + dex).toBe(num(pf1e, "touchAc"));
      const progression = str(mirror, "progression");
      const hitDice = num(mirror, "hitDice");
      expect(babAtLevel(progression as "good", hitDice)).toBe(num(pf1e, "bab"));
      const good = list(mirror, "goodSaves");
      // The saves are mirror-side content: recorded, checkable, and NOT in `pf1e`, because the mass
      // engine reads no save column and the two scales differ on ability inclusion (D-226).
      const baseSaves = block(mirror, "baseSaves");
      expect(num(baseSaves, "fort")).toBe(
        saveBonusAtLevel(good.includes("fort") ? "good" : "poor", hitDice),
      );
      expect(num(baseSaves, "ref")).toBe(
        saveBonusAtLevel(good.includes("ref") ? "good" : "poor", hitDice),
      );
      expect(num(baseSaves, "will")).toBe(
        saveBonusAtLevel(good.includes("will") ? "good" : "poor", hitDice),
      );
      expect(pf1e["fort"]).toBeUndefined();
      expect(pf1e["conMod"]).toBeUndefined();
      // Every entry has a row in the profile table the deploy seeds from (M18's "generate or
      // validate PRECREATED_PF1E_UNITS from packs", in the validate direction).
      const row = Object.values(PRECREATED_PF1E_UNITS).find(
        (p0) => p0.name === entry.name,
      );
      expect(
        row,
        `PRECREATED_PF1E_UNITS has no profile named "${entry.name}"`,
      ).toBeDefined();
    }
    expect(derived).toBeGreaterThanOrEqual(30);
    // The mirror set covers the six roles the demo deploys, in both directions.
    const names = new Set(pack.entries.map((e) => e.name));
    for (const role of [
      "infantry",
      "cavalry",
      "artillery",
      "hero",
      "troll",
      "golem",
    ]) {
      const profile = PRECREATED_PF1E_UNITS[role];
      expect(profile, `no PRECREATED_PF1E_UNITS.${role}`).toBeDefined();
      expect(names.has(profile?.name ?? "")).toBe(true);
    }
  });

  test("the class pack's twenty levels are the shared ladders, not typed numbers (M16/M17)", () => {
    const pack = readPack("classes.json");
    expect(pack.entries.map((e) => e.id).sort()).toEqual([
      "barbarian",
      "cleric",
      "fighter",
      "rogue",
      "sorcerer",
      "wizard",
    ]);
    const hdByClass: Record<string, string> = {
      barbarian: "d12",
      cleric: "d8",
      fighter: "d10",
      rogue: "d8",
      sorcerer: "d6",
      wizard: "d6",
    };
    const featNames = new Set(
      readPack("feats.json").entries.map((f) => f.name),
    );
    for (const entry of pack.entries) {
      const system = entry.data.system;
      expect(str(system, "hd")).toBe(hdByClass[entry.id]);
      const progression = str(system, "babProgression");
      const good = list(system, "goodSaves");
      const levels = system["levels"] as Array<Block>;
      expect(levels.length).toBe(20);
      for (const row of levels) {
        const level = num(row, "level");
        expect(num(row, "bab")).toBe(babAtLevel(progression as "good", level));
        expect(num(row, "fort")).toBe(
          saveBonusAtLevel(good.includes("fort") ? "good" : "poor", level),
        );
        expect(num(row, "ref")).toBe(
          saveBonusAtLevel(good.includes("ref") ? "good" : "poor", level),
        );
        expect(num(row, "will")).toBe(
          saveBonusAtLevel(good.includes("will") ? "good" : "poor", level),
        );
      }
      // Every listed bonus combat feat is a row in feats.json, by exact name — a class cannot
      // advertise a feat the pack does not describe.
      for (const feat of list(system, "bonusCombatFeats"))
        expect(featNames.has(feat)).toBe(true);
    }
  });

  test("the equipment pack mirrors the weapon and armor tables it names (M16/M17)", () => {
    const pack = readPack("equipment.json");
    const systems = new Map(
      pack.entries.map((e) => [str(e.data.system, "table"), e.data.system]),
    );
    expect([...systems.keys()].sort()).toEqual([
      "armorCategories",
      "brokenItemAdjustments",
      "firearmTouchAcIncrements",
      "maxRangeIncrements",
      "unarmedStrikeDamageBySize",
    ]);
    expect(systems.get("unarmedStrikeDamageBySize")?.["rows"]).toEqual({
      ...UNARMED_STRIKE_DAMAGE_BY_SIZE,
    });
    expect(systems.get("maxRangeIncrements")?.["rows"]).toEqual({
      ...MAX_RANGE_INCREMENTS,
    });
    expect(
      num(
        systems.get("maxRangeIncrements") as Block,
        "advancedFirearmOverride",
      ),
    ).toBe(ADVANCED_FIREARM_MAX_INCREMENTS);
    expect(systems.get("firearmTouchAcIncrements")?.["rows"]).toEqual({
      ...FIREARM_TOUCH_AC_INCREMENTS,
    });

    const broken = block(systems.get("brokenItemAdjustments") as Block, "rows");
    expect(str(broken, "armorShieldAcBonus")).toBe("halved, rounding down");
    expect(str(broken, "armorCheckPenalty")).toBe("doubled");
    // The prose is not enough: run the shipped functions and check the arithmetic matches the words.
    expect(
      brokenArmorAdjustments({
        armorBonus: 6,
        shieldBonus: 2,
        checkPenalty: -2,
        broken: true,
      }),
    ).toEqual({
      armorBonus: 3,
      shieldBonus: 1,
      checkPenalty: -4,
    });
    expect(
      brokenWeaponAdjustments({
        broken: true,
        critThreatMin: 19,
        critMultiplier: 3,
      }),
    ).toEqual({
      attack: num(broken, "weaponAttack"),
      damage: num(broken, "weaponDamage"),
      critThreatMin: 20,
      critMultiplier: 2,
    });

    const categories = pack.entries.filter((e) =>
      e.id.startsWith("armor-category-"),
    );
    expect(categories.length).toBe(4);
    for (const row of categories) {
      const system = row.data.system;
      const category = str(system, "category");
      expect(num(system, "arcaneSpellFailure")).toBe(
        arcaneSpellFailureForCategory(category),
      );
      expect(bool(system, "reducesSpeed")).toBe(armorReducesSpeed(category));
      if (category === "light") expect(speedAfterArmor(30, category)).toBe(30);
      if (category === "medium" || category === "heavy")
        expect(speedAfterArmor(30, category)).toBe(20);
    }
  });

  test("the feats pack's mechanics are what the shipped functions do (M16)", () => {
    const pack = readPack("feats.json");
    expect(pack.entries.length).toBeGreaterThanOrEqual(20);
    // M16 names its feat coverage by hand, so the box is checked literally: every one of those
    // feats is a row. Being a row is not a claim of automation — the rows below Dodge down are
    // `descriptive` with the reason in `mechanismSource`, which is the split the pack exists to
    // make visible (and `DEVIATIONS.md` records why they stay that way).
    const namedByTheBox = [
      "improved-initiative",
      "toughness",
      "dodge",
      "mobility",
      "spring-attack",
      "combat-casting",
      "great-fortitude",
      "iron-will",
      "lightning-reflexes",
      "power-attack",
      "deadly-aim",
      "combat-expertise",
      "improved-bull-rush",
      "improved-disarm",
      "improved-grapple",
      "improved-sunder",
      "improved-trip",
    ];
    for (const id of namedByTheBox) {
      expect(
        pack.entries.some((e) => e.id === id),
        `feats.json is missing ${id}`,
      ).toBe(true);
    }
    const systemOf = (id: string): Block => {
      const entry = pack.entries.find((e) => e.id === id);
      expect(entry, `feats.json has no row "${id}"`).toBeDefined();
      return entry?.data.system as Block;
    };
    // The mechanical/descriptive split is the point of the pack: a feat only "affects calculations"
    // here if a rule reads it, and every mechanical row names the function that does.
    const mechanical = pack.entries.filter(
      (e) => str(e.data.system, "automation") === "automated",
    );
    expect(mechanical.length).toBeGreaterThanOrEqual(10);
    for (const entry of pack.entries) {
      const system = entry.data.system;
      if (str(system, "automation") === "automated") {
        expect(str(system, "mechanismSource")).toMatch(/\.ts's /);
      } else {
        expect(str(system, "mechanismSource")).toMatch(
          /^no rule reads the feat by name/,
        );
      }
    }

    const power = block(systemOf("power-attack"), "mechanical");
    expect(num(power, "babDivisor")).toBe(4);
    expect(num(power, "maxSteps")).toBe(5);
    // The ladder the pack describes, at the BABs where it steps.
    expect(
      [0, 1, 4, 8, 12, 16, 20].map(
        (bab) => powerAttackStep(bab) * num(power, "damagePerStep"),
      ),
    ).toEqual([0, 2, 4, 6, 8, 10, 10]);
    expect(deadlyAimStep(8)).toBe(powerAttackStep(8));

    const twf = block(systemOf("two-weapon-fighting"), "mechanical");
    const noFeat =
      PF1E_TWF_PENALTY_TABLE[0] as (typeof PF1E_TWF_PENALTY_TABLE)[number];
    const withFeat =
      PF1E_TWF_PENALTY_TABLE[2] as (typeof PF1E_TWF_PENALTY_TABLE)[number];
    expect(noFeat.primaryHand + num(twf, "primaryHandPenaltyReduction")).toBe(
      withFeat.primaryHand,
    );
    expect(noFeat.offHand + num(twf, "offHandPenaltyReduction")).toBe(
      withFeat.offHand,
    );
    expect(offHandAttackCount([])).toBe(1);
    expect(offHandAttackCount(["Improved Two-Weapon Fighting"])).toBe(2);
    expect(offHandAttackCount(["Greater Two-Weapon Fighting"])).toBe(3);

    const manyshot = block(systemOf("manyshot"), "mechanical");
    expect(num(manyshot, "minBab")).toBe(6);
    const atSix = manyshotPlan({ feats: ["Manyshot"], bab: 6, ranged: true });
    expect(atSix.ok).toBe(true);
    if (atSix.ok) expect(atSix.arrows).toBe(num(manyshot, "arrowsBase"));
    const atSixteen = manyshotPlan({
      feats: ["Manyshot"],
      bab: 16,
      ranged: true,
    });
    if (atSixteen.ok) expect(atSixteen.arrows).toBe(num(manyshot, "maxArrows"));
    expect(manyshotPlan({ feats: [], bab: 16, ranged: true }).ok).toBe(false);

    const pb = block(systemOf("point-blank-shot"), "mechanical");
    expect(
      featAttackParts({
        feats: ["Point-Blank Shot"],
        bab: 4,
        ranged: true,
        pointBlankShot: true,
        distanceFt: num(pb, "withinFeet"),
      }),
    ).toContainEqual({
      label: "Point-Blank Shot",
      value: num(pb, "attackBonus"),
    });
    expect(
      featAttackParts({
        feats: ["Point-Blank Shot"],
        bab: 4,
        ranged: true,
        pointBlankShot: true,
        distanceFt: num(pb, "withinFeet") + 5,
      }),
    ).toEqual([]);

    const wf = block(systemOf("weapon-focus"), "mechanical");
    expect(
      featAttackParts({
        feats: ["Weapon Focus (Longsword)"],
        bab: 1,
        ranged: false,
        weaponName: "Longsword",
      }),
    ).toEqual([{ label: "Weapon Focus", value: num(wf, "attackBonus") }]);

    const ic = block(systemOf("improved-critical"), "mechanical");
    expect(
      improvedCriticalApplies({
        feats: ["Improved Critical (Longsword)"],
        weaponName: "Longsword",
      }),
    ).toBe(true);
    expect(
      improvedCriticalApplies({ feats: [], weaponName: "Longsword" }),
    ).toBe(false);
    // The doubling the row describes is the compile's own arithmetic (schema.ts, §2.5).
    const widened = compilePF1eProfile(1, {
      weapon: { critThreatMin: 20, improvedCritical: true },
    });
    expect((21 - 20) * num(ic, "threatRangeExpansion")).toBe(
      21 - widened.critThreatMin,
    );

    const cr = block(systemOf("combat-reflexes"), "mechanical");
    expect(attacksOfOpportunityPerRound(0, false)).toBe(1);
    expect(attacksOfOpportunityPerRound(3, true)).toBe(4);
    expect(num(cr, "minimum")).toBe(1);
    expect(attacksOfOpportunityPerRound(-2, true)).toBe(num(cr, "minimum"));
  });

  test("the spell pack's automation split is load-bearing, and its automated rows match the code mirrors (M15/M18)", () => {
    const pack = readPack("spells.json");
    expect(pack.entries.length).toBeGreaterThanOrEqual(40);
    const automated = pack.entries.filter(
      (e) => str(e.data.system, "automation") === "automated",
    );
    const descriptive = pack.entries.filter(
      (e) => str(e.data.system, "automation") === "descriptive",
    );
    expect(automated.length + descriptive.length).toBe(pack.entries.length);
    expect(automated.map((e) => e.id).sort()).toEqual(
      Object.keys(PF1E_MASS_SPELLS).sort(),
    );

    for (const entry of descriptive) {
      const system = entry.data.system;
      expect(system["massBattle"]).toBeUndefined();
      expect(str(system, "automationNote").length).toBeGreaterThan(40);
      // An intent block is documentation: nothing may read `massBattleIntent`, and it may not
      // pretend to be a shape the resolver owns.
      if (system["massBattleIntent"] !== undefined) {
        expect(block(system, "massBattleIntent")["shape"]).not.toBe("circle");
      }
    }

    for (const entry of automated) {
      const def = PF1E_MASS_SPELLS[entry.id];
      expect(
        def,
        `${entry.id} is automated in the pack but absent from PF1E_MASS_SPELLS`,
      ).toBeDefined();
      // The mirrored entry in spellPacks.ts carries the same executable fields, byte for byte.
      // `notes` is the pack's prose (it is what a GM reads), so it is checked for substance
      // rather than compared with a code comment.
      const system = entry.data.system;
      const packBattle = { ...block(system, "massBattle") };
      const mirrorBattle = {
        ...block(block(def?.entry as Block, "system"), "massBattle"),
      };
      // The prose is the pack's own; the code mirror carries none of it, so it is compared for
      // substance (it must cite the transcription) rather than for equality.
      expect(str(packBattle, "notes")).toContain("Transcribed");
      delete packBattle["notes"];
      delete mirrorBattle["notes"];
      expect(mirrorBattle).toEqual(packBattle);
      const mirrorSystem = block(def?.entry as Block, "system");
      expect(str(mirrorSystem, "savingThrow")).toBe(str(system, "savingThrow"));
      expect(bool(mirrorSystem, "spellResistance")).toBe(
        bool(system, "spellResistance"),
      );
      // The verified level the DC uses is the pack's own sorcerer/wizard column — the content bug
      // D-151 recorded is gone, so the pack and the constant cannot disagree.
      expect(num(block(system, "level"), "sorcererWizard")).toBe(def?.level);

      for (const casterLevel of [1, 5, 10, 20]) {
        // The parser reads a pack *document* (what `data` holds), not the compendium wrapper — the
        // same shape the mirror table stores.
        const fromPack = parsePackSpellOrder({
          entry: entry.data,
          casterLevel,
        });
        const fromMirror = parsePackSpellOrder({
          entry: def?.entry,
          casterLevel,
        });
        expect(
          fromPack.ok,
          `${entry.id} at CL ${casterLevel}: ${fromPack.issues.map((i) => i.message).join("; ")}`,
        ).toBe(true);
        expect(fromPack.order).toEqual(fromMirror.order);
        // Every automated blast is Reflex-half for half, so Evasion applies (validator-enforced,
        // asserted here so a future pack row cannot quietly break it).
        expect(fromPack.order?.evasionApplies).toBe(true);
        expect(fromPack.order?.damageDiceCount).toBe(
          Math.min(casterLevel, num(packBattle, "maxDice")),
        );
      }
    }
    // The line shape's per-level length is the one new field M15 needed, and it is Lightning
    // Bolt's "+10 ft./level" — 110 ft. at CL 1, 300 ft. at CL 20.
    const bolt = pack.entries.find((e) => e.id === "lightning-bolt");
    expect(bolt).toBeDefined();
    expect(
      parsePackSpellOrder({ entry: bolt?.data, casterLevel: 1 }).order?.radius,
    ).toBe(110);
    expect(
      parsePackSpellOrder({ entry: bolt?.data, casterLevel: 20 }).order?.radius,
    ).toBe(300);
    expect(
      parsePackSpellOrder({ entry: bolt?.data, casterLevel: 20 }).order
        ?.widthFeet,
    ).toBe(5);
    // Fireball's remote point of origin is still priced by the standard range categories.
    const fireball = pack.entries.find((e) => e.id === "fireball");
    expect(fireball).toBeDefined();
    expect(spellRangeFeet("long", 5)).toBe(600);
    expect(
      parsePackSpellOrder({ entry: fireball?.data, casterLevel: 5 }).order
        ?.rangeCategory,
    ).toBe("long");
  });

  test("the 2,000-entry pack cap is enforced at the parser for app-origin packs, with headroom to spare (M18; D-252)", () => {
    const entry = (i: number): unknown => ({
      id: `e-${i}`,
      name: `Entry ${i}`,
      data: { type: "item", name: `Entry ${i}` },
    });
    const atCap = parseCompendiumPack({
      name: "At cap",
      type: "items",
      entries: Array.from({ length: COMPENDIUM_MAX_ENTRIES }, (_, i) =>
        entry(i),
      ),
    });
    expect(atCap.ok).toBe(true);
    const overCap = parseCompendiumPack({
      name: "Over cap",
      type: "items",
      entries: Array.from({ length: COMPENDIUM_MAX_ENTRIES + 1 }, (_, i) =>
        entry(i),
      ),
    });
    expect(overCap.ok).toBe(false);
    if (!overCap.ok)
      expect(overCap.error).toContain(String(COMPENDIUM_MAX_ENTRIES));
    // And the shipped packs sit inside it, so the guard is not fiction.
    for (const file of readdirSync(packsDir).filter((f) =>
      f.endsWith(".json"),
    )) {
      const pack = readPack(file);
      expect(pack.entries.length).toBeLessThanOrEqual(COMPENDIUM_MAX_ENTRIES);
      // Names are length-capped too (the same DoS guard), and no entry smuggles an _id.
      for (const e of pack.entries)
        expect(e.name.length).toBeLessThanOrEqual(80);
    }
  });

  test("the shipped packs index and search, and stay out of the base HTML (M18)", () => {
    const parsed = readdirSync(packsDir)
      .filter((f) => f.endsWith(".json"))
      .map((f) => parseCompendiumPack(readPack(f)));
    // A pack that fails `parseCompendiumPack` is a pack the importer skips in silence, so the
    // parse result is the assertion, not a detail.
    expect(parsed.map((p) => (p.ok ? null : p.error))).toEqual([
      null,
      null,
      null,
      null,
      null,
    ]);
    const packs = parsed.flatMap((p) => (p.ok ? [p.value] : []));
    expect(packs.length).toBe(5);
    // The by-id lookup the panel uses, and the search the GM types into.
    const spellPack = packs.find((p) => p.name === "PF1e Spells");
    expect(spellPack).toBeDefined();
    const spellIndex = indexPack(spellPack as (typeof packs)[number]);
    expect(spellIndex.get("fireball")?.name).toBe("Fireball");
    expect(spellIndex.get("cone-of-cold")?.name).toBe("Cone of Cold");
    const packsByName = (hits: Array<{ pack: { name: string } }>): string[] =>
      [...new Set(hits.map((h) => h.pack.name))].sort();
    const coneHits = searchCompendia(packs, "cone of cold");
    expect(coneHits.length).toBeGreaterThan(0);
    expect(packsByName(coneHits)).toContain("PF1e Spells");
    expect(searchCompendia(packs, "iron golem").length).toBeGreaterThan(0);
    // Every automated spell is findable by its own name — the pack's purpose is search, so an
    // entry the index cannot surface is content nobody can reach.
    for (const id of Object.keys(PF1E_MASS_SPELLS)) {
      const name = spellIndex.get(id)?.name ?? "";
      expect(
        searchCompendia(packs, name).some((h) => h.entry.name === name),
      ).toBe(true);
    }

    // "Load content on demand from IndexedDB instead of inflating the base HTML": the only way in is
    // the importer's file map (`hostBoot.compendia()` reads `rec.files[descriptor.file]` of a package
    // record in IndexedDB), so no source file may *load* a pack. Comments naming the path are how the
    // mirroring is documented, so the patterns below are code-shaped: a static import, a filesystem
    // read, or a fetch of something under `systems/`.
    const LOADS_PACKS = [
      /\bfrom\s+["'][^"']*systems\//,
      /\brequire\s*\(\s*["'][^"']*systems\//,
      /\breadFileSync\s*\([^)]*systems\//,
      /\bfetch\s*\(\s*["'][^"']*systems\//,
      /\bnew\s+URL\s*\(\s*["'][^"']*systems\//,
      /\bimport\s*\(\s*["'][^"']*systems\//,
    ];
    const offenders: string[] = [];
    const root = fileURLToPath(new URL("../../src", import.meta.url));
    const walk = (dir: string): void => {
      for (const d of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, d.name);
        if (d.isDirectory()) {
          walk(p);
          continue;
        }
        if (!/\.(ts|svelte|js|html|css)$/.test(d.name)) continue;
        const text = readFileSync(p, "utf8");
        if (LOADS_PACKS.some((re) => re.test(text)))
          offenders.push(p.slice(root.length + 1));
      }
    };
    walk(root);
    expect(offenders).toEqual([]);
  });
});
