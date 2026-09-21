/**
 * PF1e **consumables and item→attack linkage** (plan §1.3 items 4/T6, gaps G-04/G-05).
 *
 * Two jobs, both pure:
 *
 * 1. **Generate a consumable from a spell.** A wand, scroll, potion or staff holds a spell;
 *    the app writes it as an ordinary embedded item carrying a `consumable` block (the spell,
 *    its level, its save/damage payload) and a `uses` ledger. The charge numbers are the
 *    printed ones: a **wand has 50 charges** ("a wand holds 50 charges" and cannot be
 *    recharged), a **scroll** and a **potion** are single-use (`uses: 1`), a **staff** holds
 *    **10 charges** and can be recharged. Item caster level: the wand/staff default is **5**
 *    (`Craft Wand` requires caster level 5th; wands in the CRB are published "CL 5th"), the
 *    potion/scroll default is the **minimum caster level** for the spell's level.
 * 2. **Link a weapon item to an attack line.** `attackEntryFromWeapon` reads the item's
 *    authored weapon block through `resolvePF1eWeapon` and writes the `PF1eAttackEntry` the
 *    sheet's existing attack editor and the whole resolve path already consume — the item is
 *    the *source*, the attack line is the *derived, editable copy*, and the two are linked by
 *    the attack line's `itemId` so the sheet can show where it came from.
 *
 * The spell's save DC from a spell-trigger/spell-completion item is not the caster's: it is
 * the **minimum** for the spell's level — `10 + spell level + the ability modifier of the
 * minimum score needed to cast that level` (CRB "Spell Trigger" / "Spell Completion"), i.e.
 * a wand of *fireball* (3rd) has DC 14. `minimumAbilityScore` (spellSlots.ts) already owns
 * that table, so `itemSpellDc` reads it rather than restating it.
 */
import type { PF1eAttackEntry } from "./actor";
import type { PF1eSaveSeverity, PF1eSaveType } from "./casting";
import type { PF1eEnergyType } from "./healthState";
import { normalizeSize, PF1E_SIZES, type PF1eSize } from "./rulesTables";
import { minimumAbilityScore } from "./spellSlots";
import { resolvePF1eWeapon, type PF1eWeaponDescriptor } from "./weapons";
import type { PF1eConsumableAuthored, PF1eInventoryItem, PF1eItemUses } from "./inventory";

/** The spell facts a consumable stores (a subset of the sheet's spell row). */
export interface PF1eConsumableSpell {
  name: string;
  level: number;
  saveType?: "fort" | "ref" | "will" | null;
  severity?: string | null;
  damageFormula?: string | null;
  energyType?: string | null;
}

export type PF1eConsumableKind = PF1eConsumableAuthored["kind"];

/** Printed charge budgets: wands 50 ("a wand holds 50 charges"), staves 10, potions/scrolls 1. */
export const CONSUMABLE_CHARGES: Readonly<Record<PF1eConsumableKind, number>> = Object.freeze({
  potion: 1,
  scroll: 1,
  wand: 50,
  staff: 10,
});

/** `Craft Wand` requires caster level 5th — the published default for a wand (and a staff). */
export const CONSUMABLE_DEFAULT_CASTER_LEVEL: Readonly<Record<PF1eConsumableKind, number>> =
  Object.freeze({ potion: 1, scroll: 1, wand: 5, staff: 8 });

/** The minimum caster level for a spell of this level (Table: caster level ↔ spell level). */
export function minimumCasterLevel(spellLevel: number): number {
  const level = Math.max(0, Math.min(9, Math.floor(spellLevel)));
  if (level === 0) return 1;
  return Math.max(1, level * 2 - 1);
}

/**
 * The save DC of a spell cast from a spell-trigger / spell-completion item: `10 + spell level
 * + the ability modifier of the minimum ability score required to cast that level`. The
 * minimum score comes from `minimumAbilityScore` (Table 1-1 style), so this cannot drift from
 * the sheet's own "can I cast this level" gate.
 */
