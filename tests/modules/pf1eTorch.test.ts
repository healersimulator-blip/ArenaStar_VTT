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

function fixture(items: InventoryItem[]) {
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
  const storage = new Map<string, unknown>();
  let nextSelection: string | null = null;
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
    storage: {
      get: async (key: string) => storage.get(key) ?? null,
      set: async (key: string, value: unknown) => {
        storage.set(key, structuredClone(value));
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
    storage,
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
    expect(f.storage.get("preferences")).toMatchObject({
      fallbackBrightFt: 30,
      fallbackDimFt: 60,
    });

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
    await f.dispatch("toggle");
    expect(f.applications.at(-1)).toMatchObject({
      sourceId: "candle",
      active: true,
      light: { bright: 0, radius: 100 },
    });
    expect(f.applications.at(-1)).not.toHaveProperty("consumeItemId");
    expect(f.inventory.items[0]?.quantity).toBe(1);
  });
});
