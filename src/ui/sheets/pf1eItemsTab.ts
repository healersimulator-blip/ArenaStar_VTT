/**
 * Items-tab model (plan §1.3 / G-03/G-04) — the arithmetic the tab renders, with no DOM and
 * no store writes, per this directory's rule (`pf1eSheetModel.ts` header).
 *
 * It reads an `ActorDocument`'s embedded items through `inventory.ts` (the rules module owns
 * every number) and hands the tab one view: rows in container order, the currency block, the
 * load readout, the item-derived value, and the actions each row offers.
 */
import type {
  ActorDocument,
  BaseDocument,
  DocRef,
  Json,
} from "../../core/documents";
import type { ClientSync, ClientEvents } from "../../client/sync";
import type { EventBus } from "../../core/events";
import type { Op } from "../../core/ops";
import { can } from "../../core/permissions";
import {
  attackEntryFromWeapon,
  consumableSaveDc,
  weaponItemsOf,
  type PF1eConsumableKind,
  type PF1eConsumableSpell,
  planConsumable,
} from "../../packages/pf1e/consumables";
import {
  carriedWeightLb,
  capacityStrengthBonusOf,
  carryingCapacityOf,
  currencyInGp,
  encumbranceReadout,
  inventoryTree,
  inventoryValueGp,
  readCurrency,
  readInventoryItems,
  slowAndSteadyOf,
  type PF1eCurrency,
  type PF1eEncumbranceReadout,
  type PF1eInventoryItem,
  type PF1eInventoryNode,
  type PF1eItemCategory,
} from "../../packages/pf1e/inventory";
import { itemChangeReport, type PF1eItemChangeReport } from "../../packages/pf1e/itemChanges";
import { normalizeSize, type PF1eSize } from "../../packages/pf1e/rulesTables";
import type { CoreWorldSettings } from "../../core/worldSettings";
import { encumbranceCapacityStrBonusOf, encumbranceEnabledOf } from "../../core/worldSettings";

const asRecord = (v: unknown): Record<string, unknown> | null =>
  typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;

export interface PF1eItemsView {
  /** Root rows with their container children, in item order. */
  roots: PF1eInventoryNode[];
  /** A container id no item answers to — surfaced rather than hidden. */
  orphans: PF1eInventoryItem[];
  items: PF1eInventoryItem[];
  currency: PF1eCurrency;
  currencyGp: number;
  capacityLb: { light: number; medium: number; heavy: number };
  carriedLb: number;
  load: PF1eEncumbranceReadout;
  /** `true` when the world switched the encumbrance rule off (the numbers still show). */
  encumbranceOff: boolean;
  totalValueGp: number;
  unpriced: string[];
  /** Weapon items, ready for "create attack from this weapon". */
  weapons: ReturnType<typeof weaponItemsOf>;
  /** Every validation/default line, for the tab's diagnostics block. */
  issues: string[];
}

/** Everything the Items tab renders, from documents only. */
export function pf1eItemsView(
  actor: ActorDocument,
  settings?: CoreWorldSettings | null,
): PF1eItemsView {
  const pf1e = asRecord(actor.system.pf1e) ?? {};
  const { items, issues } = readInventoryItems(actor.items);
  const { currency, issues: currencyIssues } = readCurrency(pf1e.currency);
  const traits = Array.isArray(pf1e.traits) ? pf1e.traits.filter((t): t is string => typeof t === "string") : [];
  const abilities = asRecord(pf1e.abilities) ?? {};
  const strength = typeof abilities.str === "number" && Number.isFinite(abilities.str) ? abilities.str : 10;
  const size: PF1eSize = normalizeSize(pf1e.size) ?? "Medium";
  const baseSpeed =
    typeof pf1e.landSpeedFt === "number" ? pf1e.landSpeedFt : typeof pf1e.speedFt === "number" ? pf1e.speedFt : 30;
  const carriedLb = carriedWeightLb(items, currency);
  const capacity = carryingCapacityOf({
    strength,
    size,
    quadruped: pf1e.quadruped === true || pf1e.reachShape === "long",
    strengthForCapacity:
      capacityStrengthBonusOf(items) + (settings ? encumbranceCapacityStrBonusOf(settings) : 0),
  });
  const load = encumbranceReadout({
    strength,
    size,
    quadruped: pf1e.quadruped === true || pf1e.reachShape === "long",
    strengthForCapacity:
      capacityStrengthBonusOf(items) + (settings ? encumbranceCapacityStrBonusOf(settings) : 0),
    totalLb: carriedLb,
    baseSpeedFt: baseSpeed,
    slowAndSteady: slowAndSteadyOf(items, traits),
  });
  const value = inventoryValueGp(items);
  const tree = inventoryTree(items);
  return {
    roots: tree.roots,
    orphans: tree.orphans,
    items,
    currency,
    currencyGp: currencyInGp(currency),
    capacityLb: { light: capacity.light, medium: capacity.medium, heavy: capacity.heavy },
    carriedLb,
    load,
    encumbranceOff: settings ? !encumbranceEnabledOf(settings) : false,
    totalValueGp: value.totalGp,
    unpriced: value.unpriced,
    weapons: weaponItemsOf(items),
    issues: [
      ...issues,
      ...currencyIssues,
      ...capacity.issues,
      ...load.issues,
    ],
  };
}