export function itemSpellDc(spellLevel: number): number {
  const level = Math.max(0, Math.min(9, Math.floor(spellLevel)));
  const min = minimumAbilityScore(level);
  const mod = min === null ? 0 : Math.floor((min - 10) / 2);
  return 10 + level + mod;
}

/**
 * The DC a scroll or potion uses. It is the same rule as a wand's (a fixed item, never the
 * reader's stats), and it is spelled as its own function because the *callers* differ: a GM
 * asking "what would this scroll save against" should not have to know that.
 */
export function consumableSaveDc(spellLevel: number): number {
  return itemSpellDc(spellLevel);
}

export interface PF1eConsumablePlan {
  kind: PF1eConsumableKind;
  name: string;
  /** `system.pf1e` body of the generated item (the sheet writes it with a normal `create` op). */
  system: Record<string, unknown>;
  /** The `uses` ledger the item starts with. */
  uses: PF1eItemUses;
  casterLevel: number;
  saveDc: number;
  /** Short lines the UI shows before it writes anything (the "what will be made" preview). */
  notes: string[];
}

const KIND_LABEL: Readonly<Record<PF1eConsumableKind, string>> = Object.freeze({
  potion: "Potion",
  scroll: "Scroll",
  wand: "Wand",
  staff: "Staff",
});

const KIND_CATEGORY: Readonly<Record<PF1eConsumableKind, string>> = Object.freeze({
  potion: "consumable",
  scroll: "consumable",
  wand: "consumable",
  staff: "consumable",
});

/**
 * Build the item a GM gets from "make a wand from this spell". Nothing is derived-and-persisted
 * that should not be: the charge budget is the printed 50/10/1, and the DC is recomputed on read
 * by `itemSpellDc` (it is *also* stamped into the item so a printed stat block's own DC can be
 * overridden — an authored `dc` wins, and the item window says which one is in force).
 */
export function planConsumable(input: {
  spell: PF1eConsumableSpell;
  kind: PF1eConsumableKind;
  /** Override the default item caster level (a GM building a CL 9 wand). */
  casterLevel?: number | undefined;
  /** Override the DC (an item whose printed DC differs). */
  saveDc?: number | undefined;
  /** Item price in gp; absent = unpriced (the sheet shows "—"). */
  priceGp?: number | undefined;
  /** Item weight in pounds; absent = unweighed. */
  weightLb?: number | undefined;
}): PF1eConsumablePlan {
  const kind = input.kind;
  const spellLevel = Math.max(0, Math.min(9, Math.floor(input.spell.level)));
  const casterLevel = Math.max(
    1,
    Math.floor(input.casterLevel ?? CONSUMABLE_DEFAULT_CASTER_LEVEL[kind]),
  );
  const charges = CONSUMABLE_CHARGES[kind];
  const saveDc = Math.floor(input.saveDc ?? itemSpellDc(spellLevel));
  const name = `${KIND_LABEL[kind]} of ${input.spell.name}`;
  const notes: string[] = [
    `${KIND_LABEL[kind]} · ${charges} charge${charges === 1 ? "" : "s"}`,
    `CL ${casterLevel} · save DC ${saveDc} (the item's own, not the wielder's)`,
  ];
  if (kind === "wand") notes.push("A wand holds 50 charges and cannot be recharged.");
  if (kind === "staff") notes.push("A staff holds 10 charges and can be recharged.");
  const system: Record<string, unknown> = {
    category: KIND_CATEGORY[kind],
    description:
      input.spell.name +
      (spellLevel === 0 ? " (cantrip/orison)" : ` (level ${spellLevel})`) +
      ` stored in a ${kind}.`,
    quantity: 1,
    equipped: false,
    carried: true,
    traits: [kind, input.spell.name],
    // Foundry's own caster-level field name — the item sheet's properties read `system.cl`,
    // and `system.consumable.casterLevel` is the same number for the cast path.
    cl: casterLevel,
    // Wands and staves are charge pools; a scroll and a potion are spent whole (`single` is
    // Foundry's own spelling for that).
    uses: {
      value: charges,
      max: charges,
      per: kind === "wand" || kind === "staff" ? "charges" : "single",
    },
    consumable: {
      kind,
      casterLevel,
      saveDc,
      spell: {
        name: input.spell.name,
        level: spellLevel,
        saveType: input.spell.saveType ?? null,
        severity: input.spell.severity ?? null,
        damageFormula: input.spell.damageFormula ?? null,
        energyType: input.spell.energyType ?? null,
      },
    },
  };
  if (input.priceGp !== undefined) system.value = input.priceGp;
  if (input.weightLb !== undefined) system.weight = input.weightLb;
  return {
    kind,
    name,
    system,
    uses: {
      value: charges,
      max: charges,
      per: kind === "wand" || kind === "staff" ? "charges" : "single",
    },
    casterLevel,
    saveDc,
    notes,
  };
}

