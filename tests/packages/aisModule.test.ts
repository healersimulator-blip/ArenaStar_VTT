import "fake-indexeddb/auto";
import { describe, expect, test, vi } from "vitest";
import type { AisCapability, AisSettingDeclaration } from "../../src/core/automationInterconnect";
import {
  AIS_RPC_TAG,
  createAisModuleDispatcher,
  type AisModuleHandlers,
} from "../../src/packages/aisModuleIframe";
import { createAisModuleHandlers } from "../../src/packages/aisModuleHandlers";
import type { ActorDocument, SceneDocument, SettingsDocument } from "../../src/core/documents";
import type { CompendiumPack } from "../../src/core/compendium";
import { openVttDb } from "../../src/storage/idb";

const allHandlers = (): AisModuleHandlers => ({
  "package.resource.read": vi.fn(async () => ({ text: "", next: null })),
  "documents.context": vi.fn(async () => ({ userId: "gm", userName: "GM", collections: [], limits: {} })),
  "documents.list": vi.fn(async () => ({ collection: "actors", total: 0, offset: 0, rows: [], next: null })),
  "documents.get": vi.fn(async () => ({ document: null })),
  "documents.mutate": vi.fn(async () => ({ txId: "tx", created: [], seq: null })),
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
  "ui.panel.open": vi.fn(async () => ({ open: true })),
  "ui.panel.close": vi.fn(async () => ({ open: false })),
  "settings.list": vi.fn(async () => ({ settings: [] })),
  "settings.get": vi.fn(async () => ({ key: "k", scope: "device", value: true })),
  "settings.set": vi.fn(async () => ({ key: "k", scope: "device", value: true })),
  "settings.register": vi.fn(async () => ({ key: "k", scope: "device", registered: true })),
  "compendium.list": vi.fn(async () => ({ packs: [] })),
  "compendium.search": vi.fn(async () => ({ hits: [] })),
  "compendium.get": vi.fn(async () => ({ packId: "p/x.json", id: "e", name: "E", type: "actor", data: {} })),
  "modules.list": vi.fn(async () => ({ modules: [] })),
  "modules.invoke": vi.fn(async () => ({ result: null })),
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

  test("D-470: ui.panel.open/close need the ui.panel capability and a shell-provided panel slot", async () => {
    const db = await openVttDb();
    const granted = new Set<string>(["ui.panel"]);
    const calls: string[] = [];
    const base = {
      worldId: "w-ais-panel", packageId: "sample-mod", emittedEvents: [], db,
      user: () => ({ id: "gm", name: "GM" }), activeScene: sampleScene, actorById: () => undefined,
      select: async () => null, submit: () => "tx-unused", notify: () => undefined,
      emitModuleEvent: () => undefined, newId: (prefix: string) => `${prefix}one`,
      assertCapability: async (capability: string) => { if (!granted.has(capability)) throw new Error(`denied ${capability}`); },
    };
    const withPanel = createAisModuleHandlers({ ...base, panel: { open: () => calls.push("open"), close: () => calls.push("close") } });
    await expect(withPanel["ui.panel.open"]({})).resolves.toEqual({ open: true });
    await expect(withPanel["ui.panel.close"]({})).resolves.toEqual({ open: false });
    expect(calls).toEqual(["open", "close"]);
    const withoutPanel = createAisModuleHandlers(base);
    await expect(withoutPanel["ui.panel.open"]({})).rejects.toThrow("declares no interconnect.panel");
    granted.clear();
    await expect(withPanel["ui.panel.open"]({})).rejects.toThrow("denied ui.panel");
    expect(calls).toHaveLength(2);
    db.close();
  });

  test("D-476: settings.get/list need no capability, settings.set coerces and routes by scope", async () => {
    const db = await openVttDb();
    const granted = new Set<string>(["module.settings.write"]);
    const submitted: unknown[][] = [];
    const deviceChanges: unknown[] = [];
    let worldDoc: SettingsDocument | undefined;
    let canWriteWorld = true;
    const declarations: AisSettingDeclaration[] = [
      { key: "radius", scope: "world", type: "number", label: "Radius", default: 20, min: 0, max: 60, step: 5 },
      { key: "sound", scope: "device", type: "boolean", label: "Sound", default: true },
      { key: "mode", scope: "world", type: "choice", label: "Mode", default: "soft", choices: [{ value: "soft", label: "Soft" }, { value: "hard", label: "Hard" }] },
    ];
    const handlers = createAisModuleHandlers({
      worldId: "w-ais-settings", packageId: "torch", emittedEvents: [], db,
      user: () => ({ id: "gm", name: "GM" }), activeScene: sampleScene, actorById: () => undefined,
      select: async () => null, notify: () => undefined, emitModuleEvent: () => undefined,
      newId: (prefix: string) => `${prefix}one`,
      submit: (ops) => {
        submitted.push(ops);
        const op = ops[0];
        if (op?.kind === "create") worldDoc = op.data as SettingsDocument;
        else if (op?.kind === "update" && worldDoc) {
          const values = ((worldDoc.flags.ais as Record<string, unknown>).values as Record<string, unknown>);
          for (const [path, value] of Object.entries(op.diff)) values[path.replace("flags.ais.values.", "")] = value;
        }
        return "tx-settings";
      },
      assertCapability: async (capability: string) => { if (!granted.has(capability)) throw new Error(`denied ${capability}`); },
      settings: {
        declarations, packageName: "Torch", worldDoc: () => worldDoc, canWriteWorld: () => canWriteWorld,
        onDeviceChange: (key, value) => deviceChanges.push({ key, value }),
      },
    });
    // Defaults before anything is stored; no capability involved.
    await expect(handlers["settings.get"]({ key: "radius" })).resolves.toEqual({ key: "radius", scope: "world", value: 20 });
    const listed = await handlers["settings.list"]({}) as { settings: Array<{ key: string; value: unknown }> };
    expect(listed.settings.map((row) => [row.key, row.value])).toEqual([["radius", 20], ["sound", true], ["mode", "soft"]]);
    await expect(handlers["settings.get"]({ key: "nope" })).rejects.toThrow("declares no setting nope");
    // World scope: coerced against the declaration, then one create op with the namespace in flags.
    await expect(handlers["settings.set"]({ key: "radius", value: 7 })).rejects.toThrow("steps of 5");
    await expect(handlers["settings.set"]({ key: "radius", value: 65 })).rejects.toThrow("between 0 and 60");
    await expect(handlers["settings.set"]({ key: "mode", value: "loud" })).rejects.toThrow("declared choices");
    await expect(handlers["settings.set"]({ key: "radius", value: 30 })).resolves.toEqual({ key: "radius", scope: "world", value: 30 });
    expect(submitted[0]).toMatchObject([{ kind: "create", coll: "settings",
      data: { _id: "ais-settings:torch", ownership: { default: 1 }, system: {}, flags: { ais: { packageId: "torch", values: { radius: 30 } } } } }]);
    await expect(handlers["settings.set"]({ key: "mode", value: "hard" })).resolves.toEqual({ key: "mode", scope: "world", value: "hard" });
    expect(submitted[1]).toEqual([{ kind: "update", ref: { coll: "settings", id: "ais-settings:torch" }, diff: { "flags.ais.values.mode": "hard" } }]);
    await expect(handlers["settings.get"]({ key: "mode" })).resolves.toEqual({ key: "mode", scope: "world", value: "hard" });
    // A no-op write submits nothing.
    await handlers["settings.set"]({ key: "mode", value: "hard" });
    expect(submitted).toHaveLength(2);
    // Device scope: IndexedDB row + change callback, never an op.
    await expect(handlers["settings.set"]({ key: "sound", value: false })).resolves.toEqual({ key: "sound", scope: "device", value: false });
    expect(deviceChanges).toEqual([{ key: "sound", value: false }]);
    expect(submitted).toHaveLength(2);
    await expect(handlers["settings.get"]({ key: "sound" })).resolves.toEqual({ key: "sound", scope: "device", value: false });
    // Player authority refuses world writes before the host would.
    canWriteWorld = false;
    await expect(handlers["settings.set"]({ key: "radius", value: 10 })).rejects.toThrow("GM authority");
    await expect(handlers["settings.set"]({ key: "sound", value: true })).resolves.toMatchObject({ value: true });
    // The write capability gates every set; reads keep working without it.
    granted.clear();
    await expect(handlers["settings.set"]({ key: "sound", value: false })).rejects.toThrow("denied module.settings.write");
    await expect(handlers["settings.get"]({ key: "sound" })).resolves.toMatchObject({ value: true });
    // Subscribing to one's own settings changes needs no observe grant; host events still do.
    await expect(handlers["events.subscribe"]({ event: "module.settings.changed" })).resolves.toEqual({ ok: true });
    await expect(handlers["events.subscribe"]({ event: "world.snapshot" })).rejects.toThrow("denied action.observe");
    // D-483: the module's own panel close is covered by the `ui.panel` grant, not by observe.
    await expect(handlers["events.subscribe"]({ event: "ui.panel.closed" })).rejects.toThrow("denied ui.panel");
    granted.add("ui.panel");
    await expect(handlers["events.subscribe"]({ event: "ui.panel.closed" })).resolves.toEqual({ ok: true });
    await expect(handlers["events.subscribe"]({ event: "world.snapshot" })).rejects.toThrow("denied action.observe");
    await expect(handlers["events.subscribe"]({ event: "ui.panel.opened" })).rejects.toThrow("not part of the AIS v1 catalog");
    granted.delete("ui.panel");

    // D-482: runtime declarations (`settings.register`) — same schema, gated by the write capability,
    // idempotent for an identical re-registration, refused for a changed shape, then readable/writable.
    await expect(handlers["settings.register"]({ key: "fresh", scope: "device", type: "boolean", label: "Fresh", default: true }))
      .rejects.toThrow("denied module.settings.write");
    granted.add("module.settings.write");
    const registered: AisSettingDeclaration[] = [];
    const withRegister = createAisModuleHandlers({
      worldId: "w-ais-settings", packageId: "torch", emittedEvents: [], db,
      user: () => ({ id: "gm", name: "GM" }), activeScene: sampleScene, actorById: () => undefined,
      select: async () => null, notify: () => undefined, emitModuleEvent: () => undefined,
      newId: (prefix: string) => `${prefix}one`, submit: () => "tx", assertCapability: async () => undefined,
      settings: {
        get declarations() { return [...declarations, ...registered]; },
        packageName: "Torch", worldDoc: () => worldDoc, canWriteWorld: () => true,
        register: (declaration) => { registered.push(declaration); return null; },
      },
    });
    await expect(withRegister["settings.register"]({ key: "Bad Key", scope: "device", type: "boolean", label: "x", default: true }))
      .rejects.toThrow("settings.register needs a key matching");
    await expect(withRegister["settings.register"]({ key: "fresh", scope: "device", type: "boolean", label: "Fresh", default: true, hidden: true }))
      .resolves.toEqual({ key: "fresh", scope: "device", registered: true });
    await expect(withRegister["settings.register"]({ key: "fresh", scope: "device", type: "boolean", label: "Fresh", default: true, hidden: true }))
      .resolves.toEqual({ key: "fresh", scope: "device", registered: false });
    await expect(withRegister["settings.register"]({ key: "fresh", scope: "world", type: "boolean", label: "Fresh", default: true }))
      .rejects.toThrow("already declared with a different shape");
    await expect(withRegister["settings.register"]({ key: "radius", scope: "world", type: "number", label: "Radius", default: 20, min: 0, max: 60, step: 5 }))
      .resolves.toEqual({ key: "radius", scope: "world", registered: false });
    expect(registered).toHaveLength(1);
    const listedAfter = await withRegister["settings.list"]({}) as { settings: Array<{ key: string; hidden?: boolean; value: unknown }> };
    expect(listedAfter.settings.at(-1)).toMatchObject({ key: "fresh", hidden: true, value: true });
    await expect(withRegister["settings.set"]({ key: "fresh", value: false })).resolves.toEqual({ key: "fresh", scope: "device", value: false });
    // A long hidden string (Foundry object settings as JSON text) fits the raised cap.
    await expect(withRegister["settings.register"]({ key: "blob", scope: "world", type: "string", label: "Blob", default: "{}", maxLength: 16384, hidden: true }))
      .resolves.toMatchObject({ registered: true });
    await expect(withRegister["settings.register"]({ key: "huge", scope: "world", type: "string", label: "Huge", default: "", maxLength: 16385 }))
      .rejects.toThrow("maxLength must be an integer 1–16384");
    // A module without declarations lists nothing and refuses keys.
    const bare = createAisModuleHandlers({
      worldId: "w-ais-settings", packageId: "bare", emittedEvents: [], db,
      user: () => ({ id: "gm", name: "GM" }), activeScene: sampleScene, actorById: () => undefined,
      select: async () => null, submit: () => "tx", notify: () => undefined, emitModuleEvent: () => undefined,
      newId: (prefix: string) => `${prefix}one`, assertCapability: async () => undefined,
    });
    await expect(bare["settings.list"]({})).resolves.toEqual({ settings: [] });
    await expect(bare["settings.set"]({ key: "x", value: 1 })).rejects.toThrow("declares no setting x");
    db.close();
  });

  test("D-477: compendium.list/search/get read imported packs read-only and only on devices that have them", async () => {
    const db = await openVttDb();
    const granted = new Set<string>(["compendium.read"]);
    const pack: CompendiumPack = { name: "Bestiary", type: "actors", entries: [
      { id: "goblin", name: "Goblin", keywords: ["humanoid"], data: { type: "character", name: "Goblin", system: { cr: 0.33 } } },
      { id: "ogre", name: "Ogre", data: { type: "character", name: "Ogre", system: { cr: 3 } } },
      { id: "huge", name: "Huge Entry", data: { type: "character", name: "Huge Entry", system: { blob: "x".repeat(50 * 1024) } } },
    ] };
    const base = {
      worldId: "w-ais-compendium", packageId: "reader", emittedEvents: [], db,
      user: () => ({ id: "gm", name: "GM" }), activeScene: sampleScene, actorById: () => undefined,
      select: async () => null, submit: () => "tx", notify: () => undefined, emitModuleEvent: () => undefined,
      newId: (prefix: string) => `${prefix}one`,
      assertCapability: async (capability: string) => { if (!granted.has(capability)) throw new Error(`denied ${capability}`); },
    };
    const handlers = createAisModuleHandlers({ ...base, compendia: async () => [{ packageId: "pf1e-core", packFile: "packs/bestiary.json", pack }] });
    await expect(handlers["compendium.list"]({})).resolves.toEqual({ packs: [
      { id: "pf1e-core/packs/bestiary.json", name: "Bestiary", type: "actors", packageId: "pf1e-core", entries: 3 },
    ] });
    const hits = await handlers["compendium.search"]({ query: "gob" }) as { hits: Array<Record<string, unknown>> };
    expect(hits.hits).toMatchObject([{ packId: "pf1e-core/packs/bestiary.json", entryId: "goblin", name: "Goblin", type: "character" }]);
    await expect(handlers["compendium.search"]({ query: "ogre", packId: "pf1e-core/packs/other.json" })).rejects.toThrow("Unknown compendium pack");
    await expect(handlers["compendium.search"]({ query: "", limit: 5 })).rejects.toThrow("1–120 characters");
    await expect(handlers["compendium.search"]({ query: "o", limit: 1000 })).rejects.toThrow("limit must be an integer 1–100");
    await expect(handlers["compendium.get"]({ packId: "pf1e-core/packs/bestiary.json", entryId: "ogre" })).resolves.toEqual({
      packId: "pf1e-core/packs/bestiary.json", id: "ogre", name: "Ogre", type: "character",
      data: { type: "character", name: "Ogre", system: { cr: 3 } },
    });
    // Returned payloads are copies: a module cannot mutate the host's parsed pack through them.
    const got = await handlers["compendium.get"]({ packId: "pf1e-core/packs/bestiary.json", entryId: "goblin" }) as { keywords: string[] };
    got.keywords.push("mutated");
    expect(pack.entries[0]?.keywords).toEqual(["humanoid"]);
    await expect(handlers["compendium.get"]({ packId: "pf1e-core/packs/bestiary.json", entryId: "huge" })).rejects.toThrow("RPC budget");
    await expect(handlers["compendium.get"]({ packId: "pf1e-core/packs/bestiary.json", entryId: "none" })).rejects.toThrow("Unknown compendium entry");
    await expect(handlers["compendium.get"]({ packId: "../etc", entryId: "ogre" })).rejects.toThrow("<packageId>/<pack file>");
    granted.clear();
    await expect(handlers["compendium.list"]({})).rejects.toThrow("denied compendium.read");
    granted.add("compendium.read");
    const player = createAisModuleHandlers(base);
    await expect(player["compendium.list"]({})).rejects.toThrow("GM device only");
    db.close();
  });

  test("D-478: modules.list is public metadata; modules.invoke needs the capability, a declared requirement and a running target", async () => {
    const db = await openVttDb();
    const granted = new Set<string>(["modules.invoke"]);
    const invoked: unknown[] = [];
    const directory = () => [
      { packageId: "caller", name: "Caller", version: "1.0.0", running: true, commands: [], provides: [], emits: [] },
      { packageId: "torch", name: "Torch", version: "2.0.0", running: true,
        commands: [{ id: "light", contract: 1 }], provides: [{ id: "scene.token.light.action", mode: "exclusive" as const, contract: 1 }], emits: ["torch.changed"] },
    ];
    const handlers = createAisModuleHandlers({
      worldId: "w-ais-bus", packageId: "caller", emittedEvents: [], db,
      user: () => ({ id: "gm", name: "GM" }), activeScene: sampleScene, actorById: () => undefined,
      select: async () => null, submit: () => "tx", notify: () => undefined, emitModuleEvent: () => undefined,
      newId: (prefix: string) => `${prefix}one`,
      assertCapability: async (capability: string) => { if (!granted.has(capability)) throw new Error(`denied ${capability}`); },
      modules: {
        requires: [{ id: "torch" }],
        list: directory,
        invoke: async (target, commandId, input) => { invoked.push({ target, commandId, input }); return { lit: true }; },
      },
    });
    // The caller never appears in its own directory listing.
    await expect(handlers["modules.list"]({})).resolves.toEqual({ modules: [
      { packageId: "torch", name: "Torch", version: "2.0.0", running: true, commands: [{ id: "light", contract: 1 }],
        provides: [{ id: "scene.token.light.action", mode: "exclusive", contract: 1 }], emits: ["torch.changed"] },
    ] });
    await expect(handlers["modules.invoke"]({ moduleId: "torch", commandId: "light", input: { tokenId: "token-1" } }))
      .resolves.toEqual({ result: { lit: true } });
    expect(invoked).toEqual([{ target: "torch", commandId: "light", input: { tokenId: "token-1" } }]);
    await expect(handlers["modules.invoke"]({ moduleId: "caller", commandId: "light" })).rejects.toThrow("cannot invoke itself");
    await expect(handlers["modules.invoke"]({ moduleId: "other", commandId: "light" })).rejects.toThrow("Declare other in interconnect.requires");
    await expect(handlers["modules.invoke"]({ moduleId: "torch", commandId: "light", extra: 1 })).rejects.toThrow("accepts moduleId, commandId and input");
    granted.clear();
    await expect(handlers["modules.invoke"]({ moduleId: "torch", commandId: "light" })).rejects.toThrow("denied modules.invoke");
    await expect(handlers["modules.list"]({})).resolves.toMatchObject({ modules: [{ packageId: "torch" }] });
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
