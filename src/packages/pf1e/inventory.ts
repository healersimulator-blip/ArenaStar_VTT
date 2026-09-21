/**
 * PF1e **inventory** (plan §1.3 / gap G-03) — carrying capacity, load thresholds,
 * encumbrance effects, item weight/price/charges, and containers.
 *
 * Everything here is a pure function of authored data, per D-113: the load level, the
 * encumbrance penalties and the weight totals are *derived on read* and never persisted.
 * The sheet renders them; the derivation's effect funnel consumes the item mods
 * (`itemChanges.ts`), and the load penalties reach attack/AC through the same
 * `derivePF1eActor` path every other penalty uses.
 *
 * Verified sources — the transcription this module is (no invented numbers):
 *
 * - **Table 7-4: Carrying Capacity** (AoN *Carrying Capacity*, CRB p.169) — the light /
 *   medium / heavy column for Strength 1–29, verbatim in `PF1E_CARRYING_CAPACITY_TABLE`.
 * - **Tremendous Strength** — "for Strength scores not shown … find the Strength score
 *   between 20 and 29 that has the same number in the 'ones' digit … and multiply the
 *   numbers in that row by 4 for every 10 points the creature's Strength is above the
 *   score for that row." The `+10 ×4` row of the table is the same rule.
 * - **Bigger and Smaller Creatures** — bipedal multipliers Fine ×1/8 … Colossal ×16.
 * - **Quadrupeds** — *replacing* the bipedal multipliers: Fine ×1/4, Diminutive ×1/2,
 *   Tiny ×3/4, Small ×1, Medium ×1-1/2, Large ×3, Huge ×6, Gargantuan ×12, Colossal ×24.
 * - **Table 7-5: Encumbrance Effects** — medium load: max Dex +3, check penalty −3,
 *   run ×4; heavy load: max Dex +1, check penalty −6, run ×3. Both loads reduce speed to
 *   the same figure on the printed table (20 ft. for a 30-ft. base, 15 ft. for 20 ft.), and
 *   "if your character is wearing armor, use the worse figure (from armor or from load)
 *   for each category. Do not stack the penalties."
 * - **Armor and Encumbrance for Other Base Speeds** — the reduced-speed table for base
 *   speeds 5–120 ft., reproduced here as `reducedSpeedFt` and verified row by row in
 *   `tests/packages/pf1eInventory.test.ts` (the closed form is ⅔ of base, rounded up to
 *   the next 5 ft., minimum 5 ft. — the Paizo design-forum reading of the same table).
 * - **Coins** — "fifty coins to the pound" (CRB Equipment); every coin type weighs the
 *   same, so `pp + gp + sp + cp` coins are `coins / 50` pounds.
 * - **Container contents** count toward the total ("total the weight of all the
 *   character's items, including armor, weapons, and gear"); a container holding items
 *   adds its own weight on top, because the contents are items too.
 *
 * Deliberately **not** encoded: the "stagger around with double your maximum load" and
 * "push or drag five times" figures are reported as `lift` / `push` numbers (they are
 * useful readouts) but no movement state is invented for them; a Bag of Holding's
 * extradimensional capacity is authored content, not a rule this module can know.
 */
import type { PF1eActiveEffect } from "./effects";
import type { PF1eArmorEntry } from "./actor";
import type { PF1eArmorDescriptor } from "./items";
import { resolvePF1eArmor } from "./items";
import { normalizeSize, type PF1eSize } from "./rulesTables";

/** One row of Table 7-4, in pounds (the table prints "or less" / ranges; these are the maxima). */
export interface PF1eCapacityRow {
  light: number;
  medium: number;
  heavy: number;
}

/**
 * Table 7-4: Carrying Capacity, Strength 1–29 (CRB p.169, AoN "Carrying Capacity").
 * Rows 21–29 are the printed rows, not a multiplication of 11–19: the printed table
 * rounds them independently, and the printed numbers win.
 */
