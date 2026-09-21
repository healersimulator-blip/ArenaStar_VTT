/**
 * §2.2 item 2 (G-10b, D-261) — **the per-character quickbar**.
 *
 * The table already had one hotbar: five chat macros bound by `flags.core.slot` and run by
 * `runChatMacro` (`src/ui/macros/run.ts`). It is world-level and command-based — fine for the GM's
 * `/gmroll` macros, useless for a player who wants *their* greataxe on key 1. This generalizes the
 * same idea per **character**: five slots on the actor document (`flags.pf1e.quickbar`), each bound
 * to one of the actions the sheet already computes — an attack line (rolled against the selected
 * target through the sheet's own `resolveAttackFlow`), that line's damage (a public roll card, which
 * the D-261 apply verb can then land on whoever it hit), or a castable item (the wand/scroll/potion
 * path `PF1eItemWindow` uses, charges and all).
 *
 * Slots live on the document, not in component state: binding a slot is an ordinary op, so it
 * replicates to the whole table and undoes like anything else. Spells are bound *through the item
 * that holds them* — the corpus authors no spell blocks (D-259), so a prepared-spell slot would
 * have to invent the save type and damage the sheet asks the caster for at cast time.
 */
import type { ActorDocument, Json } from "../../core/documents";
import type { Op } from "../../core/ops";
import { pf1eAttackRollGroups } from "../../packages/pf1e/rollData";
import type { PF1eDerived } from "../../packages/pf1e/actor";
import { pf1eItemView } from "../sheets/pf1eItemsTab";

/** The three things a player can put on a slot. */
export type PF1eQuickbarKind = "attack" | "damage" | "item";

export interface PF1eQuickbarEntry {
  /** 1–5, the key the table presses. */
  slot: number;
  kind: PF1eQuickbarKind;
  /** What the slot's button reads. */
  label: string;
  /** `attack`/`damage`: index into the actor's derived attack lines. */
  attackIndex: number;
  /** `item`: the item document that holds the spell. */
  itemId: string | null;
}

/** The five slots, in hotbar order. */
export const QUICKBAR_SLOTS: readonly number[] = [1, 2, 3, 4, 5];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readEntry(raw: unknown): PF1eQuickbarEntry | null {
  if (!isRecord(raw)) return null;
  const slot = raw.slot;
  if (typeof slot !== "number" || !Number.isInteger(slot) || slot < 1 || slot > 5) return null;
  const kind = raw.kind;
  if (kind !== "attack" && kind !== "damage" && kind !== "item") return null;
  const label = typeof raw.label === "string" && raw.label.trim() !== "" ? raw.label : null;
  if (label === null) return null;
  const attackIndex = typeof raw.attackIndex === "number" && Number.isInteger(raw.attackIndex) && raw.attackIndex >= 0 ? raw.attackIndex : 0;
  const itemId = typeof raw.itemId === "string" && raw.itemId !== "" ? raw.itemId : null;
  if (kind === "item" && itemId === null) return null;
  return { slot, kind, label, attackIndex, itemId };
}

/**
 * The actor's bound slots, validated. Anything malformed reads as unbound (a bad edit must never
 * crash the bar) and a slot bound twice keeps the first binding.
 */
export function readQuickbar(actor: ActorDocument): PF1eQuickbarEntry[] {
  const flags = actor.flags as { pf1e?: { quickbar?: unknown } } | undefined;
  const raw = flags?.pf1e?.quickbar;
  if (!Array.isArray(raw)) return [];
  const out: PF1eQuickbarEntry[] = [];
  for (const value of raw) {
    const entry = readEntry(value);
    if (entry === null) continue;
    if (out.some((e) => e.slot === entry.slot)) continue;
    out.push(entry);
  }
  return out.sort((a, b) => a.slot - b.slot);
}

/**
 * The op that writes the whole binding list.
 *
 * A flat diff cannot create intermediate objects, so the write is the actor's complete `flags`
 * subtree with the quickbar replaced — an actor's other flags (there are several) survive it.
 */
