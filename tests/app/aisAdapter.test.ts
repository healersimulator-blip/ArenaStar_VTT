import "fake-indexeddb/auto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { bootHostApp, type HostApp } from "../../src/app/hostBoot";
import { AisRuntime, assertAisModuleConsent } from "../../src/app/aisRuntime";
import { importWorldZip, exportWorldZip } from "../../src/host/worldFile";
import { openVttDb, listPackages, getWorld } from "../../src/storage/idb";
import { MemDirHandle } from "../../src/storage/opfs";
import { InlineSimRunner } from "../../src/workers/simWorkerClient";
import { FakeCodec } from "./fakes";
import { readZipPackage } from "../../src/packages/packageLoader";
import { validatePackageManifest } from "../../src/core/packageManifest";
import { aisOwnSource, aisRuntimeConfiguration, aisRuntimePackage } from "../../src/packages/aisRuntimePackage";
import { aisTagSnapshot, aisTagProposal, parseAisTagUpdate } from "../../src/core/aisScene";
import { packageContentHash } from "../../src/packages/packageHash";
import type { AisModuleIframeOptions } from "../../src/packages/aisModuleIframe";
import type { AisCapability } from "../../src/core/automationInterconnect";

// Only these host-composition tests replace the DOM shell. Browser tests separately run the
// actual iframe, SDK, adapter and upstream code; no world or RPC handler is mocked here.
const captured = vi.hoisted(() => new Map<string, { options: AisModuleIframeOptions;
  invokeCommand: ReturnType<typeof vi.fn>; dispose: ReturnType<typeof vi.fn> }>());
vi.mock("../../src/packages/aisModuleIframe", async (load) => {
  const original = await load<typeof import("../../src/packages/aisModuleIframe")>();
  return { ...original, AisModuleIframe: class {
    status = { state: "ready" };
    invokeCommand = vi.fn(async () => null);
    dispose = vi.fn(() => this.options.onStatus?.({ state: "stopped", error: "test stop" }));
    constructor(readonly options: AisModuleIframeOptions) { captured.set(options.packageId, this); }
    emit() {}
  } };
});

const stage = mkdtempSync(join(tmpdir(), "ais-adapter-tests-"));
const caps: AisCapability[] = ["runtime.execute", "scene.tags.read", "scene.tags.write", "fx.play"];
let archive: Uint8Array;
let providerZip: Uint8Array;
let guestZip: Uint8Array;
beforeAll(() => {
  execFileSync(process.execPath, ["scripts/buildAisDemo.mjs", "--out", stage], { timeout: 60_000, stdio: "pipe" });
  archive = new Uint8Array(readFileSync(join(stage, "worlds/ais-foundry-feasibility-0.1.0.zip")));
  providerZip = new Uint8Array(readFileSync(join(stage, "packages/ais-foundry-v13-0.4.0.zip")));
  guestZip = new Uint8Array(readFileSync(join(stage, "packages/foundry-tagger-0.1.0.zip")));
}, 65_000);
afterAll(() => rmSync(stage, { recursive: true, force: true }));

const required = <T>(value: T | undefined | null): T => {
  if (value == null) throw new Error("Missing fixture");
  return value;
};
async function fresh() {
  const db = await openVttDb();
  const root = new MemDirHandle();
  const imported = await importWorldZip({ db, file: archive, root, mode: "copy" });
  const app = await bootHostApp({ db, root, worldId: imported.worldId,
    codec: new FakeCodec(), simRunner: new InlineSimRunner() });
  return { app, root, db };
}
async function grant(app: HostApp, id: string, capabilities = caps) {
  const preview = await app.packages.previewAutomationModule(id);
  if (!preview.ok) throw new Error(preview.error);
  expect(await app.packages.grantAutomationCapabilities(id, capabilities, preview.hash, preview.runtimeHash)).toEqual({ ok: true });
  return preview;
}
async function reboot(app: HostApp, root: MemDirHandle) {
  const { db, worldId } = app;
  await app.close();
  return bootHostApp({ db, root, worldId, codec: new FakeCodec(), simRunner: new InlineSimRunner() });
}

function modifiedZip(bytes: Uint8Array, edit: (files: Record<string, Uint8Array>) => void) {
  const files = unzipSync(bytes); edit(files); return zipSync(files);
}

