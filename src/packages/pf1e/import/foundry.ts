/**
 * §3.1 (G-39) — **Foundry PF1e actor JSON** → an actor this app plays.
 *
 * What a user hands us is the document Foundry's "Export Data" produces for an actor: `{name,
 * type: "character", system: {...}, items: [...]}`. The pf1 *system* writes components, and that is
 * the good news — `system.abilities.str.value`, `system.attributes.bab.total`,
 * `system.attributes.ac.armor.value`, a weapon's damage inside `system.actions`. So this reader
 * carries components across and lets `derivePF1eActor` do the arithmetic, exactly as it does for a
 * sheet authored by hand in this app; the *one* place a total is authored is a source that states
 * nothing else.
 *
 * The item half mirrors `tools/convert/mappers.mjs` — the build-time converter that already maps
 * this same system's packs — deliberately narrowly: one weapon action per weapon (the converter
 * scans a whole pack for a report; a character has one sheet and its owner is looking at it), and
 * the shapes `resolveInventoryItem` reads (`category`, `quantity`, `weight`, `value`, `equipped`,
 * `weapon`, `armor`, `uses`, `hp`, `hardness`, `traits`, `cl`, `description`).
 *
 * Left behind on purpose, and said so in the report rather than guessed: prepared spell lists
 * (this app's slots are authored on the Casting tab), class/race/buff items (they are not
 * equipment and carry no rules this app keeps), and a stored initiative total (derived here from
 * Dexterity, so importing it would count twice).
 */
import type { Result } from "../../../core/result";
import { err } from "../../../core/result";
import { normalizeSizeKey } from "../rulesTables";
import { sizeRollToDice } from "./dice";
import {
  abilitiesBlock,
  attackLinesFromItems,
  imported,
  int,
  isRecord,
  num,
  plainText,
  saveKey,
  skillsBlock,
  str,
  type ImportedCharacter,
  type ImportedItem,
} from "./types";

/** Foundry item types this app has a category for; everything else is reported. */
const ITEM_TYPES = new Set([
  "weapon",
  "armor",
  "shield",
  "equipment",
  "consumable",
  "container",
  "loot",
  "item",
  "wondrous",
  "gear",
  "technological",
  "implant",
]);

const ACTIONS_WITH_CLASS: Record<string, "melee" | "thrown" | "projectile"> = {
  mwak: "melee",
  msak: "melee",
  twak: "thrown",
  tsak: "thrown",
  rsak: "projectile",
  rwak: "projectile",
};

const PHYSICAL_DAMAGE = new Set(["bludgeoning", "piercing", "slashing"]);

/**
 * One weapon's block from the system's `system.actions` (the pinned system publishes the stat
 * block there, not in a `system.weapon` map). The thrown action wins for a thrown weapon, because
 * its melee line is the same dice without a range — `tools/convert`'s rule, kept.
 */
