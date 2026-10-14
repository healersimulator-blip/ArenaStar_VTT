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

vi.mock("../../src/packages/aisModuleIframe", async (load) => {
  const original = await load<typeof import("../../src/packages/aisModuleIframe")>();
  return { ...original, AisModuleIframe: class {
    status = { state: "ready" };
    invokeCommand = vi.fn(async () => null);
    dispose = vi.fn(() => this.options.onStatus?.({ state: "stopped", error: "test stop" }));
    constructor(readonly options: AisModuleIframeOptions) {}
    emit() {}
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
