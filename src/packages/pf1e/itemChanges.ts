/**
 * PF1e **item changes → typed mods** (plan §1.3 item 6, gap G-04/G-05).
 *
 * Foundry PF1e items carry their mechanical payload in `system.changes[]` — a list of
 * path-overwrite-style entries (`{ formula, operator, target, type }`). **D-112 forbids
 * introducing that mechanic here**: our effects are a closed list of typed mods with
 * bonus-type stacking, because "path = 2" cannot express "+2 morale to AC" and because a
 * general overwrite path is a new engine, not a mapping.
 *
 * So this module is the *deliberate subset*: a fixed table from the Foundry target paths the
 * PF1e system actually uses onto keys that already exist in `PF1E_MOD_KEYS`, plus the
 * Foundry bonus-type strings onto `PF1E_BONUS_TYPES`. Anything else is **named, counted and
 * shown** in the item window (`unmapped`), never silently dropped and never guessed at:
 * `set`-operator entries are refused outright (an overwrite is exactly what D-112 rules
 * out), and a scripted item (`scriptCalls`) has no mapping at all by construction.
 *
 * The mapped items then ride the *same* resolver as spells and conditions: an item's mods
 * become a synthetic `PF1eActiveEffect` with the item as its source, so stacking,
 * suppression (`disabled`) and the derivation read side are shared, not reimplemented.
 */
import type { PF1eActiveEffect, PF1eMod } from "./effects";
import { isPF1eBonusType, type PF1eBonusType } from "./rulesTables";
import type { PF1eInventoryItem } from "./inventory";
import { readInventoryItems } from "./inventory";

/**
 * The mapping table. Keys are the Foundry target paths we map; values the mod key.
 *
 * Two spellings are accepted per concept because the PF1e system moved from short targets
 * (`"ac"`, `"attack"`) to full paths (`"system.attributes.ac.flat"`) across versions, and the
 * converter carries whatever the source wrote. A target not in this table is unmapped.
 */
export const FOUNDRY_CHANGE_TARGETS: Readonly<Record<string, string>> = Object.freeze({
  // AC — the three published figures.
  ac: "ac",
  // …and the short spellings the pinned corpora use (measured over all 28 converted packs:
  // 416 `changes[]` entries across 248 items). `nac` is natural armor, which is *not* a
  // general AC bonus — it never applies to touch AC — so it has its own key.
  nac: "naturalArmor",
  "system.attributes.ac.normal.total": "ac",
  "system.attributes.ac.flat": "ac",
  "system.attributes.ac.flatFlat": "ac",
  "system.attributes.ac.touch": "acTouch",
  "system.attributes.ac.touchFlat": "acTouch",
  "system.attributes.ac.flatFooted.total": "acFlatFooted",
  // Attacks and damage.
  attack: "attack",
  wdamage: "damage",
  "system.attributes.attack.general": "attack",
  "system.attributes.attack.melee": "attackMelee",
  "system.attributes.attack.ranged": "attackRanged",
  damage: "damage",
  mattack: "attackMelee",
  rattack: "attackRanged",
  "system.attributes.attack.damage": "damage",
  "system.attributes.damage.general": "damage",
  // Saving throws (the `total` figure is the one a save roll reads).
  "system.attributes.savingThrows.fort.total": "save.fort",
  "system.attributes.savingThrows.ref.total": "save.ref",
  "system.attributes.savingThrows.will.total": "save.will",
  saves: "saves",
  allSavingThrows: "saves",
  fort: "save.fort",
  ref: "save.ref",
  will: "save.will",
  // Combat maneuvers, initiative, speed.
  "system.attributes.cmb.total": "cmb",
  "system.attributes.cmd.total": "cmd",
  "system.attributes.init.total": "initiative",
  initiative: "initiative",
  "system.attributes.speed.land.total": "speed",
  "system.attributes.speed.all": "speed",
  landSpeed: "speed",
  allSpeeds: "speed",
  // Ability scores (belts, headbands: "system.abilities.str.total"; the short spelling is
  // the pf1 system's own `subTarget`).
  str: "ability.str",
  dex: "ability.dex",
  con: "ability.con",
  int: "ability.int",
  wis: "ability.wis",
  cha: "ability.cha",
  "system.abilities.str.total": "ability.str",
  "system.abilities.dex.total": "ability.dex",
  "system.abilities.con.total": "ability.con",
  "system.abilities.int.total": "ability.int",
  "system.abilities.wis.total": "ability.wis",
  "system.abilities.cha.total": "ability.cha",
  // Caster statistics.
  "system.attributes.spells.spellbooks.*.cl.total": "casterLevel",
  "system.attributes.spells.spellbooks.*.concentration.total": "concentration",
  "system.attributes.spells.spellbooks.*.spellDC.total": "spellDc",
  // Skills — the two the closed list always had, plus the widened `skill.<id>` family.
  "system.skills.per.mod": "perception",
  "system.skills.ste.mod": "stealth",
});