export const PF1E_CARRYING_CAPACITY_TABLE: Readonly<Record<number, PF1eCapacityRow>> =
  Object.freeze({
    1: { light: 3, medium: 6, heavy: 10 },
    2: { light: 6, medium: 13, heavy: 20 },
    3: { light: 10, medium: 20, heavy: 30 },
    4: { light: 13, medium: 26, heavy: 40 },
    5: { light: 16, medium: 33, heavy: 50 },
    6: { light: 20, medium: 40, heavy: 60 },
    7: { light: 23, medium: 46, heavy: 70 },
    8: { light: 26, medium: 53, heavy: 80 },
    9: { light: 30, medium: 60, heavy: 90 },
    10: { light: 33, medium: 66, heavy: 100 },
    11: { light: 38, medium: 76, heavy: 115 },
    12: { light: 43, medium: 86, heavy: 130 },
    13: { light: 50, medium: 100, heavy: 150 },
    14: { light: 58, medium: 116, heavy: 175 },
    15: { light: 66, medium: 133, heavy: 200 },
    16: { light: 76, medium: 153, heavy: 230 },
    17: { light: 86, medium: 173, heavy: 260 },
    18: { light: 100, medium: 200, heavy: 300 },
    19: { light: 116, medium: 233, heavy: 350 },
    20: { light: 133, medium: 266, heavy: 400 },
    21: { light: 153, medium: 306, heavy: 460 },
    22: { light: 173, medium: 346, heavy: 520 },
    23: { light: 200, medium: 400, heavy: 600 },
    24: { light: 233, medium: 466, heavy: 700 },
    25: { light: 266, medium: 533, heavy: 800 },
    26: { light: 306, medium: 613, heavy: 920 },
    27: { light: 346, medium: 693, heavy: 1040 },
    28: { light: 400, medium: 800, heavy: 1200 },
    29: { light: 466, medium: 933, heavy: 1400 },
  });

/** Bipedal size multipliers (Bigger and Smaller Creatures). Medium ×1 is the table's own scale. */
const BIPED_SIZE_MULTIPLIERS: Readonly<Record<PF1eSize, number>> = Object.freeze({
  Fine: 1 / 8,
  Diminutive: 1 / 4,
  Tiny: 1 / 2,
  Small: 3 / 4,
  Medium: 1,
  Large: 2,
  Huge: 4,
  Gargantuan: 8,
  Colossal: 16,
});

/** Quadruped multipliers — "instead of the multipliers given above". */
const QUADRUPED_SIZE_MULTIPLIERS: Readonly<Record<PF1eSize, number>> = Object.freeze({
  Fine: 1 / 4,
  Diminutive: 1 / 2,
  Tiny: 3 / 4,
  Small: 1,
  Medium: 3 / 2,
  Large: 3,
  Huge: 6,
  Gargantuan: 12,
  Colossal: 24,
});

/** Load levels, plus the state past the heavy column (documented, never silently heavy). */
export type PF1eLoadLevel = "none" | "medium" | "heavy" | "overloaded";

export interface PF1eCapacityInput {
  /** Strength score. Fractional values are floored — the table's rows are integer scores. */
  strength: number;
  size?: PF1eSize | string | null | undefined;
  /** Creature body form: a quadruped uses the "instead of" multiplier column. */
  quadruped?: boolean | undefined;
  /**
   * Strength **for carrying capacity only** (Muleback Cords, a pack animal harness, a
   * world setting): the score the table is read at, without touching the actor's
   * Strength-derived numbers. Positive and negative both allowed.
   */
  strengthForCapacity?: number | undefined;
  /** Flat pounds added after the table and size multipliers. */
  flatBonusLb?: number | undefined;
}

export interface PF1eCapacity {
  light: number;
  medium: number;
  heavy: number;
  /** The Strength score the table was actually read at (after `strengthForCapacity`). */
  effectiveStrength: number;
  /** `max(1, floor(str))` — a table row always exists, so this never throws. */
  tableStrength: number;
  size: PF1eSize;
  sizeMultiplier: number;
  quadruped: boolean;
  /** Multiplier applied on top of the printed row for Strength above 29 (`+10 → ×4`). */
  tremendousMultiplier: number;
  /** Lift: "as much as his maximum load over his head" = the heavy column. */
  liftLb: number;
  /** "Double his maximum load off the ground" (staggering, 5 ft. per round — not automated). */
  liftOffGroundLb: number;
  /** "Push or drag along the ground as much as five times his maximum load." */
  pushDragLb: number;
  issues: string[];
}

const asRecord = (v: unknown): Record<string, unknown> | null =>
  typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;

const finite = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) ? v : null;

/**
 * Table 7-4 read at a Strength score, with Tremendous Strength for scores above 29.
 * Exported because the unit test pins every printed row against it.
 */
