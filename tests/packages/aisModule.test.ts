import "fake-indexeddb/auto";
import { describe, expect, test, vi } from "vitest";
import type { AisCapability } from "../../src/core/automationInterconnect";
import {
  AIS_RPC_TAG,
  createAisModuleDispatcher,
  type AisModuleHandlers,
} from "../../src/packages/aisModuleIframe";
import { createAisModuleHandlers } from "../../src/packages/aisModuleHandlers";
import type { ActorDocument, SceneDocument } from "../../src/core/documents";
import { openVttDb } from "../../src/storage/idb";

const allHandlers = (): AisModuleHandlers => ({
  "package.resource.read": vi.fn(async () => ({ text: "", next: null })),
  "scene.tags.snapshot": vi.fn(async () => null),
  "scene.tags.update": vi.fn(async () => ({ ok: true })),
  "fx.play": vi.fn(async () => ({ ok: true })),
  "fx.list": vi.fn(async () => []),
  "fx.stop": vi.fn(async () => ({ stopped: true })),
  "events.subscribe": vi.fn(async () => ({ ok: true })),
  "events.emit": vi.fn(async () => ({ ok: true })),
  "scene.read.visible": vi.fn(() => ({ scene: "scene-1" })),
  "actor.inventory.read": vi.fn(async () => ({ actorId: "actor-1", actorName: "Actor", items: [] })),
  "scene.token.light.apply": vi.fn(async () => ({ ok: true })),
  "module.storage.get": vi.fn(async () => null),
  "module.storage.set": vi.fn(async () => ({ ok: true })),
  "chat.post": vi.fn(async () => ({ id: "message-1" })),
  "ui.notify": vi.fn(() => ({ ok: true })),
  "ui.select": vi.fn(async () => ({ selected: null })),
});

function sampleScene(): SceneDocument {
  return {
    _id: "scene-1",
    type: "scene",
    name: "The Hall",
    ownership: { default: 0 },
    flags: {},
    system: {},
    active: true,
    img: null,
    width: 1000,
    height: 1000,
    grid: { type: "square", size: 100, distance: 5, units: "ft", diagonals: "555", hexLayout: "oddQ" },
    darkness: 1,
    tokens: [{
      _id: "token-1",
      type: "token",
      name: "Guard",
      ownership: { default: 0 },
      flags: {},
      system: {},
      x: 10,
      y: 20,
      rotation: 0,
      width: 100,
      height: 100,
      img: "",
      hidden: false,
      disposition: "neutral",
      vision: true,
      light: { radius: 0, color: "#ffffff", alpha: 0 },
    }],
    walls: [],
    lights: [],
    sounds: [],
    tiles: [],
    drawings: [],
    templates: [],
    notes: [],
  };
}

const frame = (id: number, method: string, args: unknown = {}) => ({
  vttAisRpc: AIS_RPC_TAG,
  kind: "request",
  id,
  method,
  args,
});

async function dispatch(
  handlers: AisModuleHandlers,
  grants: ReadonlySet<AisCapability>,
  request: unknown,
): Promise<unknown[]> {
  const posted: unknown[] = [];
  const dispatcher = createAisModuleDispatcher(handlers, grants, vi.fn());
  dispatcher.onFrame(request, (message) => posted.push(message));
  await new Promise((resolve) => setTimeout(resolve, 0));
  return posted;
}

