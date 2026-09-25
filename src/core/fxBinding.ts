/**
 * D-311 (SQ-12's stretch clause, A09; WZ-05) — binding an authored timeline to an item.
 *
 * SQ-12's last clause is "the same authored sequence can be saved/**bound to an item**".
 * A preset (D-310) keeps the look; a binding answers *when* the look fires: the wand is
 * used, so the wand's own cue plays — and, because an item use has a **committed outcome**
 * (a hit, a miss, a spell the target saved against), the binding can answer the failure
 * case with a different authored timeline instead of playing the wrong one.
 *
 * Three things this deliberately is not:
 *
 * - **Not a mechanic.** A binding plays a cue; it never rolls, damages or spends anything.
 *   The item's own flow commits first (charges, slots, hit points), and the cue is requested
 *   *after* that commit — TR-17's "schedule linked FX after the authoritative outcome is
 *   known", which is why a refused use plays nothing at all.
 * - **Not a client-authored run.** The client only names a timeline it can already read; the
 *   host re-checks the caller's rights on the ordinary `fx.request` path, so a player whose
 *   item is bound to a GM-only timeline is refused exactly as if they had asked for it by
 *   hand. Nothing about the item grants anything.
 * - **Not a second visibility rule.** The binding is stored on the **timeline**, not on the
 *   item: a player can only discover a binding through a timeline they are already entitled
 *   to read (`docVisibleTo` does the rest), and a GM-only timeline's binding never travels.
 *   The item side needs no projection rule at all, and no macro id leaks to anyone who could
 *   not already read that macro.
 *
 * The behaviour is closed and explicit: recognition is automatic (a failed use plays
 * `onFailureId` when one is bound, and **nothing** when one is not — the binding says nothing
 * about misses, so playing the hit cue would be a lie), an author can override the
 * recognition either way, and `enabled: false` disables the binding without deleting it.
 */
import type { ActorDocument, MacroDocument } from "./documents";
import type { DocId } from "./ids";
import type { Op } from "./ops";

/** How the cue for a use is chosen. `auto` follows the committed outcome. */
export type FxRecognition = "auto" | "success" | "failure";

export const FX_RECOGNITION_MODES: readonly FxRecognition[] = ["auto", "success", "failure"];

/**
 * What an item's bound cue is. Stored on the **timeline** (`MacroDocument.fxItem`), so a
 * player discovers it only through a timeline they may read.
 */
export interface FxItemBinding {
  /** The actor the bound item lives on. */
  actorId: DocId;
  /** The item itself, inside that actor's `items`. */
  itemId: DocId;
  /** The cue a **failed** use plays instead (a miss, a lost spell, a made save). */
  onFailureId?: DocId;
  /** Author override of the automatic recognition. Default `auto`. */
  recognition?: FxRecognition;
  /** Manual disable (default true): the item plays no cue, whatever the outcome. */
  enabled?: boolean;
}

/** Every field a binding may carry — anything else is refused by name. */
export const FX_BINDING_KEYS = ["actorId", "itemId", "onFailureId", "recognition", "enabled"] as const;

const isObject = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);

const isId = (value: unknown): value is string => typeof value === "string" && value.trim() !== "";

/** Validate the authored shape of a binding, refusing an unknown field by name. */
export function validateFxItemBinding(
  value: unknown,
): { ok: true; binding: FxItemBinding } | { ok: false; error: string } {
  const invalid = (error: string) => ({ ok: false as const, error });
  if (!isObject(value)) return invalid("an FX item binding needs an actor, an item and a timeline");
  const stray = Object.keys(value).filter((key) => !(FX_BINDING_KEYS as readonly string[]).includes(key));
  if (stray.length > 0) return invalid(`an FX item binding carries no ${stray.join("/")} field`);
  if (!isId(value.actorId) || !isId(value.itemId))
    return invalid("an FX item binding needs the actor and the item it belongs to");
  if (value.onFailureId !== undefined && !isId(value.onFailureId))
    return invalid("an FX item binding's failure cue must name a timeline");
  if (value.recognition !== undefined &&
      !(FX_RECOGNITION_MODES as readonly string[]).includes(String(value.recognition)))
    return invalid("an FX item binding's recognition is auto, success or failure");
  if (value.enabled !== undefined && typeof value.enabled !== "boolean")
    return invalid("an FX item binding's enabled must be a boolean");
  if (value.recognition === "failure" && value.onFailureId === undefined)
    return invalid("forcing the failure cue needs a bound failure timeline to play");
  const binding: FxItemBinding = { actorId: value.actorId, itemId: value.itemId };
  if (typeof value.onFailureId === "string") binding.onFailureId = value.onFailureId;
  if (typeof value.recognition === "string") binding.recognition = value.recognition as FxRecognition;
  if (typeof value.enabled === "boolean") binding.enabled = value.enabled;
  return { ok: true, binding };
}

/**
 * The binding a timeline carries, or `null`. A malformed binding reads as *no* binding rather
 * than as a crash or a half-read: the host refuses to store one (below), so a document that
 * carries one anyway has been hand-edited, and the honest answer for a client is "this item
 * has no bound cue" — never a cue played out of a payload nobody validated.
 */