export function capacityRowFor(strength: number): { row: PF1eCapacityRow; multiplier: number; rowStrength: number } {
  const score = Math.max(1, Math.floor(strength));
  if (score <= 29) return { row: PF1E_CARRYING_CAPACITY_TABLE[score] as PF1eCapacityRow, multiplier: 1, rowStrength: score };
  // Tremendous Strength: the row sharing this score's "ones" digit, ×4 per 10 points above it.
  const anchor = score % 10 === 0 ? 20 : 20 + (score % 10);
  const steps = (score - anchor) / 10;
  const row = PF1E_CARRYING_CAPACITY_TABLE[anchor] as PF1eCapacityRow;
  const multiplier = 4 ** steps;
  return { row, multiplier, rowStrength: anchor };
}

/** How much this creature can carry, per Table 7-4 + the size/quadruped multipliers. */
export function carryingCapacityOf(input: PF1eCapacityInput): PF1eCapacity {
  const issues: string[] = [];
  const rawStrength = finite(input.strength);
  if (rawStrength === null) issues.push("strength: not a number — read at 1");
  const bonus = finite(input.strengthForCapacity) ?? 0;
  if (input.strengthForCapacity !== undefined && finite(input.strengthForCapacity) === null)
    issues.push("strengthForCapacity: not a number — ignored");
  const effectiveStrength = Math.max(1, Math.floor(rawStrength ?? 1) + Math.floor(bonus));
  const size = normalizeSize(input.size) ?? "Medium";
  if (input.size !== undefined && input.size !== null && normalizeSize(input.size) === null)
    issues.push(`size: ${String(input.size)} is not a size category — read as Medium`);
  const quadruped = input.quadruped === true;
  const sizeMultiplier = quadruped
    ? QUADRUPED_SIZE_MULTIPLIERS[size]
    : BIPED_SIZE_MULTIPLIERS[size];
  const flatBonusLb = finite(input.flatBonusLb) ?? 0;
  if (input.flatBonusLb !== undefined && finite(input.flatBonusLb) === null)
    issues.push("flatBonusLb: not a number — ignored");
  const { row, multiplier, rowStrength } = capacityRowFor(effectiveStrength);
  // Fractional multipliers (Fine ×1/8) are floored to whole pounds — a creature can carry
  // the whole pounds the table supports, never a fraction of one.
  const scale = (n: number): number => Math.max(0, Math.floor(n * sizeMultiplier * multiplier + flatBonusLb));
  const heavy = scale(row.heavy);
  return {
    light: scale(row.light),
    medium: scale(row.medium),
    heavy,
    effectiveStrength,
    tableStrength: rowStrength,
    size,
    sizeMultiplier,
    quadruped,
    tremendousMultiplier: multiplier,
    liftLb: heavy,
    liftOffGroundLb: heavy * 2,
    pushDragLb: heavy * 5,
    issues,
  };
}

/** Table 7-5: Encumbrance Effects — the penalties each load level applies. */
export const PF1E_ENCUMBRANCE_EFFECTS: Readonly<
  Record<"none" | "medium" | "heavy", { maxDexBonus: number | null; checkPenalty: number; runMultiplier: number; speedCapped: boolean }>
> = Object.freeze({
  none: { maxDexBonus: null, checkPenalty: 0, runMultiplier: 4, speedCapped: false },
  medium: { maxDexBonus: 3, checkPenalty: 3, runMultiplier: 4, speedCapped: true },
  heavy: { maxDexBonus: 1, checkPenalty: 6, runMultiplier: 3, speedCapped: true },
});

/** Where a carried weight falls on Table 7-4. Past the heavy column the load is `"overloaded"`. */
export function loadLevelFor(totalLb: number, capacity: PF1eCapacity): PF1eLoadLevel {
  const total = Math.max(0, finite(totalLb) ?? 0);
  if (total <= capacity.light) return "none";
  if (total <= capacity.medium) return "medium";
  if (total <= capacity.heavy) return "heavy";
  return "overloaded";
}

/**
 * "Armor and Encumbrance for Other Base Speeds" (CRB p.170): the reduced speed for every
 * base speed 5–120 ft. Verified row-by-row against the printed table in the unit test.
 * The closed form is ⅔ of the base, rounded **up** to the next 5 ft., never below 5 ft.
 */