function weaponBlock(
  system: Record<string, unknown>,
): Record<string, unknown> | undefined {
  const actions = isRecord(system.actions)
    ? Object.values(system.actions).filter(isRecord)
    : [];
  const subtype = str(system.weaponSubtype) ?? "";
  const chosen =
    subtype === "ranged"
      ? (actions.find((a) => a.actionType === "rwak") ??
        actions.find(
          (a) => ACTIONS_WITH_CLASS[String(a.actionType)] !== undefined,
        ))
      : (actions.find((a) => a.actionType === "twak") ??
        actions.find(
          (a) => ACTIONS_WITH_CLASS[String(a.actionType)] !== undefined,
        ));
  if (chosen === undefined) return undefined;
  const ability = isRecord(chosen.ability) ? chosen.ability : {};
  const damage = isRecord(chosen.damage) ? chosen.damage : {};
  const parts = Array.isArray(damage.parts)
    ? damage.parts.filter(isRecord)
    : [];
  const first = parts[0];
  const dice = first === undefined ? null : sizeRollToDice(first.formula);
  const types =
    first !== undefined && Array.isArray(first.types)
      ? first.types.map(String)
      : [];
  const damageType = types
    .map((t) => t.toLowerCase())
    .find((t) => PHYSICAL_DAMAGE.has(t));
  const properties = Array.isArray(system.properties)
    ? system.properties.map(String)
    : [];
  const ammo = isRecord(system.ammo) ? system.ammo : null;
  const tags = Array.isArray(system.tags) ? system.tags.map(String) : [];
  const firearmTag = tags.find((t) => /firearm/i.test(t));
  const range = isRecord(chosen.range) ? chosen.range : {};
  const rangeValue = num(range.value);
  const critThreat = int(ability.critRange);
  const critMult = int(ability.critMult);
  const subtypeClass =
    ACTIONS_WITH_CLASS[String(chosen.actionType)] ??
    (subtype === "ranged" ? "projectile" : "melee");
  const handedness =
    subtype === "light"
      ? "light"
      : subtype === "2h" || (num(system.hands) ?? 0) >= 2
        ? "two-handed"
        : "one-handed";
  const proficiency = ["simple", "martial", "exotic"].includes(
    String(system.subType),
  )
    ? String(system.subType)
    : undefined;
  return {
    class: firearmTag !== undefined ? "firearm" : subtypeClass,
    handedness,
    ...(proficiency !== undefined ? { proficiency } : {}),
    ...(dice !== null ? { damageDice: dice } : {}),
    ...(damageType !== undefined ? { damageType } : {}),
    ...(critThreat !== undefined && critThreat >= 1 && critThreat <= 20
      ? { critThreatMin: critThreat }
      : {}),
    ...(critMult !== undefined && critMult >= 2
      ? { critMultiplier: critMult }
      : {}),
    ...(range.units === "ft" && rangeValue !== undefined && rangeValue > 0
      ? { rangeIncrementFt: rangeValue }
      : {}),
    ...(properties.includes("rch") ? { reach: true } : {}),
    ...(properties.includes("trp") ? { trip: true } : {}),
    ...(properties.includes("dis") ? { disarm: true } : {}),
    ...(properties.includes("nnl") ? { nonlethal: true } : {}),
    ...(firearmTag !== undefined
      ? {
          firearmGeneration: /advanced/i.test(firearmTag)
            ? "advanced"
            : "early",
        }
      : {}),
    ...(firearmTag !== undefined &&
    ammo !== null &&
    int(ammo.misfire) !== undefined
      ? { misfireMinimum: int(ammo.misfire) }
      : {}),
    ...(ammo !== null
      ? {
          ammo: {
            ...(str(ammo.type) !== undefined ? { type: str(ammo.type) } : {}),
            ...(int(ammo.capacity) !== undefined
              ? { capacity: int(ammo.capacity) }
              : {}),
          },
        }
      : {}),
  };
}

/**
 * An armor/shield block, from either shape the ecosystem uses: the pf1 system's
 * (`bonus`/`maximumDexBonus`/`checkPenalty`/`arcaneSpellFailure`) or the older content packs'
 * (`value`/`dex`/`acp`/`enh`). The `subType` decides armor versus shield — an entry that says
 * neither is *not* worn armor, and `resolvePF1eArmor` is not handed a guess.
 */
