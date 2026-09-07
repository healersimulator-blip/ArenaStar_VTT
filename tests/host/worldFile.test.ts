import "fake-indexeddb/auto";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { beforeEach, describe, expect, test } from "vitest";
import { deleteAsset, deleteWorldData, listAssets, openVttDb } from "../../src/storage/idb";
import { MemDirHandle } from "../../src/storage/opfs";
import {
  exportWorldZip,
  importWorldZip,
  type WorldFileDocuments,
  type WorldFileMeta,
} from "../../src/host/worldFile";
import { DEFAULT_SCENE_ID, type HostApp } from "../../src/app/hostBoot";
import { boot, settle } from "../app/fakes";
import { HostPersister } from "../../src/storage/persistence";
import {
  getReport,
  latestCheckpoint,
  putCheckpoint,
  putReport,
} from "../../src/storage/strategicStore";
import type { TokenDocument } from "../../src/core/documents";

const token = (id: string, x: number, y: number): TokenDocument => ({
  _id: id,
  type: "token",
  name: id,
  ownership: { default: 0, gm: 3 },
  flags: {},
  system: {},
  x,
  y,
  rotation: 0,
  width: 100,
  height: 100,
  img: "",
  hidden: false,
  disposition: "neutral",
  vision: true,
  light: { radius: 0, color: "#fff", alpha: 0.5 },
});

async function addToken(app: HostApp, doc: TokenDocument): Promise<void> {
  app.gm.client.submit([
    {
      kind: "create",
      coll: "tokens",
      parent: { coll: "scenes", id: DEFAULT_SCENE_ID },
      data: doc,
    },
  ]);
  await settle();
}

function parseZip(bytes: Uint8Array): Map<string, Uint8Array> {
  return new Map(Object.entries(unzipSync(bytes)));
}