/** Foundry bonus-type strings → our bonus types. Foundry's `enh` is our `enhancement`. */
const FOUNDRY_BONUS_TYPES: Readonly<Record<string, PF1eBonusType>> = Object.freeze({
  untyped: "untyped",
  enh: "enhancement",
  enhancement: "enhancement",
  armor: "armor",
  shield: "shield",
  circumstance: "circumstance",
  competence: "competence",
  deflection: "deflection",
  dodge: "dodge",
  insight: "insight",
  luck: "luck",
  morale: "morale",
  natural: "natural",
  profane: "profane",
  racial: "racial",
  // Foundry's pithy spellings of the SRD's own bonus types.
  resist: "resistance",
  res: "resistance",
  enhance: "enhancement",
  compete: "competence",
  sacred: "sacred",
  size: "size",
  trait: "trait",
  alchemical: "alchemical",
  // Foundry writes these two for spell/feat-style items; the app has names for both.
  base: "untyped",
  penalty: "untyped",
});

/** Foundry `system.skills.<key>.mod` three-letter codes → our skill ids (`skills.ts`). */
const FOUNDRY_SKILL_CODES: Readonly<Record<string, string>> = Object.freeze({
  acr: "acrobatics",
  apr: "appraise",
  blf: "bluff",
  clm: "climb",
  crf: "craft",
  dev: "disableDevice",
  dip: "diplomacy",
  dis: "disguise",
  esc: "escapeArtist",
  fly: "fly",
  han: "handleAnimal",
  hea: "heal",
  int: "intimidate",
  kar: "knowledgeArcana",
  kdu: "knowledgeDungeoneering",
  ken: "knowledgeEngineering",
  kge: "knowledgeGeography",
  khi: "knowledgeHistory",
  klo: "knowledgeLocal",
  kna: "knowledgeNature",
  kno: "knowledgeNobility",
  kpl: "knowledgePlanes",
  kre: "knowledgeReligion",
  lin: "linguistics",
  per: "perception",
  prf: "perform",
  pro: "profession",
  rid: "ride",
  sen: "senseMotive",
  slt: "sleightOfHand",
  spl: "spellcraft",
  ste: "stealth",
  sur: "survival",
  swm: "swim",
  umd: "useMagicDevice",
});

/**
 * A skill target, in either spelling the corpora use:
 *
 * - the pf1e-content packs' full path — `system.skills.ste.mod`;
 * - the pf1 system's own short target — `skill.ste` (the spelling in the 28 converted packs).
 *
 * Both go through the same three-letter code table, so a skill item cannot work in one pack
 * and silently do nothing in the other.
 */
function skillTargetModKey(target: string): string | null {
  const full = /^system\.skills\.([a-z]{3,})\.(mod|total)$/.exec(target);
  const short = /^skill\.([a-z]{3})$/.exec(target);
  const code = (full?.[1] ?? short?.[1] ?? "") as string;
  if (code === "") return null;
  const id = FOUNDRY_SKILL_CODES[code];
  return id === undefined ? null : `skill.${id}`;
}

export interface PF1eItemChangeOutcome {
  /** Mods that will apply, typed and ready for the effects resolver. */
  mods: PF1eMod[];
  /** One line per change this module refuses, with the reason. */
  unmapped: Array<{ target: string; type: string; formula: string; reason: string }>;
  /** Non-error notes (a `set` refused because D-112 forbids overwrites, a bad bonus type…). */
  notes: string[];
}

const asRecord = (v: unknown): Record<string, unknown> | null =>
  typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;

/**
 * The path a change names. The pf1 system writes the *same* concept in two spellings across
 * its history: `target` (the pf1-system YAML packs, e.g. `skill.per`) and `subTarget` (the
 * pf1e-content JSON packs, e.g. `system.attributes.ac.flat`). Both are read; neither is
 * guessed at.
 */
function changeTarget(change: Record<string, unknown>): string {
  for (const key of ["target", "subTarget"] as const) {
    const v = change[key];
    if (typeof v === "string" && v.trim() !== "") return v.trim();
  }
  return "";
}

/**
 * The bonus type, in either spelling: `type` (pf1 system: `untyped`, `enh`, `morale`) or
 * `modifier` (pf1e-content: `resist`, `competence`). Absent means untyped, which is what
 * Foundry's own default is.
 */
function changeType(change: Record<string, unknown>): string {
  for (const key of ["type", "modifier"] as const) {
    const v = change[key];
    if (typeof v === "string" && v.trim() !== "") return v.trim();
  }
  return "untyped";
}

/**
 * Map one item's Foundry `changes[]` onto typed mods.
 *
 * `subtract` negates the formula (Foundry's own arithmetic); `set` is refused by name —
 * it is the path-overwrite mechanic D-112 rules out — and `add` is the default operator
 * when the source omits it.
 */
