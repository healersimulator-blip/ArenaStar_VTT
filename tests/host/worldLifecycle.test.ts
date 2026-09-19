/**
 * D-249 — world lifecycle on the start screen: delete leaves nothing behind in any store,
 * import-as-copy opens a shared world beside the local one, and a starter archive is a
 * template that becomes a new campaign every time.
 */
import "fake-indexeddb/auto";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { describe, expect, test } from "vitest";
import { bootHostApp, DEFAULT_SCENE_ID, type HostApp } from "../../src/app/hostBoot";
import {
  deleteWorldData,
  getWorld,
  listAssets,
  listWorlds,
  openVttDb,
  STORES,
  WORLD_SCOPED_STORES,
} from "../../src/storage/idb";
import { deleteWorldFiles, MemDirHandle, OpfsAssetStore } from "../../src/storage/opfs";
import { HostPersister } from "../../src/storage/persistence";
import { latestCheckpoint, putCheckpoint, putReport } from "../../src/storage/strategicStore";
import type { TurnReport } from "../../src/core/sim";
import { exportWorldZip, importWorldZip, type WorldFileMeta } from "../../src/host/worldFile";
import { classifyZip, describeWorldContents } from "../../src/host/zipKind";
import { InlineSimRunner } from "../../src/workers/simWorkerClient";
import { FakeCodec, settle } from "../app/fakes";

const RULES_JS =
  "export default { schema: { version: '1.2.3', modelColumns: { ammo: 'u8' }, unitTypes: {}, orderTypes: ['move'], subPhases: ['move'] }, validateOrder(){ return {ok:true}; }, resolveTurn(){}, detection(){ return 5; } };";
const zipOf = (files: Record<string, string>): Uint8Array =>
  zipSync(Object.fromEntries(Object.entries(files).map(([k, v]) => [k, strToU8(v)])));
const rulesetZip = (): Uint8Array =>
  zipOf({
    "manifest.json": JSON.stringify({
      id: "life-rules",
      name: "Life Rules",
      version: "1.2.3",
      type: "system",
      rules: { entry: "rules.js", modelColumns: { ammo: "u8" } },
    }),
    "rules.js": RULES_JS,
  });

const boot = async (worldId: string, root: MemDirHandle): Promise<HostApp> =>
  bootHostApp({
    db: await openVttDb(),
    root,
    codec: new FakeCodec(),
    simRunner: new InlineSimRunner(),
    worldId: worldId as HostApp["worldId"],
  });

/** A world with something in EVERY world-scoped store. */
async function populatedWorld(worldId: string, root: MemDirHandle): Promise<HostApp> {
  const db = await openVttDb();
  await HostPersister.createWorld(db, {
    worldId: worldId as HostApp["worldId"],
    name: "Populated",
    system: "mass-battle-basic",
    systemVersion: "1.0.0",
  });
  const app = await boot(worldId, root);
  // an asset (IDB row + OPFS blob), a package + activation, a checkpoint, a report, a delta, fog
  await app.pipeline.importImage(new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 0]), "x.png", "image/png").catch(() => {});
  expect((await app.packages.importZip(rulesetZip())).ok).toBe(true);
  expect((await app.packages.activate("life-rules")).ok).toBe(true);
  await putCheckpoint(db, {
    worldId: app.worldId,
    sceneId: DEFAULT_SCENE_ID,
    slot: 1,
    turnNumber: 1,
    tick: null,
    pool: new Uint8Array([1, 2, 3]),
    maxHpMax: 1,
    version: 0,
    unitStats: {},
    seed: 1,
    rulesVersion: "1.2.3",
    hash: "h",
  });
  await putReport(db, app.worldId, DEFAULT_SCENE_ID, {
    turn: 1,
    sceneId: DEFAULT_SCENE_ID,
    events: [],
  } as unknown as TurnReport);
  await db.put(STORES.simdeltas, { worldId, sceneId: DEFAULT_SCENE_ID, version: 1, bytes: new Uint8Array([1]) });
  await db.put(STORES.fog, { worldId, sceneId: DEFAULT_SCENE_ID, userId: "gm", png: new Uint8Array([1]) });
  const opfs = await OpfsAssetStore.open(app.worldId, root);
  await opfs?.put("deadbeef", new Uint8Array([9, 9]));
  await db.put(STORES.assets, { worldId, hash: "deadbeef", name: "blob", mime: "application/octet-stream", size: 2, chunks: 1 });
  await app.persister.flush();
  return app;
}

async function rowsFor(worldId: string): Promise<Record<string, number>> {
  const db = await openVttDb();
  const out: Record<string, number> = {};
  for (const store of WORLD_SCOPED_STORES) {
    const all = (await db.getAll(store)) as Array<{ worldId: string }>;
    out[store] = all.filter((r) => r.worldId === worldId).length;
  }
  return out;
}

