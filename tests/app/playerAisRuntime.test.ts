// D-468: player-side AIS — delivery (`ais.profile`), per-device consent, and host authority.
/**
 * The acceptance example behind D-468 is the torch: a module the GM approved must light the
 * token a *player* owns, from the player's own shell, and nothing else. This file proves the
 * three halves without a browser:
 *
 *   1. delivery — a host with a profile provider sends `ais.profile` to a welcomed player right
 *      after the snapshot, republishes on change, and the client retains the latest copy;
 *   2. consent — the player runtime starts nothing until this device allowed the exact hash,
 *      stops a module the GM un-shares, and asks again when the hash changes;
 *   3. authority — the kernel handler the module calls (`scene.token.light.apply`), composed
 *      over the player's replica, commits on the player's own token and is refused with
 *      `forbidden` on another player's token. No new permission rule exists: Foundry-default
 *      ownership in `validateOps` is the whole gate.
 */
import "fake-indexeddb/auto";
import { describe, expect, test } from "vitest";
import { HostSync, gmSessionUser, type HostEvents } from "../../src/host/sync";
import { ClientSync, type ClientEvents } from "../../src/client/sync";
import { createTransportPair, flushMicrotasks } from "../../src/net/memory";
import { createEventBus, type EventBus } from "../../src/core/events";
import { DocumentStore, OpLog, UndoStack, type StoreMeta } from "../../src/core";
import type { AisProfileMsg, AisSharedModule, HelloMsg } from "../../src/core/messages";
import type { Op, OpEnvelope } from "../../src/core/ops";
import type { AisSettingDeclaration } from "../../src/core/automationInterconnect";
import { aisWorldSettingOps } from "../../src/core/aisSettings";
import type { Json, SceneDocument, TokenDocument, UserDocument } from "../../src/core/documents";
import type { AisModuleIframeOptions, AisModuleInvocationOptions } from "../../src/packages/aisModuleIframe";
import { openVttDb, getSetting } from "../../src/storage/idb";
import type { AisPanelEntry, AisPanelHost, AisPanelSpec } from "../../src/packages/aisPanel";
import {
  PlayerAisRuntime,
  playerAisConsentScope,
  type PlayerAisFrame,
  type PlayerAisPendingConsent,
  type PlayerAisStatuses, deliveredDigest } from "../../src/app/playerAisRuntime";

/** One world id per harness: the shared fake IndexedDB must not leak consent between tests. */
let worldCounter = 0;
let meta: StoreMeta = { worldId: "w-torch-0", name: "Torchlight", system: "pf1e", systemVersion: "1.0.0" };
const GM_ID = "gm-key";
function must<T>(value: T | undefined | null): T {
  if (value === undefined || value === null) throw new Error("expected a value");
  return value;
}
const hostScene = (h: { hostStore: DocumentStore }) => h.hostStore.get("scenes", "s1") as SceneDocument;

const REX_OWNER = "rex-key";
const IVY_OWNER = "ivy-key";
const REX = "t-rex";
const IVY = "t-ivy";

function userDoc(id: string, name: string, role: UserDocument["role"] = "PLAYER"): UserDocument {
  return { _id: id, type: "user", name, ownership: { default: 0 }, flags: {}, system: {}, role, character: null, color: "#fff" };
}

function tokenDoc(id: string, owner: string, x: number): TokenDocument {
  return {
    _id: id, type: "token", name: id, ownership: { default: 0, [owner]: 3 }, flags: {}, system: {},
    x, y: 0, rotation: 0, width: 100, height: 100, img: "", hidden: false, disposition: "friendly", vision: true,
    light: { radius: 0, color: "#ffffff", alpha: 0.5 },
  };
}

function sceneDoc(tokens: TokenDocument[]): SceneDocument {
  return {
    _id: "s1", type: "scene", name: "Cellar", ownership: { default: 2 }, flags: {}, system: {}, active: true, img: null,
    width: 1000, height: 1000, darkness: 0,
    grid: { type: "square", size: 100, distance: 5, units: "ft", diagonals: "555", hexLayout: "oddQ" },
    tokens, walls: [], lights: [], sounds: [], tiles: [], drawings: [], templates: [], notes: [],
  };
}