// ─── The item window's model (plan §1.3 item 2) ──────────────────────────────

export interface PF1eItemView {
  item: PF1eInventoryItem;
  /** Label/value rows: price, weight, container, hardness, caster level, … */
  properties: Array<{ label: string; value: string }>;
  /** The `changes[]` preview (what the item does to the sheet, and what is refused). */
  changes: PF1eItemChangeReport;
  /** Consumable facts, when the item holds a spell. */
  consumable: {
    kind: PF1eConsumableKind;
    /** The spell as authored on the item (the cast panel authors the cast from this). */
    spell: PF1eConsumableSpell;
    spellName: string;
    spellLevel: number;
    casterLevel: number;
    saveDc: number;
    charges: number;
    max: number | null;
    /** The flow refuses a cast with no charges, so the button says so up front. */
    castable: boolean;
    /** True when a spell is known but the item has no charge ledger. */
    noLedger: boolean;
  } | null;
  /** The attack line this weapon would create ("1d8 · 19–20/×2 · 30 ft."). */
  weaponLine: string | null;
  /** Slow and Steady–style rules lines an item or trait grants. */
  notes: string[];
}

/**
 * Everything the item window renders. The view is built from the **live** item read, so a
 * charge decrement or an equip toggle re-renders through the ordinary store projection.
 */
export function pf1eItemView(actor: ActorDocument, itemId: string): PF1eItemView | null {
  const { items } = readInventoryItems(actor.items);
  const item = items.find((i) => i.id === itemId);
  if (!item) return null;
  const properties: Array<{ label: string; value: string }> = [
    { label: "Category", value: item.category },
    { label: "Quantity", value: String(item.quantity) },
    { label: "Price", value: item.priceGp === null ? "—" : `${item.priceGp} gp each` },
    { label: "Weight", value: item.weightLb === null ? "—" : `${item.weightLb} lb each (${item.totalWeightLb} lb total)` },
    { label: "Carried", value: item.carried ? "yes" : "stored (no weight)" },
    { label: "Equipped", value: item.equipped ? "yes" : "no" },
  ];
  if (item.containerId !== null) {
    const parent = items.find((i) => i.id === item.containerId);
    properties.push({ label: "Inside", value: parent ? parent.name : `${item.containerId} (missing)` });
  }
  if (item.hp !== null || item.hardness !== null)
    properties.push({
      label: "Hit points",
      value: `${item.hp ?? "—"}${item.hardness === null ? "" : ` (hardness ${item.hardness})`}${item.broken ? " · broken" : ""}`,
    });
  if (item.casterLevel !== null)
    properties.push({ label: "Caster level", value: String(item.casterLevel) });
  if (item.capacityStrengthBonus !== null)
    properties.push({
      label: "Strength (carrying only)",
      value: `${item.capacityStrengthBonus >= 0 ? "+" : ""}${item.capacityStrengthBonus}`,
    });
  if (item.traits.length > 0) properties.push({ label: "Traits", value: item.traits.join(", ") });
  if (item.scriptCalls > 0)
    properties.push({
      label: "Source scripts",
      value: `${item.scriptCalls} (not run — the item is described, not automated)`,
    });

  const consumable =
    item.consumable === null
      ? null
      : {
          kind: item.consumable.kind,
          spell: item.consumable.spell,
          spellName: item.consumable.spell.name,
          spellLevel: item.consumable.spell.level,
          casterLevel: item.consumable.casterLevel,
          saveDc: consumableSaveDc(item.consumable.spell.level),
          charges: item.uses?.value ?? 0,
          max: item.uses?.max ?? null,
          castable: item.uses !== null && item.uses.value > 0,
          noLedger: item.uses === null,
        };

  const notes: string[] = [];
  if (item.slowAndSteady) notes.push("Slow and Steady: a load never reduces this creature's speed.");
  if (item.armor !== null)
    notes.push(
      item.armor.slot === "shield"
        ? `Shield: +${item.armor.shieldBonus} shield bonus${item.armor.checkPenalty > 0 ? `, −${item.armor.checkPenalty} ACP` : ""}`
        : `Armor: +${item.armor.armorBonus} armor bonus${item.armor.maxDexBonus !== null ? `, max Dex +${item.armor.maxDexBonus}` : ""}${item.armor.checkPenalty > 0 ? `, −${item.armor.checkPenalty} ACP` : ""}`,
    );

  return {
    item,
    properties,
    changes: itemChangeReport(item),
    consumable,
    weaponLine: weaponLineOf(item),
    notes,
  };
}