describe("world.zip export/import (§8)", () => {
  let db: Awaited<ReturnType<typeof openVttDb>>;

  beforeEach(async () => {
    db = await openVttDb();
  });

  test("round-trips losslessly and acts as restore (M1 acceptance)", async () => {
    const root = new MemDirHandle();
    const app = await boot(root);
    await addToken(app, token("t-1", 100, 100));
    await addToken(app, token("t-2", 400, 300));
    const { hash } = await app.pipeline.importImage(
      new Uint8Array([1, 2, 3, 4]),
      "map.png",
      "image/png",
    );
    app.gm.client.submit([
      { kind: "update", ref: { coll: "scenes", id: DEFAULT_SCENE_ID }, diff: { img: hash } },
    ]);
    await settle();
    await app.persister.flush();

    // §8A strategic state rides along
    await putCheckpoint(db, {
      worldId: app.worldId,
      sceneId: DEFAULT_SCENE_ID,
      slot: 1,
      turnNumber: 1,
      tick: null,
      pool: new Uint8Array([9, 9, 9]),
      maxHpMax: 4,
      version: 0,
      unitStats: {},
      seed: 42,
      rulesVersion: "1.0.0",
      hash: "cp-hash",
    });
    await putReport(db, app.worldId, DEFAULT_SCENE_ID, {
      turn: 1,
      sceneId: DEFAULT_SCENE_ID,
      subPhases: ["move"],
      events: [{ subPhase: "move", type: "arrive", unitId: "u1", text: "marched" }],
      summary: { events: 1 },
      rulesVersion: "1.0.0",
    });

    // ── export at this exact point ──
    const blob = await exportWorldZip({
      db,
      worldId: app.worldId,
      root,
      persister: app.persister,
    });
    const archive = new Uint8Array(await blob.arrayBuffer());
    const files = parseZip(archive);
    const meta = JSON.parse(strFromU8(files.get("world.json") as Uint8Array)) as WorldFileMeta;
    expect(meta.format).toBe(1);
    expect(meta.worldId).toBe(app.worldId);
    const documents = JSON.parse(
      strFromU8(files.get("documents.json") as Uint8Array),
    ) as WorldFileDocuments;
    expect(documents.docs.length).toBeGreaterThan(0); // gm user + scene
    // map + derived thumb/mid artifacts, each with a blob in assets/
    const assetFiles = [...files.keys()].filter((k) => k.startsWith("assets/"));
    expect(assetFiles.length).toBeGreaterThanOrEqual(3);
    const worldId = app.worldId;
    const seqAtExport = meta.seq;
    app.close();

    // ── keep mutating AFTER the export (world drifts ahead) ──
    const drifted = await boot(root);
    expect(drifted.worldId).toBe(worldId);
    await addToken(drifted, token("t-3", 900, 900));
    drifted.gm.client.submit([
      { kind: "update", ref: { coll: "scenes", id: DEFAULT_SCENE_ID }, diff: { name: "Drifted" } },
    ]);
    await settle();
    await drifted.persister.flush();
    drifted.close();

    // ── import = restore to the export point ──
    expect(files.get(`checkpoints/${DEFAULT_SCENE_ID}/1.pool`)).toBeDefined();
    expect(files.get(`reports/${DEFAULT_SCENE_ID}/1.json`)).toBeDefined();
    const imported = await importWorldZip({ db, file: archive, root });
    // §8A: strategic state rides in the archive and restores
    expect(
      Array.from((await latestCheckpoint(db, imported.worldId, DEFAULT_SCENE_ID))?.pool ?? []),
    ).toEqual([9, 9, 9]);
    expect(await getReport(db, imported.worldId, DEFAULT_SCENE_ID, 1)).toBeTruthy();
    expect(imported).toMatchObject({ worldId, seq: seqAtExport });

    const restored = await boot(root);
    expect(restored.worldId).toBe(worldId);
    expect(restored.store.seq).toBe(seqAtExport);
    const scene = restored.gm.client.store.get("scenes", DEFAULT_SCENE_ID);
    expect(scene?.name).toBe("Scene 1"); // post-export rename rolled back
    expect(scene?.tokens.length).toBe(2); // post-export token rolled back
    expect(scene?.tokens.map((t) => t._id).sort()).toEqual(["t-1", "t-2"]);
    expect(scene?.img).toBe(hash);

    // every exported document row survived, byte-identical semantics
    const rows = new Map(documents.docs.map((d) => [`${d.coll}/${d.id}`, d.doc]));
    for (const [key, doc] of rows) {
      const [coll, id] = key.split("/") as [string, string];
      expect(restored.store.get(coll as never, id as never)).toEqual(doc);
    }

    // assets still stream from the restored world (blobs + manifest intact)
    const bytes = await restored.gm.fetcher.request(hash, "scene");
    expect([...bytes]).toEqual([1, 2, 3, 4]);
    await restored.persister.flush();
    restored.close();
  });

  test("import into a database that has never seen the world", async () => {
    const root = new MemDirHandle();
    // explicit fresh world (a no-worldId boot would reopen test 1's world)
    await HostPersister.createWorld(db, {
      worldId: "w-fresh-2",
      name: "Fresh Two",
      system: "mass-battle-basic",
      systemVersion: "1.0.0",
    });
    const app = await boot(root, "w-fresh-2");
    const worldId = app.worldId;
    await addToken(app, token("t-1", 50, 50));
    await app.persister.flush();
    const archive = new Uint8Array(
      await (await exportWorldZip({ db, worldId, root, persister: app.persister })).arrayBuffer(),
    );
    app.close();

    // simulate a brand-new host machine: wipe every trace of the world
    await deleteWorldData(db, worldId);
    for (const record of await listAssets(db, worldId)) {
      await deleteAsset(db, worldId, record.hash);
    }

    const imported = await importWorldZip({ db, file: archive, root: new MemDirHandle() });
    expect(imported.worldId).toBe(worldId);
    const fresh = await boot(); // no worldId → most recent = imported
    expect(fresh.worldId).toBe(worldId);
    expect(fresh.gm.client.store.get("scenes", DEFAULT_SCENE_ID)?.tokens.length).toBe(1);
    await fresh.persister.flush();
    fresh.close();
  });

  test("rejects corrupt archives with explicit errors", async () => {
    await expect(importWorldZip({ db, file: new Uint8Array([1, 2, 3]) })).rejects.toThrow(
      /world file/,
    );
    await expect(
      importWorldZip({ db, file: new Blob([new TextEncoder().encode("{}")]) }),
    ).rejects.toThrow(/world file/);

    // valid zip, but world.json declares an unknown format
    const bad = zipSync({
      "world.json": strToU8(JSON.stringify({ format: 99, worldId: "w-x", seq: 1 })),
    });
    await expect(importWorldZip({ db, file: bad })).rejects.toThrow(/unsupported format/);

    // valid format, but the archive is missing documents.json
    const noDocs = zipSync({
      "world.json": strToU8(
        JSON.stringify({ format: 1, worldId: "w-x", name: "n", system: "s", version: "1", seq: 1 }),
      ),
      "assets.json": strToU8("[]"),
    });
    await expect(importWorldZip({ db, file: noDocs })).rejects.toThrow(/missing documents\.json/);
  });
});
