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
 *
 * **Which moment fires it** (D-312) is the other half of the contract: a sword's cue belongs
 * to the swing, a wand's to the charge it burns, and the same item can therefore carry more
 * than one bound cue — **one per event**, which is the D-311 "one item, one cue" rule
 * generalised rather than dropped: what must stay a single answer is "which cue plays *when I
 * do this*", not "which cue may this item ever play". Each event carries its own committed
 * facts ({@link FX_ITEM_EVENT_CONTRACT}), so recognition reads the right thing: a saved-against
 * spell for a use, the attack roll for an attack.
 */
import type { ActorDocument, MacroDocument } from "./documents";
import type { DocId } from "./ids";
import type { Op } from "./ops";

/** How the cue for a use is chosen. `auto` follows the committed outcome. */
export type FxRecognition = "auto" | "success" | "failure";

/**
 * What a committed moment turned out to be, as recognition reads it. `unknown` is an answer:
 * a cast whose effect has not landed yet has no committed result, so no branch can honestly be
 * chosen (and nothing fires).
 */
export type FxItemOutcome = "success" | "failure" | "unknown";

/**
 * The committed moments a bound cue can fire on (WZ-05's phase binding). Closed set: the use
 * path can only deliver what it actually knows, and an unknown name is refused rather than
 * kept as a field that never matches.
 */
export type FxItemEvent = "use" | "attack";

export const FX_ITEM_EVENTS: readonly FxItemEvent[] = ["use", "attack"];

/**
 * WZ-06's **event/context contract**, as data rather than prose so the wizard, the use path and
 * the tests read the same sentences: which moment each event is, which committed facts it
 * carries, and what `auto` recognition counts as a failure.
 */
export interface FxItemEventContract {
  /** What the moment is, in the author's words (the wizard shows this). */
  label: string;
  /** The committed facts the event carries — the context a binding's recognition reads. */
  facts: string;
  /** What `auto` recognition reads as a failure for this event. */
  failure: string;
}

export const FX_ITEM_EVENT_CONTRACT: Readonly<Record<FxItemEvent, FxItemEventContract>> = {
  use: {
    label: "the item is used",
    facts: "the item's own use as it committed: a cast paying a charge or slot, and whether the spell landed",
    failure: "the spell did not land — it was lost or held, a touch attack missed, " +
      "spell resistance turned it, or the target made its save (a multi-round cast that has " +
      "not landed yet is `unknown` and fires nothing)",
  },
  attack: {
    label: "the item attacks",
    facts: "an attack line authored from this item, resolved: the attack roll's own outcome",
    failure: "the attack missed (a confirmed critical is a success like any hit)",
  },
};

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
  /** Which committed moments fire it. Default `["use"]` — the D-311 behaviour, unchanged. */
  events?: FxItemEvent[];
}

/** Every field a binding may carry — anything else is refused by name. */
export const FX_BINDING_KEYS = ["actorId", "itemId", "onFailureId", "recognition", "enabled",
  "events"] as const;

/** The events of a *valid* binding, defaulted and in the closed set's own order. */
export function fxBindingEvents(binding: FxItemBinding): FxItemEvent[] {
  if (binding.events === undefined || binding.events.length === 0) return ["use"];
  return FX_ITEM_EVENTS.filter((event) => binding.events?.includes(event) === true);
}

/** Does this item's cue fire on that committed moment? */
export function fxBindingFiresOn(binding: FxItemBinding, event: FxItemEvent): boolean {
  return fxBindingEvents(binding).includes(event);
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);

const isId = (value: unknown): value is string => typeof value === "string" && value.trim() !== "";

/**
 * D-407 — binding a timeline to a **spell**, not an item. A prepared spell is a row on the actor, not
 * an item document, so the item binding cannot name it; the catalogue id from
 * `packages/pf1e/spellEffects` is the key. The committed moment is the cast itself, and the automatic
 * recognition is the same one the item binding uses for a use: a made save, spell resistance, a lost
 * spell, a held charge or a missed touch all mean the effect did not land, so `onFailureId` (or
 * nothing) plays instead of the spell's own cue.
 */
export interface FxSpellBinding {
  /**
   * Stable spell key. Tactical-effect catalogue ids remain valid for legacy worlds; otherwise
   * this is the normalized name key (for example, "fireball" or "burning-hands") so any
   * world-compendium spell can bind without inventing a rules effect.
   */
  spellId: string;
  /** Original catalogue/compendium display name, when known; the key remains authoritative. */
  spellName?: string;
  /** The cue a **failed** cast plays instead. */
  onFailureId?: DocId;
  /** Author override of the automatic recognition. Default `auto`. */
  recognition?: FxRecognition;
  /** Manual disable (default true): the spell plays no cue, whatever the outcome. */
  enabled?: boolean;
}