export function quickbarWriteOp(actor: ActorDocument, entries: readonly PF1eQuickbarEntry[]): Op {
  const flags = (actor.flags ?? {}) as Record<string, Json>;
  const pf1e = (flags.pf1e ?? {}) as Record<string, Json>;
  return {
    kind: "update",
    ref: { coll: "actors", id: actor._id },
    diff: {
      flags: {
        ...flags,
        pf1e: { ...pf1e, quickbar: entries.map((e) => ({ ...e })) as unknown as Json },
      } as unknown as Json,
    },
  };
}

/** Replace one slot's binding (independent of `entries`'s order). */
export function bindQuickbarSlot(
  entries: readonly PF1eQuickbarEntry[],
  entry: PF1eQuickbarEntry,
): PF1eQuickbarEntry[] {
  const next = entries.filter((e) => e.slot !== entry.slot);
  next.push(entry);
  return next.sort((a, b) => a.slot - b.slot);
}

/** Empty one slot. */
export function clearQuickbarSlot(
  entries: readonly PF1eQuickbarEntry[],
  slot: number,
): PF1eQuickbarEntry[] {
  return entries.filter((e) => e.slot !== slot);
}

/** One bindable thing, as the picker lists it. */
export interface PF1eQuickbarCandidate {
  /** stable id: `attack:<i>` · `damage:<i>` · `item:<itemId>` */
  id: string;
  kind: PF1eQuickbarKind;
  label: string;
  /** The picker's second line — says what the slot will actually do. */
  detail: string;
  attackIndex: number;
  itemId: string | null;
}

/**
 * Everything this character can bind: the derived attack lines (their attack and their damage) and
 * the castable items they carry. Data-driven, so a binding always names something that exists —
 * a slot whose line or item disappears later is reported missing at run time, not silently rerolled.
 */
export function quickbarCandidates(
  actor: ActorDocument,
  derived: PF1eDerived,
): PF1eQuickbarCandidate[] {
  const out: PF1eQuickbarCandidate[] = [];
  const groups = pf1eAttackRollGroups(derived);
  derived.attacks.forEach((line, index) => {
    const group = groups[index];
    out.push({
      id: `attack:${String(index)}`,
      kind: "attack",
      label: line.name,
      detail: `attack ${group?.attack.formula ?? "?"} vs the selected target`,
      attackIndex: index,
      itemId: null,
    });
    if (group?.damage) {
      out.push({
        id: `damage:${String(index)}`,
        kind: "damage",
        label: `${line.name} damage`,
        detail: `${group.damage.formula} as a public roll card`,
        attackIndex: index,
        itemId: null,
      });
    }
  });
  for (const item of actor.items ?? []) {
    const view = pf1eItemView(actor, item._id);
    const consumable = view?.consumable ?? null;
    if (consumable === null || !consumable.castable) continue;
    out.push({
      id: `item:${item._id}`,
      kind: "item",
      label: `${consumable.spellName} (${view?.item.name ?? item.name})`,
      detail: `cast at the selected target — DC ${String(consumable.saveDc)}, ${String(consumable.charges)} charge(s)`,
      attackIndex: 0,
      itemId: item._id,
    });
  }
  return out;
}

/** The candidate, as a slot binding. */
export function candidateToEntry(
  slot: number,
  candidate: PF1eQuickbarCandidate,
): PF1eQuickbarEntry {
  return {
    slot,
    kind: candidate.kind,
    label: candidate.label,
    attackIndex: candidate.attackIndex,
    itemId: candidate.itemId,
  };
}

/**
 * Why a bound slot cannot run any more — the actor's gear changed, the wand ran dry. Named, so the
 * bar can say what is wrong instead of doing something else.
 */
export function quickbarSlotNote(
  actor: ActorDocument,
  entry: PF1eQuickbarEntry,
  derived: PF1eDerived,
): string | null {
  if (entry.kind === "item") {
    const view = entry.itemId === null ? null : pf1eItemView(actor, entry.itemId);
    if (view === null) return "the bound item is gone";
    if (view.consumable === null) return "the bound item no longer holds a spell";
    if (!view.consumable.castable) return "the bound item has no charges left";
    return null;
  }
  if (entry.attackIndex >= derived.attacks.length) return "the bound attack line is gone";
  return null;
}
