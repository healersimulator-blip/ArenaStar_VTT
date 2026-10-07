/**
 * §2.2 item 2 (G-10b, D-261) — **the per-character quickbar**.
 *
 * The table already had one hotbar: five chat macros bound by `flags.core.slot` and run by
 * `runChatMacro` (`src/ui/macros/run.ts`). It is world-level and command-based — fine for the GM's
 * `/gmroll` macros, useless for a player who wants *their* greataxe on key 1. This generalizes the
 * same idea per **character**: five slots on the actor document (`flags.pf1e.quickbar`), each bound
 * to one of the actions the sheet already computes — an attack line (rolled against the selected
 * target through the sheet's own `resolveAttackFlow`), that line's damage (a public roll card, which
 * the D-261 apply verb can then land on whoever it hit), a castable item (the wand/scroll/potion
 * path `PF1eItemWindow` uses, charges and all), or — D-407 — a prepared/known spell through the same
 * `resolveCastFlow` the sheet's cast form uses. Catalogue spells carry authored mechanics; all other
 * spells require a reviewed save/damage profile rather than an invented one.
 *
 * Slots live on the document, not in component state: binding a slot is an ordinary op, so it
 * replicates to the whole table and undoes like anything else. A spell slot was deferred by D-259
 * precisely because a prepared row carries no save or damage; it is possible now only for the spells
 * the catalogue authors (the save, the severity and the condition come from the effect, not from a
 * form the player does not have on a hot bar).
 */
import type { ActorDocument, Json } from "../../core/documents";
import type { Op } from "../../core/ops";
import { pf1eAttackRollGroups } from "../../packages/pf1e/rollData";
import type { PF1eDerived } from "../../packages/pf1e/actor";
import { pf1eItemView } from "../sheets/pf1eItemsTab";
import { pf1eSpellbookView } from "../sheets/pf1eSpellbook";
import { pf1eSpellEffectByName } from "../../packages/pf1e/spellEffects";
import { fxSpellKeyFromName } from "../../core/fxBinding";
import { PF1E_SAVE_SEVERITIES, type PF1eSaveSeverity, type PF1eSaveType } from "../../packages/pf1e/casting";
import { PF1E_ENERGY_TYPES, type PF1eEnergyType } from "../../packages/pf1e/healthState";

/** The four things a player can put on a slot. */
export type PF1eQuickbarKind = "attack" | "damage" | "item" | "spell";

export interface PF1eQuickbarSpellProfile {
  /** The spellbook/compendium's adjudicated mechanics for a spell without an authored effect. */
  saveType: PF1eSaveType;
  severity: PF1eSaveSeverity;
  damageFormula: string;
  energyType?: PF1eEnergyType;
}

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
  /**
   * `spell` (D-407): the prepared row to expend, or `null`/absent for a spontaneous caster (the slot
   * level is spent instead). The spell's identity is the label, resolved through the tactical
   * catalogue at bind and run time. Optional so entries authored before D-407 stay readable.
   */
  preparedIndex?: number | null;
  /** `spell`: the spell level, for the cast and for the DC. */
  spellLevel?: number;
  /**
   * A caller-reviewed cast profile for a spell with no authored tactical-effect row. It does not
   * assert that the VTT automates the spell's full text; it feeds the same save/damage inputs the
   * actor sheet asks the GM to adjudicate.
   */
  spellProfile?: PF1eQuickbarSpellProfile;
  /** Components line from the prepared/known row, used by the shared cast gate when present. */
  spellComponents?: string;
}

/** The five slots, in hotbar order. */
export const QUICKBAR_SLOTS: readonly number[] = [1, 2, 3, 4, 5];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const QUICKBAR_SAVE_TYPES: readonly PF1eSaveType[] = ["fort", "ref", "will"];

function readSpellProfile(raw: unknown): PF1eQuickbarSpellProfile | null {
  if (!isRecord(raw) || Object.keys(raw).some((key) =>
    !["saveType", "severity", "damageFormula", "energyType"].includes(key))) return null;
  if (!QUICKBAR_SAVE_TYPES.includes(raw.saveType as PF1eSaveType) ||
      !PF1E_SAVE_SEVERITIES.includes(raw.severity as PF1eSaveSeverity) ||
      typeof raw.damageFormula !== "string" || raw.damageFormula.length > 120 ||
      (raw.energyType !== undefined && !PF1E_ENERGY_TYPES.includes(raw.energyType as PF1eEnergyType)))
    return null;
  return { saveType: raw.saveType as PF1eSaveType,
    severity: raw.severity as PF1eSaveSeverity,
    damageFormula: raw.damageFormula,
    ...(raw.energyType !== undefined ? { energyType: raw.energyType as PF1eEnergyType } : {}) };
}