describe("adapter package contracts and provenance", () => {
  test("the prepared source is closed, source-preserving and hash-pinned; no code executes on import", async () => {
    const loaded = await readZipPackage(guestZip);
    if (!loaded.ok) throw new Error(loaded.error);
    expect(loaded.value.manifest.interconnect?.runtime).toMatchObject({ provider: "ais-foundry-v13" });
    expect(loaded.value.files["prepared/tagger.js"]).toContain("Tagger | ${inFunctionName}");
    expect(loaded.value.files["upstream/scripts/module.js"]).toContain("export default class Tagger");
    expect(aisOwnSource({ ...loaded.value, id: "foundry-tagger", version: "0.1.0" }))
      .toContain("AIS.commands.on");
    expect(aisRuntimeConfiguration({ ...loaded.value, id: "foundry-tagger", version: "0.1.0" }))
      .toMatchObject({ sourceCommit: "e7936bc9ee01e4445624fbc82a11e887e5cd0075" });
  });

  test.each([
    { provider: "../escape" },
    { scripts: ["../escape.js"] },
    { scripts: ["prepared/tagger.js", "prepared/tagger.js"] },
    { scripts: ["automation/commands.js"] },
    { configuration: "https://example.test/config.json" },
    { contract: 99 },
  ])("runtime binding rejects malformed/unknown fields %j", (patch) => {
    const files = unzipSync(guestZip);
    const manifest = JSON.parse(strFromU8(required(files["manifest.json"])));
    Object.assign(manifest.interconnect.runtime, patch);
    expect(validatePackageManifest(manifest).ok).toBe(false);
  });

  test("runtime provider requires an explicit nonoptional exact-version dependency", () => {
    const manifest = JSON.parse(strFromU8(required(unzipSync(guestZip)["manifest.json"])));
    manifest.interconnect.requires = [{ id: "ais-foundry-v13", optional: true }];
    expect(validatePackageManifest(manifest)).toMatchObject({ ok: false, error: expect.stringContaining("exact-version") });
  });

  test.each(["prepared/tagger.js", "compatibility.json"])("required file %s is validated without execution", async (path) => {
    const bytes = modifiedZip(guestZip, (files) => { Reflect.deleteProperty(files, path); });
    expect((await readZipPackage(bytes)).ok).toBe(false);
  });

  test("runtime marker is mandatory, including for guests using only otherwise-legacy capabilities", () => {
    const manifest = JSON.parse(strFromU8(required(unzipSync(guestZip)["manifest.json"])));
    manifest.interconnect.capabilities = ["ui.notify"];
    expect(validatePackageManifest(manifest)).toMatchObject({ ok: false, error: expect.stringContaining("runtime.execute") });
  });

  test("providers cannot advertise standalone entry points which never run", () => {
    const manifest = JSON.parse(strFromU8(required(unzipSync(providerZip)["manifest.json"])));
    manifest.interconnect.commands = [{ id: "phantom", contract: 1 }];
    expect(validatePackageManifest(manifest)).toMatchObject({ ok: false, error: expect.stringContaining("standalone") });
  });

  test("executable path labels cannot inject code into source assembly", async () => {
    const loaded = await readZipPackage(providerZip);
    if (!loaded.ok) throw new Error(loaded.error);
    const path = "runtime/new\nthrow new Error('injected');\n.js";
    const pkg = { ...loaded.value, id: "path-test", version: "0.1.0",
      manifest: { ...loaded.value.manifest, interconnect: { ...required(loaded.value.manifest.interconnect), entry: path } },
      files: { ...loaded.value.files, [path]: "globalThis.safe = true;" } };
    expect(aisOwnSource(pkg).split("\n").filter((line) => line.startsWith("throw"))).toEqual([]);
  });

  test("D-483: a provider's layered scripts are validated and evaluated before its entry", async () => {
    const loaded = await readZipPackage(providerZip);
    if (!loaded.ok) throw new Error(loaded.error);
    const provider = required(loaded.value.manifest.interconnect?.runtimeProvider);
    expect(provider.scripts).toEqual(["runtime/hbs.js", "runtime/jq.js", "runtime/core.js", "runtime/fields.js", "runtime/ui.js"]);
    const source = aisOwnSource({ ...loaded.value, id: "ais-foundry-v13", version: "0.4.0" });
    const offsets = ["runtime/hbs.js", "runtime/jq.js", "runtime/core.js", "runtime/fields.js", "runtime/ui.js", "runtime/adapter.js"].map((path) => source.indexOf(`// AIS package ais-foundry-v13: "${path}"`));
    expect(offsets.every((offset, i) => offset >= 0 && (i === 0 || offset > required(offsets[i - 1])))).toBe(true);
    const raw = JSON.parse(strFromU8(required(unzipSync(providerZip)["manifest.json"]))) as { interconnect: { runtimeProvider: Record<string, unknown>; entry: string } };
    for (const scripts of [[], ["../x.js"], ["runtime/adapter.js"], ["runtime/ui.js", "runtime/ui.js"], Array.from({ length: 17 }, (_, i) => `runtime/${i}.js`)]) {
      const manifest = structuredClone(raw);
      manifest.interconnect.runtimeProvider = { ...manifest.interconnect.runtimeProvider, scripts };
      expect(validatePackageManifest(manifest)).toMatchObject({ ok: false, error: expect.stringContaining("invalid runtimeProvider scripts") });
    }
    const missing = { ...loaded.value, id: "ais-foundry-v13", version: "0.4.0", files: { ...loaded.value.files } };
    Reflect.deleteProperty(missing.files, "runtime/jq.js");
    expect(() => aisOwnSource(missing)).toThrow("runtime/jq.js is missing or empty");
  });

  test("adapter and guest cannot be declared by the same package", () => {
    const manifest = JSON.parse(strFromU8(required(unzipSync(guestZip)["manifest.json"])));
    manifest.interconnect.runtimeProvider = { contract: 1, profiles: ["foundry-v13-scene-tags-fx"] };
    expect(validatePackageManifest(manifest).ok).toBe(false);
  });
});