/** "1d8 · crit 19–20/×2 · range 30 ft. · heavy blade" — the weapon's own numbers. */
function weaponLineOf(item: PF1eInventoryItem): string | null {
  if (item.weapon === null) return null;
  const parts: string[] = [];
  const weapon = item.weapon as Record<string, unknown>;
  const damage = typeof weapon.damageDice === "string" ? weapon.damageDice : null;
  parts.push(damage ?? weaponFamilyOf(item) ?? "weapon");
  const threat = typeof weapon.critThreatMin === "number" ? weapon.critThreatMin : null;
  const mult = typeof weapon.critMultiplier === "number" ? weapon.critMultiplier : null;
  if (mult !== null)
    parts.push(
      `crit ${threat !== null && threat < 20 ? `${threat}–20` : "20"}/${mult === 2 ? "×2" : `×${mult}`}`,
    );
  const range = typeof weapon.rangeIncrementFt === "number" ? weapon.rangeIncrementFt : null;
  if (range !== null && range > 0) parts.push(`range ${range} ft.`);
  const family = weaponFamilyOf(item);
  if (family !== null) parts.push(family);
  if (item.broken) parts.push("broken");
  return parts.join(" · ");
}

function weaponFamilyOf(item: PF1eInventoryItem): string | null {
  if (item.weapon === null) return null;
  const family = (item.weapon as Record<string, unknown>).family;
  return typeof family === "string" && family.trim() !== "" ? family.trim() : null;
}

/** One row's changes preview (the item window renders the same report). */
export function rowChangeReport(item: PF1eInventoryItem): PF1eItemChangeReport {
  return itemChangeReport(item);
}

// ─── Ops the tab submits ─────────────────────────────────────────────────────
// All of them are ordinary embedded-document ops: the host authorizes them like any other
// sheet edit, so a player can only change what they own (the tab's `editable` prop gates the
// buttons; the ops are the same either way).

function itemRef(actorId: string, itemId: string): DocRef {
  return { coll: "items", id: itemId, parent: { coll: "actors", id: actorId } };
}

export function setItemFlagOp(
  actorId: string,
  itemId: string,
  key: "equipped" | "carried" | "broken",
  value: boolean,
): Op {
  return {
    kind: "update",
    ref: itemRef(actorId, itemId),
    diff: { [`system.${key}`]: value } as Record<string, Json>,
  };
}

export function setItemQuantityOp(actorId: string, itemId: string, quantity: number): Op {
  return {
    kind: "update",
    ref: itemRef(actorId, itemId),
    diff: { "system.quantity": Math.max(0, Math.floor(quantity)) } as Record<string, Json>,
  };
}