function readEntry(raw: unknown): PF1eQuickbarEntry | null {
  if (!isRecord(raw)) return null;
  const slot = raw.slot;
  if (typeof slot !== "number" || !Number.isInteger(slot) || slot < 1 || slot > 5) return null;
  const kind = raw.kind;
  if (kind !== "attack" && kind !== "damage" && kind !== "item" && kind !== "spell") return null;
  const label = typeof raw.label === "string" && raw.label.trim() !== "" ? raw.label : null;
  if (label === null) return null;
  const attackIndex = typeof raw.attackIndex === "number" && Number.isInteger(raw.attackIndex) && raw.attackIndex >= 0 ? raw.attackIndex : 0;
  const itemId = typeof raw.itemId === "string" && raw.itemId !== "" ? raw.itemId : null;
  if (kind === "item" && itemId === null) return null;
  const preparedIndex = typeof raw.preparedIndex === "number" && Number.isInteger(raw.preparedIndex) &&
    raw.preparedIndex >= 0 ? raw.preparedIndex : null;
  const spellLevel = typeof raw.spellLevel === "number" && Number.isInteger(raw.spellLevel) &&
    raw.spellLevel >= 0 && raw.spellLevel <= 9 ? raw.spellLevel : 0;
  const spellProfile = raw.spellProfile === undefined ? null : readSpellProfile(raw.spellProfile);
  const spellComponents = raw.spellComponents === undefined ? undefined
    : typeof raw.spellComponents === "string" && raw.spellComponents.length <= 120
      ? raw.spellComponents : null;
  if (kind === "spell" && (raw.spellProfile !== undefined && spellProfile === null || spellComponents === null))
    return null;
  // Spell fields are written only for spell bindings; the other kinds keep older stored shapes.
  return kind === "spell"
    ? { slot, kind, label, attackIndex, itemId, preparedIndex, spellLevel,
        ...(spellProfile !== null ? { spellProfile } : {}),
        ...(spellComponents !== undefined && spellComponents !== null ? { spellComponents } : {}) }
    : { slot, kind, label, attackIndex, itemId };
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
  /** stable id: `attack:<i>` · `damage:<i>` · `item:<itemId>` · `spell:<preparedIndex>` */
  id: string;
  kind: PF1eQuickbarKind;
  label: string;
  /** The picker's second line — says what the slot will actually do. */
  detail: string;
  attackIndex: number;
  itemId: string | null;
  /** `spell`: the prepared row to expend (absent for the other kinds). */
  preparedIndex?: number;
  /** `spell`: the spell level. */
  spellLevel?: number;
  /** `spell`: components line carried by the prepared/known row, when authored. */
  spellComponents?: string;
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
  // D-407: catalogue spells carry authored tactical mechanics; every other prepared spell remains
  // available with an explicit, caller-reviewed quickbar cast profile rather than being hidden.
  const spellbook = pf1eSpellbookView(actor, derived);
  spellbook.prepared.forEach((row, index) => {
    const effect = pf1eSpellEffectByName(row.name);
    const lightningLine = row.name.trim().toLowerCase() === "lightning bolt";
    out.push({
      id: `spell:${String(index)}`,
      kind: "spell",
      label: `${effect?.name ?? row.name} (level ${String(row.level)})`,
      detail: effect
        ? `cast at the selected target — ${effect.save === null
          ? "no save" : `${effect.save.type.toUpperCase()} DC from your spell DC`}, delivers ${effect.conditions.join(", ")}`
        : lightningLine
          ? "aim a 90-ft line — 6d6 electricity, Reflex half (verified level-six profile)"
          : "cast at the selected target — review and set this spell's save/damage profile when binding",
      attackIndex: 0,
      itemId: null,
      preparedIndex: index,
      spellLevel: row.level,
      ...(row.components !== "" ? { spellComponents: row.components } : {}),
    });
  });
  // Spontaneous casters use the same stored slot flow but identify a spell from `known`, not from
  // a prepared row. The starter Lightning Bolt keeps its explicit CL 6 line profile; other known
  // spells require a reviewed quickbar profile when bound.
  const pf1e = (actor.system as Record<string, unknown>).pf1e;
  const spells = isRecord(pf1e) ? pf1e.spells : undefined;
  const known = isRecord(spells) && Array.isArray(spells.known) ? spells.known : [];
  known.forEach((raw, index) => {
    if (!isRecord(raw) || typeof raw.name !== "string" || !Number.isInteger(raw.level)) return;
    const effect = pf1eSpellEffectByName(raw.name);
    const demoLine = raw.name.trim().toLowerCase() === "lightning bolt";
    const level = typeof raw.slotLevel === "number" && Number.isInteger(raw.slotLevel)
      ? raw.slotLevel : raw.level as number;
    out.push({
      id: `spell:known:${String(index)}`,
      kind: "spell",
      label: `${effect?.name ?? raw.name} (level ${String(level)})`,
      detail: demoLine
        ? "cast a 90-ft line, 6d6 electricity, Reflex half (6th-level sorcerer profile)"
        : effect
          ? `cast at the selected target — ${effect.save === null
            ? "no save" : `${effect.save.type.toUpperCase()} DC from your spell DC`}, delivers ${effect.conditions.join(", ")}`
          : "cast at the selected target — review and set this spell's save/damage profile when binding",
      attackIndex: 0,
      itemId: null,
      spellLevel: level,
      ...(typeof raw.components === "string" && raw.components.length <= 120 && raw.components !== ""
        ? { spellComponents: raw.components } : {}),
    });
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
      spellLevel: consumable.spellLevel,
    });
  }
  return out;
}

