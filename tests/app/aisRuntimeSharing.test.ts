// D-468: the GM runtime publishes the shared module set through the real host and session path.
/**
 * `tests/app/playerAisRuntime.test.ts` drives HostSync with a hand-written profile provider;
 * this file closes the loop on the GM side: a booted HostApp whose AisRuntime computes the
 * profile from the frozen boot set + live consent, pushes it to a joined player, strips it
 * when the GM un-shares or revokes, and never hands players appearance packages or
 * GM-device capabilities. The iframe is the only thing replaced (no DOM under vitest).
 */
import "fake-indexeddb/auto";
import { strToU8, zipSync } from "fflate";
import { describe, expect, test, vi } from "vitest";
import { bootHostApp, BUILTIN_SYSTEM_ID, BUILTIN_SYSTEM_VERSION, type HostApp } from "../../src/app/hostBoot";
import { AisRuntime } from "../../src/app/aisRuntime";
import { ClientSync, type ClientEvents } from "../../src/client/sync";
import { createEventBus } from "../../src/core/events";
import type { AisProfileMsg, HelloMsg } from "../../src/core/messages";
import { createTransportPair, flushMicrotasks } from "../../src/net/memory";
import { generateIdentity, helloPayload, signText } from "../../src/net/identity";
import { openVttDb } from "../../src/storage/idb";
import { MemDirHandle } from "../../src/storage/opfs";
import { HostPersister } from "../../src/storage/persistence";
import { InlineSimRunner } from "../../src/workers/simWorkerClient";
import type { AisModuleIframeOptions } from "../../src/packages/aisModuleIframe";
import type { AisPanelHost, AisPanelSpec } from "../../src/packages/aisPanel";
import { FakeCodec } from "./fakes";

/** Every frame the mocked iframe class created (D-476+ tests drive their real handlers directly). */
const created = vi.hoisted(() => ({ frames: [] as Array<{
  options: AisModuleIframeOptions;
  emit: ReturnType<typeof vi.fn>;
  invokeCommand: ReturnType<typeof vi.fn>;
}> }));
vi.mock("../../src/packages/aisModuleIframe", async (load) => {
  const original = await load<typeof import("../../src/packages/aisModuleIframe")>();
  return { ...original, AisModuleIframe: class {
    status = { state: "ready" };
    invokeCommand = vi.fn(async () => null);
    emit = vi.fn();
    diagnostics = vi.fn(() => ({ counters: { requests: 0, failures: 0, rejected: 0, commands: 0, commandFailures: 0, events: 0 }, trace: [], circuitOpenedAt: null }));
    dispose = vi.fn(() => this.options.onStatus?.({ state: "stopped", error: "test stop" }));
    constructor(readonly options: AisModuleIframeOptions) { created.frames.push(this as never); }
  } };
});

const zipOf = (files: Record<string, string>): Uint8Array =>
  zipSync(Object.fromEntries(Object.entries(files).map(([k, v]) => [k, strToU8(v)])));

const moduleZip = (id: string, capabilities: string[], extra: Record<string, unknown> = {}): Uint8Array => zipOf({
  "manifest.json": JSON.stringify({ id, name: `${id} name`, version: "1.0.0", type: "module",
    interconnect: { api: "arena.ais/1", entry: "automation/entry.js", capabilities,
      commands: [{ id: "poke", contract: 1 }], ...extra } }),
  "automation/entry.js": `AIS.commands.on("poke", () => "${id}");`,
});