export function fxBindingOf(macro: MacroDocument): FxItemBinding | null {
  if (macro.fxItem === undefined) return null;
  const checked = validateFxItemBinding(macro.fxItem);
  return checked.ok ? checked.binding : null;
}

/** Does this timeline name that item? The client's lookup and the host's are the same one. */
export function fxBindingMatches(macro: MacroDocument, actorId: DocId, itemId: DocId): boolean {
  const binding = fxBindingOf(macro);
  return binding !== null && binding.actorId === actorId && binding.itemId === itemId;
}

/**
 * Which timeline a **committed** use plays. `null` means "play nothing", which is an answer:
 * a disabled binding, and an unrecognised failure with no failure cue bound. The default
 * branch is the timeline the binding is stored on, so a binding never has to repeat its own
 * id (and cannot point at a different one).
 */
export function fxBindingBranch(macro: MacroDocument, outcome: "success" | "failure"): DocId | null {
  const binding = fxBindingOf(macro);
  if (binding === null || binding.enabled === false) return null;
  const recognition = binding.recognition ?? "auto";
  if (recognition === "success") return macro._id;
  if (recognition === "failure") return binding.onFailureId ?? null;
  return outcome === "success" ? macro._id : binding.onFailureId ?? null;
}

/**
 * What the host must be able to see for a binding to be stored: a real item inside a real
 * actor, a real **timeline** for each named cue, and an editor entitled to read both. The
 * last rule is the one that keeps the macro id out of the wrong hands: a player editing their
 * own item cannot bind a timeline they cannot read (and so cannot discover its id), and an
 * assistant can bind what an assistant can run.
 */
export interface FxBindingLookup {
  actor(id: DocId): ActorDocument | undefined;
  macro(id: DocId): MacroDocument | undefined;
  /** Whether the *editor* may read that document — the host passes its own `can(...)`. */
  readable(coll: "actors" | "macros", doc: { _id: DocId }): boolean;
  /** Every timeline already bound to that item, so one item has exactly one bound cue. */
  boundTimelines(actorId: DocId, itemId: DocId): readonly DocId[];
}

/** The document rule for a timeline's binding, or `null` when it may be stored. */
export function fxItemBindingError(macro: MacroDocument, lookup: FxBindingLookup): string | null {
  if (macro.fxItem === undefined) return null;
  const checked = validateFxItemBinding(macro.fxItem);
  if (!checked.ok) return checked.error;
  const binding = checked.binding;
  const actor = lookup.actor(binding.actorId);
  const item = actor?.items.find((entry) => entry._id === binding.itemId);
  if (actor === undefined || item === undefined)
    return "an FX item binding must name an item that exists on its actor";
  if (!lookup.readable("actors", actor))
    return "an FX item binding must name an actor its author can see";
  for (const [which, id] of [["the cue", macro._id], ["the failure cue", binding.onFailureId]] as const) {
    if (id === undefined) continue;
    // The cue is this document: on **create** it is not in the store yet, and asking the
    // lookup for it would refuse every binding the moment it was authored.
    const target = id === macro._id ? macro : lookup.macro(id);
    if (target === undefined) return `${which} names no timeline`;
    if (target.kind !== "sequence")
      return `${which} names a ${target.kind} macro, not a timeline`;
    if (!lookup.readable("macros", target))
      return `${which} names a timeline its author cannot read`;
  }
  // One item, one bound cue: two timelines naming the same item would make the use path
  // choose arbitrarily, and "which cue plays when I press this" must never be a coin toss.
  const others = lookup.boundTimelines(binding.actorId, binding.itemId)
    .filter((id) => id !== macro._id);
  if (others.length > 0) return "another timeline is already bound to that item";
  return null;
}

/**
 * D-311's pruning half: when an actor or an item is deleted, the timelines bound to it have
 * their binding **removed** in the same undoable envelope, so a stale binding cannot come back
 * to life on a re-created id and a GM never has to hunt for a pointer to something gone. The
 * update is a `-=` on one field (the D-295 rule: a cleared field is deleted, never written as
 * `undefined`).
 */
export function fxBindingDeletionOps(world: { macros?: readonly MacroDocument[] }, ops: readonly Op[]): Op[] {
  const actors = new Set<DocId>();
  const items = new Set<string>();
  for (const op of ops) {
    if (op.kind !== "delete") continue;
    if (op.ref.coll === "actors" && !op.ref.parent) {
      actors.add(op.ref.id);
      continue;
    }
    if (op.ref.coll === "items") {
      const parent = op.ref.parent?.coll === "actors" ? op.ref.parent.id : "";
      items.add(`${parent}\u0000${op.ref.id}`);
    }
  }
  if (actors.size === 0 && items.size === 0) return [...ops];
  const more: Op[] = [];
  for (const macro of world.macros ?? []) {
    const binding = fxBindingOf(macro);
    if (binding === null) continue;
    if (actors.has(binding.actorId) || items.has(`${binding.actorId}\u0000${binding.itemId}`))
      more.push({ kind: "update", ref: { coll: "macros", id: macro._id }, diff: { "-=fxItem": null } });
  }
  return more.length > 0 ? [...ops, ...more] : [...ops];
}