/** The candidate, as a slot binding. */
export function candidateToEntry(
  slot: number,
  candidate: PF1eQuickbarCandidate,
  spellProfile?: PF1eQuickbarSpellProfile,
): PF1eQuickbarEntry {
  return {
    slot,
    kind: candidate.kind,
    label: candidate.label,
    attackIndex: candidate.attackIndex,
    itemId: candidate.itemId,
    // Only a spell binding carries the spell fields; the other kinds keep their stored shape.
    ...(candidate.kind === "spell"
      ? { preparedIndex: candidate.preparedIndex ?? null, spellLevel: candidate.spellLevel ?? 0,
          ...(spellProfile !== undefined ? { spellProfile } : {}),
          ...(candidate.spellComponents !== undefined ? { spellComponents: candidate.spellComponents } : {}) }
      : {}),
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
  if (entry.kind === "spell") {
    // The normalized exact name is the binding's identity: a prepared row's *index* shifts as the
    // caster re-prepares, so the note re-reads the current book and never casts a different spell.
    const spellName = entry.label.replace(/ \(level \d+\)$/, "").trim();
    const spellKey = fxSpellKeyFromName(spellName);
    if (spellKey === null) return "the bound spell name cannot be normalized — re-bind it";
    const effect = pf1eSpellEffectByName(spellName);
    const demoLine = spellName.toLowerCase() === "lightning bolt";
    if (entry.preparedIndex == null) {
      const pf1e = (actor.system as Record<string, unknown>).pf1e;
      const spells = isRecord(pf1e) ? pf1e.spells : undefined;
      const known = isRecord(spells) && Array.isArray(spells.known) ? spells.known : [];
      const found = known.some((raw) => isRecord(raw) && typeof raw.name === "string" &&
        fxSpellKeyFromName(raw.name) === spellKey &&
        (raw.slotLevel === entry.spellLevel || raw.slotLevel === undefined && raw.level === entry.spellLevel));
      if (!found) return "the bound known spell is gone — re-bind it";
    } else {
      const row = pf1eSpellbookView(actor, derived).prepared[entry.preparedIndex];
      if (row === undefined) return "the bound prepared row is gone — re-prepare and re-bind";
      if (fxSpellKeyFromName(row.name) !== spellKey)
        return `the bound row now holds ${row.name}, not ${spellName}`;
    }
    if (effect === null && !demoLine && entry.spellProfile === undefined)
      return "set this spell's save, severity and damage profile when binding it";
    return null;
  }
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
