import { describe, expect, test } from "vitest";
import type { MacroDocument } from "../../src/core/documents";
import {
  MACRO_HOTBAR_STORAGE_PREFIX, assignMacroHotbarSlot, hotbarMacroChoices, macroHotbarStorageKey,
  macroSlots, normalizeMacroHotbarPrefs, playerMacroSlots, readMacroHotbarPrefs, writeMacroHotbarPrefs,
  type MacroHotbarScope, type MacroHotbarStorage,
} from "../../src/core/macroHotbar";

function macro(id: string, kind: MacroDocument["kind"] = "automation", slot?: number | string | boolean): MacroDocument {
  return { _id: id, type: "macro", name: `Macro ${id}`, kind, command: "",
    flags: slot === undefined ? {} : { core: { slot } }, system: {}, ownership: { default: 2 } };
}
function memoryStorage(): MacroHotbarStorage & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return { data, getItem: (key) => data.get(key) ?? null, setItem: (key, value) => { data.set(key, value); } };
}
const scope: MacroHotbarScope = { worldId: "world-1", userId: "player-1" };
const ids = (slots: ReadonlyArray<MacroDocument | null>) => slots.map((entry) => entry?._id ?? null);

describe("player-owned macro hotbar (MC-01/D-392)", () => {
  test("GM defaults keep last-wins and accept only integer slots 1–5", () => {
    const defaults = macroSlots([
      macro("a", "chat", 1), macro("b", "automation", 1), macro("c", "sequence", 5),
      ...[0, 6, -1, 1.5, Number.NaN, Infinity, "2", true].map((slot, i) => macro(`invalid-${i}`, "chat", slot)),
    ]);
    expect(ids(defaults)).toEqual(["b", null, null, null, "c"]);
    expect(defaults).toHaveLength(5);
    expect(Object.keys(defaults)).toHaveLength(5); // no fractional array properties
    expect(ids(macroSlots([]))).toEqual([null, null, null, null, null]);
  });

  test("prefs are fresh, versioned, bounded, padded and distinguish default from empty", () => {
    const prefs = normalizeMacroHotbarPrefs({ version: 1, slots: [null, "", "bell", 42, false, "overflow"] });
    expect(prefs).toEqual({ version: 1, slots: [null, "", "bell", null, null] });
    expect(normalizeMacroHotbarPrefs({ version: 1, slots: ["bell"] }).slots)
      .toEqual(["bell", null, null, null, null]);
    for (const raw of [null, [], {}, "bell", { version: 2, slots: ["bell"] }, { version: 1, slots: "bell" }])
      expect(normalizeMacroHotbarPrefs(raw).slots).toEqual([null, null, null, null, null]);
    expect(normalizeMacroHotbarPrefs({ version: 1, slots: ["x".repeat(129), "bad\n", "bad\u0000", {}, []] }).slots)
      .toEqual([null, null, null, null, null]);
    const first = normalizeMacroHotbarPrefs(null);
    first.slots[0] = "changed";
    expect(normalizeMacroHotbarPrefs(null).slots[0]).toBeNull();
    const cloned = normalizeMacroHotbarPrefs(prefs);
    cloned.slots[0] = "changed";
    expect(prefs.slots[0]).toBeNull();
  });

  test("choices contain only current delivered chat/script/sequence/automation/composite entries", () => {
    const catalog = [macro("z-chat", "chat"), macro("b-script", "script"), macro("a-sequence", "sequence"),
      macro("c-graph", "automation"), macro("d-bundle", "composite"), macro("e-summon", "summon"),
      macro("f-preset", "fxPreset"), macro(""), macro("bad\n"), macro("x".repeat(129))];
    expect(hotbarMacroChoices(catalog).map((entry) => entry._id))
      .toEqual(["a-sequence", "b-script", "c-graph", "d-bundle", "z-chat"]);
    expect(catalog[0]?._id).toBe("z-chat"); // sorting never rearranges the store's catalog
  });

  test("overrides replace a slot and explicit empty suppresses its GM default without world edits", () => {
    const catalog = [macro("table", "automation", 1), macro("second", "chat", 2), macro("personal")];
    const before = structuredClone(catalog);
    let prefs = normalizeMacroHotbarPrefs(null);
    expect(ids(playerMacroSlots(catalog, prefs))).toEqual(["table", "second", null, null, null]);
    prefs = assignMacroHotbarSlot(prefs, 0, "personal", catalog);
    prefs = assignMacroHotbarSlot(prefs, 1, "", catalog);
    expect(ids(playerMacroSlots(catalog, prefs))).toEqual(["personal", null, null, null, null]);
    expect(catalog).toEqual(before);
    expect(macroSlots(catalog)[0]?._id).toBe("table"); // GM and other players unchanged
    expect(ids(playerMacroSlots(catalog, normalizeMacroHotbarPrefs(null)))).toEqual(["table", "second", null, null, null]);
  });

  test("GM changes update inherited slots only; resetting returns to the latest defaults", () => {
    const prefs = normalizeMacroHotbarPrefs({ version: 1, slots: ["personal", null, ""] });
    const catalog = [macro("new-table", "chat", 1), macro("new-second", "chat", 2),
      macro("third", "chat", 3), macro("personal")];
    expect(ids(playerMacroSlots(catalog, prefs))).toEqual(["personal", "new-second", null, null, null]);
    const restored = assignMacroHotbarSlot(prefs, 0, null, catalog);
    expect(ids(playerMacroSlots(catalog, restored))).toEqual(["new-table", "new-second", null, null, null]);
    expect(ids(playerMacroSlots(catalog, normalizeMacroHotbarPrefs(null))))
      .toEqual(["new-table", "new-second", "third", null, null]);
  });

  test("fresh assignments reject unavailable/unsupported ids and bad indices without mutation", () => {
    const prefs = normalizeMacroHotbarPrefs(null);
    const catalog = [macro("bell"), macro("summon", "summon")];
    for (const index of [-1, 5, 1.5, Infinity, Number.NaN])
      expect(assignMacroHotbarSlot(prefs, index, "bell", catalog)).toBe(prefs);
    for (const binding of ["missing", "summon", "x".repeat(129)])
      expect(assignMacroHotbarSlot(prefs, 0, binding, catalog)).toBe(prefs);
    const assigned = assignMacroHotbarSlot(prefs, 0, "bell", catalog);
    expect(assigned.slots[0]).toBe("bell");
    expect(prefs.slots[0]).toBeNull();
    expect(assignMacroHotbarSlot(assigned, 0, "", catalog).slots[0]).toBe("");
    expect(assignMacroHotbarSlot(assigned, 0, null, catalog).slots[0]).toBeNull();
  });

  test("deleted/unpublished bindings stay inert, never fall back, and recover on republish", () => {
    const prefs = normalizeMacroHotbarPrefs({ version: 1, slots: ["personal"] });
    const table = macro("table", "automation", 1);
    const personal = macro("personal");
    expect(playerMacroSlots([table, personal], prefs)[0]).toBe(personal);
    expect(playerMacroSlots([table], prefs)[0]).toBeNull(); // no fallback to table
    expect(prefs.slots[0]).toBe("personal"); // no purge during a temporary projected snapshot gap
    expect(playerMacroSlots([table, personal], prefs)[0]).toBe(personal);
    expect(playerMacroSlots([table, macro("personal", "summon")], prefs)[0]).toBeNull();
  });

  test("resolution uses the live document, not a saved body/name, and prototype-looking ids are inert unless delivered", () => {
    const prefs = normalizeMacroHotbarPrefs({ version: 1, slots: ["__proto__", "constructor"] });
    expect(ids(playerMacroSlots([], prefs))).toEqual([null, null, null, null, null]);
    const live = { ...macro("constructor", "chat"), name: "Renamed live entry", command: "new revision" };
    expect(playerMacroSlots([live], prefs)[1]).toBe(live);
    const updated = { ...live, command: "newer revision" };
    expect(playerMacroSlots([updated], prefs)[1]).toBe(updated);
  });

  test("round-trip stores ids only and isolates world and player scopes in the same browser", () => {
    const storage = memoryStorage();
    const prefs = normalizeMacroHotbarPrefs({ version: 1, slots: ["personal", ""] });
    expect(writeMacroHotbarPrefs(scope, prefs, storage)).toEqual({ prefs, saved: true });
    expect(readMacroHotbarPrefs(scope, storage)).toEqual(prefs);
    expect(storage.data.get(macroHotbarStorageKey(scope)))
      .toBe('{"version":1,"slots":["personal","",null,null,null]}');
    for (const other of [{ ...scope, worldId: "world-2" }, { ...scope, userId: "player-2" }])
      expect(readMacroHotbarPrefs(other, storage)).toEqual(normalizeMacroHotbarPrefs(null));
    writeMacroHotbarPrefs({ ...scope, userId: "player-2" }, normalizeMacroHotbarPrefs(null), storage);
    expect(readMacroHotbarPrefs(scope, storage)).toEqual(prefs);
    expect(macroHotbarStorageKey(scope).startsWith(MACRO_HOTBAR_STORAGE_PREFIX)).toBe(true);
    expect(macroHotbarStorageKey({ worldId: "a:b", userId: "c" }))
      .not.toBe(macroHotbarStorageKey({ worldId: "a", userId: "b:c" }));
  });

  test("corrupt/oversized/future stored data and denied reads fail safely to GM defaults", () => {
    const storage = memoryStorage();
    for (const raw of ["not json", "x".repeat(4097), '{"version":2,"slots":["bell"]}', "null"] ) {
      storage.data.set(macroHotbarStorageKey(scope), raw);
      expect(readMacroHotbarPrefs(scope, storage)).toEqual(normalizeMacroHotbarPrefs(null));
    }
    const denied: MacroHotbarStorage = { getItem: () => { throw new Error("denied"); }, setItem: () => undefined };
    expect(readMacroHotbarPrefs(scope, denied)).toEqual(normalizeMacroHotbarPrefs(null));
    expect(readMacroHotbarPrefs(scope, null)).toEqual(normalizeMacroHotbarPrefs(null));
  });

  test("failed persistence retains a normalized arrangement for the visit and reports that it was not saved", () => {
    const prefs = normalizeMacroHotbarPrefs({ version: 1, slots: ["bell", ""] });
    const denied: MacroHotbarStorage = { getItem: () => null, setItem: () => { throw new Error("quota"); } };
    for (const storage of [null, denied]) {
      const written = writeMacroHotbarPrefs(scope, prefs, storage);
      expect(written).toEqual({ prefs, saved: false });
      written.prefs.slots[0] = "changed";
      expect(prefs.slots[0]).toBe("bell");
    }
  });
});