describe("runtime identity, joint consent and world portability", () => {
  test("imported world carries both enabled packages, no approval and no booted code", async () => {
    const { app } = await fresh();
    try {
      expect(app.automationBoot.modules).toEqual([]);
      const state = await app.packages.automation();
      expect(state.modules).toHaveLength(2);
      expect(state.modules.every((module) => module.enabled && !module.approved)).toBe(true);
      expect(state.modules.find((module) => module.id === "foundry-tagger")?.runtimeHash).toMatch(/^[a-f0-9]{64}$/);
      expect((await getWorld(app.db, app.worldId))?.automationGrants).toBeUndefined();
    } finally { await app.close(); }
  });

  test("a separately approved guest stays blocked while its adapter has no approval", async () => {
    const { app, root } = await fresh();
    await grant(app, "foundry-tagger");
    const restarted = await reboot(app, root);
    try {
      const guest = required(restarted.automationBoot.modules.find((module) => module.packageId === "foundry-tagger"));
      expect(guest.blockedReason).toContain("locally approve runtime provider");
      expect(() => assertAisModuleConsent(undefined, guest)).toThrow("approval");
      const world = await getWorld(restarted.db, restarted.worldId);
      expect(() => assertAisModuleConsent(world, guest)).toThrow("ais-foundry-v13");
    } finally { await restarted.close(); }
  });

  test("the effective authority is the intersection of adapter and guest grants", async () => {
    const { app, root } = await fresh();
    await grant(app, "ais-foundry-v13", ["runtime.execute", "scene.tags.read"]);
    await grant(app, "foundry-tagger");
    const restarted = await reboot(app, root);
    try {
      const guest = required(restarted.automationBoot.modules.find((module) => module.packageId === "foundry-tagger"));
      const provider = required(restarted.automationBoot.modules.find((module) => module.packageId === "ais-foundry-v13"));
      expect(provider.runtimeProvider).toBe(true);
      expect(guest.source.indexOf("globalThis.FoundryAdapter")).toBeLessThan(guest.source.indexOf("class Tagger"));
      const world = await getWorld(restarted.db, restarted.worldId);
      expect(() => assertAisModuleConsent(world, guest, "scene.tags.read")).not.toThrow();
      expect(() => assertAisModuleConsent(world, guest, "scene.tags.write")).toThrow("ais-foundry-v13");
      await restarted.packages.revokeAutomationApproval("ais-foundry-v13");
      expect(() => assertAisModuleConsent(world, guest, "scene.tags.read")).not.toThrow(); // frozen prior snapshot is not authority
      expect(() => assertAisModuleConsent(undefined, guest)).toThrow();
      const current = await getWorld(restarted.db, restarted.worldId);
      expect(() => assertAisModuleConsent(current, guest, "scene.tags.read")).toThrow("ais-foundry-v13");
    } finally { await restarted.close(); }
  });

  test("changing adapter bytes invalidates guest consent, even with unchanged guest/version", async () => {
    const { app } = await fresh();
    try {
      await grant(app, "ais-foundry-v13");
      const old = await grant(app, "foundry-tagger");
      expect(old.runtimeHash).toBeTruthy();
      const changed = modifiedZip(providerZip, (files) => {
        files["runtime/adapter.js"] = strToU8(strFromU8(required(files["runtime/adapter.js"])) + "\n// changed adapter implementation\n");
      });
      expect((await app.packages.importZip(changed)).ok).toBe(true);
      const guest = required((await app.packages.automation()).modules.find((module) => module.id === "foundry-tagger"));
      expect(guest.hash).toBe(old.hash);
      expect(guest.approved).toBe(false);
      expect(guest.runtimeHash).not.toBe(old.runtimeHash);
      expect(await app.packages.grantAutomationCapabilities("foundry-tagger", caps, old.hash, old.runtimeHash))
        .toMatchObject({ ok: false, error: expect.stringContaining("composition changed") });
      const current = await app.packages.previewAutomationModule("foundry-tagger");
      if (!current.ok) throw new Error(current.error);
      expect(await app.packages.grantAutomationCapabilities("foundry-tagger", caps, current.hash, current.runtimeHash)).toEqual({ ok: true });
    } finally { await app.close(); }
  });

  test("format 5 round trips code and hashes, but copy import never transfers consent", async () => {
    const { app, root } = await fresh();
    try {
      await grant(app, "ais-foundry-v13"); await grant(app, "foundry-tagger");
      const exported = await exportWorldZip({ db: app.db, worldId: app.worldId, root, persister: app.persister });
      const files = unzipSync(new Uint8Array(await exported.arrayBuffer()));
      const meta = JSON.parse(strFromU8(required(files["world.json"])));
      expect(meta.format).toBe(5);
      expect(meta.requiredFeatures).toContain("arena.ais.runtime/1");
      expect(JSON.stringify(meta)).not.toContain("automationGrants");
      const copy = await importWorldZip({ db: app.db, root, file: exported, mode: "copy" });
      const records = await listPackages(app.db, copy.worldId);
      expect(records.map((pkg) => ({ id: pkg.id, hash: packageContentHash(pkg.files) })))
        .toEqual(meta.automation.modules.map((lock: { id: string; hash: string }) => ({ id: lock.id, hash: lock.hash })));
      const guest = required(records.find((pkg) => pkg.id === "foundry-tagger"));
      expect(aisRuntimePackage(guest, records)?.hash).toBe((await app.packages.automation()).modules.find((module) => module.id === guest.id)?.runtimeHash);
      expect((await getWorld(app.db, copy.worldId))?.automationGrants).toBeUndefined();
    } finally { await app.close(); }
  });

  test.each([4, 5])("runtime archive cannot downgrade or omit its feature marker (format %s)", async (format) => {
    const broken = modifiedZip(archive, (files) => {
      const meta = JSON.parse(strFromU8(required(files["world.json"])));
      meta.format = format; meta.requiredFeatures = meta.requiredFeatures.filter((feature: string) => feature !== "arena.ais.runtime/1");
      files["world.json"] = strToU8(JSON.stringify(meta));
    });
    const db = await openVttDb();
    try { await expect(importWorldZip({ db, file: broken, root: new MemDirHandle(), mode: "copy" })).rejects.toThrow(/format 5|unsupported format/); }
    finally { db.close(); }
  });
});

