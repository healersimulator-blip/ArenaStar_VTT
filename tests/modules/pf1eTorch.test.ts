import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, test } from "vitest";

type InventoryItem = { id: string; name: string; quantity: number };
type Light = {
  radius: number;
  bright: number;
  color: string;
  alpha: number;
  angle: number;
  animation?: { type: "torch" | "pulse"; speed: number; intensity: number; reverse?: boolean } | null;
};
type Token = {
  id: string;
  name: string;
  actorId: string;
  rotation: number;
  light: Light;
  state: Record<string, unknown> | null;
};
type Request = { sceneId: string; tokenId: string; action: string };
type UiOption = { value: string; label: string; description?: string };

const entryPath = new URL(
  "../../modules/pf1e-torch/automation/entry.js",
  import.meta.url,
);
const entrySource = readFileSync(entryPath, "utf8");

const SETTING_SCOPES: Record<string, "world" | "device"> = {
  ignoreInventory: "world",
  consumeConsumables: "world",
  fallbackLight: "world",
  defaultSourceId: "world",
  quietNotices: "device",
};
const SETTING_DEFAULTS: Record<string, unknown> = {
  ignoreInventory: false,
  consumeConsumables: true,
  fallbackLight: "20-40",
  defaultSourceId: "torch",
  quietNotices: false,
};

function fixture(items: InventoryItem[], options: { device?: "gm" | "player" } = {}) {
  const inventory = { items: structuredClone(items) };
  const token: Token = {
    id: "token-1",
    name: "Ranger",
    actorId: "actor-1",
    rotation: 90,
    light: { radius: 0, bright: 0, color: "#ffffff", alpha: 0, angle: 360 },
    state: null,
  };
  const scene = {
    id: "scene-1",
    name: "Dark Cave",
    grid: { size: 100, distance: 5, units: "ft" },
    tokens: [token],
  };
  const selections: Array<{ title: string; options: UiOption[] }> = [];
  const applications: Array<Record<string, unknown>> = [];
  const notifications: Array<{ message: string; level: string }> = [];
  // D-481: the torch reads its policy from manifest-declared settings (world = GM-authored and
  // replicated; device = this browser). A player device is refused world writes by the kernel.
  const settings = new Map<string, unknown>();
  const settingWrites: Array<{ key: string; value: unknown }> = [];
  let nextSelection: string | null = null;
  let inventoryError: string | null = null;
  let inventoryReads = 0;
  let actionListener: ((request: Request) => unknown) | null = null;
  const eventListeners = new Map<string, Set<(payload: unknown) => unknown>>();
  const macroCommands = new Map<string, (input: Record<string, unknown>, context: Record<string, unknown>) => unknown>();
  const emittedEvents: Array<{ eventId: string; payload: unknown }> = [];

  const AIS = {
    api: "arena.ais/1",
    events: {
      on(event: string, callback: (request: Request) => unknown) {
        if (event === "ui.token.action") {
          actionListener = callback;
          return () => { actionListener = null; };
        }
        let listeners = eventListeners.get(event);
        if (!listeners) { listeners = new Set(); eventListeners.set(event, listeners); }
        const listener = callback as unknown as (payload: unknown) => unknown;
        listeners.add(listener);
        return () => listeners?.delete(listener);
      },
      emit: async (eventId: string, payload: unknown) => {
        emittedEvents.push({ eventId, payload: structuredClone(payload) });
        return { ok: true };
      },
    },
    commands: {
      on(commandId: string, callback: (input: Record<string, unknown>, context: Record<string, unknown>) => unknown) {
        macroCommands.set(commandId, callback);
        return () => macroCommands.delete(commandId);
      },
    },
    scene: { readVisible: async () => scene },
    actor: {
      readInventory: async () => {
        inventoryReads += 1;
        if (inventoryError) throw new Error(inventoryError);
        return inventory;
      },
    },
    lighting: {
      applyTokenLight: async (request: Record<string, unknown>) => {
        applications.push(structuredClone(request));
        const target = scene.tokens.find((row) => row.id === request.tokenId);
        if (!target) throw new Error("missing test token");
        target.light = structuredClone(request.light as Light);
        target.state = {
          sourceId: request.sourceId,
          sourceName: request.sourceName,
          sourceItemId: request.sourceItemId,
          stateIndex: request.stateIndex,
          active: request.active,
        };
        const consumeItemId = request.consumeItemId;
        if (typeof consumeItemId === "string") {
          const item = inventory.items.find((row) => row.id === consumeItemId);
          if (!item || item.quantity <= 0)
            throw new Error("empty test inventory stack");
          item.quantity -= 1;
        }
        const change = { sceneId: scene.id, tokenId: target.id, light: structuredClone(request.light as Light) };
        for (const listener of eventListeners.get("scene.token.light.changed") ?? []) await listener(change);
        return { ok: true };
      },
    },
    settings: {
      list: async () => ({
        settings: Object.keys(SETTING_SCOPES).map((key) => ({
          key,
          scope: SETTING_SCOPES[key],
          value: settings.has(key) ? settings.get(key) : SETTING_DEFAULTS[key],
        })),
      }),
      get: async (key: string) => (settings.has(key) ? settings.get(key) : SETTING_DEFAULTS[key]),
      set: async (key: string, value: unknown) => {
        if (!(key in SETTING_SCOPES)) throw new Error(`setting ${key} is not declared`);
        if (SETTING_SCOPES[key] === "world" && options.device === "player")
          throw new Error("World-scope settings are changed with GM authority; this device is a player.");
        settings.set(key, structuredClone(value));
        settingWrites.push({ key, value: structuredClone(value) });
        return { ok: true };
      },
    },
    ui: {
      select: async (request: { title: string; options: UiOption[] }) => {
        selections.push(structuredClone(request));
        const selected = nextSelection;
        nextSelection = null;
        return { selected };
      },
      notify: async (message: string, level = "info") => {
        notifications.push({ message, level });
        return { ok: true };
      },
    },
  };

  runInNewContext(entrySource, { AIS });
  const dispatch = async (action: string) => {
    if (!actionListener)
      throw new Error("module did not subscribe to ui.token.action");
    await actionListener({ sceneId: scene.id, tokenId: token.id, action });
  };
  const dispatchCommand = async (commandId: string, input: Record<string, unknown> = {}) => {
    const command = macroCommands.get(commandId);
    if (!command) throw new Error(`module did not register ${commandId}`);
    return command(input, {
      sceneId: scene.id,
      callerId: "gm",
      requestId: "request-1",
      runAs: "gm",
      deadlineAt: Date.now() + 8000,
      ais: AIS,
    });
  };
  return {
    AIS,
    applications,
    dispatchCommand,
    emittedEvents,
    macroCommands,
    dispatch,
    inventory,
    get inventoryReads() {
      return inventoryReads;
    },
    notifications,
    scene,
    selections,
    setSelection(value: string | null) {
      nextSelection = value;
    },
    failInventory(message: string | null) {
      inventoryError = message;
    },
    settings,
    settingWrites,
    token,
  };
}