/** Every field a spell binding may carry — anything else is refused by name. */
export const FX_SPELL_BINDING_KEYS = ["spellId", "spellName", "onFailureId", "recognition", "enabled"] as const;

/**
 * Turn a display name into the stable key used by both compendium rows and cast outcomes.
 * Matching is exact after normalization — never fuzzy — so "Fireball" cannot capture
 * "Delayed Blast Fireball". Existing tactical ids (such as `entangle`) are unchanged.
 */
export function fxSpellKeyFromName(name: string): string | null {
  const key = name.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase()
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return key.length > 0 && key.length <= 128 ? key : null;
}

/** The validated key a macro carries, or null when its field is malformed/absent. */
export function fxSpellBindingKey(binding: unknown): string | null {
  const checked = validateFxSpellBinding(binding);
  return checked.ok ? checked.binding.spellId : null;
}

/** Validate the authored shape of a spell binding, refusing an unknown field by name. */
export function validateFxSpellBinding(
  value: unknown,
): { ok: true; binding: FxSpellBinding } | { ok: false; error: string } {
  const invalid = (error: string) => ({ ok: false as const, error });
  if (!isObject(value)) return invalid("an FX spell binding needs a spell");
  const stray = Object.keys(value).filter((key) => !(FX_SPELL_BINDING_KEYS as readonly string[]).includes(key));
  if (stray.length > 0) return invalid(`an FX spell binding carries no ${stray.join("/")} field`);
  if (typeof value.spellId !== "string" || !/^[a-z0-9][a-z0-9_-]{0,127}$/i.test(value.spellId))
    return invalid("an FX spell binding needs a stable spell key of 1–128 letters, digits, \"_\" or \"-\"");
  const spellId = value.spellId.toLowerCase();
  if (value.spellName !== undefined) {
    if (typeof value.spellName !== "string" || value.spellName.trim() === "" ||
        value.spellName.length > 80 || fxSpellKeyFromName(value.spellName) !== spellId)
      return invalid("an FX spell binding's display name must match its stable spell key");
  }
  if (value.onFailureId !== undefined && !isId(value.onFailureId))
    return invalid("an FX spell binding's failure cue must name a timeline");
  if (value.recognition !== undefined &&
      !(FX_RECOGNITION_MODES as readonly string[]).includes(String(value.recognition)))
    return invalid("an FX spell binding's recognition is auto, success or failure");
  if (value.enabled !== undefined && typeof value.enabled !== "boolean")
    return invalid("an FX spell binding's enabled must be a boolean");
  if (value.recognition === "failure" && value.onFailureId === undefined)
    return invalid("forcing the failure cue needs a bound failure timeline to play");
  const binding: FxSpellBinding = { spellId };
  if (typeof value.spellName === "string") binding.spellName = value.spellName.trim();
  if (typeof value.onFailureId === "string") binding.onFailureId = value.onFailureId;
  if (typeof value.recognition === "string") binding.recognition = value.recognition as FxRecognition;
  if (typeof value.enabled === "boolean") binding.enabled = value.enabled;
  return { ok: true, binding };
}

/**
 * The spell binding a timeline carries, or `null`. Malformed reads as *no* binding, the same
 * fail-closed rule the item binding uses: the host refuses to store one, so a document that carries
 * one anyway has been hand-edited and must not play a cue out of it.
 */
export function fxSpellBindingOf(macro: MacroDocument): FxSpellBinding | null {
  if (macro.fxSpell === undefined) return null;
  const checked = validateFxSpellBinding(macro.fxSpell);
  return checked.ok ? checked.binding : null;
}

/** Does this timeline name that spell? */
export function fxSpellBindingMatches(macro: MacroDocument, spellIdOrName: string): boolean {
  const binding = fxSpellBindingOf(macro);
  const rawKey = /^[a-z0-9][a-z0-9_-]{0,127}$/i.test(spellIdOrName)
    ? spellIdOrName.toLowerCase() : null;
  // Preserve an exact legacy catalogue id; otherwise normalize display-name punctuation too
  // (for example, "Fireball_0" and "Fireball, 0" both become "fireball-0").
  const key = binding !== null && rawKey === binding.spellId
    ? rawKey : fxSpellKeyFromName(spellIdOrName) ?? rawKey;
  return binding !== null && key !== null && binding.spellId === key;
}

/**
 * Which timeline a committed cast plays. `null` means "play nothing" (a disabled binding, or an
 * unrecognised failure with no failure cue bound); the default branch is the timeline the binding is
 * stored on, so a binding never has to repeat its own id.
 */