describe("host-validated scene proposals and reused native FX", () => {
  test("projected reads omit hidden data; stale snapshots/hidden targets/extra fields cannot commit", async () => {
    const { app } = await fresh();
    try {
      const scene = required(app.store.get("scenes", "scene-1"));
      const view = aisTagSnapshot(scene, app.store.seq);
      expect(view.collections.tokens.map((doc) => doc.id)).toEqual(["beacon-one", "beacon-two"]);
      expect(JSON.stringify(view)).not.toContain("secret");
      const request = { sceneId: scene._id, collection: "tokens", id: "beacon-one", expectedSeq: app.store.seq, tags: ["committed"] };
      const receipt = app.host.applyAisSceneTags(request);
      expect(receipt.seq).toBe(request.expectedSeq + 1);
      expect(app.store.get("scenes", scene._id)?.tokens[0]?.taggerTags).toEqual(["committed"]);
      expect(() => app.host.applyAisSceneTags(request)).toThrow("stale");
      expect(() => app.host.applyAisSceneTags({ ...request, expectedSeq: app.store.seq, id: "hidden-beacon" })).toThrow("not visible");
      expect(() => parseAisTagUpdate({ ...request, role: "GM" })).toThrow("Invalid");
      expect(() => parseAisTagUpdate({ ...request, tags: ["dup", "dup"] })).toThrow("unique");
      expect(() => aisTagProposal(scene, 9999, parseAisTagUpdate(request))).toThrow("stale");
    } finally { await app.close(); }
  });

  test("AIS transient FX uses native validation/scheduling, creates no macro or persistent document", async () => {
    const { app } = await fresh();
    try {
      const sequence = { version: 1, audience: "scene", persistent: false,
        sections: [{ id: "test", kind: "text", at: { kind: "source" }, startMs: 0, durationMs: 500, text: "Native", color: "#ffffff" }] };
      const before = app.store.seq;
      const run = app.host.playAisFx("scene-1", { sequence, sourceTokenId: "beacon-one" });
      expect(run.endsAtHostTime - run.atHostTime).toBe(500);
      expect(app.store.getAll("macros")).toHaveLength(0);
      expect(app.store.getAll("fxInstances")).toHaveLength(0);
      expect(app.store.seq).toBe(before);
      expect(app.host.stopAisFx(run.runId)).toBe(true);
      expect(app.host.stopAisFx(run.runId)).toBe(false);
      expect(() => app.host.playAisFx("scene-1", { sequence: { ...sequence, persistent: true } })).toThrow("transient");
      expect(() => app.host.playAisFx("scene-1", { sequence, sourceTokenId: "hidden-beacon" })).toThrow("visible anchor");
      expect(() => app.host.playAisFx("scene-1", { sequence, runAs: "gm" })).toThrow("Invalid");
      expect(() => app.host.playAisFx("scene-1", { sequence: { ...sequence, sections: [{ ...sequence.sections[0], durationMs: -1 }] } })).toThrow();
    } finally { await app.close(); }
  });
});