export interface PF1eUseOutcome {
  ok: boolean;
  error: string | null;
  /** The `uses` ledger after the spend (`null` for an item with no ledger). */
  uses: PF1eItemUses | null;
  /** Lines for the cast card / the sheet's status line. */
  notes: string[];
}

/**
 * Spend one charge/use. Refusals are named rather than silent: an empty wand says so, and an
 * item with no charge pool is *not* a consumable. The caller writes the returned ledger with a
 * normal embedded `update` op — this module never touches a store.
 */
export function spendUse(item: PF1eInventoryItem, count = 1): PF1eUseOutcome {
  const spend = Math.max(1, Math.floor(count));
  if (item.uses === null)
    return { ok: false, error: `"${item.name}" has no charge ledger.`, uses: null, notes: [] };
  if (item.uses.value < spend)
    return {
      ok: false,
      error:
        item.uses.value === 0
          ? `"${item.name}" is out of charges.`
          : `"${item.name}" has ${item.uses.value} charge(s) left — ${spend} requested.`,
      uses: item.uses,
      notes: [],
    };
  const uses: PF1eItemUses = { ...item.uses, value: item.uses.value - spend };
  return {
    ok: true,
    error: null,
    uses,
    notes: [`${uses.value}${uses.max === null ? "" : ` / ${uses.max}`} charge(s) left`],
  };
}

/** A charge/use restored (a recharged staff, a refilled wand for the GM's ledger). */
export function restoreUse(item: PF1eInventoryItem, count = 1): PF1eUseOutcome {
  const add = Math.max(1, Math.floor(count));
  if (item.uses === null)
    return { ok: false, error: `"${item.name}" has no charge ledger.`, uses: null, notes: [] };
  const max = item.uses.max;
  const value = max === null ? item.uses.value + add : Math.min(max, item.uses.value + add);
  const uses: PF1eItemUses = { ...item.uses, value };
  return {
    ok: true,
    error: null,
    uses,
    notes: max !== null && value === max ? [`${item.name} is full (${max})`] : [`${value} / ${max ?? "—"} charge(s)`],
  };
}

/**
 * The `authored` block a cast from an item starts from. The item's own spell carries the save
 * type and the damage dice; the **severity** is not on the item, so it is the ordinary reading
 * of the printed spell: a damaging spell is *half* on a save (the fireball/breath line) and a
 * non-damaging one is *negates*. An item with no save at all is authored with a save type of
 * `will` and a severity of `none`, which is exactly "no saving throw is allowed" (AoN 212) —
 * the save type is unused in that case and the card says so.
 */
export function consumableCastAuthored(spell: PF1eConsumableSpell): {
  saveType: PF1eSaveType;
  severity: PF1eSaveSeverity;
  damageFormula: string;
  energyType?: PF1eEnergyType;
} {
  const damageFormula = spell.damageFormula?.trim() ?? "";
  const saveType: PF1eSaveType =
    spell.saveType === "fort" || spell.saveType === "ref" || spell.saveType === "will"
      ? spell.saveType
      : "will";
  const noSave = spell.saveType === null || spell.saveType === undefined;
  const severity: PF1eSaveSeverity = noSave ? "none" : damageFormula !== "" ? "half" : "negates";
  const energy = spell.energyType?.trim() ?? "";
  return {
    saveType,
    severity,
    damageFormula,
    ...(energy !== "" ? { energyType: energy as PF1eEnergyType } : {}),
  };
}