describe("AIS module RPC capability boundary", () => {
  test("denies ungranted methods before their handler runs", async () => {
    const handlers = allHandlers();
    const result = await dispatch(handlers, new Set(), frame(1, "scene.read.visible"));
    expect(result).toMatchObject([{ kind: "response", id: 1, ok: false, error: "Capability not granted: scene.read.visible" }]);
    expect(handlers["scene.read.visible"]).not.toHaveBeenCalled();
  });

  test("requires action.observe for typed event subscriptions and rejects unknown events", async () => {
    const handlers = allHandlers();
    const onSubscribe = vi.fn();
    const dispatcher = createAisModuleDispatcher(handlers, new Set(["action.observe"]), onSubscribe);
    const posted: unknown[] = [];
    dispatcher.onFrame(frame(1, "events.subscribe", { event: "turn.phase.changed" }), (value) => posted.push(value));
    dispatcher.onFrame(frame(2, "events.subscribe", { event: "scene.token.light.changed" }), (value) => posted.push(value));
    dispatcher.onFrame(frame(3, "events.subscribe", { event: "arbitrary.global.hook" }), (value) => posted.push(value));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(onSubscribe).toHaveBeenCalledTimes(2);
    expect(onSubscribe).toHaveBeenNthCalledWith(1, "turn.phase.changed");
    expect(onSubscribe).toHaveBeenNthCalledWith(2, "scene.token.light.changed");
    const responses = (posted as Array<{ id: number; ok: boolean; error?: string }>).sort((a, b) => a.id - b.id);
    expect(responses).toMatchObject([
      { id: 1, ok: true },
      { id: 2, ok: true },
      { id: 3, ok: false, error: "Unknown AIS event" },
    ]);
  });

  test("custom event emission requires its separate capability", async () => {
    const handlers = allHandlers();
    const denied = await dispatch(handlers, new Set(["action.observe"]), frame(1, "events.emit", {
      eventId: "torch.changed", payload: { tokenId: "token-1" },
    }));
    expect(denied).toMatchObject([{ ok: false, error: "Capability not granted: event.emit" }]);
    expect(handlers["events.emit"]).not.toHaveBeenCalled();

    const allowed = await dispatch(handlers, new Set(["event.emit"]), frame(2, "events.emit", {
      eventId: "torch.changed", payload: { tokenId: "token-1" },
    }));
    expect(allowed).toMatchObject([{ ok: true }]);
    expect(handlers["events.emit"]).toHaveBeenCalledWith({ eventId: "torch.changed", payload: { tokenId: "token-1" } }, undefined);
  });

  test("macro command RPCs carry an active host context and expired commands fail closed", async () => {
    const handlers = allHandlers();
    const dispatcher = createAisModuleDispatcher(handlers, new Set(["scene.read.visible"]), vi.fn());
    const post = vi.fn();
    const assertActive = vi.fn();
    const context = {
      commandId: "cmd-1", sceneId: "scene-1", callerId: "gm", requestId: "run-1",
      runAs: "gm" as const, deadlineAt: Date.now() + 1000, isActive: () => true, assertActive,
    };
    dispatcher.onFrame({ ...frame(1, "scene.read.visible"), commandId: "cmd-1" }, post, (id) => id === "cmd-1" ? context : null);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(handlers["scene.read.visible"]).toHaveBeenCalledWith({}, context);
    expect(assertActive).toHaveBeenCalledTimes(2);

    const expired = { ...context, isActive: () => false };
    dispatcher.onFrame({ ...frame(2, "scene.read.visible"), commandId: "cmd-1" }, post, () => expired);
    expect(post).toHaveBeenLastCalledWith(expect.objectContaining({ id: 2, ok: false, error: "AIS macro command is no longer active" }));
    expect(handlers["scene.read.visible"]).toHaveBeenCalledTimes(1);
  });

  test("drops oversized malformed requests instead of dispatching them", async () => {
    const handlers = allHandlers();
    const posted = await dispatch(handlers, new Set(["scene.read.visible"]), frame(1, "scene.read.visible", { text: "x".repeat(70_000) }));
    expect(posted).toEqual([]);
    expect(handlers["scene.read.visible"]).not.toHaveBeenCalled();
  });
});

