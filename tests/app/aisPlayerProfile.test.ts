// D-468: the GM-side sharing policy behind `ais.profile`, as a pure builder.
import "fake-indexeddb/auto";
import { strToU8, zipSync } from "fflate";
import { describe, expect, test } from "vitest";
import {
  buildAisPlayerProfile,
  GM_DEVICE_ONLY_CAPABILITIES,
  playerRunnableCapabilities,
  sharedModuleOf,
} from "../../src/app/aisPlayerProfile";
import { AIS_CAPABILITIES } from "../../src/core/automationInterconnect";
import {
  bootHostApp,
  BUILTIN_SYSTEM_ID,
  BUILTIN_SYSTEM_VERSION,
  type HostApp,
  type HostAutomationModuleBoot,
} from "../../src/app/hostBoot";
import { getWorld, openVttDb } from "../../src/storage/idb";
import { MemDirHandle } from "../../src/storage/opfs";
import { HostPersister } from "../../src/storage/persistence";
import { InlineSimRunner } from "../../src/workers/simWorkerClient";
import { FakeCodec } from "./fakes";

const bootModule = (over: Partial<HostAutomationModuleBoot> = {}): HostAutomationModuleBoot => ({
  packageId: "pf1e-torch", name: "Torch", version: "1.0.0", hash: "h1", sharedWithPlayers: true,
  source: "AIS.commands.on('x', () => null);", resources: { "data/sources.json": "[]" },
  capabilities: ["action.observe", "scene.token.light.manage", "fx.play", "scene.tags.write"],
  commands: [{ id: "x", contract: 1 }], emittedEvents: ["lit"],
  ...over,
});

const providers = (selected: string | null) => [{
  slotId: "scene.token.light.action", contract: 1, mode: "exclusive" as const,
  selected, candidates: selected ? [selected] : [],
}] as unknown as Parameters<typeof buildAisPlayerProfile>[0]["providers"];

describe("buildAisPlayerProfile — what the GM shares", () => {
  test("an approved, consented module travels with player-runnable capabilities only", () => {
    const body = buildAisPlayerProfile({ modules: [bootModule()], providers: providers("pf1e-torch/light"), assertConsent: () => {} });
    expect(body.modules).toHaveLength(1);
    expect(body.modules[0]).toEqual({
      packageId: "pf1e-torch", name: "Torch", version: "1.0.0", hash: "h1",
      source: "AIS.commands.on('x', () => null);", resources: { "data/sources.json": "[]" },
      commands: [{ id: "x", contract: 1 }], capabilities: ["action.observe", "scene.token.light.manage"], emittedEvents: ["lit"],
    });
    expect(body.providers).toEqual({ "scene.token.light.action": "pf1e-torch/light" });
  });

  test("appearance, runtime providers, blocked modules, lapsed consent and the GM opt-out never travel", () => {
    const modules = [
      bootModule({ packageId: "theme", appearance: true }),
      bootModule({ packageId: "adapter", runtimeProvider: true }),
      bootModule({ packageId: "blocked", blockedReason: "Enable the provider" }),
      bootModule({ packageId: "revoked" }),
      bootModule({ packageId: "private", sharedWithPlayers: false }),
      // D-469: the author's own declaration wins even when the GM never unticked the box.
      bootModule({ packageId: "author-host-only", sharedWithPlayers: true, hostOnly: true }),
      bootModule({ packageId: "ok", tokenActions: [{ id: "mount", label: "Mount up" }] }),
    ];
    const body = buildAisPlayerProfile({
      modules, providers: providers("private/light"),
      assertConsent: (module) => { if (module.packageId === "revoked") throw new Error("not approved"); },
    });
    expect(body.modules.map((m) => m.packageId)).toEqual(["ok"]);
    expect(body.modules[0]?.tokenActions).toEqual([{ id: "mount", label: "Mount up" }]);
    // A selection whose provider does not travel is dropped: a player cannot act on it.
    expect(body.providers).toEqual({});
  });

  test("an adapter-composed module is restricted to capabilities its runtime dependency also holds", () => {
    const module = bootModule({
      runtimeHash: "rt1", runtimeContext: { profile: "foundry" },
      runtimeDependencies: [{ packageId: "ais-foundry-v13", version: "1.0.0", hash: "d1", capabilities: ["action.observe", "runtime.execute"] }],
      capabilities: ["action.observe", "scene.token.light.manage", "runtime.execute"],
    });
    expect(sharedModuleOf(module)).toMatchObject({ runtimeHash: "rt1", runtimeContext: { profile: "foundry" }, capabilities: ["action.observe", "runtime.execute"] });
  });

  test("the GM-device-only set is exactly FX, scene-tag writes and themes", () => {
    expect([...GM_DEVICE_ONLY_CAPABILITIES].sort()).toEqual(["fx.play", "scene.tags.write", "ui.theme"]);
    expect(playerRunnableCapabilities([...AIS_CAPABILITIES])).toEqual(
      AIS_CAPABILITIES.filter((capability) => !GM_DEVICE_ONLY_CAPABILITIES.has(capability)),
    );
  });
});