export function fxSpellBindingBranch(macro: MacroDocument, outcome: "success" | "failure"): DocId | null {
  const binding = fxSpellBindingOf(macro);
  if (binding === null || binding.enabled === false) return null;
  const recognition = binding.recognition ?? "auto";
  if (recognition === "success") return macro._id;
  if (recognition === "failure") return binding.onFailureId ?? null;
  return outcome === "success" ? macro._id : binding.onFailureId ?? null;
}

/** What the host must be able to see for a spell binding: its readable timelines and unique key. */
export interface FxSpellBindingLookup {
  macro(id: DocId): MacroDocument | undefined;
  /** Whether the *editor* may read that document — the host passes its own `can(...)`. */
  readable(coll: "macros", doc: { _id: DocId }): boolean;
  /** Every timeline already bound to that spell, so one spell plays exactly one cue. */
  boundTimelines(spellId: string): readonly { id: DocId }[];
}

/** The document rule for a timeline's spell binding, or `null` when it may be stored. */
export function fxSpellBindingError(macro: MacroDocument, lookup: FxSpellBindingLookup): string | null {
  if (macro.fxSpell === undefined) return null;
  const checked = validateFxSpellBinding(macro.fxSpell);
  if (!checked.ok) return checked.error;
  const binding = checked.binding;
  for (const [which, id] of [["the cue", macro._id], ["the failure cue", binding.onFailureId]] as const) {
    if (id === undefined) continue;
    const target = id === macro._id ? macro : lookup.macro(id);
    if (target === undefined) return `${which} names no timeline`;
    if (target.kind !== "sequence") return `${which} names a ${target.kind} macro, not a timeline`;
    if (!lookup.readable("macros", target)) return `${which} names a timeline its author cannot read`;
  }
  const clash = lookup.boundTimelines(binding.spellId).find((other) => other.id !== macro._id);
  if (clash !== undefined) return "another timeline is already bound to that spell";
  return null;
}

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
  const events: FxItemEvent[] = [];
  if (value.events !== undefined) {
    if (!Array.isArray(value.events) || value.events.length === 0)
      return invalid("an FX item binding fires on at least one event");
    for (const event of value.events) {
      if (!(FX_ITEM_EVENTS as readonly string[]).includes(String(event)))
        return invalid(`an FX item binding fires on ${FX_ITEM_EVENTS.join(" or ")}, not "${String(event)}"`);
      if (events.includes(event as FxItemEvent))
        return invalid(`an FX item binding lists the ${String(event)} event twice`);
      events.push(event as FxItemEvent);
    }
  }
  const binding: FxItemBinding = { actorId: value.actorId, itemId: value.itemId };
  if (typeof value.onFailureId === "string") binding.onFailureId = value.onFailureId;
  if (typeof value.recognition === "string") binding.recognition = value.recognition as FxRecognition;
  if (typeof value.enabled === "boolean") binding.enabled = value.enabled;
  if (events.length > 0) binding.events = events;
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
 * Which timeline a **committed** moment plays. `null` means "play nothing", which is an
 * answer: a disabled binding, a moment the binding does not fire on, and an unrecognised
 * failure with no failure cue bound. The default branch is the timeline the binding is stored
 * on, so a binding never has to repeat its own id (and cannot point at a different one).
 *
 * `event` defaults to `"use"`, which is exactly the D-311 behaviour: a binding that says
 * nothing about events fires on the item's own use.
 */
export function fxBindingBranch(macro: MacroDocument, outcome: "success" | "failure",
  event: FxItemEvent = "use"): DocId | null {
  const binding = fxBindingOf(macro);
  if (binding === null || binding.enabled === false) return null;
  if (!fxBindingFiresOn(binding, event)) return null;
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
  /**
   * Every timeline already bound to that item and the events it fires on, so a *moment* on an
   * item has exactly one cue (two timelines may share an item as long as they fire on
   * different moments).
   */
  boundTimelines(actorId: DocId, itemId: DocId): readonly { id: DocId; events: readonly FxItemEvent[] }[];
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
  // One cue per moment: two timelines firing on the same event of the same item would make the
  // use path choose arbitrarily, and "which cue plays when I press this" must never be a coin
  // toss. Two timelines *may* share an item when they fire on different moments — that is the
  // point of phase binding (a swing cue and a charge-burn cue on the same weapon).
  const mine = fxBindingEvents(binding);
  const clash = lookup.boundTimelines(binding.actorId, binding.itemId)
    .filter((other) => other.id !== macro._id)
    .flatMap((other) => other.events)
    .find((event) => mine.includes(event));
  if (clash !== undefined)
    return `another timeline is already bound to that item's ${clash} event`;
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