/** Move an item into a container, or out of every container (`null`). */
export function setItemContainerOp(actorId: string, itemId: string, containerId: string | null): Op {
  return {
    kind: "update",
    ref: itemRef(actorId, itemId),
    // `container: null` clears the nesting; the store's dotted diff writes it as a removal.
    diff: { "system.containerId": containerId } as Record<string, Json>,
  };
}

/** Write a `uses` ledger (a spent charge, a recharge). */
export function setItemUsesOp(
  actorId: string,
  itemId: string,
  uses: { value: number; max: number | null; per: string | null },
): Op {
  return {
    kind: "update",
    ref: itemRef(actorId, itemId),
    diff: { "system.uses": uses as unknown as Json } as Record<string, Json>,
  };
}

/** The currency block (pp/gp/sp/cp) as one op on the actor. */
export function setCurrencyOp(actorId: string, currency: PF1eCurrency): Op {
  return {
    kind: "update",
    ref: { coll: "actors", id: actorId },
    diff: { "system.pf1e.currency": currency as unknown as Json } as Record<string, Json>,
  };
}

/** "Create attack from this weapon": append the item's line to `system.pf1e.attacks`. */
export function createAttackFromWeaponOp(
  actor: ActorDocument,
  item: PF1eInventoryItem,
): { op: Op; entry: Record<string, Json> } | { error: string } {
  if (item.weapon === null) return { error: `"${item.name}" has no weapon data to build an attack from.` };
  const pf1e = asRecord(actor.system.pf1e) ?? {};
  const attacks = Array.isArray(pf1e.attacks) ? pf1e.attacks : [];
  const size = normalizeSize(pf1e.size) ?? "Medium";
  const entry = attackEntryFromWeapon({ item, size }) as unknown as Record<string, Json>;
  const linked = attacks.some(
    (a) => asRecord(a)?.itemId === item.id && asRecord(a)?.name === entry.name,
  );
  if (linked) return { error: `"${item.name}" already has an attack line.` };
  return {
    op: {
      kind: "update",
      ref: { coll: "actors", id: actor._id },
      diff: { "system.pf1e.attacks": [...attacks, entry] as unknown as Json } as Record<string, Json>,
    },
    entry,
  };
}

// ─── Imported items: the world `items` collection → this actor ───────────────
// A compendium *Item* import writes a **world** item (`CompendiaPanel.importEntry` → a
// `create` op on the top-level `items` collection). Attaching it to an actor is the same
// gesture Foundry spells as "drag it onto the sheet": an embedded copy on the actor. These
// two functions are the tab's half of that — a readable list, and the one `create` op.

export interface PF1eWorldItemRow {
  id: string;
  name: string;
  /** The inventory category the row will read as once embedded (weapon, armor, …). */
  category: PF1eItemCategory;
  weightLb: number | null;
  priceGp: number | null;
}

/** The world items a reader may add to a sheet, as picker rows (document order). */
export function worldItemRows(docs: readonly unknown[]): PF1eWorldItemRow[] {
  const { items } = readInventoryItems(docs);
  return items.map((item) => ({
    id: item.id,
    name: item.name,
    category: item.category,
    weightLb: item.weightLb,
    priceGp: item.priceGp,
  }));
}

type SheetClient = Pick<ClientSync, "store" | "user">;

/**
 * The world `items` collection, filtered to what this reader may see. A compendium import
 * writes its document with the pack's permission block, so a player usually sees none of
 * these — the picker is then empty rather than showing documents the host would refuse.
 */
export function readableWorldItems(client: SheetClient): unknown[] {
  return (client.store.getAll("items") as unknown[]).filter(
    (doc) => client.user !== null && can(client.user, "read", doc as BaseDocument, "items"),
  );
}

/** Refresh on every store/permission event (the `observePF1eItem` pattern). */
export function observeWorldItems(
  client: SheetClient,
  bus: EventBus<ClientEvents>,
  changed: (docs: unknown[]) => void,
): () => void {
  const refresh = (): void => changed(readableWorldItems(client));
  const offs = [
    bus.on("snapshot", refresh),
    bus.on("ops", refresh),
    bus.on("rejected", refresh),
  ];
  refresh();
  return () => {
    for (const off of offs) off();
  };
}

