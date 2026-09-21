/**
 * §3.1 (G-39) — **Roll20 character export JSON** → an actor this app plays.
 *
 * What a Roll20 user can produce without a script is the character *sheet's* own export: a flat
 * document whose `attribs` array names each field the way the sheet's HTML names it
 * (`{"name": "strength", "current": "18", "max": ""}`), with repeating rows keyed
 * `repeating_<section>_<rowid>_<field>`. It is the least structured of the three sources and the
 * one most likely to have been reshaped by a table's own macros, so this reader is built the way
 * that problem wants:
 *
 * - **A named alias table, not a guess.** Every field this reader recognises is listed below, and
 *   the tests pin the list. A name it does not recognise is *not* silently dropped: it is counted
 *   into the report, named when there are few enough to name, so a user can see exactly which
 *   fields did not come across and author them in a minute rather than wonder what happened.
 * - **Stored totals are read only where they are the only truth.** `hp` is a value this app
 *   stores the same way, so it is read; `ac` and the saves are derived here from components, so
 *   only a source that states nothing else gets a published total. An attack row's stored
 *   `atkmod` is *never* read: this app computes it from BAB and ability scores, and the sheet's
 *   stored total already contains them.
 * - **Repeating rows become items.** `repeating_melee_<row>_meleeweaponname` and its siblings group
 *   into one weapon item per row id, with the dice read and the modifiers reported.
 */
import type { Result } from "../../../core/result";
import { err } from "../../../core/result";
import { abilityMod, normalizeSize } from "../rulesTables";
import { normalizeSkillId } from "../skills";
import { parseDamage } from "./dice";
import {
  attackLinesFromItems,
  imported,
  int,
  isRecord,
  str,
  type ImportedCharacter,
  type ImportedItem,
} from "./types";

/**
 * The alias table: attrib name (lower-cased, punctuation stripped) → what this app calls it.
 * Every entry is a field name Roll20's PF sheets actually use; nothing here is a guess about a
 * sheet this app has not seen, and an unrecognised name is reported rather than approximated.
 */
const ABILITY_ALIASES: Record<
  string,
  "str" | "dex" | "con" | "int" | "wis" | "cha"
> = {
  strength: "str",
  str: "str",
  strscore: "str",
  strengthscore: "str",
  dexterity: "dex",
  dex: "dex",
  dexscore: "dex",
  dexterityscore: "dex",
  constitution: "con",
  con: "con",
  conscore: "con",
  constitutionscore: "con",
  intelligence: "int",
  int: "int",
  intscore: "int",
  intelligencescore: "int",
  wisdom: "wis",
  wis: "wis",
  wisscore: "wis",
  wisdomscore: "wis",
  charisma: "cha",
  cha: "cha",
  chascore: "cha",
  charismascore: "cha",
};

const OTHER_ALIASES = {
  hp: ["hp", "hitpoints", "hitpoint", "currenthp", "hpcurrent", "current_hp"],
  hpmax: [
    "hpmax",
    "maxhp",
    "hitpointsmax",
    "maxhitpoints",
    "hpmaximum",
    "hp_max",
  ],
  nonlethal: ["nonlethal", "nonlethaldamage", "subdual"],
  ac: ["ac", "armorclass", "armourclass", "actotal"],
  bab: ["bab", "baseattack", "baseattackbonus", "attackbonusbase"],
  speed: ["speed", "landspeed", "basespeed", "walkspeed"],
  size: ["size", "sizeclass", "sz"],
  feats: ["feats", "feat", "featsandfeatures"],
  traits: ["traits", "trait"],
} as const;

/** Which of the app's save keys a name means, via the shared save-label table. */
const SAVE_ALIASES: Record<string, "fort" | "ref" | "will"> = {
  fort: "fort",
  fortsave: "fort",
  fortitude: "fort",
  fortitudesave: "fort",
  ref: "ref",
  refsave: "ref",
  reflex: "ref",
  reflexsave: "ref",
  will: "will",
  willsave: "will",
  willpower: "will",
};

/** Repeating sections whose rows describe a weapon, and the sub-fields that matter. */
const WEAPON_SECTIONS = [
  "melee",
  "ranged",
  "attack",
  "weapon",
  "attacks",
] as const;
const WEAPON_NAME_FIELDS = [
  "meleeweaponname",
  "rangedweaponname",
  "weaponname",
  "attackname",
  "name",
];
const WEAPON_DAMAGE_FIELDS = [
  "meleedamage",
  "rangeddamage",
  "weapondamage",
  "damage",
  "damagedice",
  "dmg",
];
const WEAPON_MODIFIER_FIELDS = [
  "meleeatkmod",
  "rangedatkmod",
  "atkmod",
  "attackmod",
  "hit",
  "tohit",
  "attackbonus",
];