describe("delete", () => {
  test("deleteWorldData + deleteWorldFiles leave no row in any world-scoped store and no OPFS tree", async () => {
    const root = new MemDirHandle();
    const app = await populatedWorld("w-del", root);
    await app.close();
    const before = await rowsFor("w-del");
    for (const store of WORLD_SCOPED_STORES) {
      expect(before[store], `${store} should be populated by the fixture`).toBeGreaterThan(0);
    }
    const vtt = root.dirs.get("vtt") as MemDirHandle;
    expect(vtt.dirs.has("w-del")).toBe(true);

    // a bystander world must not lose anything
    const other = await populatedWorld("w-keep", root);
    await other.close();

    const db = await openVttDb();
    await deleteWorldData(db, "w-del");
    await deleteWorldFiles(root, "w-del");
    expect(await getWorld(db, "w-del")).toBeUndefined();
    const after = await rowsFor("w-del");
    for (const store of WORLD_SCOPED_STORES) expect(after[store], store).toBe(0);
    expect(vtt.dirs.has("w-del")).toBe(false);
    expect((await listWorlds(db)).map((w) => w.worldId)).toEqual(["w-keep"]);
    const kept = await rowsFor("w-keep");
    for (const store of WORLD_SCOPED_STORES) expect(kept[store], store).toBeGreaterThan(0);
    expect(vtt.dirs.has("w-keep")).toBe(true);
    // deleting what is not there is not an error (a second click, an OPFS-less browser)
    await deleteWorldData(db, "w-del");
    await deleteWorldFiles(root, "w-del");
    await deleteWorldFiles(null, "w-del");
  });
});