const torchModule = (hash = "h-torch-1"): AisSharedModule => ({
  packageId: "pf1e-torch", name: "Torch", version: "1.0.0", hash,
  source: "AIS.events.on('ui.token.action', function () {});",
  commands: [{ id: "light.toggle", contract: 1 }],
  capabilities: ["action.observe", "scene.read.visible", "actor.inventory.read", "scene.token.light.manage", "chat.post", "ui.interaction"],
  emittedEvents: [],
});

interface Harness {
  host: HostSync;
  hostStore: DocumentStore;
  hostBus: EventBus<HostEvents>;
  /** The GM's own client (GM-authority commits, e.g. world-scope module settings). */
  gm: ClientSync;
  profileBody: Omit<AisProfileMsg, "kind" | "seq" | "worldId">;
  addPlayer: (pubkey: string, name: string) => Promise<{ client: ClientSync; bus: EventBus<ClientEvents>; profiles: AisProfileMsg[] }>;
}

async function setup(): Promise<Harness> {
  meta = { ...meta, worldId: `w-torch-${++worldCounter}` };
  const hostStore = new DocumentStore({ meta });
  const hostLog = new OpLog();
  const undo = new UndoStack();
  const hostBus = createEventBus<HostEvents>();
  const host = new HostSync({
    store: hostStore, log: hostLog, undo, bus: hostBus, systemUserId: GM_ID, roomId: "room-torch",
    verifyHelloSig: async (hello) => hello.sig === "valid", rng: () => 0.25,
  });
  const seed: OpEnvelope = {
    seq: 1, ts: 0, by: GM_ID, txId: "seed",
    ops: [
      { kind: "create", coll: "users", data: userDoc(GM_ID, "GM", "GM") },
      { kind: "create", coll: "users", data: userDoc(REX_OWNER, "Rex") },
      { kind: "create", coll: "users", data: userDoc(IVY_OWNER, "Ivy") },
      { kind: "create", coll: "scenes", data: sceneDoc([tokenDoc(REX, REX_OWNER, 0), tokenDoc(IVY, IVY_OWNER, 100)]) },
    ],
  };
  const applied = hostStore.applyEnvelope(seed);
  if (!applied.ok) throw new Error(applied.error);
  const appended = hostLog.append(seed, applied.value.inverses);
  if (!appended.ok) throw new Error(appended.error);
  undo.push(seed, applied.value.inverses);

  const gmPair = createTransportPair();
  host.addSession("gm", gmPair.a, gmSessionUser(GM_ID));
  const gm = new ClientSync({ transport: gmPair.b, bus: createEventBus<ClientEvents>(), meta });
  await flushMicrotasks();

  const harness: Harness = {
    host, hostStore, hostBus, gm,
    profileBody: { providers: { "scene.token.light.action": "pf1e-torch/light" }, modules: [torchModule()] },
    addPlayer: async (pubkey, name) => {
      const pair = createTransportPair();
      host.addSession(`peer-${pubkey}`, pair.a);
      const bus = createEventBus<ClientEvents>();
      const profiles: AisProfileMsg[] = [];
      bus.on("aisProfile", (message) => profiles.push(message));
      const client = new ClientSync({ transport: pair.b, bus, meta });
      const hello: HelloMsg = { kind: "hello", pubkey, displayName: name, ts: 1, sig: "valid" };
      hostBus.on("join:request", ({ approve }) => approve());
      client.connect(hello);
      await flushMicrotasks();
      return { client, bus, profiles };
    },
  };
  host.setAisProfileProvider(() => harness.profileBody);
  return harness;
}

/** A frame double: records events, exposes the composed handlers, never touches the DOM. */
class FakeFrame implements PlayerAisFrame {
  status: PlayerAisFrame["status"] = { state: "ready" };
  readonly events: Array<{ event: string; payload: unknown }> = [];
  disposedWith: string | null = null;
  readonly commands: Array<{ commandId: string; input: Json; options: AisModuleInvocationOptions }> = [];
  readonly visibility: boolean[] = [];
  constructor(readonly options: AisModuleIframeOptions) {}
  setVisible(visible: boolean): void { this.visibility.push(visible); }
  emit(event: string, payload: unknown): void { this.events.push({ event, payload }); }
  invokeCommand(commandId: string, input: Json, options: AisModuleInvocationOptions): Promise<Json> {
    this.commands.push({ commandId, input, options });
    return Promise.resolve({ ok: true, commandId });
  }
  dispose(reason: string): void { this.disposedWith = reason; this.status = { state: "stopped", error: reason }; }
}

