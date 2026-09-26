/**
 * D-311 (SQ-12 / A09) — binding a timeline to an item: the authored shape, which branch a
 * committed use plays, the host's document rule, and the pruning that keeps a binding from
 * outliving its item.
 */
import { describe, expect, test } from "vitest";
import { fxBindingBranch, fxBindingDeletionOps, fxBindingEvents, fxBindingFiresOn,
  fxBindingMatches, fxBindingOf, fxItemBindingError, FX_BINDING_KEYS, FX_ITEM_EVENT_CONTRACT,
  FX_ITEM_EVENTS, validateFxItemBinding,
  type FxBindingLookup, type FxItemBinding } from "../../src/core/fxBinding";
import type { ActorDocument, ItemDocument, MacroDocument } from "../../src/core/documents";
import type { DocId } from "../../src/core/ids";
import type { Op } from "../../src/core/ops";

const item = (id: string, name = id): ItemDocument => ({ _id: id, type: "item", name,
  ownership: { default: 0 }, flags: {}, system: {}, effects: [] } as ItemDocument);
const actor = (id: string, items: ItemDocument[] = []): ActorDocument => ({ _id: id,
  type: "actor", name: id, ownership: { default: 0 }, flags: {}, system: {}, items,
  effects: [] });
const timeline = (id: string, patch: Partial<MacroDocument> = {}): MacroDocument => ({ _id: id,
  type: "macro", name: id, command: "", kind: "sequence", ownership: { default: 1 },
  flags: {}, system: {}, sequence: { version: 1, audience: "scene", persistent: false,
    sections: [{ id: "a", kind: "text", text: "boom", at: { kind: "point", x: 10, y: 10 },
      startMs: 0, durationMs: 500, color: "#ffffff", scale: 1 }] },
  ...patch } as MacroDocument);

/** A world with one actor holding one item, and a lookup over named timelines. */
function world(overrides: {
  actors?: ActorDocument[]; macros?: MacroDocument[]; readable?: DocId[];
} = {}): FxBindingLookup & { macros: MacroDocument[] } {
  const actors = overrides.actors ?? [actor("a-hero", [item("wand")])];
  const macros = overrides.macros ?? [];
  const readable = new Set(overrides.readable ?? [...macros.map((m) => m._id), ...actors.map((a) => a._id)]);
  return {
    macros,
    actor: (id) => actors.find((entry) => entry._id === id),
    macro: (id) => macros.find((entry) => entry._id === id),
    readable: (coll, doc) => readable.has(doc._id) || coll === "actors" && readable.has(doc._id),
    boundTimelines: (actorId, itemId) => macros
      .filter((macro) => macro.kind === "sequence" && macro.fxItem?.actorId === actorId &&
        macro.fxItem?.itemId === itemId)
      .map((macro) => ({ id: macro._id,
        events: macro.fxItem ? fxBindingEvents(macro.fxItem) : [] })),
  };
}