/**
 * Embed a copy of a world item on this actor: one ordinary `create` op with a parent (the
 * same shape the generated consumables use), so the host authorizes it like any other sheet
 * edit. The item's `_id` is **kept**, which keeps the item-window id
 * (`pf1e-item:<actor>:<item>`) stable and makes the copy traceable; a collision with an
 * existing embedded item is refused with a reason instead of silently replacing it.
 */
export function addWorldItemOp(
  actor: ActorDocument,
  worldItem: unknown,
): { op: Op; row: PF1eWorldItemRow } | { error: string } {
  const rec = asRecord(worldItem);
  const id = typeof rec?._id === "string" && rec._id !== "" ? rec._id : null;
  const name = typeof rec?.name === "string" && rec.name.trim() !== "" ? rec.name.trim() : null;
  if (id === null || name === null) return { error: "That imported item has no id or name." };
  if (rec?.type !== "item") return { error: `"${name}" is not an item document.` };
  if (actor.items.some((i) => i._id === id))
    return { error: `"${name}" is already on ${actor.name}.` };
  const [row] = worldItemRows([worldItem]);
  const flags = asRecord(rec.flags) ?? {};
  const pf1e = asRecord(flags.pf1e) ?? {};
  const data = {
    _id: id,
    type: "item",
    name,
    ownership: asRecord(rec.ownership) ?? { default: 0 },
    // Provenance: this item came off the world's item list, not from the actor's own pack.
    flags: { ...flags, pf1e: { ...pf1e, importedFrom: id } },
    system: asRecord(rec.system) ?? {},
    effects: Array.isArray(rec.effects) ? rec.effects : [],
  } as unknown as BaseDocument;
  return {
    op: {
      kind: "create",
      coll: "items",
      parent: { coll: "actors", id: actor._id },
      data,
    },
    row: row ?? { id, name, category: "other", weightLb: null, priceGp: null },
  };
}

/** The item a "make a consumable" action would create (plan §1.3 item 4). */
export function generatedConsumableItem(
  spell: PF1eConsumableSpell,
  kind: PF1eConsumableKind,
  actorId: string,
): { name: string; data: Record<string, Json>; notes: string[] } {
  const plan = planConsumable({ spell, kind });
  return {
    name: plan.name,
    notes: plan.notes,
    data: {
      _id: `item-${globalThis.crypto.randomUUID().slice(0, 8)}`,
      type: "item",
      name: plan.name,
      ownership: { default: 0 },
      flags: { pf1e: { generatedFor: actorId } } as unknown as Json,
      system: plan.system as unknown as Json,
      effects: [],
    },
  };
}

/**
 * Every authored spell the sheet can generate a consumable from (a prepared caster's rows).
 * Reads the raw document so the tab does not need a typed actor projection.
 */
export function authoredSpellRows(
  system: Record<string, Json> | null | undefined,
): PF1eConsumableSpell[] {
  const pf1e = asRecord(system?.pf1e);
  const spells = asRecord(pf1e?.spells);
  const list = Array.isArray(spells?.prepared) ? spells.prepared : [];
  const out: PF1eConsumableSpell[] = [];
  const seen = new Set<string>();
  for (const row of list) {
    const rec = asRecord(row);
    const name = typeof rec?.name === "string" && rec.name.trim() !== "" ? rec.name.trim() : null;
    if (name === null || seen.has(name)) continue;
    seen.add(name);
    const level = typeof rec?.level === "number" && Number.isFinite(rec.level) ? rec.level : 0;
    out.push({
      name,
      level: Math.max(0, Math.min(9, Math.trunc(level))),
      saveType:
        rec?.saveType === "fort" || rec?.saveType === "ref" || rec?.saveType === "will"
          ? rec.saveType
          : null,
      damageFormula: typeof rec?.damageFormula === "string" ? rec.damageFormula : null,
      energyType: typeof rec?.energyType === "string" ? rec.energyType : null,
    });
  }
  return out;
}