/** D-470: a panel-host double recording the shell-side protocol (mount → attach → open/close → remove). */
class FakePanelHost implements AisPanelHost {
  readonly log: string[] = [];
  readonly openIds = new Set<string>();
  readonly specs = new Map<string, AisPanelSpec>();
  readonly bodies = new Map<string, HTMLElement>();
  readonly frames = new Map<string, { setVisible(visible: boolean): void }>();
  mount(packageId: string, spec: AisPanelSpec): HTMLElement {
    this.log.push(`mount:${packageId}`);
    this.specs.set(packageId, spec);
    const body = { tag: `body:${packageId}` } as unknown as HTMLElement;
    this.bodies.set(packageId, body);
    return body;
  }
  attach(packageId: string, frame: { setVisible(visible: boolean): void }): void { this.log.push(`attach:${packageId}`); this.frames.set(packageId, frame); }
  open(packageId: string): boolean {
    if (!this.specs.has(packageId) || this.openIds.has(packageId)) return false;
    this.openIds.add(packageId); this.frames.get(packageId)?.setVisible(true); this.log.push(`open:${packageId}`); return true;
  }
  close(packageId: string): boolean {
    if (!this.openIds.delete(packageId)) return false;
    this.frames.get(packageId)?.setVisible(false); this.log.push(`close:${packageId}`); return true;
  }
  remove(packageId: string): void { this.specs.delete(packageId); this.openIds.delete(packageId); this.log.push(`remove:${packageId}`); }
  isOpen(packageId: string): boolean { return this.openIds.has(packageId); }
  entries(): AisPanelEntry[] { return Array.from(this.specs, ([packageId, spec]) => ({ packageId, title: spec.title, open: this.openIds.has(packageId) })); }
  dispose(): void { for (const id of Array.from(this.specs.keys())) this.remove(id); }
}

function runtimeFor(player: { client: ClientSync; bus: EventBus<ClientEvents> }, db: Awaited<ReturnType<typeof openVttDb>>, panelHost?: FakePanelHost) {
  const frames: FakeFrame[] = [];
  let pending: PlayerAisPendingConsent[] = [];
  let statuses: PlayerAisStatuses = {};
  const notices: string[] = [];
  const runtime = new PlayerAisRuntime({
    client: player.client, bus: player.bus, db, worldId: meta.worldId,
    activeScene: () => player.client.store.get("scenes", "s1") as SceneDocument | undefined ?? null,
    select: async () => null, cancelChoice: () => {},
    notify: (message) => notices.push(message),
    onStatus: (next) => { statuses = next; },
    onPending: (next) => { pending = next; },
    createFrame: (options) => { const frame = new FakeFrame(options); frames.push(frame); return frame; },
    ...(panelHost ? { panelHost } : {}),
    now: () => 1234,
  });
  return { runtime, frames, notices, pending: () => pending, statuses: () => statuses };
}

const lightArgs = (tokenId: string) => ({
  sceneId: "s1", tokenId, sourceId: "torch", sourceName: "Torch", stateIndex: 1, active: true,
  light: { radius: 800, bright: 400, color: "#ffcf82", alpha: 0.8, angle: 360, animation: { type: "torch", speed: 4, intensity: 0.3 } },
});

describe("D-468 — ais.profile delivery", () => {
  test("a welcomed player receives the shared set after the snapshot; the client retains it", async () => {
    const h = await setup();
    const rex = await h.addPlayer(REX_OWNER, "Rex");
    expect(rex.profiles).toHaveLength(1);
    const profile = must(rex.profiles[0]);
    expect(profile.kind).toBe("ais.profile");
    expect(profile.worldId).toBe(meta.worldId);
    expect(profile.providers).toEqual({ "scene.token.light.action": "pf1e-torch/light" });
    expect(profile.modules.map((m) => m.packageId)).toEqual(["pf1e-torch"]);
    expect(rex.client.aisProfile).toBe(profile);
    // The replica was hydrated before the profile arrived (modules read documents, not the void).
    expect(rex.client.store.get("scenes", "s1")).toBeDefined();
  });

  test("publishAisProfile re-sends the current set to every connected player", async () => {
    const h = await setup();
    const rex = await h.addPlayer(REX_OWNER, "Rex");
    const ivy = await h.addPlayer(IVY_OWNER, "Ivy");
    h.profileBody = { providers: {}, modules: [] };
    h.host.publishAisProfile();
    await flushMicrotasks();
    expect(rex.profiles).toHaveLength(2);
    expect(ivy.profiles).toHaveLength(2);
    expect(rex.profiles[1]?.modules).toEqual([]);
    expect(rex.client.aisProfile?.modules).toEqual([]);
  });

  test("a profile for another world is ignored by the runtime", async () => {
    const h = await setup();
    const rex = await h.addPlayer(REX_OWNER, "Rex");
    const db = await openVttDb();
    try {
      const r = runtimeFor(rex, db);
      await r.runtime.settled();
      expect(r.pending()).toHaveLength(1);
      rex.bus.emit("aisProfile", { kind: "ais.profile", worldId: "elsewhere", seq: 99, providers: {}, modules: [] });
      await r.runtime.settled();
      expect(r.pending()).toHaveLength(1); // still the real world's offer
      r.runtime.dispose();
    } finally { db.close(); }
  });
});