describe("FX item binding (D-311)", () => {
  test("the authored shape is closed: unknown fields and half-bindings are refused by name", () => {
    expect(validateFxItemBinding({ actorId: "a", itemId: "i" }).ok).toBe(true);
    const full = validateFxItemBinding({ actorId: "a", itemId: "i", onFailureId: "f",
      recognition: "auto", enabled: false });
    expect(full.ok).toBe(true);
    if (full.ok) expect(Object.keys(full.binding).sort()).toEqual(["actorId", "enabled", "itemId", "onFailureId", "recognition"]);
    for (const bad of [
      { actorId: "", itemId: "i" },
      { actorId: "a" },
      { actorId: "a", itemId: "i", onFailureId: "" },
      { actorId: "a", itemId: "i", recognition: "sometimes" },
      { actorId: "a", itemId: "i", enabled: "yes" },
      { actorId: "a", itemId: "i", phase: "cast" },
      // D-312 — the event list is a closed set, non-empty, and never repeats itself.
      { actorId: "a", itemId: "i", events: [] },
      { actorId: "a", itemId: "i", events: "use" },
      { actorId: "a", itemId: "i", events: ["cast"] },
      { actorId: "a", itemId: "i", events: ["use", "use"] },
      "a",
      null,
    ]) expect(validateFxItemBinding(bad).ok, JSON.stringify(bad)).toBe(false);
    const forced = validateFxItemBinding({ actorId: "a", itemId: "i", recognition: "failure" });
    expect(forced.ok).toBe(false);
    if (!forced.ok) expect(forced.error).toContain("failure timeline");

    // The events field round-trips in the closed set's canonical order, and keeping the
    // default explicit is harmless (the wizard drops it, the validator does not care).
    const both = validateFxItemBinding({ actorId: "a", itemId: "i", events: ["attack", "use"] });
    expect(both.ok).toBe(true);
    if (both.ok) expect(both.binding.events).toEqual(["attack", "use"]);
    const explicitUse = validateFxItemBinding({ actorId: "a", itemId: "i", events: ["use"] });
    expect(explicitUse.ok).toBe(true);
    if (explicitUse.ok) expect(explicitUse.binding.events).toEqual(["use"]);
  });

  test("an omitted event list means the item's own use — the D-311 behaviour, unchanged", () => {
    const silent = { actorId: "a-hero", itemId: "wand" } as FxItemBinding;
    expect(fxBindingEvents(silent)).toEqual(["use"]);
    expect(fxBindingFiresOn(silent, "use")).toBe(true);
    expect(fxBindingFiresOn(silent, "attack")).toBe(false);

    const swingOnly = { actorId: "a-hero", itemId: "wand", events: ["attack"] } as FxItemBinding;
    expect(fxBindingEvents(swingOnly)).toEqual(["attack"]);
    expect(fxBindingFiresOn(swingOnly, "use")).toBe(false);

    // A hand-edited empty list reads the same as an omitted one rather than as "never fires".
    expect(fxBindingEvents({ actorId: "a", itemId: "i", events: [] })).toEqual(["use"]);
    // …and an unknown name in a hand-edited list is filtered out, never invented into an event.
    const forged = { actorId: "a", itemId: "i",
      events: ["nonsense", "attack"] } as unknown as FxItemBinding;
    expect(fxBindingEvents(forged)).toEqual(["attack"]);
  });

  test("WZ-06: the event contract is readable data, not prose in a comment", () => {
    expect(FX_ITEM_EVENTS).toEqual(["use", "attack"]);
    for (const event of FX_ITEM_EVENTS) {
      const contract = FX_ITEM_EVENT_CONTRACT[event];
      expect(contract.label.length).toBeGreaterThan(0);
      expect(contract.facts.length).toBeGreaterThan(0);
      expect(contract.failure.length).toBeGreaterThan(0);
    }
    expect(FX_ITEM_EVENT_CONTRACT.attack.failure).toContain("missed");
    expect(FX_ITEM_EVENT_CONTRACT.use.failure).toContain("did not land");
  });

  test("the branch honours the event: a swing cue does not answer a charge burn", () => {
    const swing = timeline("swing", { fxItem: { actorId: "a-hero", itemId: "axe",
      events: ["attack"], onFailureId: "whiff" } as FxItemBinding });
    expect(fxBindingBranch(swing, "success", "attack")).toBe("swing");
    expect(fxBindingBranch(swing, "failure", "attack")).toBe("whiff");
    // Not this cue's moment: the use path may not borrow the swing cue.
    expect(fxBindingBranch(swing, "success", "use")).toBeNull();

    const burn = timeline("burn", { fxItem: { actorId: "a-hero", itemId: "axe" } as FxItemBinding });
    expect(fxBindingBranch(burn, "success", "use")).toBe("burn");
    expect(fxBindingBranch(burn, "success")).toBe("burn"); // the default is the use event
    expect(fxBindingBranch(burn, "success", "attack")).toBeNull();

    // Both moments on one timeline is allowed alongside its own failure cue.
    const both = timeline("both", { fxItem: { actorId: "a-hero", itemId: "axe",
      events: ["use", "attack"], onFailureId: "fizzle" } as FxItemBinding });
    expect(fxBindingBranch(both, "success", "attack")).toBe("both");
    expect(fxBindingBranch(both, "failure", "use")).toBe("fizzle");
    const off = timeline("both", { fxItem: { actorId: "a-hero", itemId: "axe",
      events: ["attack"], enabled: false } as FxItemBinding });
    expect(fxBindingBranch(off, "success", "attack")).toBeNull();
  });

  test("a malformed binding reads as no binding at all, never as a cue", () => {
    const good = timeline("hit", { fxItem: { actorId: "a-hero", itemId: "wand" } as FxItemBinding });
    expect(fxBindingOf(good)).toEqual({ actorId: "a-hero", itemId: "wand" });
    expect(fxBindingMatches(good, "a-hero", "wand")).toBe(true);
    expect(fxBindingMatches(good, "a-hero", "sword")).toBe(false);
    const handEdited = timeline("hit", { fxItem: { actorId: "a-hero" } as unknown as FxItemBinding });
    expect(fxBindingOf(handEdited)).toBeNull();
  });

  test("the branch follows the committed outcome, and 'play nothing' is an answer", () => {
    const plain = timeline("hit", { fxItem: { actorId: "a-hero", itemId: "wand" } as FxItemBinding });
    expect(fxBindingBranch(plain, "success")).toBe("hit");
    // No failure cue is bound, so a miss plays nothing rather than the hit cue.
    expect(fxBindingBranch(plain, "failure")).toBeNull();

    const paired = timeline("hit", { fxItem: { actorId: "a-hero", itemId: "wand",
      onFailureId: "miss" } as FxItemBinding });
    expect(fxBindingBranch(paired, "success")).toBe("hit");
    expect(fxBindingBranch(paired, "failure")).toBe("miss");

    // Manual disable wins over everything.
    const off = timeline("hit", { fxItem: { actorId: "a-hero", itemId: "wand",
      onFailureId: "miss", enabled: false } as FxItemBinding });
    expect(fxBindingBranch(off, "success")).toBeNull();
    expect(fxBindingBranch(off, "failure")).toBeNull();

    // And the recognition override can force either branch.
    const forcedHit = timeline("hit", { fxItem: { actorId: "a-hero", itemId: "wand",
      onFailureId: "miss", recognition: "success" } as FxItemBinding });
    expect(fxBindingBranch(forcedHit, "failure")).toBe("hit");
    const forcedMiss = timeline("hit", { fxItem: { actorId: "a-hero", itemId: "wand",
      onFailureId: "miss", recognition: "failure" } as FxItemBinding });
    expect(fxBindingBranch(forcedMiss, "success")).toBe("miss");
  });

  test("the host's rule needs a real item, real *timelines*, and a readable pair", () => {
    const binding = { actorId: "a-hero", itemId: "wand" } as FxItemBinding;
    const own = timeline("hit", { fxItem: binding });
    expect(fxItemBindingError(own, world({ macros: [own] }))).toBeNull();
    // The cue is checked like any other reference: an author who cannot read the very
    // timeline they are binding to an item cannot bind it.
    expect(fxItemBindingError(own, world({ macros: [own], readable: ["a-hero"] })))
      .toContain("its author cannot read");
    expect(fxItemBindingError(timeline("hit"), world())).toBeNull(); // no binding, no rule

    const missingItem = timeline("hit", { fxItem: { actorId: "a-hero", itemId: "gone" } as FxItemBinding });
    expect(fxItemBindingError(missingItem, world())).toContain("an item that exists");
    const missingActor = timeline("hit", { fxItem: { actorId: "a-ghost", itemId: "wand" } as FxItemBinding });
    expect(fxItemBindingError(missingActor, world())).toContain("an item that exists");

    // A failure cue must be a timeline: a preset or a script is refused by name, exactly as
    // the D-310 mixed-document rule refuses them on the payload side.
    const preset = timeline("look", { kind: "fxPreset", preset: { version: 1, sections: [] } });
    const bad = timeline("hit", { fxItem: { actorId: "a-hero", itemId: "wand",
      onFailureId: "look" } as FxItemBinding });
    const worldWith = world({ macros: [bad, preset], readable: ["a-hero", "hit", "look"] });
    expect(fxItemBindingError(bad, worldWith)).toContain("not a timeline");
    const absent = timeline("hit", { fxItem: { actorId: "a-hero", itemId: "wand",
      onFailureId: "nope" } as FxItemBinding });
    expect(fxItemBindingError(absent, world({ macros: [absent], readable: ["a-hero", "hit"] })))
      .toContain("names no timeline");
    // An author who cannot read the failure cue cannot bind it (and so cannot discover it).
    const unreadable = timeline("hit", { fxItem: { actorId: "a-hero", itemId: "wand",
      onFailureId: "miss" } as FxItemBinding });
    const miss = timeline("miss");
    const locked = world({ macros: [unreadable, miss], readable: ["a-hero", "hit"] });
    expect(fxItemBindingError(unreadable, locked)).toContain("its author cannot read");

    // One cue per moment — a second timeline on the same event of the same item is refused.
    const first = timeline("hit", { fxItem: { actorId: "a-hero", itemId: "wand" } as FxItemBinding });
    const second = timeline("other", { fxItem: { actorId: "a-hero", itemId: "wand" } as FxItemBinding });
    expect(fxItemBindingError(second, world({ macros: [first, second] })))
      .toContain("already bound to that item's use event");
    // …and re-saving the same one (the update path) is not "another".
    const both = world({ macros: [first, second] });
    expect(fxItemBindingError(first, both)).toContain("already bound to that item's use event");
    // …while a *different* moment on the same item is exactly what phase binding is for.
    const swing = timeline("swing", { fxItem: { actorId: "a-hero", itemId: "wand",
      events: ["attack"] } as FxItemBinding });
    expect(fxItemBindingError(swing, world({ macros: [first, swing] }))).toBeNull();
    const overlap = timeline("both", { fxItem: { actorId: "a-hero", itemId: "wand",
      events: ["use", "attack"] } as FxItemBinding });
    expect(fxItemBindingError(overlap, world({ macros: [first, swing, overlap] })))
      .toContain("use event");
  });

  test("deleting the item (or its actor) clears the binding in the same envelope", () => {
    const bound = timeline("hit", { fxItem: { actorId: "a-hero", itemId: "wand" } as FxItemBinding });
    const other = timeline("elsewhere", { fxItem: { actorId: "a-other", itemId: "wand" } as FxItemBinding });
    const worldState = { macros: [bound, other] };
    const deleteItem: Op = { kind: "delete", ref: { coll: "items", id: "wand",
      parent: { coll: "actors", id: "a-hero" } } };
    const pruned = fxBindingDeletionOps(worldState, [deleteItem]);
    expect(pruned).toHaveLength(2);
    expect(pruned[1]).toEqual({ kind: "update", ref: { coll: "macros", id: "hit" },
      diff: { "-=fxItem": null } });
    // The same id on another actor is untouched, and an unrelated delete adds nothing.
    expect(fxBindingDeletionOps(worldState, [{ kind: "delete",
      ref: { coll: "items", id: "wand", parent: { coll: "actors", id: "a-else" } } }]))
      .toHaveLength(1);
    expect(fxBindingDeletionOps(worldState, [{ kind: "delete", ref: { coll: "actors", id: "a-hero" } }]))
      .toHaveLength(2);
    expect(fxBindingDeletionOps(worldState, [{ kind: "delete", ref: { coll: "actors", id: "a-nobody" } }]))
      .toHaveLength(1);
    expect(fxBindingDeletionOps({}, [deleteItem])).toHaveLength(1);
    expect(FX_BINDING_KEYS).toHaveLength(6);
  });
});