export function reducedSpeedFt(baseSpeedFt: number): number {
  const base = Math.max(5, Math.floor(finite(baseSpeedFt) ?? 0));
  return Math.max(5, Math.ceil((base * 2) / 3 / 5) * 5);
}

export interface PF1eEncumbranceReadout {
  level: PF1eLoadLevel;
  /** True when a load penalty applies at all (medium/heavy). An overloaded creature is past the rules. */
  encumbered: boolean;
  /** Max Dexterity bonus to AC from the load alone (null = no cap). */
  maxDexBonus: number | null;
  /** Armor check penalty from the load alone, as a positive number. */
  checkPenalty: number;
  runMultiplier: number;
  /** Base speed before the load. */
  baseSpeedFt: number;
  /** Speed after the load (unchanged when the creature ignores encumbrance). */
  speedFt: number;
  /** True when this creature's speed is immune to armor/encumbrance (dwarf Slow and Steady). */
  slowAndSteady: boolean;
  issues: string[];
}

export interface PF1eEncumbranceInput extends PF1eCapacityInput {
  totalLb: number;
  /** Base land speed in feet (the actor's authored `landSpeedFt` / `speedFt`). */
  baseSpeedFt?: number | undefined;
  /**
   * "Slow and Steady: Dwarves' speed is never modified by armor or encumbrance" — the
   * creature keeps its base speed. The AC/check penalties still apply.
   */
  slowAndSteady?: boolean | undefined;
}

export function encumbranceReadout(input: PF1eEncumbranceInput): PF1eEncumbranceReadout {
  const capacity = carryingCapacityOf(input);
  const level = loadLevelFor(input.totalLb, capacity);
  const baseSpeedFt = Math.max(0, Math.floor(finite(input.baseSpeedFt) ?? 30));
  const slowAndSteady = input.slowAndSteady === true;
  const effects =
    level === "medium" || level === "heavy"
      ? PF1E_ENCUMBRANCE_EFFECTS[level]
      : PF1E_ENCUMBRANCE_EFFECTS.none;
  const encumbered = level === "medium" || level === "heavy";
  const issues = [...capacity.issues];
  if (level === "overloaded")
    issues.push(
      `total ${Math.round(input.totalLb)} lb exceeds the heavy column (${capacity.heavy} lb) — a character can only lift, not carry, above it`,
    );
  return {
    level,
    encumbered,
    maxDexBonus: encumbered ? effects.maxDexBonus : null,
    checkPenalty: encumbered ? effects.checkPenalty : 0,
    runMultiplier: level === "none" ? PF1E_ENCUMBRANCE_EFFECTS.none.runMultiplier : effects.runMultiplier,
    baseSpeedFt,
    speedFt: encumbered && !slowAndSteady ? reducedSpeedFt(baseSpeedFt) : baseSpeedFt,
    slowAndSteady,
    issues,
  };
}

/**
 * "If your character is wearing armor, use the worse figure (from armor or from load) for
 * each category. Do not stack the penalties." The two categories a load and armor share are
 * the maximum Dexterity bonus (lower wins) and the armor check penalty (larger wins).
 */
export function worseOfArmorAndLoad(
  armor: Pick<PF1eArmorEntry, "maxDexBonus" | "checkPenalty"> | null | undefined,
  load: PF1eEncumbranceReadout,
): { maxDexBonus: number | null; checkPenalty: number } {
  const armorMaxDex = finite(armor?.maxDexBonus);
  const armorPenalty = Math.abs(finite(armor?.checkPenalty) ?? 0);
  const worst: number | null =
    armorMaxDex === null
      ? load.maxDexBonus
      : load.maxDexBonus === null
        ? armorMaxDex
        : Math.min(armorMaxDex, load.maxDexBonus);
  return { maxDexBonus: worst, checkPenalty: Math.max(armorPenalty, load.checkPenalty) };
}

// ─── The item itself ─────────────────────────────────────────────────────────

/** Item categories the converted packs and the sheet agree on. */
export type PF1eItemCategory =
  | "weapon"
  | "armor"
  | "shield"
  | "equipment"
  | "consumable"
  | "container"
  | "loot"
  | "other";

/** Table 7-6 prices are in gp; the sheet's currency block uses the same unit. */
export interface PF1eCurrency {
  pp: number;
  gp: number;
  sp: number;
  cp: number;
}