function armorBlock(
  system: Record<string, unknown>,
): Record<string, unknown> | undefined {
  const raw = isRecord(system.armor) ? system.armor : null;
  if (raw === null) return undefined;
  const subtype = str(system.subType) ?? "";
  const equipmentSubtype = str(system.equipmentSubtype) ?? "";
  const slot =
    subtype === "shield" ? "shield" : subtype === "armor" ? "armor" : undefined;
  const bonus = num(raw.bonus) ?? num(raw.value);
  const maxDex =
    num(raw.maximumDexBonus) ?? (raw.dex === null ? 0 : num(raw.dex));
  const acp = num(raw.checkPenalty) ?? num(raw.acp);
  const spellFailure = num(raw.arcaneSpellFailure) ?? num(raw.spellFailure);
  const proficiency =
    subtype === "shield"
      ? "shield"
      : equipmentSubtype === "lightArmor"
        ? "light"
        : equipmentSubtype === "mediumArmor"
          ? "medium"
          : equipmentSubtype === "heavyArmor"
            ? "heavy"
            : undefined;
  const allZero =
    (bonus ?? 0) === 0 &&
    (maxDex ?? 0) === 0 &&
    (acp ?? 0) === 0 &&
    (spellFailure ?? 0) === 0 &&
    slot === undefined &&
    proficiency === undefined;
  if (allZero) return undefined; // Foundry's item template carries this on every physical item
  return {
    ...(slot !== undefined ? { slot } : {}),
    ...(proficiency !== undefined ? { proficiency } : {}),
    ...(bonus !== undefined && slot !== undefined
      ? slot === "shield"
        ? { shieldBonus: bonus }
        : { armorBonus: bonus }
      : {}),
    ...(maxDex !== undefined ? { maxDexBonus: maxDex } : {}),
    ...(acp !== undefined ? { checkPenalty: acp } : {}),
    ...(spellFailure !== undefined ? { spellFailure } : {}),
  };
}

function categoryOf(type: string, system: Record<string, unknown>): string {
  const subtype = str(system.subType);
  if (type === "armor" && subtype === "shield") return "shield";
  if (type === "armor") return "armor";
  if (ITEM_TYPES.has(type))
    return type === "item" || type === "wondrous" || type === "gear"
      ? "equipment"
      : type;
  return "other";
}

/** One Foundry item document → the embedded item this app reads. `null` = not importable. */
function itemOf(
  raw: Record<string, unknown>,
  warnings: string[],
): ImportedItem | null {
  const type = str(raw.type) ?? "";
  const name = str(raw.name);
  if (name === undefined) {
    warnings.push("an item with no name in the export was skipped");
    return null;
  }
  const system = isRecord(raw.system) ? raw.system : {};
  const weapon = weaponBlock(system);
  const armor = armorBlock(system);
  const description = plainText(
    isRecord(system.description)
      ? system.description.value
      : system.description,
  );
  const price =
    num(system.value) ??
    num(system.price) ??
    num(isRecord(system.price) ? system.price.value : undefined);
  const weight =
    num(system.weight) ??
    num(isRecord(system.weight) ? system.weight.value : undefined);
  const uses = isRecord(system.uses) ? system.uses : null;
  const itemHp =
    int(system.hp) ??
    int(isRecord(system.hp) ? (system.hp.value ?? system.hp.max) : undefined);
  const hardness = int(system.hardness);
  return {
    name,
    system: {
      category: categoryOf(type, system),
      quantity: Math.max(0, int(system.quantity) ?? 1),
      ...(price !== undefined ? { value: price } : {}),
      ...(weight !== undefined ? { weight } : {}),
      ...(system.equipped === true ? { equipped: true } : {}),
      ...(system.carried === false ? { carried: false } : {}),
      ...(uses !== null ? { uses } : {}),
      ...(itemHp !== undefined ? { hp: itemHp } : {}),
      ...(hardness !== undefined ? { hardness } : {}),
      ...(int(system.cl) !== undefined ? { cl: int(system.cl) } : {}),
      ...(description !== "" ? { description } : {}),
      ...(weapon !== undefined ? { weapon } : {}),
      ...(armor !== undefined ? { armor } : {}),
    },
  };
}

/** Is this JSON a Foundry actor document at all? (Also the format sniffer's test, in `index.ts`.) */
export function looksLikeFoundryActor(raw: unknown): boolean {
  if (!isRecord(raw)) return false;
  if (!isRecord(raw.system)) return false;
  const type = str(raw.type);
  const system = raw.system;
  return (
    type === "character" ||
    type === "npc" ||
    isRecord(system.abilities) ||
    isRecord(system.attributes) ||
    Array.isArray(raw.items)
  );
}

