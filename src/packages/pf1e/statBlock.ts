/**
 * PF1e **stat-block adapter** — reads the shape the shipped content and the strategic sim author, and
 * hands the tactical derivation the component-shaped block it wants.
 *
 * Why this exists: `systems/pf1e-core/packs/bestiary.json` writes
 * `{ bab, strMod, ac, touchAc, weapon: { damageDiceCount, damageDiceSides, damageMod }, dr: { val,
 * bypass }, sr, sizeMod, regeneration }` — flat *modifiers and totals*, because that is what the
 * pool-shaped sim consumes (`schema.ts:compilePF1eProfile`'s `RawPF1eProfile`). A character sheet must
 * instead author *components* (six scores, armor/shield/natural bonuses), because that is the only way
 * a buff to one of them can move the totals. The tactical rules have exactly one reader — `actor.ts` —
 * so the two shapes meet here, once, and the conversion is *reported* instead of hidden:
 *
 *  - `converted` names every reconstruction the adapter had to guess at (ability scores rebuilt from
 *    modifiers are rounded to the even score that produced them, so a stat block with `strMod: 3`
 *    reports `Str 16` and never claims to know whether it was 16 or 17);
 *  - `unsupported` names every authored field the tactical rules do not implement yet, with the phase
 *    that will implement it — the sheet displays these so "not modelled" is never mistaken for
 *    "not present".
 */
import type { Json } from "../../core/documents";
import { normalizeSize } from "./rulesTables";

/** Authored-but-unimplemented tactical fields, and the phase that owns each. */
const DEFERRED_FIELDS: Record<string, string> = {
  hasTrample: "trample is P6 (movement & special attacks)",
  trampleDamage: "trample is P6 (movement & special attacks)",
  trampleDc: "trample is P6 (movement & special attacks)",
  "weapon.isFirearm": "firearm rules are P6",
  "weapon.isEarlyFirearm": "firearm rules are P6",
  "weapon.misfireMin": "firearm misfire is P6",
  "weapon.material": "material-vs-DR is P7",
  "weapon.elementalType": "energy damage is P5",
  special_abilities: "special qualities are prose until P4's condition library",
  traits: "traits are display-only in P0",
  notes: "display-only",
  keywords: "display-only",
  items: "inventory is out of scope for the combat plan",
};

/** Keys that mean "this block is a stat block, not a sheet". */
const STAT_BLOCK_KEYS = [
  "bab",
  "strMod",
  "dexMod",
  "conMod",
  "intMod",
  "wisMod",
  "chaMod",
  "sizeMod",
  "ac",
  "touchAc",
  "flatFootedAc",
  "weapon",
  "dr",
  "sr",
  "hp",
  "fort",
  "ref",
  "will",
  "casterLevel",
  "spellPenetration",
  "fastHealing",
  "regeneration",
];

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const finiteNumber = (v: unknown): number | undefined => {
  if (typeof v === "number" && Number.isFinite(v)) return Math.trunc(v);
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    if (Number.isFinite(n)) return Math.trunc(n);
  }
  return undefined;
};

/**
 * An ability *modifier* back to the score that produced it. PF1e's mapping is
 * `mod = floor((score − 10) / 2)`, so a modifier only determines the even score; the caller records
 * the reconstruction in `converted`.
 */
export function scoreFromMod(mod: number): number {
  return 10 + 2 * mod;
}

/** "1d8" from a `{ damageDiceCount, damageDiceSides }` pair, or null when either is missing. */
function diceString(
  count: number | undefined,
  sides: number | undefined,
): string | null {
  if (count === undefined || sides === undefined || count < 1 || sides < 2)
    return null;
  return `${count}d${sides}`;
}

export interface NormalizeResult {
  /** A block the tactical derivation can read: components where they can be known, totals where not. */
  system: Record<string, Json>;
  /** Reconstructions the adapter performed, so the UI can say "derived from the stat block". */
  converted: string[];
  /** `field — phase that owns it`, for the sheet's "not modelled yet" list. */
  unsupported: string[];
  /** True when anything at all was converted (i.e. the input was a stat block). */
  convertedFromStatBlock: boolean;
}

/**
 * Convert (or pass through) a `system.pf1e` block. Idempotent: feeding the result back in changes
 * nothing, which is what lets the sheet round-trip an imported bestiary entry.
 */