export function itemChangesToMods(
  changes: readonly unknown[],
  sourceName: string,
): PF1eItemChangeOutcome {
  const mods: PF1eMod[] = [];
  const unmapped: PF1eItemChangeOutcome["unmapped"] = [];
  const notes: string[] = [];
  for (const raw of changes) {
    const change = asRecord(raw);
    if (change === null) {
      unmapped.push({ target: "?", type: "?", formula: "?", reason: "change is not an object" });
      continue;
    }
    const target = changeTarget(change);
    const formula = change.formula === undefined || change.formula === null ? "" : String(change.formula);
    // Foundry's newer operator spelling for `add` is a literal `+`.
    const rawOperator = typeof change.operator === "string" ? change.operator : "add";
    const operator = rawOperator === "+" ? "add" : rawOperator;
    const typeRaw = changeType(change);
    const refuse = (reason: string): void => {
      unmapped.push({ target: target || "?", type: typeRaw, formula, reason });
    };
    if (target === "") {
      refuse("no target path");
      continue;
    }
    if (operator === "set") {
      refuse("`set` overwrites a path — the app's mechanic is typed mods (D-112), so this is not applied");
      continue;
    }
    if (operator !== "add" && operator !== "subtract") {
      refuse(`operator "${operator}" is not add/subtract`);
      continue;
    }
    const key = FOUNDRY_CHANGE_TARGETS[target] ?? skillTargetModKey(target);
    if (key === undefined || key === null) {
      refuse("no mapping for this path (see the item sheet's changes list)");
      continue;
    }
    const numeric = Number(formula);
    if (!Number.isFinite(numeric)) {
      // A formula like "@abilities.str.mod" cannot be evaluated here; naming it is honest.
      refuse("formula is not a plain number (a reference or expression this mapper does not evaluate)");
      continue;
    }
    const value = operator === "subtract" ? -numeric : numeric;
    const mappedType = FOUNDRY_BONUS_TYPES[typeRaw.toLowerCase()];
    if (mappedType === undefined) {
      notes.push(`change on "${target}": bonus type "${typeRaw}" is unknown — applied as untyped`);
    }
    const type = mappedType ?? (isPF1eBonusType(typeRaw) ? typeRaw : "untyped");
    mods.push({ key: key as PF1eMod["key"], type, value, source: sourceName });
  }
  return { mods, unmapped, notes };
}

/**
 * The item's continuous contribution as an active effect, or `null` when it contributes
 * nothing (a consumable activates rather than persisting; an unequipped or disabled item
 * does nothing at all).
 *
 * Why an effect: stacking, `disabled`, the derivation read side and the effects tab's
 * diagnostics are all built around `PF1eActiveEffect`. An item that grants "+2 morale to
 * saves" must combine with a *spell* that grants "+1 morale to saves" through one code path,
 * or the two would disagree the first time a bonus type mattered.
 */
export function itemActiveEffect(item: PF1eInventoryItem): PF1eActiveEffect | null {
  if (item.category === "consumable") return null;
  if (!item.carried) return null;
  // PF1e: a continuous item's bonuses apply while it is worn or wielded. Categories that are
  // worn by nature (armor, shield, weapon) still say so with `equipped` — an item in the pack
  // grants nothing. Trait-like items the converter marks `equipped: true` (the Foundry
  // default for `equipmentType: "misc"`) behave the same way.
  if (!item.equipped) return null;
  const outcome = itemChangesToMods(item.changes, item.name);
  if (outcome.mods.length === 0) return null;
  return {
    id: `item:${item.id}`,
    name: item.name,
    icon: null,
    disabled: false,
    durationLeft: null,
    payload: { mods: outcome.mods, source: { kind: "item", id: item.id } },
  };
}

/** Every item effect an actor carries, in item order — the read side's input. */
export function itemActiveEffects(items: readonly PF1eInventoryItem[]): PF1eActiveEffect[] {
  const out: PF1eActiveEffect[] = [];
  for (const item of items) {
    const effect = itemActiveEffect(item);
    if (effect !== null) out.push(effect);
  }
  return out;
}

/**
 * `ActorDocument.items` (raw) → the item effects that ride the derivation. Kept here, next to
 * the mapper, so callers that only have a document (`effectOps.ts`) need one import.
 */
export function actorItemEffects(rawItems: readonly unknown[] | undefined): PF1eActiveEffect[] {
  return itemActiveEffects(readInventoryItems(rawItems).items);
}

/** A change list rendered for the item window: what applies, what does not, and why. */
export interface PF1eItemChangeReport {
  applied: Array<{ target: string; type: PF1eBonusType; value: number; key: string }>;
  unmapped: PF1eItemChangeOutcome["unmapped"];
  notes: string[];
  /** True when the item's payload includes a script the app will never run. */
  hasScriptCalls: boolean;
}

export function itemChangeReport(item: PF1eInventoryItem): PF1eItemChangeReport {
  const outcome = itemChangesToMods(item.changes, item.name);
  const notes = [...outcome.notes];
  if (item.category === "consumable")
    notes.push("This is a consumable: its changes apply when it is used, not while carried.");
  else if (!item.equipped) notes.push("Not equipped: nothing here applies until it is worn or wielded.");
  if (item.scriptCalls > 0)
    notes.push(
      `${item.scriptCalls} scripted call(s) were dropped by the converter — the app never runs item scripts.`,
    );
  return {
    applied: outcome.mods.map((m) => ({
      target: m.key,
      type: m.type,
      value: m.value,
      key: m.key,
    })),
    unmapped: outcome.unmapped,
    notes,
    hasScriptCalls: item.scriptCalls > 0,
  };
}