const zipOf = (files: Record<string, string>): Uint8Array =>
  zipSync(Object.fromEntries(Object.entries(files).map(([k, v]) => [k, strToU8(v)])));

let n = 0;
async function freshApp(): Promise<HostApp> {
  const db = await openVttDb();
  const worldId = `w-share-${++n}` as HostApp["worldId"];
  await HostPersister.createWorld(db, { worldId, name: "Share", system: BUILTIN_SYSTEM_ID, systemVersion: BUILTIN_SYSTEM_VERSION });
  return bootHostApp({ db, root: new MemDirHandle(), codec: new FakeCodec(), simRunner: new InlineSimRunner(), worldId });
}

describe("HostPackages.setAutomationSharing — the GM's per-module opt-out", () => {
  test("shared by default; false persists, survives reboot, and true clears the record", async () => {
    const app = await freshApp();
    expect((await app.packages.importZip(zipOf({
      "manifest.json": JSON.stringify({ id: "observe-mod", name: "Observe", version: "1.0.0", type: "module",
        interconnect: { api: "arena.ais/1", entry: "automation/entry.js", capabilities: ["action.observe"] } }),
      "automation/entry.js": "AIS.events.on('turn.phase.changed', () => {});",
    }))).ok).toBe(true);
    expect(await app.packages.enableAutomationModule("observe-mod")).toEqual({ ok: true });
    expect(await app.packages.grantAutomationCapabilities("observe-mod", ["action.observe"])).toEqual({ ok: true });
    expect((await app.packages.automation()).modules[0]).toMatchObject({ approved: true, sharedWithPlayers: true });

    let changes = 0;
    const off = app.packages.onAutomationChanged(() => { changes += 1; });
    expect(await app.packages.setAutomationSharing("observe-mod", false)).toEqual({ ok: true });
    expect(changes).toBe(1); // the runtime republishes ais.profile from this hook
    off();
    expect((await app.packages.automation()).modules[0]?.sharedWithPlayers).toBe(false);
    await app.persister.flush();
    expect((await getWorld(app.db, app.worldId))?.automationSharing).toEqual({ "observe-mod": false });
    await app.close();

    const second = await bootHostApp({ db: await openVttDb(), root: new MemDirHandle(), codec: new FakeCodec(), simRunner: new InlineSimRunner(), worldId: app.worldId });
    expect(second.automationBoot.modules[0]).toMatchObject({ packageId: "observe-mod", name: "Observe", sharedWithPlayers: false });
    expect(await second.packages.setAutomationSharing("observe-mod", true)).toEqual({ ok: true });
    await second.persister.flush();
    expect((await getWorld(second.db, second.worldId))?.automationSharing).toBeUndefined();
    await second.close();
  });

  test("D-469: a manifest with sharing: host-only boots as hostOnly and is never shared, whatever the record says", async () => {
    const app = await freshApp();
    expect((await app.packages.importZip(zipOf({
      "manifest.json": JSON.stringify({ id: "gm-only-mod", name: "GM only", version: "1.0.0", type: "module",
        interconnect: { api: "arena.ais/1", entry: "automation/entry.js", capabilities: ["action.observe", "ui.interaction"],
          sharing: "host-only", tokenActions: [{ id: "ping", label: "Ping" }] } }),
      "automation/entry.js": "AIS.events.on('turn.phase.changed', () => {});",
    }))).ok).toBe(true);
    expect(await app.packages.enableAutomationModule("gm-only-mod")).toEqual({ ok: true });
    expect(await app.packages.grantAutomationCapabilities("gm-only-mod", ["action.observe", "ui.interaction"])).toEqual({ ok: true });
    expect((await app.packages.automation()).modules[0]).toMatchObject({ approved: true, hostOnly: true, sharedWithPlayers: false });
    const module = (await app.packages.runtimePlan()).modules.find((m) => m.packageId === "gm-only-mod");
    expect(module).toMatchObject({ hostOnly: true, sharedWithPlayers: false, tokenActions: [{ id: "ping", label: "Ping" }] });
    await app.close();
  });
});