let n = 0;
async function freshApp(): Promise<HostApp> {
  const db = await openVttDb();
  const worldId = `w-rt-share-${++n}` as HostApp["worldId"];
  await HostPersister.createWorld(db, { worldId, name: "Share", system: BUILTIN_SYSTEM_ID, systemVersion: BUILTIN_SYSTEM_VERSION });
  return bootHostApp({ db, root: new MemDirHandle(), codec: new FakeCodec(), simRunner: new InlineSimRunner(), worldId });
}
async function reboot(app: HostApp): Promise<HostApp> {
  const { db, worldId } = app;
  await app.persister.flush();
  await app.close();
  return bootHostApp({ db, root: new MemDirHandle(), worldId, codec: new FakeCodec(), simRunner: new InlineSimRunner() });
}
async function approve(app: HostApp, id: string, capabilities: string[]): Promise<void> {
  expect(await app.packages.enableAutomationModule(id)).toEqual({ ok: true });
  const preview = await app.packages.previewAutomationModule(id);
  if (!preview.ok) throw new Error(preview.error);
  expect(await app.packages.grantAutomationCapabilities(id, capabilities as never, preview.hash, preview.runtimeHash)).toEqual({ ok: true });
}
/** A real signed hello: the booted host verifies identities (D-007), unlike the bare HostSync harness. */
async function joinPlayer(app: HostApp, name: string) {
  const identity = await generateIdentity();
  const pair = createTransportPair();
  app.host.addSession(`peer-${name}`, pair.a);
  const bus = createEventBus<ClientEvents>();
  const profiles: AisProfileMsg[] = [];
  bus.on("aisProfile", (message) => profiles.push(message));
  const client = new ClientSync({ transport: pair.b, bus, meta: app.store.meta });
  app.host.bus.on("join:request", ({ approve: ok }) => ok());
  const ts = Date.now();
  const hello: HelloMsg = { kind: "hello", pubkey: identity.publicKeyHex, displayName: name, ts,
    sig: await signText(identity, helloPayload(app.worldId, name, ts)) };
  client.connect(hello);
  for (let i = 0; i < 20 && !client.user; i += 1) { await flushMicrotasks(); await new Promise((r) => setTimeout(r, 5)); }
  await flushMicrotasks();
  return { client, profiles };
}
const runtimeFor = (app: HostApp, extra: { panelHost?: AisPanelHost; notify?: (message: string) => void } = {}) => new AisRuntime({
  app, activeSceneId: () => null, select: async () => null, cancelChoice: vi.fn(), notify: extra.notify ?? vi.fn(), onStatus: vi.fn(),
  ...(extra.panelHost ? { panelHost: extra.panelHost } : {}),
});

/** D-470: the GM shell's panel slot, recorded instead of drawn. */
function fakePanelHost() {
  const log: string[] = [];
  const specs = new Map<string, AisPanelSpec>();
  const bodies = new Map<string, HTMLElement>();
  const open = new Set<string>();
  const host: AisPanelHost = {
    mount: (id, spec) => { log.push(`mount:${id}`); specs.set(id, spec); const body = { id } as unknown as HTMLElement; bodies.set(id, body); return body; },
    attach: (id) => { log.push(`attach:${id}`); },
    open: (id) => { if (!specs.has(id) || open.has(id)) return false; open.add(id); log.push(`open:${id}`); return true; },
    close: (id) => { if (!open.delete(id)) return false; log.push(`close:${id}`); return true; },
    remove: (id) => { if (specs.delete(id)) log.push(`remove:${id}`); open.delete(id); },
    isOpen: (id) => open.has(id),
    entries: () => Array.from(specs, ([packageId, spec]) => ({ packageId, title: spec.title, open: open.has(packageId) })),
    dispose: () => { for (const id of Array.from(specs.keys())) host.remove(id); },
  };
  return { host, log, specs, bodies };
}
/** Package mutations republish after an IndexedDB read — a few timer turns, not just microtasks. */
async function settle(): Promise<void> {
  for (let i = 0; i < 10; i += 1) { await flushMicrotasks(); await new Promise((r) => setTimeout(r, 5)); }
}

