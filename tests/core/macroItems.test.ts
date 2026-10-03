import { describe, expect, test } from "vitest";
import type { ActorDocument, ItemDocument, MacroDocument } from "../../src/core/documents";
import type { PermissionUser } from "../../src/core/ownership";
import type { WindowSpec } from "../../src/core/windows";
import {
  macroItemChoices, macroItemReadable, macroItemReference, parseMacroItemRef, selectedMacroItem,
  type MacroItemWorld,
} from "../../src/core/macroItems";
import { bindMacroArgFields, bindMacroArgs, coerceMacroArgText, macroArgSchemaError,
  macroSelection, validateMacroArgs, type MacroArgInput } from "../../src/core/macroArgs";
import type { ClientSync } from "../../src/client/sync";
import { macroSelectionOf, runMacroSlot } from "../../src/ui/macros/run";

const player: PermissionUser = { id: "p", role: "PLAYER" };
const gm: PermissionUser = { id: "gm", role: "GM" };
const item = (id: string, name = id, level: 0 | 1 | 2 | 3 = 0): ItemDocument => ({
  _id: id, type: "item", name, ownership: { default: level }, flags: {}, system: {}, effects: [],
});
const actor = (id: string, items: ItemDocument[], level: 0 | 1 | 2 | 3 = 1): ActorDocument => ({
  _id: id, type: "actor", name: id, ownership: { default: level }, flags: {}, system: {}, items, effects: [],
});
const window = (actorId: string, itemId: string, z = 1, minimized = false): WindowSpec => ({
  id: `item:${actorId}:${itemId}`, kind: "item", title: "Item", x: 0, y: 0, width: 400, height: 500,
  z, minimized, data: { actorId, itemId },
});
const catalog = (): MacroItemWorld => ({ items: [item("shared", "World sword", 1), item("secret-world")],
  actors: [actor("hero", [item("shared", "Hero sword"), item("wand", "Hero wand")]),
    actor("scout", [item("shared", "Scout sword")]), actor("secret", [item("shared", "Private sword", 3)], 0)] });
const required: MacroArgInput[] = [{ name: "tool", type: "item", required: true, from: "selected" }];