export interface PF1eItemUses {
  /** Charges/uses left. */
  value: number;
  /** `null` = an item with no charge pool (the ledger is not shown). */
  max: number | null;
  /** `"charges"` (wand/staff), `"single"` (potion/scroll), `"day"`, … — a label, not a timer. */
  per: string | null;
}

export interface PF1eInventoryItem {
  id: string;
  name: string;
  category: PF1eItemCategory;
  quantity: number;
  /** Unit price in gp; `null` when the source has no price (not the same as free). */
  priceGp: number | null;
  /** Unit weight in pounds; `null` when the source has none. */
  weightLb: number | null;
  /** Total weight for the stack, `weightLb × quantity`. */
  totalWeightLb: number;
  equipped: boolean;
  /** False = stored away (a bag of holding, a wagon): excluded from the carried total. */
  carried: boolean;
  /** Parent container's item id, when the item sits inside another item. */
  containerId: string | null;
  uses: PF1eItemUses | null;
  /** Worn armor/shield facts, when the item is one (already validated by `resolvePF1eArmor`). */
  armor: PF1eArmorDescriptor | null;
  /** Raw weapon block as authored (the typed read is `resolvePF1eWeapon`'s job, `weapons.ts`). */
  weapon: Record<string, unknown> | null;
  hp: number | null;
  hardness: number | null;
  broken: boolean;
  traits: string[];
  /** Foundry `changes[]` as the converter carried them; the typed read is `itemChanges.ts`. */
  changes: readonly unknown[];
  /** Foundry caster level, when the source published one. */
  casterLevel: number | null;
  /**
   * How many Foundry `scriptCalls` the source item carried (the converter drops them). They
   * are counted, never run — an item with scripts is *described*, not automated.
   */
  scriptCalls: number;
  /** Authored consumable facts (a generated wand/scroll/potion carries them). */
  consumable: PF1eConsumableAuthored | null;
  /** Strength bonus that applies to carrying capacity only (Muleback-style items). */
  capacityStrengthBonus: number | null;
  /** "Slow and Steady"-style flags an item or trait grants. */
  slowAndSteady: boolean;
  /** Enough of the description for the item window's first paint. */
  description: string;
}

/** A consumable this app can generate and spend charges on (plan §1.3 item 4). */
export interface PF1eConsumableAuthored {
  kind: "potion" | "wand" | "scroll" | "staff";
  /** The spell it holds (save type validated to the three kinds, else absent). */
  spell: {
    name: string;
    level: number;
    saveType?: "fort" | "ref" | "will" | null;
    damageFormula?: string | null;
    energyType?: string | null;
  };
  /** Item caster level (wands default to 5 — the level Craft Wand requires). */
  casterLevel: number;
}

const ITEM_CATEGORIES: readonly PF1eItemCategory[] = [
  "weapon",
  "armor",
  "shield",
  "equipment",
  "consumable",
  "container",
  "loot",
  "other",
];

/** The three saving throws, or `null` for anything else (a spell with no save). */
function readSaveType(v: unknown): "fort" | "ref" | "will" | null {
  return v === "fort" || v === "ref" || v === "will" ? v : null;
}

function readString(v: unknown): string | null {
  return typeof v === "string" && v.trim() !== "" ? v.trim() : null;
}

function readInt(v: unknown): number | null {
  const n = finite(v);
  return n === null ? null : Math.trunc(n);
}

function readDescription(system: Record<string, unknown>): string {
  const direct = readString(system.description);
  if (direct !== null) return direct;
  const block = asRecord(system.description);
  const value = readString(block?.value);
  return value ?? "";
}

/**
 * Category from the authored kind: the converter writes `category` (the Foundry item type),
 * the sheet writes it too when it authors an item by hand. A weapon/armor block wins over a
 * generic label, because the *mechanical* half is what the tabs group by.
 */
function categoryOf(system: Record<string, unknown>, declared: string | null): PF1eItemCategory {
  const weapon = asRecord(system.weapon);
  const armor = asRecord(system.armor);
  const armorBonus = finite(armor?.armorBonus) ?? finite(armor?.bonus);
  const shieldBonus = finite(armor?.shieldBonus);
  if (declared === "shield" || (shieldBonus ?? 0) > 0) return "shield";
  if (declared === "armor") return "armor";
  if ((armorBonus ?? 0) > 0) return "armor";
  if (weapon !== null) return "weapon";
  if (declared === "consumable" || asRecord(system.consumable) !== null) return "consumable";
  if (declared === "container" || system.container === true) return "container";
  if (declared !== null && (ITEM_CATEGORIES as readonly string[]).includes(declared))
    return declared as PF1eItemCategory;
  if (declared === "loot" || declared === "treasure") return "loot";
  return "other";
}