const flat = (raw: string): string =>
  raw.toLowerCase().replace(/[^a-z0-9]/g, "");

/** `+3` / `−1` — how a bonus reads on a character sheet. */
function signed(n: number): string {
  return n >= 0 ? `+${n}` : String(n);
}

export function looksLikeRoll20Export(raw: unknown): boolean {
  if (!isRecord(raw)) return false;
  return (
    Array.isArray(raw.attribs) &&
    (typeof raw.name === "string" || raw.attribs.length > 0)
  );
}

interface Attrib {
  name: string;
  value: string;
  /** The sheet's `max` column, when the field has one (`hp` does; `strength` does not). */
  max?: string;
}

export function importRoll20Character(raw: unknown): Result<ImportedCharacter> {
  if (!isRecord(raw)) return err("roll20: the file is not a JSON object");
  if (!Array.isArray(raw.attribs)) {
    return err(
      "roll20: no `attribs` array — export the character sheet's own JSON (the Character sheet ▸ Settings ▸ Export, or the character exporter script)",
    );
  }
  const name = str(raw.name) ?? "";
  const warnings: string[] = [];
  const read: string[] = [];
  const attribs: Attrib[] = [];
  for (const entry of raw.attribs) {
    if (!isRecord(entry)) continue;
    const attribName = str(entry.name);
    if (attribName === undefined) continue;
    const value =
      str(entry.current) ?? str(entry.value) ?? str(entry.max) ?? "";
    const max = str(entry.max);
    attribs.push({
      name: attribName,
      value,
      ...(max === undefined ? {} : { max }),
    });
  }

  const pf1e: Record<string, unknown> = {};
  const consumed = new Set<string>();
  const byAlias = (aliases: readonly string[]): Attrib | undefined => {
    for (const attrib of attribs) {
      const key = flat(attrib.name);
      if (!aliases.includes(key)) continue;
      consumed.add(attrib.name);
      return attrib;
    }
    return undefined;
  };

  // ── ability scores ──
  const abilities: Record<string, number> = {};
  for (const attrib of attribs) {
    const key = ABILITY_ALIASES[flat(attrib.name)];
    if (key === undefined) continue;
    const value = int(attrib.value);
    if (value === undefined) continue;
    abilities[key] = value;
    consumed.add(attrib.name);
  }
  if (Object.keys(abilities).length > 0) {
    pf1e.abilities = abilities;
    read.push(
      `abilities: ${Object.entries(abilities)
        .map(([k, v]) => `${k} ${v}`)
        .join(", ")}`,
    );
  } else {
    warnings.push("no ability scores were found in the attrib list");
  }
  /** Strength modifier — the flat part a printed weapon damage line is decomposed against. */
  const strMod =
    abilities.str === undefined ? undefined : abilityMod(abilities.str);

  // ── hit points ──
  const hp = byAlias(OTHER_ALIASES.hp);
  const hpMax = byAlias(OTHER_ALIASES.hpmax);
  const hpValue = hp === undefined ? undefined : int(hp.value);
  // Two spellings reach us: a companion `hp_max` field, or the `max` column of the `hp` attrib.
  const hpMaxValue = hpMax?.value ?? hp?.max;
  const max = hpMaxValue === undefined ? undefined : int(hpMaxValue);
  if (hpValue !== undefined || max !== undefined) {
    if (hpValue !== undefined) pf1e.hp = Math.max(0, hpValue);
    if (max !== undefined && max > 0) pf1e.hpMax = max;
    read.push(`hit points: ${hpValue ?? "—"}/${max ?? "—"}`);
  } else {
    warnings.push("no hit points were found in the attrib list");
  }
  const nonlethal = byAlias(OTHER_ALIASES.nonlethal);
  const nonlethalValue =
    nonlethal === undefined ? undefined : int(nonlethal.value);
  if (nonlethalValue !== undefined && nonlethalValue > 0)
    pf1e.nonlethalDamage = nonlethalValue;

  // ── AC, published (the sheet stores the total; this app derives it) ──
  const ac = byAlias(OTHER_ALIASES.ac);
  const acValue = ac === undefined ? undefined : int(ac.value);
  if (acValue !== undefined && acValue > 0) {
    pf1e.acTotals = { normal: acValue };
    pf1e.acMode = "published";
    read.push(`AC (published): ${acValue}`);
    warnings.push(
      "AC came across as the sheet's stored total: it will not follow a change of armor or Dexterity — author the components on the sheet if it should recompute",
    );
  } else {
    warnings.push(
      "no armor class was found in the attrib list — author it on the sheet",
    );
  }

  // ── saves: a stored save on a Roll20 sheet is usually the *total* (base + ability + misc) ──
  const saves: Record<string, number> = {};
  const saveTotals: string[] = [];
  for (const attrib of attribs) {
    const key = SAVE_ALIASES[flat(attrib.name)];
    if (key === undefined || saves[key] !== undefined) continue;
    const value = int(attrib.value);
    if (value === undefined) continue;
    saves[key] = value;
    saveTotals.push(`${key} +${value}`);
    consumed.add(attrib.name);
  }
  if (Object.keys(saves).length > 0) {
    pf1e.saves = saves;
    // A sheet's stored save is written as `1d20 + fort` where `fort` already includes the ability
    // modifier, so it is a total — the same conclusion the Foundry reader reaches for `total`.
    pf1e.savesAsTotal = true;
    read.push(`saves (published): ${saveTotals.join(", ")}`);
    warnings.push(
      "saving throws were read as stored totals (Roll20's PF sheets keep them that way): they will not follow a change of ability score",
    );
  } else {
    warnings.push("no saving throws were found in the attrib list");
  }

  // ── BAB, speed, size ──
  const bab = byAlias(OTHER_ALIASES.bab);
  const babValue = bab === undefined ? undefined : int(bab.value);
  if (babValue !== undefined) {
    pf1e.baseAttack = babValue;
    read.push(`base attack bonus: ${babValue}`);
  }
  const speed = byAlias(OTHER_ALIASES.speed);
  const speedValue = speed === undefined ? undefined : int(speed.value);
  if (speedValue !== undefined && speedValue > 0) {
    pf1e.speedFt = speedValue;
    read.push(`speed: ${speedValue} ft`);
  }
  const size = byAlias(OTHER_ALIASES.size);
  if (size !== undefined && size.value !== "") {
    const normalized = normalizeSize(size.value);
    if (normalized === null) {
      warnings.push(
        `size ${JSON.stringify(size.value)} is not a PF1e size category — left unauthored (Medium is assumed until the sheet says otherwise)`,
      );
    } else {
      pf1e.size = normalized;
      read.push(`size: ${normalized}`);
    }
  }

  // ── feats and traits, which Roll20 sheets keep as free text ──
  const feats = byAlias(OTHER_ALIASES.feats);
  if (feats !== undefined && feats.value !== "") {
    pf1e.feats = feats.value
      .split(/[,;]\s*/)
      .map((f) => f.trim())
      .filter((f) => f !== "");
    read.push(
      `feats: ${(pf1e.feats as string[]).length} (from the sheet's own text)`,
    );
  }
  const traits = byAlias(OTHER_ALIASES.traits);
  if (traits !== undefined && traits.value !== "") {
    pf1e.traits = traits.value
      .split(/[,;]\s*/)
      .map((t) => t.trim())
      .filter((t) => t !== "");
  }

  // ── skills: only the names this app's own table recognises ──
  const skills: Record<string, { ranks: number; classSkill?: boolean }> = {};
  const skippedSkills: string[] = [];
  for (const attrib of attribs) {
    if (!attrib.name.startsWith("skill")) continue;
    const label = attrib.name
      .replace(/^skill[_-]?/i, "")
      .replace(/[_-](ranks?|total|misc|mod|class)$/i, "");
    const id = normalizeSkillId(label);
    if (id === undefined) {
      skippedSkills.push(attrib.name);
      continue;
    }
    consumed.add(attrib.name);
    const isRanks = /rank/i.test(attrib.name);
    const isClass = /class/i.test(attrib.name);
    if (!isRanks && !isClass) continue; // a stored total: this app derives it
    const ranks = int(attrib.value) ?? 0;
    skills[id] = {
      ranks: isRanks ? Math.max(0, ranks) : (skills[id]?.ranks ?? 0),
      ...(isClass && /^(yes|true|y|1)$/i.test(attrib.value)
        ? { classSkill: true }
        : {}),
    };
  }
  if (Object.keys(skills).length > 0) {
    pf1e.skills = skills;
    read.push(`skill ranks: ${Object.keys(skills).length} skill(s)`);
    warnings.push(
      "skill modifiers were not imported: this app derives them from ability, ranks, class skill and armor check penalty, so only the sheet's rank and class-skill fields were read",
    );
  }
  if (skippedSkills.length > 0) {
    warnings.push(
      `skill field(s) this app has no row for were skipped: ${skippedSkills.slice(0, 6).join(", ")}${skippedSkills.length > 6 ? ` (+${skippedSkills.length - 6} more)` : ""}`,
    );
  }

  // ── repeating weapon rows ──
  const rows = new Map<string, Record<string, string>>();
  for (const attrib of attribs) {
    const match = /^repeating_([a-z0-9]+)_([^_]+)_(.+)$/i.exec(attrib.name);
    if (match === null) continue;
    const [, section, rowId, field] = match;
    if (section === undefined || rowId === undefined || field === undefined)
      continue;
    if (!(WEAPON_SECTIONS as readonly string[]).includes(section.toLowerCase()))
      continue;
    consumed.add(attrib.name);
    const row = rows.get(rowId) ?? {};
    row[flat(field)] = attrib.value;
    rows.set(rowId, row);
  }
  const items: ImportedItem[] = [];
  let ignoredModifiers = 0;
  for (const [, row] of rows) {
    const name = WEAPON_NAME_FIELDS.map((f) => row[f]).find(
      (v) => v !== undefined && v !== "",
    );
    const damageText = WEAPON_DAMAGE_FIELDS.map((f) => row[f]).find(
      (v) => v !== undefined && v !== "",
    );
    if (
      WEAPON_MODIFIER_FIELDS.some((f) => row[f] !== undefined && row[f] !== "")
    )
      ignoredModifiers++;
    if (name === undefined && damageText === undefined) continue;
    const parsed = damageText === undefined ? null : parseDamage(damageText);
    // A Roll20 damage field is the sheet's own *total* ("1d6+2"), which already contains the
    // character's Strength — same treatment as a Hero Lab damage line: the dice come across, the
    // ability contribution is derived from the abilities read above, and only the remainder of
    // the printed total stays on the weapon (flagged, so Strength is not added twice). The
    // sheet's own attack modifier is not imported at all (see `ignoredModifiers` below).
    const printedRemainder =
      parsed === null || parsed.bonus === 0
        ? undefined
        : strMod === undefined
          ? null
          : parsed.bonus - strMod;
    if (printedRemainder === null) {
      warnings.push(
        `${name ?? "weapon"}: the printed damage bonus was not imported because the export states no Strength for this character — add it on the Items tab if the weapon is magical`,
      );
    }
    items.push({
      name: name ?? "Weapon",
      system: {
        category: "weapon",
        quantity: 1,
        weapon: {
          class: "melee",
          ...(parsed !== null && parsed.dice !== ""
            ? { damageDice: parsed.dice }
            : {}),
          ...(printedRemainder !== undefined &&
          printedRemainder !== null &&
          printedRemainder !== 0
            ? { damageBonus: printedRemainder, abilityDamageIncluded: true }
            : {}),
        },
      },
    });
    if (printedRemainder !== undefined && printedRemainder !== null) {
      read.push(
        `${name ?? "weapon"}: damage ${damageText ?? ""} — the wielder's Strength (${signed(strMod ?? 0)}) is derived from the character's own scores${printedRemainder !== 0 ? `, ${signed(printedRemainder)} kept on the weapon` : ""}`,
      );
    }
  }
  if (items.length > 0)
    read.push(`weapons: ${items.map((i) => i.name).join(", ")}`);
  const { attacks } = attackLinesFromItems(items, str(pf1e.size), warnings);
  if (attacks.length > 0) {
    pf1e.attacks = attacks;
    read.push(
      `attack lines authored from weapons: ${attacks.map((a) => a.name).join(", ")}`,
    );
  }
  if (ignoredModifiers > 0) {
    warnings.push(
      "the attack modifiers stored on the sheet's weapon rows were not imported: this app derives them from base attack bonus and ability scores, so the sheet's stored totals would count twice",
    );
  }

  // ── what is left, named ──
  const left = attribs.filter((a) => !consumed.has(a.name));
  if (left.length > 0) {
    const names = left.slice(0, 8).map((a) => a.name);
    warnings.push(
      `${left.length} sheet field(s) have no home here yet: ${names.join(", ")}${left.length > names.length ? ` (+${left.length - names.length} more)` : ""}`,
    );
  }
  const abilities2 = isRecord(raw.abilities) ? raw.abilities : null;
  if (abilities2 !== null && Object.keys(abilities2).length > 0) {
    warnings.push(
      `${Object.keys(abilities2).length} free-text abilit(ies) on the sheet were not imported (this app has no such field)`,
    );
  }

  if (read.length === 0) {
    return err(
      "roll20: nothing recognisable was found in this character's attrib list",
    );
  }
  return imported("roll20", {
    name: name === "" ? "Imported character" : name,
    system: pf1e,
    items,
    read,
    warnings,
  });
}