export function importFoundryCharacter(
  raw: unknown,
): Result<ImportedCharacter> {
  if (!isRecord(raw)) return err("foundry: the file is not a JSON object");
  const name = str(raw.name);
  if (name === undefined) return err("foundry: the export has no `name`");
  const system = isRecord(raw.system) ? raw.system : {};
  const attributes = isRecord(system.attributes) ? system.attributes : {};
  const warnings: string[] = [];
  const read: string[] = [];
  const pf1e: Record<string, unknown> = {};

  const abilities = abilitiesBlock(
    isRecord(system.abilities) ? system.abilities : {},
  );
  if (abilities !== undefined) {
    pf1e.abilities = abilities;
    read.push(
      `abilities: ${Object.entries(abilities)
        .map(([k, v]) => `${k} ${v}`)
        .join(", ")}`,
    );
  } else {
    warnings.push(
      "no ability scores in the export (system.abilities) — left unauthored",
    );
  }

  const hp = isRecord(attributes.hp) ? attributes.hp : {};
  const hpValue = int(hp.value ?? hp.max);
  const hpMax = int(hp.max);
  if (hpValue !== undefined) pf1e.hp = Math.max(0, hpValue);
  if (hpMax !== undefined && hpMax > 0) {
    pf1e.hpMax = hpMax;
    read.push(`hit points: ${String(pf1e.hp)}/${hpMax}`);
  } else if (hpValue !== undefined && hpValue > 0) {
    // The content packs' character sheets carry a hit-point *pool* and no maximum (0 of 597
    // sampled documents state `attributes.hp.max`): the pool is the total there, which is how
    // `tools/convert` has always read it. Authored as both, and said out loud.
    pf1e.hp = hpValue;
    pf1e.hpMax = hpValue;
    read.push(`hit points: ${hpValue} (no maximum was stated)`);
    warnings.push(
      `the export states no hit-point maximum: its pool of ${hpValue} was authored as both current and maximum — check it on the sheet if this character takes damage`,
    );
  }
  const nonlethal = int(hp.nonlethal);
  if (nonlethal !== undefined && nonlethal > 0)
    pf1e.nonlethalDamage = nonlethal;

  // AC: components when the source has them (that is what the derivation wants), else the
  // published totals with `acMode: "published"` — the same two paths `tools/convert` uses.
  const ac = isRecord(attributes.ac) ? attributes.ac : {};
  const readPart = (raw: unknown): number | undefined =>
    num(isRecord(raw) ? (raw.value ?? raw.total) : raw);
  const armorBonus = readPart(ac.armor);
  const shieldBonus = readPart(ac.shield);
  // `attributes.naturalAC` is a plain number on the content packs' character sheets (597 of 597
  // sampled documents state it), while `ac.natural` is the pf1 system's nested spelling.
  const naturalBonus = readPart(ac.natural) ?? num(attributes.naturalAC);
  const miscBonus = readPart(ac.misc);
  const dodgeBonus = readPart(ac.dodge);
  const components = {
    ...(armorBonus !== undefined && armorBonus !== 0
      ? { armor: armorBonus }
      : {}),
    ...(shieldBonus !== undefined && shieldBonus !== 0
      ? { shield: shieldBonus }
      : {}),
    ...(naturalBonus !== undefined && naturalBonus !== 0
      ? { natural: naturalBonus }
      : {}),
    ...(miscBonus !== undefined && miscBonus !== 0 ? { misc: miscBonus } : {}),
    ...(dodgeBonus !== undefined && dodgeBonus !== 0
      ? { dodge: dodgeBonus }
      : {}),
  };
  if (Object.keys(components).length > 0) {
    pf1e.armorClass = components;
    read.push(`AC components: ${JSON.stringify(components)}`);
  } else {
    const normal = int(readPart(ac.normal));
    const touch = int(readPart(ac.touch));
    const flat = int(readPart(ac.flatFooted));
    if (normal !== undefined && normal > 0) {
      pf1e.acTotals = {
        normal,
        ...(touch !== undefined ? { touch } : {}),
        ...(flat !== undefined ? { flatFooted: flat } : {}),
      };
      pf1e.acMode = "published";
      read.push(
        `AC published as totals: ${normal}${touch !== undefined ? ` / touch ${touch}` : ""}${flat !== undefined ? ` / flat-footed ${flat}` : ""}`,
      );
      warnings.push(
        "AC came across as published totals: the export states no component breakdown, so effects and armor items will not change it (author the components on the sheet if you want them to)",
      );
    }
  }

  const savingThrows = isRecord(attributes.savingThrows)
    ? attributes.savingThrows
    : {};
  const saves: Record<string, number> = {};
  for (const [key, value] of Object.entries(savingThrows)) {
    const id = saveKey(key);
    const total = int(isRecord(value) ? (value.total ?? value.value) : value);
    if (id !== undefined && total !== undefined) saves[id] = total;
  }
  // A character sheet also carries a details block; the reader names it in the report instead of
  // dropping it silently (there is no biography field on this app's sheet yet).
  if (Object.keys(saves).length > 0) {
    pf1e.saves = saves;
    // The pf1 system's `total` already includes the ability modifier: authoring it as a base
    // value would add the modifier a second time (`savesAsTotal`, the converter's own rule).
    pf1e.savesAsTotal = true;
    read.push(
      `saves: ${Object.entries(saves)
        .map(([k, v]) => `${k} +${v}`)
        .join(", ")}`,
    );
  }

  const bab = int(
    isRecord(attributes.bab)
      ? (attributes.bab.total ?? attributes.bab.value)
      : attributes.bab,
  );
  if (bab !== undefined) {
    pf1e.baseAttack = bab;
    read.push(`base attack bonus: ${bab}`);
  }

  const speed = isRecord(attributes.speed) ? attributes.speed : {};
  const speedFields: Array<[string, keyof Record<string, number>]> = [
    ["land", "speedFt"],
    ["fly", "flySpeedFt"],
    ["swim", "swimSpeedFt"],
    ["climb", "climbSpeedFt"],
    ["burrow", "burrowSpeedFt"],
  ];
  const speeds: string[] = [];
  for (const [source, target] of speedFields) {
    const entry = speed[source];
    const base = int(isRecord(entry) ? (entry.base ?? entry.value) : entry);
    if (base !== undefined && base > 0) {
      pf1e[target as string] = base;
      speeds.push(`${source} ${base} ft`);
    }
  }
  if (speeds.length > 0) read.push(`speed: ${speeds.join(", ")}`);

  const traits = isRecord(system.traits) ? system.traits : {};
  // `traits.size` is a short key in this system's packs and sheets ("med"), so it is normalized
  // before it is authored: an unnormalized key is not a size category, and authoring one would
  // make the whole block fail the actor validator — a character that derives as a blank sheet.
  const size = str(traits.size);
  const normalizedSize = size === undefined ? null : normalizeSizeKey(size);
  if (normalizedSize !== null) {
    pf1e.size = normalizedSize;
    read.push(
      `size: ${normalizedSize}${normalizedSize.toLowerCase() === size?.toLowerCase() ? "" : ` (the export's "${size}")`}`,
    );
  } else if (size !== undefined) {
    warnings.push(
      `size ${JSON.stringify(size)} is not a PF1e size category — left unauthored (Medium is assumed until the sheet says otherwise)`,
    );
  }

  const skills = skillsBlock(system.skills, warnings);
  if (skills !== undefined) {
    pf1e.skills = skills;
    read.push(`skill ranks: ${Object.keys(skills).length} skill(s)`);
  }

  // Items: weapons, armor and gear come across; feats and traits become names the sheet shows
  // (several rules read them); everything else is named in the report.
  const rawItems = Array.isArray(raw.items) ? raw.items.filter(isRecord) : [];
  const items: ImportedItem[] = [];
  const feats: string[] = [];
  const traitNames: string[] = [];
  const leftBehind: Record<string, number> = {};
  for (const item of rawItems) {
    const type = str(item.type) ?? "item";
    const itemName = str(item.name) ?? "item";
    if (type === "feat") {
      feats.push(itemName);
      continue;
    }
    if (type === "trait" || type === "racialTrait") {
      traitNames.push(itemName);
      continue;
    }
    if (type === "spell") {
      leftBehind.spell = (leftBehind.spell ?? 0) + 1;
      continue;
    }
    if (
      type === "class" ||
      type === "race" ||
      type === "buff" ||
      type === "attack"
    ) {
      leftBehind[type] = (leftBehind[type] ?? 0) + 1;
      continue;
    }
    const built = itemOf(item, warnings);
    if (built === null) continue;
    items.push(built);
  }
  if (feats.length > 0) pf1e.feats = feats;
  if (feats.length > 0) read.push(`feats: ${feats.length}`);
  if (traitNames.length > 0) pf1e.traits = traitNames;
  for (const [type, count] of Object.entries(leftBehind)) {
    const why =
      type === "spell"
        ? "spell lists are authored on the Casting tab, where this app's slots and prepared rows live"
        : type === "attack"
          ? "attack items are not equipment; author the natural attacks on the Attacks tab"
          : `${type} items carry no rules this app keeps`;
    warnings.push(`${count} ${type} item(s) were not imported (${why})`);
  }

  const weapons = items.filter((item) => isRecord(item.system.weapon)).length;
  const armors = items.filter((item) => isRecord(item.system.armor)).length;
  if (items.length > 0)
    read.push(
      `items: ${items.length}${weapons > 0 ? ` (${weapons} weapon${weapons === 1 ? "" : "s"})` : ""}${armors > 0 ? `, ${armors} armor/shield` : ""}`,
    );
  if (weapons === 0) {
    warnings.push(
      "no weapon was found in the export — the Attacks tab starts empty and can be filled from the Items tab",
    );
  }

  const { attacks } = attackLinesFromItems(items, size, warnings);
  if (attacks.length > 0) {
    pf1e.attacks = attacks;
    read.push(
      `attack lines authored from weapons: ${attacks.map((a) => a.name).join(", ")}`,
    );
  }

  // Stated-but-not-imported totals, named rather than silently dropped.
  const initTotal = int(
    isRecord(attributes.init)
      ? (attributes.init.total ?? attributes.init.value)
      : attributes.init,
  );
  if (initTotal !== undefined) {
    warnings.push(
      `initiative total ${initTotal} was not imported: this app derives initiative from Dexterity, so author Improved Initiative and friends as feats`,
    );
  }
  const details = isRecord(system.details) ? system.details : {};
  const personalKeys = [
    "alignment",
    "deity",
    "gender",
    "age",
    "height",
    "weight",
    "hair",
    "eyes",
    "skin",
    "cr",
    "xp",
  ];
  const personal = personalKeys.filter(
    (k) => str(details[k]) !== undefined,
  ).length;
  if (personal > 0) {
    warnings.push(
      `${personal} personal-detail field(s) (alignment, deity, …) have no home on this app's sheet yet — description text was not imported`,
    );
  }
  const currency = isRecord(system.currency) ? system.currency : null;
  if (
    currency !== null &&
    ["pp", "gp", "sp", "cp"].some((c) => num(currency[c]) !== undefined)
  ) {
    const coins = ["pp", "gp", "sp", "cp"]
      .map((c) => [c, int(currency[c]) ?? 0] as const)
      .filter(([, v]) => v !== 0);
    pf1e.currency = Object.fromEntries(coins);
    read.push(`coin: ${coins.map(([c, v]) => `${v} ${c}`).join(", ")}`);
  }

  if (read.length === 0) {
    return err(
      "foundry: nothing recognisable was found in this actor's system data",
    );
  }
  return imported("foundry", { name, system: pf1e, items, read, warnings });
}