export function normalizePF1eSystem(raw: unknown): NormalizeResult {
  const converted: string[] = [];
  const unsupported: string[] = [];
  const src = isRecord(raw) ? raw : {};
  // `system` is JSON by contract (documents.ts:38), so the unknown-typed bag carries no more risk
  // than the document it came from; the adapter only ever narrows what it writes back.
  const out = { ...src } as Record<string, Json>;

  const note = (field: string): void => {
    const owner = DEFERRED_FIELDS[field];
    if (owner) unsupported.push(`${field} — ${owner}`);
  };
  for (const key of Object.keys(src)) note(key);

  const isStatBlock = STAT_BLOCK_KEYS.some((k) => src[k] !== undefined);
  if (!isStatBlock) {
    return {
      system: out,
      converted,
      unsupported,
      convertedFromStatBlock: false,
    };
  }

  // 1. Ability modifiers → scores (only for abilities the block did not already author).
  const authoredAbilities = isRecord(src.abilities) ? src.abilities : {};
  const abilities: Record<string, number> = {};
  for (const key of ["str", "dex", "con", "int", "wis", "cha"] as const) {
    const authored = finiteNumber(authoredAbilities[key]);
    if (authored !== undefined) {
      abilities[key] = authored;
      continue;
    }
    const mod = finiteNumber(src[`${key}Mod`]);
    if (mod === undefined) continue;
    abilities[key] = scoreFromMod(mod);
    converted.push(
      `abilities.${key}: reconstructed from ${key}Mod ${mod} as the even score ${abilities[key]}`,
    );
  }
  if (Object.keys(abilities).length > 0)
    out.abilities = abilities as unknown as Json;

  // 2. Base attack bonus.
  const bab = finiteNumber(src.bab ?? src.baseAttack ?? src.attackBonus);
  if (bab !== undefined && out.baseAttack === undefined) {
    out.baseAttack = bab;
    if (src.baseAttack === undefined && src.attackBonus === undefined) {
      converted.push("baseAttack: taken from the stat block's `bab`");
    }
  }

  // 3. Totals the component model cannot express are carried as `acTotals`, which the derivation
  // honours only when no AC components were authored — the same precedence the sim uses.
  const authoredComponents = isRecord(src.armorClass) || isRecord(src.armor);
  const acTotal = finiteNumber(src.ac);
  if (acTotal !== undefined && (!authoredComponents || src.acMode === "published")) {
    const totals: Record<string, number> = { normal: acTotal };
    const touch = finiteNumber(src.touchAc);
    const flat = finiteNumber(src.flatFootedAc);
    if (touch !== undefined) totals.touch = touch;
    if (flat !== undefined) totals.flatFooted = flat;
    out.acTotals = totals as Json;
    converted.push(
      "armorClass: authored totals kept as totals — no components to recompose from",
    );
  }

  // 4. Saves published as totals must not have the ability modifier added again.
  const flatSaves =
    finiteNumber(src.fort) !== undefined ||
    finiteNumber(src.ref) !== undefined ||
    finiteNumber(src.will) !== undefined;
  if (flatSaves && src.saves === undefined) {
    const saves: Record<string, number> = {};
    for (const [k, v] of [
      ["fort", src.fort],
      ["ref", src.ref],
      ["will", src.will],
    ] as const) {
      const n = finiteNumber(v);
      if (n !== undefined) saves[k] = n;
    }
    out.saves = saves as Json;
    out.savesAsTotal = true;
    converted.push(
      "saves: stat-block totals (already include the ability modifier) — not re-added",
    );
  }

  // 5. Size: a category is used as-is; a bare `sizeMod` cannot name a category, so it is carried and
  //    the derivation applies it to attack/AC *and* CMB/CMD (the recorded A.4 deviation).
  const sizeCategory = normalizeSize(src.size);
  if (sizeCategory !== null) out.size = sizeCategory;
  const sizeMod = finiteNumber(src.sizeMod);
  if (sizeMod !== undefined) {
    out.sizeMod = sizeMod;
    if (out.size === undefined) {
      converted.push(
        `size: not authored — sizeMod ${sizeMod} is applied to attack/AC and to CMB/CMD, so the special size ladder (A.4) is not in play for this block`,
      );
    }
  }

  // 6. One weapon → one attack line. `damageMod` in a stat block already contains the ability
  // contribution, so the line is marked to stop Strength being added a second time.
  if (!Array.isArray(src.attacks) && isRecord(src.weapon)) {
    const w = src.weapon as Record<string, unknown>;
    const count = finiteNumber(w.damageDiceCount);
    const sides = finiteNumber(w.damageDiceSides);
    const dice = diceString(count, sides);
    const enhancement = finiteNumber(w.enhancementBonus) ?? 0;
    const damageMod = finiteNumber(w.damageMod);
    const line: Record<string, Json> = {
      name: typeof w.name === "string" ? w.name : "Attack",
    };
    if (dice !== null) line.damageDice = dice;
    const flat =
      damageMod !== undefined
        ? damageMod - (finiteNumber(src.strMod) ?? 0) + enhancement
        : enhancement;
    if (flat !== 0) line.damageBonus = flat;
    if (damageMod !== undefined) {
      line.abilityDamageIncluded = true;
      converted.push(
        `attacks[0]: damageMod ${damageMod} already includes the ability bonus — Str is not added again`,
      );
    }
    const range = finiteNumber(w.rangeIncrement);
    if (range !== undefined && range > 0) {
      line.ranged = true;
      line.rangeIncrementFt = range;
    }
    // `critThreatMin` is carried unchanged: the SRD and the sim both compare the die roll to the
    // lowest threatening number, so no 21-n conversion happens anywhere.
    const critMin = finiteNumber(w.critThreatMin);
    if (critMin !== undefined) line.critThreatMin = critMin;
    const critMult = finiteNumber(w.critMultiplier);
    if (critMult !== undefined) line.critMultiplier = critMult;
    const dtype = typeof w.damageType === "string" ? w.damageType : undefined;
    if (dtype !== undefined) line.damageType = dtype;
    for (const k of Object.keys(w)) note(`weapon.${k}`);
    out.attacks = [line as Json];
    converted.push("attacks: one line built from the stat block's `weapon`");
  }

  // 7. Defensive special qualities.
  const dr = src.dr;
  if (isRecord(dr)) {
    // The object form is what a stat block publishes; the derivation reads a flat number plus the
    // bypass list, so the object is *replaced* rather than kept alongside it.
    const val = finiteNumber(dr.val) ?? 0;
    out.dr = val;
    if (Array.isArray(dr.bypass)) {
      out.drBypass = dr.bypass.filter(
        (b): b is string => typeof b === "string",
      );
    }
    converted.push(
      `dr: flat value ${val} (the bypass list is carried, DR interaction is P7)`,
    );
  }
  const sr = finiteNumber(src.sr);
  if (sr !== undefined && out.spellResistance === undefined)
    out.spellResistance = sr;
  const regen = src.regeneration;
  if (isRecord(regen)) {
    const value = finiteNumber(regen.value);
    if (value !== undefined) out.regeneration = value;
    if (Array.isArray(regen.suppress)) {
      out.regenSuppress = regen.suppress.filter(
        (s): s is string => typeof s === "string",
      );
    }
  }
  const fastHealing = finiteNumber(src.fastHealing);
  if (fastHealing !== undefined) out.fastHealing = fastHealing;

  // 8. Casting numbers that the pool-shaped block carries flat.
  const casterLevel = finiteNumber(src.casterLevel);
  if (casterLevel !== undefined && !isRecord(src.spells)) {
    out.spells = { casterLevel } as Json;
    converted.push(
      "spells: caster level carried from the stat block; slots stay unauthored",
    );
  }
  // `spellPenetration` and `hp` are spelled the same in both shapes, so they need no copy.
  // Numeric authored dr/regeneration are already canonical and must survive too.
  // Consumed flat aliases are dropped so normalizing the output again is a no-op.
  // dr/regeneration stay as canonical numeric values, whether authored that way or
  // converted from objects above. hp/spellPenetration also keep their keys unchanged.
  const dropped = [
    "strMod",
    "dexMod",
    "conMod",
    "intMod",
    "wisMod",
    "chaMod",
    "bab",
    "ac",
    "touchAc",
    "flatFootedAc",
    "fort",
    "ref",
    "will",
    "weapon",
    "sr",
    "casterLevel",
  ];
  const kept: Record<string, Json> = {};
  for (const [key, value] of Object.entries(out)) {
    if (!dropped.includes(key)) kept[key] = value;
  }

  return { system: kept, converted, unsupported, convertedFromStatBlock: true };
}

/** Which fields would be converted, for the import preview in the sheet (no copying of logic). */
export function describeStatBlock(raw: unknown): {
  statBlock: boolean;
  fields: string[];
} {
  const src = isRecord(raw) ? raw : {};
  const fields = STAT_BLOCK_KEYS.filter((k) => src[k] !== undefined);
  return { statBlock: fields.length > 0, fields };
}