/**
 * An item's Foundry `changes[]`. Two source shapes reach us and both are normal:
 *
 * - the vendored Foundry packs put them at `system.changes` as an **id-keyed object**
 *   (`{ "16dXxr9a": { formula, target, type } }`) — Foundry's collection spelling;
 * - the converter carries the pf1 system's `system.changes` to `system.foundry.changes`,
 *   where the pinned commit's own shape is either an array (`{ formula, operator, subTarget,
 *   modifier }`) or that same object map.
 *
 * Only the shape is normalized here; *meaning* is `itemChanges.ts`'s job (which targets map,
 * which are named as unmapped).
 */
function readChanges(system: Record<string, unknown>): readonly unknown[] {
  for (const candidate of [system.changes, asRecord(system.foundry)?.changes]) {
    if (Array.isArray(candidate)) return candidate;
    const map = asRecord(candidate);
    if (map !== null) {
      const values = Object.values(map);
      if (values.length > 0) return values;
    }
  }
  return [];
}

function usesOf(system: Record<string, unknown>): PF1eItemUses | null {
  const raw = asRecord(system.uses);
  if (raw === null) return null;
  const value = readInt(raw.value) ?? 0;
  const max =
    readInt(raw.max) ??
    readInt(raw.maxFormula === "" || raw.maxFormula === undefined ? undefined : Number(raw.maxFormula));
  const per = readString(raw.per);
  if (max === null && per === null && value === 0) return null;
  return {
    value: Math.max(0, value),
    max: max === null ? null : Math.max(0, max),
    per,
  };
}

/**
 * Foundry's item template carries an `armor` block on **every** physical item, and 3,956 of the
 * converted entries (measured across the 28 packs) have one that is all zeros — the base-item
 * artifact of a cloak or a wand, not a suit of armor. Reading it as armor prints
 * "armor +0 · max Dex +0 · ACP −0" on the row and, because an armor slot caps Dexterity, would
 * silently floor a wearer's AC as soon as the item's category ever says `armor`. An all-zero
 * block therefore reads as **no armor**; an authored `slot`/`proficiency` still counts as the
 * author saying "this is armor" and is kept as written.
 */
function isZeroArmorBlock(raw: Record<string, unknown>): boolean {
  for (const key of ["armorBonus", "shieldBonus", "maxDexBonus", "checkPenalty", "spellFailure"]) {
    const value = finite(raw[key]);
    if (value !== null && value !== 0) return false;
  }
  return readString(raw.slot) === null && readString(raw.proficiency) === null;
}

function consumableOf(system: Record<string, unknown>): PF1eConsumableAuthored | null {
  const raw = asRecord(system.consumable);
  if (raw === null) return null;
  const kind = readString(raw.kind);
  if (kind !== "potion" && kind !== "wand" && kind !== "scroll" && kind !== "staff") return null;
  const spell = asRecord(raw.spell);
  const name = readString(spell?.name);
  if (name === null) return null;
  return {
    kind,
    spell: {
      name,
      level: Math.min(9, Math.max(0, readInt(spell?.level) ?? 0)),
      saveType: readSaveType(spell?.saveType),
      damageFormula: readString(spell?.damageFormula),
      energyType: readString(spell?.energyType),
    },
    casterLevel: Math.max(1, readInt(raw.casterLevel) ?? (kind === "wand" || kind === "staff" ? 5 : 1)),
  };
}

/**
 * Read one embedded `ItemDocument` into the inventory contract. Garbage in ⇒ a usable
 * minimum item out, with every malformed field named in `issues` — the `resolvePF1eArmor`
 * convention, applied to the inventory half.
 */