describe("AIS host handlers", () => {
  test("emits only manifest-declared custom events after the event capability check", async () => {
    const db = await openVttDb();
    const granted = new Set<AisCapability>(["event.emit"]);
    const emitted: unknown[] = [];
    const handlers = createAisModuleHandlers({
      worldId: "w-ais-events",
      packageId: "sample-mod",
      emittedEvents: ["torch.changed"],
      db,
      user: () => ({ id: "gm", name: "GM" }),
      activeScene: sampleScene,
      actorById: () => undefined,
      select: async () => null,
      submit: () => "tx-unused",
      notify: () => undefined,
      emitModuleEvent: (eventId, payload) => emitted.push({ eventId, payload }),
      newId: (prefix) => `${prefix}one`,
      assertCapability: async (capability) => {
        if (!granted.has(capability)) throw new Error(`denied ${capability}`);
      },
    });
    await handlers["events.emit"]({ eventId: "torch.changed", payload: { tokenId: "token-1" } });
    expect(emitted).toEqual([{ eventId: "torch.changed", payload: { tokenId: "token-1" } }]);
    await expect(handlers["events.emit"]({ eventId: "unlisted.hook", payload: {} })).rejects.toThrow("not declared");
    await expect(handlers["events.emit"]({ eventId: "torch.changed", payload: { data: "x".repeat(17 * 1024) } })).rejects.toThrow("16 KiB");
    granted.clear();
    await expect(handlers["events.emit"]({ eventId: "torch.changed", payload: {} })).rejects.toThrow("denied event.emit");
    db.close();
  });

  test("scopes module storage, projects visible scene data, and posts chat via host ops", async () => {
    const db = await openVttDb();
    const granted = new Set<AisCapability>([
      "scene.read.visible",
      "module.storage.read",
      "module.storage.write",
      "chat.post",
      "ui.notify",
      "action.observe",
    ]);
    const submitted: unknown[] = [];
    const notices: unknown[] = [];
    const handlers = createAisModuleHandlers({
      worldId: "w-ais-handlers",
      packageId: "sample-mod",
      emittedEvents: [],
      db,
      user: () => ({ id: "gm", name: "GM" }),
      activeScene: sampleScene,
      actorById: () => undefined,
      select: async () => null,
      submit: (ops) => { submitted.push(...ops); return "tx-ais-1"; },
      notify: (message, level) => notices.push({ message, level }),
      emitModuleEvent: vi.fn(),
      newId: (prefix) => `${prefix}one`,
      assertCapability: async (capability) => {
        if (!granted.has(capability)) throw new Error(`denied ${capability}`);
      },
    });

    expect(await handlers["scene.read.visible"]({})).toEqual({
      id: "scene-1",
      name: "The Hall",
      grid: { size: 100, distance: 5, units: "ft" },
      tokens: [{
        id: "token-1",
        name: "Guard",
        x: 10,
        y: 20,
        rotation: 0,
        light: { radius: 0, bright: 0, color: "#ffffff", alpha: 0, angle: 360 },
        state: null,
      }],
    });
    await handlers["module.storage.set"]({ key: "counter", value: { count: 2 } });
    expect(await handlers["module.storage.get"]({ key: "counter" })).toEqual({ count: 2 });
    await expect(handlers["module.storage.set"]({ key: "__proto__", value: 1 })).rejects.toThrow("safe characters");

    expect(await handlers["chat.post"]({ content: "<script>alert(1)</script>" })).toEqual({ id: "ais-msg-one", txId: "tx-ais-1" });
    expect(submitted).toMatchObject([{
      kind: "create",
      coll: "messages",
      data: { author: "gm", content: "&lt;script&gt;alert(1)&lt;/script&gt;", flavor: "AIS module sample-mod" },
    }]);
    await handlers["ui.notify"]({ message: "Hello", level: "warn" });
    expect(notices).toEqual([{ message: "Hello", level: "warn" }]);
    granted.delete("chat.post");
    await expect(handlers["chat.post"]({ content: "no" })).rejects.toThrow("denied chat.post");
    db.close();
  });

  test("bounds inventory reads, requires both light capabilities, and writes only module-owned light state", async () => {
    const db = await openVttDb();
    const granted = new Set<AisCapability>([
      "actor.inventory.read",
      "actor.inventory.consume",
      "scene.token.light.manage",
      "ui.interaction",
    ]);
    const scene = sampleScene();
    const token = scene.tokens[0];
    if (!token) throw new Error("test scene token missing");
    token.actorId = "actor-1";
    const actor = {
      _id: "actor-1",
      type: "actor",
      name: "Guard",
      ownership: { default: 0 },
      flags: {},
      system: {},
      items: [{
        _id: "item-torch",
        type: "item",
        name: "Torch",
        ownership: { default: 0 },
        flags: {},
        system: { quantity: 2, privateNote: "must not leak" },
        effects: [],
      }],
      effects: [],
    } as unknown as ActorDocument;
    const submitted: unknown[][] = [];
    const handlers = createAisModuleHandlers({
      worldId: "w-ais-light",
      packageId: "sample-mod",
      emittedEvents: [],
      db,
      user: () => ({ id: "gm", name: "GM" }),
      activeScene: () => scene,
      actorById: (id) => id === actor._id ? actor : undefined,
      select: async (request) => request.options[0]?.value ?? null,
      submit: (ops) => { submitted.push(ops); return "tx-light"; },
      notify: () => undefined,
      emitModuleEvent: vi.fn(),
      newId: (prefix) => `${prefix}one`,
      assertCapability: async (capability) => {
        if (!granted.has(capability)) throw new Error(`denied ${capability}`);
      },
    });

    expect(await handlers["actor.inventory.read"]({ actorId: "actor-1" })).toEqual({
      actorId: "actor-1",
      actorName: "Guard",
      items: [{ id: "item-torch", name: "Torch", quantity: 2 }],
    });
    expect(await handlers["ui.select"]({
      title: "Pick one",
      options: [{ value: "torch", label: "Torch" }],
    })).toEqual({ selected: "torch" });

    await handlers["scene.token.light.apply"]({
      sceneId: "scene-1",
      tokenId: "token-1",
      sourceId: "torch",
      sourceName: "Torch",
      sourceItemId: "item-torch",
      consumeItemId: "item-torch",
      stateIndex: 1,
      active: true,
      light: { radius: 800, bright: 400, color: "#ffcf82", alpha: 0.8, angle: 360, animation: { type: "torch", speed: 4.1, intensity: 0.32 } },
    });
    expect(submitted[0]).toMatchObject([
      { kind: "update", ref: { coll: "items", id: "item-torch", parent: { coll: "actors", id: "actor-1" } }, diff: { "system.quantity": 1 } },
      {
        kind: "update",
        ref: { coll: "tokens", id: "token-1", parent: { coll: "scenes", id: "scene-1" } },
        diff: {
          light: { radius: 800, bright: 400, angle: 360, animation: { type: "torch", speed: 4.1, intensity: 0.32 } },
          // A token no module touched yet has no `flags.ais`; the first write creates the
          // namespace whole (dotted paths need their intermediates — core/diff.ts).
          "flags.ais": { "sample-mod": { sourceId: "torch", sourceName: "Torch", sourceItemId: "item-torch", stateIndex: 1, active: true } },
        },
      },
    ]);
    expect((submitted[0] as Array<{ diff: Record<string, unknown> }>)[1]?.diff).not.toHaveProperty("flags");
    // Once the namespace exists, only this module's key is addressed — other modules' state survives.
    token.flags = { ais: { "other-mod": { active: false } } } as unknown as typeof token.flags;
    await handlers["scene.token.light.apply"]({
      sceneId: "scene-1",
      tokenId: "token-1",
      sourceId: "torch",
      sourceName: "Torch",
      stateIndex: 0,
      active: false,
      light: { radius: 0, bright: 0, color: "#ffcf82", alpha: 0.8, angle: 360, animation: null },
    });
    expect((submitted[1] as Array<{ diff: Record<string, unknown> }>)[0]?.diff).toMatchObject({
      "flags.ais.sample-mod": { sourceId: "torch", sourceName: "Torch", stateIndex: 0, active: false },
    });
    expect((submitted[1] as Array<{ diff: Record<string, unknown> }>)[0]?.diff).not.toHaveProperty("flags.ais");
    submitted.pop();
    await expect(handlers["scene.token.light.apply"]({
      sceneId: "scene-1",
      tokenId: "token-1",
      sourceId: "torch",
      sourceName: "Torch",
      stateIndex: 0,
      active: true,
      light: { radius: 800, bright: 400, color: "#ffcf82", alpha: 0.8, angle: 360, animation: { type: "torch", speed: 11, intensity: 0.2 } },
    })).rejects.toThrow("speed must be between 0 and 10");
    expect(submitted).toHaveLength(1);

    await expect(handlers["scene.token.light.apply"]({
      sceneId: "scene-1",
      tokenId: "not-visible",
      sourceId: "torch",
      sourceName: "Torch",
      stateIndex: 0,
      active: false,
      light: { radius: 0, bright: 0, color: "#ffcf82", alpha: 0.8, angle: 360 },
    })).rejects.toThrow("not visible");
    granted.delete("scene.token.light.manage");
    await expect(handlers["scene.token.light.apply"]({})).rejects.toThrow("denied scene.token.light.manage");
    db.close();
  });
});
