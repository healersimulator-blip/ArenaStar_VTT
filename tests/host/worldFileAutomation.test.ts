import "fake-indexeddb/auto";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { describe, expect, test } from "vitest";
import { bootHostApp, BUILTIN_SYSTEM_ID, BUILTIN_SYSTEM_VERSION } from "../../src/app/hostBoot";
import { AIS_WORLD_FEATURE } from "../../src/core/automationInterconnect";
import { exportWorldZip, importWorldZip } from "../../src/host/worldFile";
import { getWorld, listPackages, openVttDb } from "../../src/storage/idb";
import { MemDirHandle } from "../../src/storage/opfs";
import { HostPersister } from "../../src/storage/persistence";
import { InlineSimRunner } from "../../src/workers/simWorkerClient";
import { FakeCodec } from "../app/fakes";

const zipOf = (files: Record<string, string>): Uint8Array =>
  zipSync(Object.fromEntries(Object.entries(files).map(([path, text]) => [path, strToU8(text)])));
const aisModuleZip = (): Uint8Array => zipOf({
  "manifest.json": JSON.stringify({
    id: "zip-module",
    name: "ZIP Automation Module",
    version: "1.2.0",
    type: "module",
    interconnect: {
      api: "arena.ais/1",
      entry: "automation/entry.js",
      provides: [{ id: "pf1e.damage.resolve", mode: "exclusive", contract: 1 }],
      capabilities: ["action.observe", "ui.notify"],
    },
  }),
  "automation/entry.js": "AIS.events.on('turn.phase.changed', () => {});",
});

let nextWorld = 0;
async function freshApp() {
  const db = await openVttDb();
  const worldId = `w-ais-zip-${++nextWorld}`;
  await HostPersister.createWorld(db, {
    worldId,
    name: "AIS ZIP Test",
    system: BUILTIN_SYSTEM_ID,
    systemVersion: BUILTIN_SYSTEM_VERSION,
  });
  const app = await bootHostApp({
    db,
    worldId: worldId as never,
    root: new MemDirHandle(),
    codec: new FakeCodec(),
    simRunner: new InlineSimRunner(),
  });
  return { app, db };
}

describe("AIS world archive portability", () => {
  test("world ZIP carries module files and enabled profile, never local code approval", async () => {
    const { app, db } = await freshApp();
    expect((await app.packages.importZip(aisModuleZip())).ok).toBe(true);
    expect(await app.packages.enableAutomationModule("zip-module")).toEqual({ ok: true });
    expect(await app.packages.selectAutomationProvider(
      "pf1e.damage.resolve",
      "zip-module/pf1e.damage.resolve",
    )).toEqual({ ok: true });
    expect(await app.packages.grantAutomationCapabilities("zip-module", ["action.observe"])).toEqual({ ok: true });
    const grant = (await getWorld(db, app.worldId))?.automationGrants?.["zip-module"];
    expect(grant?.capabilities).toEqual(["action.observe"]);

    const archive = new Uint8Array(await (await exportWorldZip({
      db,
      worldId: app.worldId,
      root: new MemDirHandle(),
      persister: app.persister,
    })).arrayBuffer());
    const files = unzipSync(archive);
    const meta = JSON.parse(strFromU8(files["world.json"] as Uint8Array)) as {
      format: number;
      requiredFeatures: string[];
      automation: {
        api: string;
        modules: Array<{ id: string; version: string; hash: string }>;
        providers: Record<string, string>;
      };
    } & Record<string, unknown>;
    expect(meta.format).toBe(4);
    expect(meta.requiredFeatures).toContain(AIS_WORLD_FEATURE);
    expect(meta.automation).toMatchObject({
      api: "arena.ais/1",
      modules: [{ id: "zip-module", version: "1.2.0", hash: grant?.hash }],
      providers: { "pf1e.damage.resolve": "zip-module/pf1e.damage.resolve" },
    });
    expect(meta).not.toHaveProperty("automationGrants");
    expect(files["packages/zip-module/automation/entry.js"]).toBeDefined();
    await app.close();

    const copiedId = `w-ais-copy-${nextWorld}`;
    await importWorldZip({ db, file: archive, mode: "copy", worldId: copiedId as never, root: new MemDirHandle() });
    const copy = await getWorld(db, copiedId as never);
    expect(copy?.automationProfile).toEqual(meta.automation);
    expect(copy?.automationGrants).toBeUndefined();
    expect((await listPackages(db, copiedId as never)).map((pkg) => pkg.type)).toEqual(["module"]);

    // A restore on the same device retains consent only for the exact same module bytes.
    await importWorldZip({ db, file: archive, mode: "replace", root: new MemDirHandle() });
    const restored = await getWorld(db, app.worldId);
    expect(restored?.automationGrants?.["zip-module"]).toEqual(grant);

    // A portable profile that disables the module revokes its old local approval on restore,
    // even though the package bytes still match.
    const disabledMeta = { ...meta, automation: { ...meta.automation, modules: [], providers: {} } };
    const disabledArchive = zipSync({ ...files, "world.json": strToU8(JSON.stringify(disabledMeta)) });
    await importWorldZip({ db, file: disabledArchive, mode: "replace", root: new MemDirHandle() });
    const disabled = await getWorld(db, app.worldId);
    expect(disabled?.automationGrants).toBeUndefined();
    expect(disabled?.automationProfile?.modules).toEqual([]);
  });
});