export function resolveInventoryItem(
  doc: unknown,
  issues: string[] = [],
): PF1eInventoryItem {
  const record = asRecord(doc);
  const where = readString(record?.name) ?? "item";
  const system = asRecord(record?.system) ?? {};
  if (record === null) issues.push("item: not an object — read as an empty item");
  const foundry = asRecord(system.foundry);
  const quantityRaw = system.quantity ?? foundry?.quantity;
  const quantity = Math.max(0, readInt(quantityRaw) ?? 1);
  if (quantityRaw !== undefined && readInt(quantityRaw) === null)
    issues.push(`${where}.quantity: not an integer — read as 1`);
  const weight = finite(system.weight);
  if (system.weight !== undefined && weight === null)
    issues.push(`${where}.weight: not a number — read as unweighed`);
  const price = finite(system.value);
  if (system.value !== undefined && price === null)
    issues.push(`${where}.value: not a number — read as unpriced`);
  const containerId = readString(system.containerId) ?? readString(system.container);
  const armorRaw = asRecord(system.armor);
  const armor =
    armorRaw === null || isZeroArmorBlock(armorRaw)
      ? null
      : (() => {
          const resolved = resolvePF1eArmor(armorRaw);
          for (const issue of resolved.issues) issues.push(`${where}.${issue}`);
          return resolved.armor;
        })();
  const weapon = asRecord(system.weapon);
  const declaredCategory = readString(system.category) ?? readString(system.kind);
  const uses = usesOf(system);
  return {
    id: readString(record?._id) ?? "",
    name: where,
    category: categoryOf(system, declaredCategory),
    quantity,
    priceGp: price === null ? null : Math.max(0, price),
    weightLb: weight === null ? null : Math.max(0, weight),
    totalWeightLb: Math.max(0, (weight ?? 0) * quantity),
    // PF1e: an item grants its continuous bonuses only while worn or wielded. Foundry's own
    // default for a misc magic item is `equipped: true`, so absent follows the authored field
    // the converter carried.
    equipped: system.equipped === true || foundry?.equipped === true,
    carried: system.carried !== false && foundry?.carried !== false,
    containerId,
    uses,
    armor,
    weapon,
    hp: readInt(system.hp ?? foundry?.hp),
    hardness: readInt(system.hardness ?? foundry?.hardness),
    broken: system.broken === true,
    traits: Array.isArray(system.traits)
      ? system.traits.filter((t): t is string => typeof t === "string")
      : [],
    changes: readChanges(system),
    casterLevel: readInt(system.cl) ?? readInt(foundry?.cl),
    scriptCalls: Array.isArray(system.scriptCalls) ? system.scriptCalls.length : 0,
    consumable: consumableOf(system),
    capacityStrengthBonus: readInt(system.capacityStrengthBonus),
    slowAndSteady: system.slowAndSteady === true,
    description: readDescription(system),
  };
}

/** Every embedded item of an actor, validated one by one (never throws on a bad row). */
export function readInventoryItems(
  items: readonly unknown[] | undefined,
): { items: PF1eInventoryItem[]; issues: string[] } {
  const issues: string[] = [];
  const out: PF1eInventoryItem[] = [];
  for (const raw of items ?? []) out.push(resolveInventoryItem(raw, issues));
  return { items: out, issues };
}

/**
 * The carried weight: every carried item's stack weight, plus the coins.
 *
 * Container contents are items too and are already in the list, so a container adds its own
 * weight only — this is why the container is *not* special-cased: the SRD total is "the
 * weight of all the character's items", and the items inside a container are among them.
 * An item whose `carried` is false is stored away and contributes nothing.
 */
export function carriedWeightLb(items: readonly PF1eInventoryItem[], currency?: PF1eCurrency | null): number {
  let total = 0;
  for (const item of items) if (item.carried) total += item.totalWeightLb;
  return round2(total + coinWeightLb(currency ?? null));
}

/** "Fifty coins to the pound" — every coin type weighs the same. */
export function coinWeightLb(currency: PF1eCurrency | null | undefined): number {
  if (!currency) return 0;
  const coins =
    Math.max(0, finite(currency.pp) ?? 0) +
    Math.max(0, finite(currency.gp) ?? 0) +
    Math.max(0, finite(currency.sp) ?? 0) +
    Math.max(0, finite(currency.cp) ?? 0);
  return coins / 50;
}

/** The sheet's pp/gp/sp/cp block, read from an authored `system.pf1e.currency`. */
export function readCurrency(raw: unknown): { currency: PF1eCurrency; issues: string[] } {
  const issues: string[] = [];
  const record = asRecord(raw) ?? {};
  const take = (key: keyof PF1eCurrency): number => {
    const v = finite(record[key]);
    if (record[key] !== undefined && v === null) {
      issues.push(`currency.${key}: not a number — read as 0`);
      return 0;
    }
    return Math.max(0, Math.floor(v ?? 0));
  };
  return {
    currency: { pp: take("pp"), gp: take("gp"), sp: take("sp"), cp: take("cp") },
    issues,
  };
}