// ─── Item → cast source (the `resolveCastFlow` seam) ─────────────────────────

/**
 * What a cast **from an item** tells the cast flow (structurally the `source` field of
 * `PF1eCastFlowParams`; this file owns the numbers so the flow does not).
 */
export interface PF1eItemCastSource {
  kind: PF1eConsumableKind;
  /** The embedded item on the caster's actor, for the charge-decrement op. */
  itemId: string;
  /** Display name for the card ("Wand of Fireball"). */
  itemName: string;
  /** The item's caster level (wands default to 5). */
  casterLevel: number;
  /** The item's save DC — never the wielder's. */
  saveDc: number;
  /** Charges before the cast; the flow writes `value − 1`. */
  charges: number;
}

/**
 * Read one item as a cast source, or explain why it is not one. A consumable needs both a
 * spell and a charge ledger: a scroll found in a pack with neither stays described data.
 */
export function itemCastSource(
  item: PF1eInventoryItem,
): { ok: true; source: PF1eItemCastSource; notes: string[] } | { ok: false; error: string } {
  const consumable = item.consumable;
  if (consumable === null)
    return { ok: false, error: `"${item.name}" holds no spell — nothing to cast.` };
  if (item.uses === null)
    return { ok: false, error: `"${item.name}" has no charge ledger to spend.` };
  const notes: string[] = [
    `${consumable.kind}: ${consumable.spell.name} (spell level ${consumable.spell.level})`,
    `item caster level ${consumable.casterLevel}, save DC ${consumableSaveDc(consumable.spell.level)}`,
  ];
  if (item.uses.value <= 0) notes.push("out of charges — the flow will refuse the cast");
  return {
    ok: true,
    source: {
      kind: consumable.kind,
      itemId: item.id,
      itemName: item.name,
      casterLevel: consumable.casterLevel,
      saveDc: consumableSaveDc(consumable.spell.level),
      charges: item.uses.value,
    },
    notes,
  };
}

// ─── Item → attack line ──────────────────────────────────────────────────────

/**
 * Every weapon-shaped item on the actor, with its typed descriptor. An item with no
 * `system.weapon` block is not a weapon (a sword the converter only described is data, not
 * a weapon) — `resolvePF1eWeapon` is what decides, so the sheet cannot invent one.
 */
export function weaponItemsOf(items: readonly PF1eInventoryItem[]): Array<{
  item: PF1eInventoryItem;
  weapon: PF1eWeaponDescriptor;
  issues: string[];
}> {
  const out: Array<{ item: PF1eInventoryItem; weapon: PF1eWeaponDescriptor; issues: string[] }> = [];
  for (const item of items) {
    if (item.weapon === null) continue;
    const resolved = resolvePF1eWeapon(item.weapon);
    out.push({ item, weapon: resolved.weapon, issues: resolved.issues });
  }
  return out;
}