describe("D-468 — player consent", () => {
  test("nothing runs before the player allows; allow starts the frame with the shared capabilities and persists the hash", async () => {
    const h = await setup();
    const rex = await h.addPlayer(REX_OWNER, "Rex");
    const db = await openVttDb();
    try {
      const r = runtimeFor(rex, db);
      await r.runtime.settled();
      expect(r.frames).toHaveLength(0);
      expect(r.pending()).toEqual([expect.objectContaining({ packageId: "pf1e-torch", hash: "h-torch-1", updated: false })]);
      expect(r.runtime.tokenLightState(must(hostScene(h).tokens[0]))).toMatchObject({ enabled: false });

      await r.runtime.allow("pf1e-torch");
      expect(r.frames).toHaveLength(1);
      expect(r.frames[0]?.options.grantedCapabilities).toEqual(torchModule().capabilities);
      expect(r.pending()).toEqual([]);
      expect(r.statuses()["pf1e-torch"]).toEqual({ state: "ready" });
      const stored = await getSetting(db, playerAisConsentScope(meta.worldId), "pf1e-torch");
      expect(stored?.value).toEqual({
        hash: "h-torch-1", digest: deliveredDigest(torchModule()), capabilities: torchModule().capabilities,
        decision: "allow", at: 1234,
      });

      // The light entries are live now, and the menu intent reaches the frame as ui.token.action.
      const scene = rex.client.store.get("scenes", "s1") as SceneDocument;
      expect(r.runtime.tokenLightState(must(scene.tokens[0]))).toEqual({ enabled: true, reason: null, active: false, sourceName: null });
      r.runtime.tokenLightAction(REX, "toggle");
      expect(r.frames[0]?.events.at(-1)).toEqual({ event: "ui.token.action", payload: { sceneId: "s1", tokenId: REX, action: "toggle" } });
      r.runtime.dispose();
    } finally { db.close(); }
  });

  test("D-469: manifest token actions are listed with the module's run state and reach the frame as ui.token.action", async () => {
    const h = await setup();
    const rex = await h.addPlayer(REX_OWNER, "Rex");
    const db = await openVttDb();
    try {
      h.profileBody = { providers: {}, modules: [{ ...torchModule(), tokenActions: [{ id: "snuff", label: "Snuff the torch" }] }] };
      h.host.publishAisProfile();
      await flushMicrotasks();
      const r = runtimeFor(rex, db);
      await r.runtime.settled();
      // Pending consent: listed, disabled, with a reason the menu can show.
      expect(r.runtime.tokenActions()).toEqual([{
        packageId: "pf1e-torch", id: "snuff", label: "Snuff the torch", enabled: false,
        reason: "Allow this module when prompted (it is waiting for your decision).",
      }]);
      r.runtime.runTokenAction(REX, "pf1e-torch", "snuff");
      expect(r.frames).toHaveLength(0);
      expect(r.notices.at(-1)).toContain("waiting for your decision");

      await r.runtime.allow("pf1e-torch");
      expect(r.runtime.tokenActions()).toEqual([{ packageId: "pf1e-torch", id: "snuff", label: "Snuff the torch", enabled: true, reason: null }]);
      r.runtime.runTokenAction(REX, "pf1e-torch", "snuff");
      expect(r.frames[0]?.events.at(-1)).toEqual({ event: "ui.token.action", payload: { sceneId: "s1", tokenId: REX, action: "snuff" } });
      // Unknown action ids never reach a frame.
      const before = r.frames[0]?.events.length;
      r.runtime.runTokenAction(REX, "pf1e-torch", "nope");
      expect(r.frames[0]?.events.length).toBe(before);

      // Declared commands run inside the player's frame as "player", never as "gm".
      expect(r.frames[0]?.options.playerCommands).toBe(true);
      await expect(r.runtime.invokeCommand("pf1e-torch", "light.toggle", { tokenId: REX })).resolves.toEqual({ ok: true, commandId: "light.toggle" });
      expect(r.frames[0]?.commands[0]).toMatchObject({
        commandId: "light.toggle", input: { tokenId: REX },
        options: { sceneId: "s1", callerId: REX_OWNER, runAs: "player", requestId: "player-cmd-1" },
      });
      expect(r.frames[0]?.commands[0]?.options.isActive()).toBe(true);
      await expect(r.runtime.invokeCommand("other", "x", {})).rejects.toThrow("not running on this device");
      r.runtime.dispose();
      expect(r.frames[0]?.commands[0]?.options.isActive()).toBe(false);
    } finally { db.close(); }
  });

  test("D-470: a declared panel is mounted before the frame, the frame is born inside it, and open/close flow both ways", async () => {
    const h = await setup();
    const rex = await h.addPlayer(REX_OWNER, "Rex");
    const db = await openVttDb();
    try {
      h.profileBody = { providers: {}, modules: [{ ...torchModule(), capabilities: [...torchModule().capabilities, "ui.panel"],
        panel: { title: "Torch kit", width: 320, height: 240 } }] };
      h.host.publishAisProfile();
      await flushMicrotasks();
      const panels = new FakePanelHost();
      const r = runtimeFor(rex, db, panels);
      await r.runtime.settled();
      expect(panels.log).toEqual([]); // nothing before consent
      expect(r.runtime.openPanel("pf1e-torch")).toBe(false);
      expect(r.notices.at(-1)).toContain("not running on this device");

      await r.runtime.allow("pf1e-torch");
      expect(panels.log).toEqual(["mount:pf1e-torch", "attach:pf1e-torch"]);
      expect(panels.specs.get("pf1e-torch")).toMatchObject({ title: "Torch kit", moduleName: "Torch", width: 320, height: 240 });
      // The iframe host element IS the panel body (no re-parenting later).
      expect(r.frames[0]?.options.hostElement).toBe(panels.bodies.get("pf1e-torch"));
      expect(r.frames[0]?.options.grantedCapabilities).toContain("ui.panel");
      expect(r.runtime.panelEntries()).toEqual([{ packageId: "pf1e-torch", title: "Torch kit", open: false }]);

      // Shell → open; module (via its RPC handler) → close; module → open again.
      expect(r.runtime.openPanel("pf1e-torch")).toBe(true);
      expect(r.frames[0]?.visibility).toEqual([true]);
      await expect(r.frames[0]?.options.handlers["ui.panel.close"]({})).resolves.toEqual({ open: false });
      expect(panels.isOpen("pf1e-torch")).toBe(false);
      await expect(r.frames[0]?.options.handlers["ui.panel.open"]({})).resolves.toEqual({ open: true });
      expect(panels.isOpen("pf1e-torch")).toBe(true);
      expect(r.frames[0]?.visibility).toEqual([true, false, true]);

      // Un-sharing stops the module: the panel closes with it and disappears when the runtime goes.
      h.profileBody = { providers: {}, modules: [] };
      h.host.publishAisProfile();
      await flushMicrotasks();
      expect(r.frames[0]?.disposedWith).toBe("No longer shared by the GM");
      expect(panels.log.at(-1)).toBe("remove:pf1e-torch");
      expect(panels.entries()).toEqual([]);
      expect(r.runtime.panelEntries()).toEqual([]);
      r.runtime.dispose();
    } finally { db.close(); }
  });

  test("a remembered allow starts silently next session; deny is remembered too; forget asks again", async () => {
    const h = await setup();
    const rex = await h.addPlayer(REX_OWNER, "Rex");
    const db = await openVttDb();
    try {
      const first = runtimeFor(rex, db);
      await first.runtime.settled();
      await first.runtime.allow("pf1e-torch");
      first.runtime.dispose();

      const second = runtimeFor(rex, db);
      await second.runtime.settled();
      expect(second.pending()).toEqual([]);
      expect(second.frames).toHaveLength(1);
      await second.runtime.forget("pf1e-torch");
      await second.runtime.settled();
      expect(second.frames[0]?.disposedWith).toBe("Consent withdrawn on this device");
      expect(second.pending().map((p) => p.packageId)).toEqual(["pf1e-torch"]);
      await second.runtime.deny("pf1e-torch");
      expect(second.statuses()["pf1e-torch"]).toEqual({ state: "stopped", error: "Declined on this device" });
      second.runtime.dispose();

      const third = runtimeFor(rex, db);
      await third.runtime.settled();
      expect(third.pending()).toEqual([]);
      expect(third.frames).toHaveLength(0);
      third.runtime.dispose();
    } finally { db.close(); }
  });

  test("un-sharing stops the module at once; a new hash stops it and asks again as an update", async () => {
    const h = await setup();
    const rex = await h.addPlayer(REX_OWNER, "Rex");
    const db = await openVttDb();
    try {
      const r = runtimeFor(rex, db);
      await r.runtime.settled();
      await r.runtime.allow("pf1e-torch");

      h.profileBody = { providers: {}, modules: [] };
      h.host.publishAisProfile();
      await flushMicrotasks();
      await r.runtime.settled();
      expect(r.frames[0]?.disposedWith).toBe("No longer shared by the GM");
      expect(r.runtime.tokenLightState(must((rex.client.store.get("scenes", "s1") as SceneDocument).tokens[0]))).toBeUndefined();
      // The frame's own consent check now fails too — an in-flight RPC cannot outlive the share.
      await expect(r.frames[0]?.options.assertModuleActive?.()).rejects.toThrow("no longer shared");

      h.profileBody = { providers: { "scene.token.light.action": "pf1e-torch/light" }, modules: [torchModule("h-torch-2")] };
      h.host.publishAisProfile();
      await flushMicrotasks();
      await r.runtime.settled();
      expect(r.frames).toHaveLength(1); // not restarted: the new hash needs new consent
      expect(r.pending()).toEqual([expect.objectContaining({ hash: "h-torch-2", updated: true })]);
      r.runtime.dispose();
    } finally { db.close(); }
  });

  test("the same package hash with different delivered code never starts: flagged, not silently trusted", async () => {
    const h = await setup();
    const rex = await h.addPlayer(REX_OWNER, "Rex");
    const db = await openVttDb();
    try {
      const first = runtimeFor(rex, db);
      await first.runtime.settled();
      await first.runtime.allow("pf1e-torch");
      first.runtime.dispose();

      // A host that lies: same hash, other source.
      h.profileBody = { providers: {}, modules: [{ ...torchModule(), source: "AIS.events.on('ui.token.action', function () { /* altered */ });" }] };
      h.host.publishAisProfile();
      await flushMicrotasks();
      const second = runtimeFor(rex, db);
      await second.runtime.settled();
      expect(second.frames).toHaveLength(0);
      expect(second.statuses()["pf1e-torch"]).toEqual({ state: "failed", error: "Delivered code does not match the code allowed under this hash" });
      expect(second.pending()).toEqual([expect.objectContaining({ hash: "h-torch-1", updated: true, integrity: "mismatch" })]);
      expect(second.notices.some((n) => n.includes("differs from what you allowed"))).toBe(true);
      second.runtime.dispose();

      // The honest offer is still covered by the original consent.
      h.profileBody = { providers: {}, modules: [torchModule()] };
      h.host.publishAisProfile();
      await flushMicrotasks();
      const third = runtimeFor(rex, db);
      await third.runtime.settled();
      expect(third.frames).toHaveLength(1);
      expect(third.pending()).toEqual([]);
      third.runtime.dispose();
    } finally { db.close(); }
  });

  test("consent covers a capability subset silently and asks again when the GM shares more", async () => {
    const h = await setup();
    const rex = await h.addPlayer(REX_OWNER, "Rex");
    const db = await openVttDb();
    try {
      const first = runtimeFor(rex, db);
      await first.runtime.settled();
      await first.runtime.allow("pf1e-torch");
      first.runtime.dispose();

      h.profileBody = { providers: {}, modules: [{ ...torchModule(), capabilities: ["action.observe", "scene.read.visible"] }] };
      h.host.publishAisProfile();
      await flushMicrotasks();
      const fewer = runtimeFor(rex, db);
      await fewer.runtime.settled();
      expect(fewer.frames).toHaveLength(1);
      expect(fewer.frames[0]?.options.grantedCapabilities).toEqual(["action.observe", "scene.read.visible"]);
      fewer.runtime.dispose();

      h.profileBody = { providers: {}, modules: [{ ...torchModule(), capabilities: [...torchModule().capabilities, "module.storage.write"] }] };
      h.host.publishAisProfile();
      await flushMicrotasks();
      const more = runtimeFor(rex, db);
      await more.runtime.settled();
      expect(more.frames).toHaveLength(0);
      expect(more.pending()).toEqual([expect.objectContaining({ hash: "h-torch-1", updated: true, integrity: "ok" })]);
      more.runtime.dispose();
    } finally { db.close(); }
  });
});