describe("independent PF1e Torch AIS module", () => {
  test("selects an inventory source and applies a 90-degree bullseye beam in scene pixels", async () => {
    const f = fixture([
      { id: "item-candle", name: "Candle", quantity: 2 },
      { id: "item-bullseye", name: "Bull's-Eye Lantern", quantity: 1 },
      { id: "item-torch", name: "Torch", quantity: 3 },
    ]);
    f.setSelection("item-1");
    await f.dispatch("select");

    expect(f.selections[0]?.title).toBe("Choose a carried light source");
    expect(f.selections[0]?.options.map((option) => option.value)).toEqual([
      "item-0",
      "item-1",
      "item-2",
      "fallback",
    ]);
    expect(f.token.state).toMatchObject({
      sourceId: "bullseye-lantern",
      sourceItemId: "item-bullseye",
      active: false,
    });

    await f.dispatch("toggle");
    expect(f.applications.at(-1)).toMatchObject({
      sourceId: "bullseye-lantern",
      stateIndex: 1,
      active: true,
      light: { bright: 1200, radius: 2400, angle: 90 },
    });
    expect(f.applications.at(-1)).not.toHaveProperty("consumeItemId");
    expect(
      f.inventory.items.find((item) => item.id === "item-bullseye")?.quantity,
    ).toBe(1);
  });

  test("turning a consumable Torch on spends one item; extinguishing does not", async () => {
    const f = fixture([{ id: "item-torch", name: "Torch", quantity: 2 }]);
    await f.dispatch("toggle"); // Default source is Torch.
    expect(f.applications.at(-1)).toMatchObject({
      sourceId: "torch",
      stateIndex: 1,
      active: true,
      consumeItemId: "item-torch",
      light: { bright: 400, radius: 800, angle: 360, animation: { type: "torch", speed: 4.1, intensity: 0.32 } },
    });
    expect(f.inventory.items[0]?.quantity).toBe(1);

    await f.dispatch("toggle");
    expect(f.applications.at(-1)).toMatchObject({
      stateIndex: 0,
      active: false,
      light: { radius: 0, bright: 0 },
    });
    expect(f.applications.at(-1)).not.toHaveProperty("consumeItemId");
    expect(f.inventory.items[0]?.quantity).toBe(1);
  });

  test("selecting a different source while lit replaces the active beam immediately", async () => {
    const f = fixture([
      { id: "item-torch", name: "Torch", quantity: 1 },
      { id: "item-lantern", name: "Lantern", quantity: 1 },
    ]);
    f.setSelection("item-0");
    await f.dispatch("select");
    await f.dispatch("toggle");
    expect(f.inventory.items[0]?.quantity).toBe(0);

    f.setSelection("item-0");
    await f.dispatch("select");
    expect(f.applications.at(-1)).toMatchObject({
      sourceId: "lantern",
      stateIndex: 1,
      active: true,
      light: { bright: 600, radius: 1200, angle: 360 },
    });
  });

  test("cycles a Lantern through declared High and Low modes before extinguishing", async () => {
    const f = fixture([{ id: "item-lantern", name: "Lantern", quantity: 1 }]);
    await f.dispatch("toggle");
    expect(f.applications.at(-1)).toMatchObject({ stateIndex: 1, active: true, light: { bright: 600, radius: 1200 } });
    await f.dispatch("toggle");
    expect(f.applications.at(-1)).toMatchObject({ stateIndex: 2, active: true, light: { bright: 300, radius: 600 } });
    expect(await f.dispatchCommand("current-state", { tokenId: f.token.id })).toMatchObject({ stateIndex: 2, mode: "Low" });
    expect(f.inventory.items[0]?.quantity).toBe(1);
    await f.dispatch("toggle");
    expect(f.applications.at(-1)).toMatchObject({ stateIndex: 0, active: false, light: { radius: 0, bright: 0 } });
  });

  test("supports aliases, source cycling, and a configurable free fallback", async () => {
    const f = fixture([{ id: "oil-lamp", name: "Oil Lamp", quantity: 1 }]);
    f.setSelection("item:oil-lamp");
    await f.dispatch("select");
    await f.dispatch("next");
    expect(f.applications.at(-1)).toMatchObject({
      sourceId: "personal-light",
      active: true,
    });

    f.setSelection("fallback:30:60");
    await f.dispatch("settings");
    expect(f.settingWrites).toEqual([{ key: "fallbackLight", value: "30-60" }]);

    await f.dispatch("off");
    await f.dispatch("toggle");
    expect(f.applications.at(-1)).toMatchObject({
      sourceId: "personal-light",
      sourceName: "Personal light (fallback)",
      light: { bright: 600, radius: 1200, angle: 360 },
    });
  });

  test("inventory bypass does not read actor inventory and exposes the full source list", async () => {
    const f = fixture([{ id: "item-candle", name: "Candle", quantity: 1 }]);
    f.setSelection("inventory:ignored");
    await f.dispatch("settings");
    await f.dispatch("select");

    expect(f.inventoryReads).toBe(0);
    expect(
      f.selections.at(-1)?.options.map((option) => option.value),
    ).toContain("source:torch");
    await f.dispatch("toggle");
    expect(f.applications.at(-1)).toMatchObject({
      sourceId: "torch",
      active: true,
    });
    expect(f.applications.at(-1)).not.toHaveProperty("consumeItemId");
    expect(f.inventory.items[0]?.quantity).toBe(1);
  });

  test("exposes reviewed macro commands and emits source-change events through the typed AIS event API", async () => {
    const f = fixture([{ id: "item-torch", name: "wooden torch", quantity: 2 }]);
    expect([...f.macroCommands.keys()].sort()).toEqual([
      "current-source", "current-state", "equipped-sources", "extinguish", "inventory", "select-source", "source-exhausted", "toggle",
    ]);

    const lit = await f.dispatchCommand("toggle", { tokenId: f.token.id });
    expect(lit).toMatchObject({ sourceId: "torch", stateIndex: 1, active: true });
    expect(f.inventory.items[0]?.quantity).toBe(1);
    expect(await f.dispatchCommand("current-state", { tokenId: f.token.id })).toMatchObject({
      light: { animation: { type: "torch", speed: 4.1, intensity: 0.32 } },
    });
    expect(f.emittedEvents).toEqual(expect.arrayContaining([
      expect.objectContaining({ eventId: "torch.changed", payload: expect.objectContaining({ tokenId: "token-1", active: true }) }),
    ]));
    expect(await f.dispatchCommand("current-source", { tokenId: f.token.id })).toMatchObject({ sourceId: "torch", sourceName: "Torch" });
    expect(await f.dispatchCommand("inventory", { tokenId: f.token.id, sourceId: "torch" })).toEqual({ sourceId: "torch", quantity: 1 });

    await f.dispatchCommand("extinguish", { tokenId: f.token.id });
    expect(f.token.light.radius).toBe(0);
    expect(await f.dispatchCommand("source-exhausted", { tokenId: f.token.id, sourceId: "torch" })).toEqual({ sourceId: "torch", exhausted: false });
    expect(f.emittedEvents.some((event) => event.eventId === "torch.selected")).toBe(false);
  });

  test("lets testers disable inventory consumption in module settings", async () => {
    const f = fixture([{ id: "item-candle", name: "Candle", quantity: 1 }]);
    f.setSelection("consume:off");
    await f.dispatch("settings");
    expect(f.settingWrites).toEqual([{ key: "consumeConsumables", value: false }]);
    await f.dispatch("toggle");
    expect(f.applications.at(-1)).toMatchObject({
      sourceId: "candle",
      active: true,
      light: { bright: 0, radius: 100 },
    });
    expect(f.applications.at(-1)).not.toHaveProperty("consumeItemId");
    expect(f.inventory.items[0]?.quantity).toBe(1);
  });

  // D-481: the policy is the GM's world setting; a player's copy of the module follows it as soon
  // as the replicated value changes and cannot overwrite it.
  test("follows the GM's replicated world policy on a player device and refuses to overwrite it", async () => {
    const f = fixture([{ id: "item-torch", name: "Torch", quantity: 2 }], { device: "player" });
    await f.dispatch("toggle");
    expect(f.inventory.items[0]?.quantity).toBe(1);

    f.settings.set("consumeConsumables", false); // the GM's change arrives through replication
    await f.dispatch("off");
    await f.dispatch("toggle");
    expect(f.applications.at(-1)).toMatchObject({ sourceId: "torch", active: true });
    expect(f.applications.at(-1)).not.toHaveProperty("consumeItemId");
    expect(f.inventory.items[0]?.quantity).toBe(1);

    f.setSelection("consume:on");
    await f.dispatch("settings");
    expect(f.settingWrites).toEqual([]);
    expect(f.notifications.at(-1)).toMatchObject({ level: "warn" });
    expect(f.notifications.at(-1)?.message).toMatch(/only the GM can change them/);
    expect(f.notifications.at(-1)?.message).toMatch(/consumables are not consumed/);
  });

  test("the device-scope quietNotices setting mutes informational notices but not warnings", async () => {
    const f = fixture([], { device: "player" });
    f.setSelection("quiet:on");
    await f.dispatch("settings");
    expect(f.settingWrites).toEqual([{ key: "quietNotices", value: true }]);
    expect(f.notifications.at(-1)).toMatchObject({ message: "Torch settings saved.", level: "info" });

    const before = f.notifications.length;
    f.setSelection("fallback");
    await f.dispatch("select");
    await f.dispatch("toggle");
    expect(f.applications.at(-1)).toMatchObject({ sourceId: "personal-light", active: true });
    expect(f.notifications.length).toBe(before);

    await f.dispatch("off");
    f.failInventory("sheet locked");
    await f.dispatch("toggle");
    expect(f.notifications.at(-1)).toMatchObject({ message: "Inventory could not be read: sheet locked", level: "warn" });
  });
});