/** A finite number out of a loosely-typed authored block (an item's raw `weapon` JSON), else 0. */
function flatNumber(raw: unknown): number {
  if (typeof raw === "number") return Number.isFinite(raw) ? raw : 0;
  if (typeof raw === "string" && raw.trim() !== "") {
    const n = Number(raw);
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

/** Melee reach in 5-ft. squares for a size, from the weapon's own flags (reach doubles it). */
function reachSquaresFor(size: PF1eSize, reach: boolean): number {
  const natural: Record<PF1eSize, number> = {
    Fine: 0,
    Diminutive: 0,
    Tiny: 0,
    Small: 1,
    Medium: 1,
    Large: 1,
    Huge: 2,
    Gargantuan: 2,
    Colossal: 2,
  };
  const base = natural[size];
  return reach ? base * 2 : base;
}

/**
 * The `PF1eAttackEntry` a weapon item produces — the sheet's "create attack from this weapon"
 * action. This is a **copy for editing**: the attack line is the derived, GM-editable thing
 * the resolve path consumes, and it records `itemId` so the sheet can say where it came from
 * and offer a re-sync. Nothing here re-derives attack arithmetic (that is `derivePF1eActor`'s
 * job): it copies the weapon's facts into the authored line.
 */
export function attackEntryFromWeapon(input: {
  item: PF1eInventoryItem;
  size?: PF1eSize | string | null | undefined;
}): PF1eAttackEntry {
  const resolved = resolvePF1eWeapon(input.item.weapon ?? {});
  const weapon = resolved.weapon;
  const size = normalizeSize(input.size) ?? "Medium";
  const ranged = weapon.class === "projectile" || weapon.class === "firearm" || (weapon.class === "thrown");
  // The item's own name is the attack line's name (an item called "Longsword" makes a
  // "Longsword" attack). A weapon block that authors a `name` (a magic weapon's own label)
  // wins, because that is the authored intent.
  const authoredName =
    typeof input.item.weapon?.name === "string" && input.item.weapon.name.trim() !== ""
      ? input.item.weapon.name.trim()
      : "";
  // A weapon described by a printed damage *total* (a stat block's `damageMod`, a Hero Lab
  // `damage="1d8+4"`, a Roll20 damage field) carries the remainder of that total in the item's
  // `damageBonus` and says the ability contribution is already inside it — the pair
  // `statBlock.ts` authors for the same reason, so the derivation does not add Strength twice.
  const authoredFlat = flatNumber(input.item.weapon?.damageBonus);
  const authoredAbilityIncluded = input.item.weapon?.abilityDamageIncluded === true;
  const entry: PF1eAttackEntry = {
    name: authoredName !== "" ? authoredName : input.item.name !== "" ? input.item.name : weapon.name,
    itemId: input.item.id,
    ranged,
    damageType: weapon.damageType,
    critThreatMin: weapon.critThreatMin,
    critMultiplier: weapon.critMultiplier,
    twoHanded: weapon.handedness === "two-handed",
    offHand: weapon.handedness === "light" && !ranged,
    reachSquares: reachSquaresFor(size, weapon.reach),
    touchAttack: weapon.touch,
    ...(weapon.enhancementBonus > 0
      ? { damageBonus: weapon.enhancementBonus }
      : authoredFlat !== 0
        ? { damageBonus: authoredFlat }
        : {}),
  };
  if (authoredAbilityIncluded && entry.damageBonus !== undefined) entry.abilityDamageIncluded = true;
  if (weapon.damageDice !== null) entry.damageDice = weapon.damageDice;
  if (weapon.rangeIncrementFt !== null) entry.rangeIncrementFt = weapon.rangeIncrementFt;
  if (weapon.class === "firearm") {
    entry.firearm = {
      generation: weapon.firearmGeneration ?? "early",
      misfireMinimum: weapon.misfireValue,
      capacity: weapon.ammo?.capacity ?? 1,
      loaded: 0,
    };
  }
  if (weapon.broken) entry.broken = true;
  if (weapon.natural) entry.natural = true;
  if (weapon.naturalSecondary) entry.secondary = true;
  return entry;
}

/** A one-line label for the attack-family rows the sheet lists. */
export function weaponFamilyLabel(weapon: PF1eWeaponDescriptor): string {
  const parts: string[] = [weapon.class];
  if (weapon.handedness !== "one-handed") parts.push(weapon.handedness);
  if (weapon.natural) parts.push("natural");
  if (weapon.reach) parts.push("reach");
  return parts.join(" · ");
}

/** Sizes a Large-or-bigger wielder's reach depends on (`SIZES` re-exported for the UI). */
export const WEAPON_SIZES: readonly PF1eSize[] = PF1E_SIZES;