describe("D-468 — host authority over a player's torch", () => {
  test("the kernel light handler commits on the player's own token and is refused on another player's token", async () => {
    const h = await setup();
    const rex = await h.addPlayer(REX_OWNER, "Rex");
    const db = await openVttDb();
    try {
      const r = runtimeFor(rex, db);
      await r.runtime.settled();
      await r.runtime.allow("pf1e-torch");
      const handlers = must(r.frames[0]).options.handlers;

      // Own token: the exact op shape the torch module produces is accepted by validateOps.
      const pendingOwn = handlers["scene.token.light.apply"](lightArgs(REX)) as Promise<{ ok: true; active: boolean }>;
      await flushMicrotasks();
      await expect(pendingOwn).resolves.toMatchObject({ ok: true, active: true });
      const hostToken = must(hostScene(h).tokens.find((t) => t._id === REX));
      expect(hostToken.light.radius).toBe(800);
      expect((hostToken.flags.ais as Record<string, unknown>)["pf1e-torch"]).toMatchObject({ active: true, sourceName: "Torch" });

      // Ivy's token: forbidden, nothing committed, the replica keeps the truth.
      const pendingForeign = handlers["scene.token.light.apply"](lightArgs(IVY)) as Promise<unknown>;
      await flushMicrotasks();
      await expect(pendingForeign).rejects.toThrow(/forbidden/);
      const ivyToken = must(hostScene(h).tokens.find((t) => t._id === IVY));
      expect(ivyToken.light.radius).toBe(0);
      expect(ivyToken.flags.ais).toBeUndefined();

      // scene.read.visible and the inventory handler work over the replica as well.
      const visible = await handlers["scene.read.visible"]({}) as { id: string; tokens: Array<{ id: string }> };
      expect(visible.id).toBe("s1");
      expect(visible.tokens.map((t) => t.id).sort()).toEqual([IVY, REX].sort());
      r.runtime.dispose();
    } finally { db.close(); }
  });

  test("D-476/D-477/D-478/D-479: world settings come from the replica, only device scope is writable, siblings run with player authority", async () => {
    const h = await setup();
    const settings: AisSettingDeclaration[] = [
      { key: "radius", scope: "world", type: "number", label: "Radius", default: 20, min: 0, max: 60, step: 5 },
      { key: "sound", scope: "device", type: "boolean", label: "Sound", default: true },
    ];
    h.profileBody = { providers: {}, modules: [
      { ...torchModule(), capabilities: ["action.observe", "module.settings.write", "modules.invoke"], settings, requires: [{ id: "lamp" }] },
      { packageId: "lamp", name: "Lamp", version: "1.0.0", hash: "h-lamp", source: "", commands: [{ id: "poke", contract: 1 }], capabilities: [], emittedEvents: [] },
    ] };
    const rex = await h.addPlayer(REX_OWNER, "Rex");
    const db = await openVttDb();
    try {
      const r = runtimeFor(rex, db);
      await r.runtime.settled();
      await r.runtime.allow("pf1e-torch");
      await r.runtime.allow("lamp");
      const torch = must(r.frames.find((frame) => frame.options.packageId === "pf1e-torch"));
      const lamp = must(r.frames.find((frame) => frame.options.packageId === "lamp"));
      const handlers = torch.options.handlers;

      // Defaults; the shell form and the module read the same values.
      expect((await r.runtime.moduleSettings("pf1e-torch"))?.values).toEqual({ radius: 20, sound: true });
      expect(await r.runtime.moduleSettings("lamp")).toBeNull();
      await expect(handlers["settings.get"]({ key: "radius" })).resolves.toEqual({ key: "radius", scope: "world", value: 20 });
      // World scope is the GM's: refused here before any op is built.
      await expect(handlers["settings.set"]({ key: "radius", value: 30 })).rejects.toThrow("GM authority");
      await expect(r.runtime.setDeviceSetting("pf1e-torch", "radius", 30)).rejects.toThrow("changed by the GM");
      expect(h.hostStore.get("settings", "ais-settings:pf1e-torch")).toBeUndefined();
      // Device scope: local row + change event, from the module and from the shell form.
      await expect(handlers["settings.set"]({ key: "sound", value: false })).resolves.toEqual({ key: "sound", scope: "device", value: false });
      expect(torch.events).toContainEqual({ event: "module.settings.changed", payload: { scope: "device", key: "sound", value: false } });
      await r.runtime.setDeviceSetting("pf1e-torch", "sound", true);
      expect(torch.events.at(-1)).toEqual({ event: "module.settings.changed", payload: { scope: "device", key: "sound", value: true } });
      expect((await r.runtime.moduleSettings("pf1e-torch"))?.values).toEqual({ radius: 20, sound: true });
      // The GM commits the world document → it replicates → the player's module hears the change.
      await h.gm.submitAndWait(aisWorldSettingOps(undefined, "pf1e-torch", "Torch", "radius", 35));
      await flushMicrotasks();
      expect(rex.client.store.get("settings", "ais-settings:pf1e-torch")).toMatchObject({ flags: { ais: { values: { radius: 35 } } } });
      expect(torch.events).toContainEqual({ event: "module.settings.changed", payload: { scope: "world", key: "radius", value: 35 } });
      expect(lamp.events.some((entry) => entry.event === "module.settings.changed")).toBe(false);
      await expect(handlers["settings.get"]({ key: "radius" })).resolves.toEqual({ key: "radius", scope: "world", value: 35 });

      // Module bus with player authority; compendia stay on the GM device.
      await expect(handlers["modules.list"]({})).resolves.toEqual({ modules: [
        { packageId: "lamp", name: "Lamp", version: "1.0.0", running: true, commands: [{ id: "poke", contract: 1 }], provides: [], emits: [] },
      ] });
      await expect(handlers["modules.invoke"]({ moduleId: "lamp", commandId: "poke", input: 1 })).resolves.toEqual({ result: { ok: true, commandId: "poke" } });
      expect(lamp.commands[0]).toMatchObject({ commandId: "poke", input: 1, options: { runAs: "player", requestId: "ais-module:pf1e-torch:1" } });
      await expect(lamp.options.handlers["modules.invoke"]({ moduleId: "pf1e-torch", commandId: "light.toggle" })).rejects.toThrow("modules.invoke is not shared");
      await expect(handlers["compendium.list"]({})).rejects.toThrow("compendium.read is not shared");

      // Diagnostics are absent in the frame double; restart re-reads consent and re-creates the frame.
      expect(r.runtime.diagnostics("pf1e-torch")).toBeNull();
      expect(await r.runtime.restart("pf1e-torch")).toBe(true);
      expect(r.frames.filter((frame) => frame.options.packageId === "pf1e-torch")).toHaveLength(2);
      expect(torch.disposedWith).toBe("Restarted on this device");
      expect(await r.runtime.restart("nobody")).toBe(false);
      r.runtime.dispose();
    } finally { db.close(); }
  });

  test("a capability the GM did not share is refused before any op is built", async () => {
    const h = await setup();
    h.profileBody = {
      providers: { "scene.token.light.action": "pf1e-torch/light" },
      modules: [{ ...torchModule(), capabilities: ["action.observe", "scene.read.visible"] }],
    };
    const rex = await h.addPlayer(REX_OWNER, "Rex");
    const db = await openVttDb();
    try {
      const r = runtimeFor(rex, db);
      await r.runtime.settled();
      await r.runtime.allow("pf1e-torch");
      const handlers = must(r.frames[0]).options.handlers;
      await expect(handlers["scene.token.light.apply"](lightArgs(REX)) as Promise<unknown>)
        .rejects.toThrow("scene.token.light.manage is not shared");
      expect((h.hostStore.get("scenes", "s1") as SceneDocument).tokens[0]?.light.radius).toBe(0);
      r.runtime.dispose();
    } finally { db.close(); }
  });
});

/** Compile-time: the op shape above is what `validateOps` sees (kept next to the test it explains). */
export const torchOpShape: Op = {
  kind: "update",
  ref: { coll: "tokens", id: REX, parent: { coll: "scenes", id: "s1" } },
  diff: { light: { radius: 800, bright: 400, color: "#ffcf82", alpha: 0.8, angle: 360, animation: null }, "flags.ais.pf1e-torch": { active: true } },
};