describe("AisRuntime → ais.profile", () => {
  test("approved modules reach a player with player-runnable capabilities; themes and GM-only grants do not", async () => {
    let app = await freshApp();
    expect((await app.packages.importZip(moduleZip("torch", ["action.observe", "scene.token.light.manage", "fx.play"],
      { provides: [{ id: "scene.token.light.action", mode: "exclusive", contract: 1 }] }))).ok).toBe(true);
    expect((await app.packages.importZip(moduleZip("theme", ["runtime.execute", "package.resources.read", "ui.theme"],
      { provides: [{ id: "ui.theme", mode: "exclusive", contract: 1 }] }))).ok).toBe(true);
    await approve(app, "torch", ["action.observe", "scene.token.light.manage", "fx.play"]);
    await approve(app, "theme", ["runtime.execute", "package.resources.read", "ui.theme"]);
    expect(await app.packages.selectAutomationProvider("scene.token.light.action", "torch/scene.token.light.action")).toEqual({ ok: true });
    app = await reboot(app);
    expect(app.automationBoot.modules.map((m) => m.packageId).sort()).toEqual(["theme", "torch"]);
    const runtime = runtimeFor(app);
    try {
      await settle();
      const rex = await joinPlayer(app, "rex");
      expect(rex.profiles).toHaveLength(1);
      expect(rex.profiles[0]?.modules.map((m) => m.packageId)).toEqual(["torch"]);
      expect(rex.profiles[0]?.modules[0]).toMatchObject({
        name: "torch name", version: "1.0.0", capabilities: ["action.observe", "scene.token.light.manage"],
        commands: [{ id: "poke", contract: 1 }], source: expect.stringContaining('AIS.commands.on("poke"'),
      });
      expect(rex.profiles[0]?.providers).toEqual({ "scene.token.light.action": "torch/scene.token.light.action" });
      expect(runtime.playerProfile.modules).toHaveLength(1);

      // The GM keeps the torch private: the player hears an empty set at once, no reload.
      expect(await app.packages.setAutomationSharing("torch", false)).toEqual({ ok: true });
      await settle();
      expect(rex.profiles.at(-1)?.modules).toEqual([]);
      expect(rex.profiles.at(-1)?.providers).toEqual({});
      expect(await app.packages.setAutomationSharing("torch", true)).toEqual({ ok: true });
      await settle();
      expect(rex.profiles.at(-1)?.modules.map((m) => m.packageId)).toEqual(["torch"]);

      // Revoking the GM-device consent removes the module from players as well as from the host.
      expect(await app.packages.revokeAutomationApproval("torch")).toEqual({ ok: true });
      await settle();
      expect(rex.profiles.at(-1)?.modules).toEqual([]);
      expect(rex.client.aisProfile?.modules).toEqual([]);
    } finally { runtime.dispose(); await app.close(); }
  });

  test("D-476/D-477/D-478/D-479: settings, compendium, module bus and diagnostics through a booted host", async () => {
    let app = await freshApp();
    const settings = [
      { key: "radius", scope: "world", type: "number", label: "Radius", default: 20, min: 0, max: 60, step: 5 },
      { key: "sound", scope: "device", type: "boolean", label: "Sound", default: true },
    ];
    expect((await app.packages.importZip(moduleZip("torch", ["action.observe", "module.settings.write", "modules.invoke", "compendium.read"],
      { settings, requires: [{ id: "lamp" }] }))).ok).toBe(true);
    expect((await app.packages.importZip(moduleZip("lamp", ["action.observe"]))).ok).toBe(true);
    expect((await app.packages.importZip(zipOf({
      "manifest.json": JSON.stringify({ id: "beasts", name: "Beasts", version: "1.0.0", type: "data",
        packs: [{ name: "Beasts", type: "actors", file: "packs/beasts.json" }] }),
      "packs/beasts.json": JSON.stringify({ name: "Beasts", type: "actors", entries: [
        { id: "wolf", name: "Wolf", keywords: ["animal"], data: { type: "actor", name: "Wolf", system: { cr: 1 } } },
        { id: "worg", name: "Worg", data: { type: "actor", name: "Worg", system: { cr: 2 } } },
      ] }),
    }))).ok).toBe(true);
    await approve(app, "lamp", ["action.observe"]); // a required module must be enabled first
    await approve(app, "torch", ["action.observe", "module.settings.write", "modules.invoke", "compendium.read"]);
    app = await reboot(app);
    created.frames.length = 0; // earlier tests in this file created frames of the same package ids
    const runtime = runtimeFor(app);
    try {
      await settle();
      // The packages view reads these off PackageSummary (previously only on the automation summary).
      expect((await app.packages.list()).find((entry) => entry.id === "torch")).toMatchObject({
        sharedWithPlayers: true, hostOnly: false, settings: [{ key: "radius", scope: "world" }, { key: "sound", scope: "device" }],
      });
      expect(app.automationBoot.modules.find((m) => m.packageId === "torch")).toMatchObject({ settings, requires: [{ id: "lamp" }] });
      const torch = created.frames.find((frame) => frame.options.packageId === "torch");
      const lamp = created.frames.find((frame) => frame.options.packageId === "lamp");
      if (!torch || !lamp) throw new Error("frames not created");

      // Defaults, then the GM's form writes world scope (a real commit) and device scope (local).
      expect((await runtime.moduleSettings("torch"))?.values).toEqual({ radius: 20, sound: true });
      expect(await runtime.moduleSettings("lamp")).toBeNull();
      await runtime.setModuleSetting("torch", "radius", 30);
      await settle();
      expect(app.store.get("settings", "ais-settings:torch")).toMatchObject({ ownership: { default: 1 }, flags: { ais: { values: { radius: 30 } } } });
      expect(torch.emit).toHaveBeenCalledWith("module.settings.changed", { scope: "world", key: "radius", value: 30 });
      expect(lamp.emit).not.toHaveBeenCalledWith("module.settings.changed", expect.anything());
      await runtime.setModuleSetting("torch", "sound", false);
      expect(torch.emit).toHaveBeenCalledWith("module.settings.changed", { scope: "device", key: "sound", value: false });
      expect((await runtime.moduleSettings("torch"))?.values).toEqual({ radius: 30, sound: false });
      await expect(runtime.setModuleSetting("torch", "radius", 7)).rejects.toThrow("steps of 5");

      // The module's own RPC path lands the same commit, with the live consent check in front of it.
      const handlers = torch.options.handlers;
      await expect(handlers["settings.set"]({ key: "radius", value: 45 })).resolves.toEqual({ key: "radius", scope: "world", value: 45 });
      await settle();
      expect(torch.emit).toHaveBeenCalledWith("module.settings.changed", { scope: "world", key: "radius", value: 45 });
      await expect(handlers["settings.get"]({ key: "radius" })).resolves.toEqual({ key: "radius", scope: "world", value: 45 });

      // Players receive the declarations with the shared module and the replicated document itself.
      const rex = await joinPlayer(app, "rex");
      expect(rex.profiles.at(-1)?.modules.find((m) => m.packageId === "torch")).toMatchObject({
        settings, requires: [{ id: "lamp" }], capabilities: ["action.observe", "module.settings.write", "modules.invoke"],
      });
      expect(rex.client.store.get("settings", "ais-settings:torch")).toMatchObject({ flags: { ais: { values: { radius: 45 } } } });

      // Compendium: the imported data package's pack, read-only, through the module's handlers.
      await expect(handlers["compendium.list"]({})).resolves.toEqual({ packs: [
        { id: "beasts/packs/beasts.json", name: "Beasts", type: "actors", packageId: "beasts", entries: 2 },
      ] });
      await expect(handlers["compendium.search"]({ query: "wor" })).resolves.toMatchObject({ hits: [{ entryId: "worg", name: "Worg" }] });
      await expect(handlers["compendium.get"]({ packId: "beasts/packs/beasts.json", entryId: "wolf" })).resolves.toMatchObject({
        id: "wolf", keywords: ["animal"], data: { type: "actor", name: "Wolf", system: { cr: 1 } },
      });
      await expect(lamp.options.handlers["compendium.list"]({})).rejects.toThrow("compendium.read is not currently approved for lamp");

      // Module bus: torch declared lamp → it may invoke lamp's command with GM authority.
      lamp.invokeCommand.mockResolvedValue("lamp says hi");
      await expect(handlers["modules.list"]({})).resolves.toEqual({ modules: [
        { packageId: "lamp", name: "lamp name", version: "1.0.0", running: true, commands: [{ id: "poke", contract: 1 }], provides: [], emits: [] },
      ] });
      await expect(handlers["modules.invoke"]({ moduleId: "lamp", commandId: "poke", input: { x: 1 } })).resolves.toEqual({ result: "lamp says hi" });
      expect(lamp.invokeCommand).toHaveBeenCalledWith("poke", { x: 1 }, expect.objectContaining({ runAs: "gm", requestId: "ais-module:torch:1" }));
      await expect(lamp.options.handlers["modules.invoke"]({ moduleId: "torch", commandId: "poke" })).rejects.toThrow("modules.invoke is not currently approved for lamp");

      // Diagnostics come from the frame; restart re-creates it from the frozen boot definition.
      expect(runtime.diagnostics("torch")).toMatchObject({ counters: { requests: 0 }, circuitOpenedAt: null });
      expect(runtime.diagnostics("nobody")).toBeNull();
      expect(runtime.restart("torch")).toBe(true);
      expect(runtime.restart("nobody")).toBe(false);
      expect(created.frames.filter((frame) => frame.options.packageId === "torch")).toHaveLength(2);
      expect((await runtime.moduleSettings("torch"))?.values).toEqual({ radius: 45, sound: false });
    } finally { runtime.dispose(); await app.close(); }
  });

  test("disposing the runtime stops publication; a later joiner receives nothing", async () => {
    let app = await freshApp();
    expect((await app.packages.importZip(moduleZip("torch", ["action.observe"]))).ok).toBe(true);
    await approve(app, "torch", ["action.observe"]);
    app = await reboot(app);
    const runtime = runtimeFor(app);
    await settle();
    try {
      runtime.dispose();
      const late = await joinPlayer(app, "late");
      expect(late.profiles).toEqual([]);
      expect(late.client.aisProfile).toBeNull();
    } finally { await app.close(); }
  });
});