describe("import as copy", () => {
  test("a copy is a new world with the same documents, packages, checkpoints and blobs; the original is untouched", async () => {
    const root = new MemDirHandle();
    const app = await populatedWorld("w-orig", root);
    const client = app.gm.client;
    client.submit([
      {
        kind: "update",
        ref: { coll: "scenes", id: DEFAULT_SCENE_ID },
        diff: { name: "Original Field" },
      },
    ]);
    await settle();
    await app.persister.flush();
    const db = await openVttDb();
    const archive = new Uint8Array(
      await (await exportWorldZip({ db, worldId: app.worldId, root, persister: app.persister })).arrayBuffer(),
    );
    const seqAtExport = client.store.seq;
    await app.close();

    const info = await classifyZip(archive);
    expect(info).toMatchObject({
      kind: "world",
      worldId: "w-orig",
      name: "Populated",
      activeRules: "life-rules",
      starter: false,
    });
    if (info.kind === "world") {
      expect(info.packages.map((p) => p.id)).toEqual(["life-rules"]);
      expect(describeWorldContents(info)).toBe("strategic ruleset Life Rules v1.2.3");
    }

    const copied = await importWorldZip({
      db,
      file: archive,
      root,
      mode: "copy",
      name: "Populated (shared)",
    });
    expect(copied.mode).toBe("copy");
    expect(copied.sourceWorldId).toBe("w-orig");
    expect(copied.worldId).not.toBe("w-orig");
    expect(copied.worldId).toMatch(/^w-/);
    expect(copied.name).toBe("Populated (shared)");
    expect(copied.activeRulesPackage).toBe("life-rules");

    const worlds = (await listWorlds(db)).map((w) => w.worldId);
    expect(worlds).toContain(copied.worldId);
    expect(worlds).toContain("w-orig");
    const orig = await rowsFor("w-orig");
    const copy = await rowsFor(copied.worldId);
    // documents, packages, checkpoints, reports, assets travel; fog/simdeltas are not archived
    for (const store of [STORES.documents, STORES.packages, STORES.checkpoints, STORES.turnReports, STORES.assets]) {
      expect(copy[store], store).toBe(orig[store]);
    }
    expect((await listAssets(db, copied.worldId)).map((a) => a.hash)).toEqual(
      (await listAssets(db, "w-orig")).map((a) => a.hash),
    );
    const vtt = root.dirs.get("vtt") as MemDirHandle;
    const copyAssets = (vtt.dirs.get(copied.worldId) as MemDirHandle).dirs.get("assets") as MemDirHandle;
    expect(copyAssets.files.has("deadbeef")).toBe(true);
    expect((await latestCheckpoint(db, copied.worldId, DEFAULT_SCENE_ID))?.hash).toBe("h");
    const copyRec = await getWorld(db, copied.worldId);
    expect(copyRec).toMatchObject({
      name: "Populated (shared)",
      system: "life-rules",
      activeRulesPackage: "life-rules",
      flushedSeq: seqAtExport,
    });
    expect(copyRec?.trustedPackages).toBeUndefined();
    expect((await getWorld(db, "w-orig"))?.name).toBe("Populated");

    // the copy boots on the package and shows the same scene, independently of the original
    const second = await boot(copied.worldId, root);
    expect(second.rulesBoot.source).toBe("package");
    expect(second.meta.name).toBe("Populated (shared)");
    expect(second.gm.client.store.get("scenes", DEFAULT_SCENE_ID)?.name).toBe("Original Field");
    second.gm.client.submit([
      { kind: "update", ref: { coll: "scenes", id: DEFAULT_SCENE_ID }, diff: { name: "Copy Field" } },
    ]);
    await settle();
    await second.persister.flush();
    await second.close();
    const first = await boot("w-orig", root);
    expect(first.gm.client.store.get("scenes", DEFAULT_SCENE_ID)?.name).toBe("Original Field");
    await first.persister.flush();
    await first.close();
  }, 20_000);

  test("copy refuses to land on an existing id; replace refuses a foreign id", async () => {
    const root = new MemDirHandle();
    const app = await populatedWorld("w-ids", root);
    const db = await openVttDb();
    const archive = new Uint8Array(
      await (await exportWorldZip({ db, worldId: app.worldId, root, persister: app.persister })).arrayBuffer(),
    );
    await app.close();
    await expect(
      importWorldZip({ db, file: archive, root, mode: "copy", worldId: "w-ids" as HostApp["worldId"] }),
    ).rejects.toThrow(/existing world w-ids/);
    await expect(
      importWorldZip({ db, file: archive, root, mode: "replace", worldId: "w-other" as HostApp["worldId"] }),
    ).rejects.toThrow(/archive's own worldId/);
    // an explicit copy id is honoured
    const copied = await importWorldZip({
      db,
      file: archive,
      root,
      mode: "copy",
      worldId: "w-ids-copy" as HostApp["worldId"],
    });
    expect(copied.worldId).toBe("w-ids-copy");
  });
});

describe("starter archives", () => {
  /** What scripts/buildStarterWorlds.mjs emits: header + empty documents + packages, no campaign. */
  function starterArchive(): Uint8Array {
    const rulesetFiles = unzipSync(rulesetZip());
    const meta: WorldFileMeta = {
      format: 2,
      worldId: "starter-life-rules",
      name: "Life Rules — starter",
      system: "life-rules",
      version: "1.2.3",
      seq: 0,
      exportedAt: 0,
      rules: { active: "life-rules" },
      starter: true,
    };
    return zipSync({
      "world.json": strToU8(JSON.stringify(meta)),
      "documents.json": strToU8(JSON.stringify({ seq: 0, docs: [] })),
      "assets.json": strToU8("[]"),
      "packages.json": strToU8(
        JSON.stringify([
          { id: "life-rules", name: "Life Rules", version: "1.2.3", type: "system", importedAt: 0, packCount: 0 },
        ]),
      ),
      "packages/life-rules/manifest.json": rulesetFiles["manifest.json"] as Uint8Array,
      "packages/life-rules/rules.js": rulesetFiles["rules.js"] as Uint8Array,
    });
  }

  test("is sniffed as a starter, imports as a copy twice, and each copy seeds + boots on the ruleset", async () => {
    const root = new MemDirHandle();
    const db = await openVttDb();
    const bytes = starterArchive();
    const info = await classifyZip(bytes);
    expect(info).toMatchObject({ kind: "world", starter: true, activeRules: "life-rules" });

    const a = await importWorldZip({ db, file: bytes, root, mode: "copy", name: "Campaign A" });
    const b = await importWorldZip({ db, file: bytes, root, mode: "copy", name: "Campaign B" });
    expect(a.worldId).not.toBe(b.worldId);
    expect(await getWorld(db, "starter-life-rules")).toBeUndefined(); // the template id never lands

    for (const [id, name] of [
      [a.worldId, "Campaign A"],
      [b.worldId, "Campaign B"],
    ] as const) {
      const app = await boot(id, root);
      expect(app.meta.name).toBe(name);
      expect(app.rulesBoot).toMatchObject({ source: "package", packageId: "life-rules" });
      // seq 0 in the archive → the normal seed ran: GM user + default scene exist
      expect(app.gm.client.store.get("scenes", DEFAULT_SCENE_ID)).toBeDefined();
      expect(app.gm.client.store.seq).toBeGreaterThanOrEqual(1);
      await app.persister.flush();
      await app.close();
    }
    // a starter exported again by the GM is a plain world (no starter flag on the record → none in the header)
    const reexport = unzipSync(
      new Uint8Array(await (await exportWorldZip({ db, worldId: a.worldId, root })).arrayBuffer()),
    );
    const header = JSON.parse(strFromU8(reexport["world.json"] as Uint8Array)) as WorldFileMeta;
    expect(header.starter).toBeUndefined();
    expect(header.worldId).toBe(a.worldId);
  }, 20_000);
});