describe("qualified macro item references (MC-02/D-393)", () => {
  test("world and embedded refs are exact, bounded and round-trip without guessing a parent", () => {
    expect(parseMacroItemRef("wand")).toEqual({ itemId: "wand", actorId: null });
    expect(parseMacroItemRef("hero/wand")).toEqual({ itemId: "wand", actorId: "hero" });
    expect(macroItemReference("wand")).toBe("wand");
    expect(macroItemReference("wand", "hero")).toBe("hero/wand");
    const max = `${"a".repeat(128)}/${"b".repeat(128)}`;
    expect(max).toHaveLength(257);
    expect(parseMacroItemRef(max)?.itemId).toHaveLength(128);
    expect(coerceMacroArgText(required[0] as MacroArgInput, max)).toBe(max);
    expect(parseMacroItemRef(`${"a".repeat(129)}/b`)).toBeNull();
    expect(parseMacroItemRef(`a/${"b".repeat(129)}`)).toBeNull();
  });

  test("malformed/object/path refs and slash-containing component ids are refused", () => {
    for (const value of [null, {}, { actorId: "hero", itemId: "wand" }, [], "", "/wand", "hero/", "a/b/c",
      "hero//wand", " hero/wand", "hero/wand ", "hero/../wand", "Actor.hero.Item.wand", "hero/wand\n", "world item"])
      expect(parseMacroItemRef(value)).toBeNull();
    expect(macroItemReference("hero/wand")).toBeNull(); // cannot reinterpret a malformed WORLD id
    expect(macroItemReference("wand", "hero/scout")).toBeNull();
  });

  test("bare ids read world items only, even when inventories share that same id", () => {
    const world = catalog();
    expect(macroItemReadable(world, player, "shared")).toBe(true);
    expect(macroItemReadable(world, player, "hero/shared")).toBe(true);
    expect(macroItemReadable(world, player, "scout/shared")).toBe(true);
    world.items = [];
    expect(macroItemReadable(world, player, "shared")).toBe(false); // no inventory scan/fallback
    expect(macroItemReadable(world, player, "hero/shared")).toBe(true);
    expect(macroItemReadable(world, player, "hero/missing")).toBe(false);
    expect(macroItemReadable(world, player, "missing/shared")).toBe(false);
  });

  test("a parent must be readable even when its embedded item has a public ownership map", () => {
    const world = catalog();
    expect(macroItemReadable(world, player, "secret/shared")).toBe(false);
    expect(macroItemReadable(world, gm, "secret/shared")).toBe(true);
    expect(macroItemReadable(world, player, "secret-world")).toBe(false);
    expect(macroItemReadable(world, gm, "secret-world")).toBe(true);
    expect(macroItemReadable(world, null, "shared")).toBe(false);
    // Item ownership cascades from a readable actor, exactly like the rest of the document model.
    expect(macroItemReadable(world, player, "hero/wand")).toBe(true);
  });

  test("deletion and ownership revocation are checked live, without cached ids or bodies", () => {
    const world = catalog();
    const hero = world.actors[0] as ActorDocument;
    expect(macroItemReadable(world, player, "hero/wand")).toBe(true);
    hero.items = [];
    expect(macroItemReadable(world, player, "hero/wand")).toBe(false);
    hero.items = [item("wand", "Renamed", 3)];
    hero.ownership = { default: 0 };
    expect(macroItemReadable(world, player, "hero/wand")).toBe(false);
    hero.ownership = { default: 1 };
    expect(macroItemReadable(world, player, "hero/wand")).toBe(true);
  });

  test("picker choices use readable world and parent-qualified embedded entries, never private names", () => {
    const world = catalog();
    const before = structuredClone(world);
    const choices = macroItemChoices(world, player);
    expect(choices).toHaveLength(4);
    expect(choices).toContainEqual({ reference: "shared", label: "World sword — world item" });
    expect(choices).toContainEqual({ reference: "hero/shared", label: "Hero sword — hero" });
    expect(choices).toContainEqual({ reference: "scout/shared", label: "Scout sword — scout" });
    expect(JSON.stringify(choices)).not.toContain("secret");
    expect(JSON.stringify(choices)).not.toContain("Private sword");
    expect(macroItemChoices(world, gm)).toHaveLength(6);
    expect(macroItemChoices(world, null)).toEqual([]);
    expect(world).toEqual(before);
  });

  test("the last focused open item window survives focus on the macro surface, independently of tokens", () => {
    const windows = [window("hero", "wand", 4), window("scout", "shared", 7),
      { ...window("secret", "shared", 20), kind: "macros" }];
    expect(selectedMacroItem(windows, catalog(), player)).toBe("scout/shared");
    windows[0] = window("hero", "wand", 21);
    expect(selectedMacroItem(windows, catalog(), player)).toBe("hero/wand");
    expect(selectedMacroItem([], catalog(), player)).toBeNull();
  });

  test("a stale/unreadable top item clears selection instead of falling back to a different item", () => {
    const older = window("hero", "wand", 1);
    expect(selectedMacroItem([older, window("secret", "shared", 2)], catalog(), player)).toBeNull();
    expect(selectedMacroItem([older, window("hero", "deleted", 2)], catalog(), player)).toBeNull();
    expect(selectedMacroItem([older, window("secret", "shared", 2, true)], catalog(), player)).toBe("hero/wand");
    expect(selectedMacroItem([older], catalog(), player)).toBe("hero/wand"); // explicitly closed top window
    expect(selectedMacroItem([{ ...older, data: {} }], catalog(), player)).toBeNull();
  });

  test("item-only context neither invents a selected token nor defaults an actor to the item's parent", () => {
    expect(macroSelection(null, "hero/wand")).toEqual({ tokenId: null, actorId: null, itemRef: "hero/wand" });
    expect(macroSelection({ _id: "t", actorId: "scout" }, "hero/wand"))
      .toEqual({ tokenId: "t", actorId: "scout", itemRef: "hero/wand" });
    expect(macroSelection(null, "bad/ref/extra")).toBeNull();
    expect(bindMacroArgs(required, "", macroSelection(null, "hero/wand")))
      .toEqual({ ok: true, args: { tool: "hero/wand" } });
    expect(bindMacroArgs([{ name: "target", type: "token", required: true, from: "selected" }], "",
      macroSelection(null, "hero/wand"))).toEqual({ ok: false, error: "select a token for target" });
  });

  test("item schemas, explicit named/positional values, run fields and selection defaults share one binder", () => {
    expect(macroArgSchemaError(required)).toBeNull();
    expect(macroArgSchemaError([{ name: "tool", type: "item", from: "inventory" }])).toBe("invalid input schema");
    const selected = macroSelection(null, "hero/wand");
    expect(bindMacroArgs(required, "tool=scout/shared", selected)).toEqual({ ok: true, args: { tool: "scout/shared" } });
    expect(bindMacroArgs(required, "shared", selected)).toEqual({ ok: true, args: { tool: "shared" } });
    expect(bindMacroArgFields(required, { tool: "" }, selected)).toEqual({ ok: true, args: { tool: "hero/wand" } });
    expect(bindMacroArgFields(required, { tool: "shared" }, selected)).toEqual({ ok: true, args: { tool: "shared" } });
    expect(bindMacroArgs(required, "", null)).toEqual({ ok: false, error: "select an item for tool" });
    expect(bindMacroArgs(required, "", macroSelection({ _id: "t", actorId: "hero" })))
      .toEqual({ ok: false, error: "select an item for tool" }); // NEVER choose hero.items[0]
    expect(bindMacroArgs([{ name: "tool", type: "item", from: "selected" }], "", null)).toEqual({ ok: true, args: {} });
    expect(bindMacroArgs(required, "tool=a/b/c", selected)).toEqual({ ok: false, error: "invalid tool" });
  });

  test("host validation consults the item reference check, not token/actor ids or client-supplied documents", () => {
    const world = catalog();
    const visible = (type: "token" | "actor" | "item", reference: string) =>
      type === "item" && macroItemReadable(world, player, reference);
    expect(validateMacroArgs({ tool: "hero/wand" }, required, visible))
      .toEqual({ ok: true, args: { tool: "hero/wand" } });
    for (const value of ["secret/shared", "secret-world", "a/b/c", "hero", 1, { itemId: "wand", actorId: "hero" }])
      expect(validateMacroArgs({ tool: value }, required, visible)).toEqual({ ok: false, error: "invalid or invisible tool" });
    expect(validateMacroArgs({ tool: "hero/wand" }, [{ name: "tool", type: "token" }], visible).ok).toBe(false);
  });

  test("the shared hotbar dispatch binds a readable item-only context and sends only its exact scalar ref", () => {
    const calls: unknown[] = [];
    const world = catalog();
    const client = { user: player, store: { world, getAll: () => [] },
      invokeMacro: (id: string, args: unknown) => { calls.push({ id, args }); return "request"; } } as unknown as ClientSync;
    const macro: MacroDocument = { _id: "m", type: "macro", name: "Item macro", kind: "automation",
      ownership: { default: 1 }, flags: {}, system: {}, command: "", automation: { graphId: "private-graph", inputs: required } };
    expect(runMacroSlot(client, macro, { selection: () => macroSelectionOf(client, null, "hero/wand") }))
      .toEqual({ ok: true, requestId: "request" });
    expect(calls).toEqual([{ id: "m", args: { tool: "hero/wand" } }]);
    expect(macroSelectionOf(client, null, "secret/shared")).toBeNull();
    expect(runMacroSlot(client, macro, { selection: () => macroSelectionOf(client, null, "secret/shared") }))
      .toEqual({ ok: false, error: "select an item for tool" });
    expect(calls).toHaveLength(1);
  });
});