/** One currency in gp (10 sp = 1 gp, 10 cp = 1 sp, 10 gp = 1 pp). */
export function currencyInGp(currency: PF1eCurrency): number {
  return round2(
    currency.pp * 10 + currency.gp + currency.sp / 10 + currency.cp / 100,
  );
}

/** Total price of the inventory, in gp (stacks count their quantity; unpriced items are named). */
export function inventoryValueGp(items: readonly PF1eInventoryItem[]): { totalGp: number; unpriced: string[] } {
  let total = 0;
  const unpriced: string[] = [];
  for (const item of items) {
    if (item.priceGp === null) {
      unpriced.push(item.name);
      continue;
    }
    total += item.priceGp * item.quantity;
  }
  return { totalGp: round2(total), unpriced };
}

/**
 * The armor entry a wearer actually wears: the **equipped** armor and shield from the item
 * list. `PF1eArmorEntry` is what `derivePF1eActor` reads for AC and what the load's
 * "worse figure" rule compares against, so an equipped suit has to arrive there as one.
 * A broken suit's adjustments (AoN 413) are applied by `brokenArmorAdjustments` at read
 * time; this only picks the pieces up.
 */
export function equippedArmorEntry(items: readonly PF1eInventoryItem[]): PF1eArmorEntry | null {
  const worn = items.filter(
    (i) => i.equipped && i.armor !== null && (i.category === "armor" || i.category === "shield"),
  );
  if (worn.length === 0) return null;
  const entry: PF1eArmorEntry = {};
  for (const item of worn) {
    const armor = item.armor;
    if (armor === null) continue;
    if (armor.slot === "shield") entry.shieldBonus = (entry.shieldBonus ?? 0) + armor.shieldBonus;
    else entry.armorBonus = (entry.armorBonus ?? 0) + armor.armorBonus;
    if (armor.maxDexBonus !== null) {
      entry.maxDexBonus =
        entry.maxDexBonus === undefined ? armor.maxDexBonus : Math.min(entry.maxDexBonus, armor.maxDexBonus);
    }
    entry.checkPenalty = (entry.checkPenalty ?? 0) + armor.checkPenalty;
    entry.spellFailure = (entry.spellFailure ?? 0) + armor.spellFailure;
  }
  return entry;
}

/** "Slow and Steady"-style immunity, wherever it is authored (actor traits or a worn item). */
export function slowAndSteadyOf(items: readonly PF1eInventoryItem[], actorTraits: readonly string[] = []): boolean {
  if (items.some((i) => i.equipped && i.slowAndSteady)) return true;
  return actorTraits.some((t) => t.trim().toLowerCase() === "slow and steady");
}

/** The capacity-only Strength bonus the *equipped* items grant (Muleback Cords: +8). */
export function capacityStrengthBonusOf(items: readonly PF1eInventoryItem[]): number {
  return items.reduce((n, i) => n + (i.equipped ? (i.capacityStrengthBonus ?? 0) : 0), 0);
}

/**
 * Items grouped for the sheet: containers first, their contents nested one level deep, then
 * everything else. A container id that names no item is treated as top level (and named),
 * so a deleted container never hides its contents.
 */
export interface PF1eInventoryNode {
  item: PF1eInventoryItem;
  children: PF1eInventoryItem[];
}

export function inventoryTree(items: readonly PF1eInventoryItem[]): {
  roots: PF1eInventoryNode[];
  orphans: PF1eInventoryItem[];
} {
  const byId = new Map(items.map((i) => [i.id, i]));
  const roots: PF1eInventoryNode[] = [];
  const orphans: PF1eInventoryItem[] = [];
  const placed = new Set<string>();
  for (const item of items) {
    // A container is *any* item another item names, whatever its category says.
    if (item.containerId !== null && byId.has(item.containerId)) placed.add(item.id);
  }
  for (const item of items) {
    if (placed.has(item.id)) continue;
    const children = items.filter((i) => i.containerId === item.id);
    roots.push({ item, children });
    if (item.containerId !== null && !byId.has(item.containerId)) orphans.push(item);
  }
  return { roots, orphans };
}

/** The item mods as active effects, so they stack through the one resolver (`itemChanges.ts`). */
export type { PF1eActiveEffect };

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