describe("D-470 — GM-side sandboxed panels", () => {
  test("a module with interconnect.panel is born inside its host-chromed window; the shell opens it, revocation removes it", async () => {
    let app = await freshApp();
    expect((await app.packages.importZip(moduleZip("kit", ["action.observe", "ui.panel"],
      { panel: { title: "Kit", width: 300, height: 200 } }))).ok).toBe(true);
    expect((await app.packages.importZip(moduleZip("plain", ["action.observe"]))).ok).toBe(true);
    await approve(app, "kit", ["action.observe", "ui.panel"]);
    await approve(app, "plain", ["action.observe"]);
    app = await reboot(app);
    expect(app.automationBoot.modules.find((m) => m.packageId === "kit")?.panel).toEqual({ title: "Kit", width: 300, height: 200 });
    expect((await app.packages.automation()).modules.find((m) => m.id === "kit")?.panel).toEqual({ title: "Kit", width: 300, height: 200 });
    const panels = fakePanelHost();
    const notices: string[] = [];
    const runtime = runtimeFor(app, { panelHost: panels.host, notify: (message) => notices.push(message) });
    try {
      await settle();
      expect(panels.log).toEqual(["mount:kit", "attach:kit"]);
      expect(panels.specs.get("kit")).toMatchObject({ title: "Kit", moduleName: "kit name", width: 300, height: 200 });
      expect(runtime.panelEntries()).toEqual([{ packageId: "kit", title: "Kit", open: false }]);
      expect(runtime.openPanel("kit")).toBe(true);
      expect(runtime.openPanel("plain")).toBe(false); // no panel declared
      expect(runtime.closePanel("kit")).toBe(true);
      // The module's own RPC path reaches the same slot.
      const rex = await joinPlayer(app, "rex");
      expect(rex.profiles.at(-1)?.modules.find((m) => m.packageId === "kit")?.panel).toEqual({ title: "Kit", width: 300, height: 200 });
      expect(await app.packages.revokeAutomationApproval("kit")).toEqual({ ok: true });
      await settle();
      expect(panels.log.at(-1)).toBe("remove:kit");
      expect(runtime.panelEntries()).toEqual([]);
    } finally { runtime.dispose(); await app.close(); }
  });
});