describe("runtime broker boundaries", () => {
  test("player elevation cannot enter the GM-local adapter profile; one island cannot stop another's FX", async () => {
    captured.clear();
    const { app, root } = await fresh();
    await app.packages.importZip(modifiedZip(guestZip, (files) => {
      const manifest = JSON.parse(strFromU8(required(files["manifest.json"])));
      manifest.id = "other-guest";
      files["manifest.json"] = strToU8(JSON.stringify(manifest));
    }));
    expect(await app.packages.enableAutomationModule("other-guest")).toEqual({ ok: true });
    await grant(app, "ais-foundry-v13"); await grant(app, "foundry-tagger"); await grant(app, "other-guest");
    const restarted = await reboot(app, root);
    const registered = vi.spyOn(restarted.host, "setAisMacroModuleInvoker");
    const stopped = vi.spyOn(restarted.host, "stopAisFx");
    const runtime = new AisRuntime({ app: restarted, activeSceneId: () => "scene-1", select: async () => null,
      cancelChoice: vi.fn(), notify: vi.fn(), onStatus: vi.fn() });
    try {
      expect(captured.has("ais-foundry-v13")).toBe(false);
      const invoke = required(registered.mock.calls[0]?.[0]);
      const request = { moduleId: "foundry-tagger", commandId: "info", input: {}, sceneId: "scene-1",
        requestId: "test", runAs: "gm" as const, isActive: () => true };
      await expect(invoke({ ...request, callerId: "player" })).rejects.toThrow("local GM");
      const first = required(captured.get("foundry-tagger"));
      const second = required(captured.get("other-guest"));
      expect(first.invokeCommand).not.toHaveBeenCalled();
      await expect(invoke({ ...request, callerId: "gm" })).resolves.toBeNull();
      expect(first.invokeCommand).toHaveBeenCalledTimes(1);
      const run = await first.options.handlers["fx.play"]({ sequence: { version: 1, audience: "scene", persistent: false,
        sections: [{ id: "active", kind: "text", text: "owned", color: "#ffffff", at: { kind: "point", x: 250, y: 250 }, startMs: 0, durationMs: 5000 }] } }) as { runId: string };
      expect(await second.options.handlers["fx.stop"]({ runId: run.runId })).toEqual({ stopped: false });
      expect(await first.options.handlers["fx.list"]({})).toHaveLength(1);
      await restarted.packages.revokeAutomationApproval("ais-foundry-v13");
      expect(first.dispose).toHaveBeenCalled();
      expect(second.dispose).toHaveBeenCalled();
      expect(stopped).toHaveBeenCalledWith(run.runId);
      await expect(first.options.handlers["scene.tags.snapshot"]({})).rejects.toThrow("approval");
    } finally { runtime.dispose(); await restarted.close(); }
  });
});
