import "fake-indexeddb/auto";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { beforeEach, describe, expect, test } from "vitest";
import {
  deleteAsset,
  deleteWorldData,
  getAllDocumentRecords,
  listAssets,
  openVttDb,
} from "../../src/storage/idb";
import { MemDirHandle } from "../../src/storage/opfs";
import {
  exportWorldZip,
  importWorldZip,
  WORLD_FILE_FORMAT,
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
import type { AutomationDocument, MacroDocument, TokenDocument } from "../../src/core/documents";
import { scriptApprovalHash, validateScriptMacro, type ScriptPolicy } from "../../src/core/scriptMacros";

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

  test("a user-provided FX pack cannot be exported until separate redistribution rights are granted", async () => {
    const root = new MemDirHandle();
    const app = await boot(root);
    const bytes = new Uint8Array([21, 34, 55]);
    const { hash } = await app.assets.import(bytes, "premium.webm", "video/webm", "gm", "restricted");
    expect(app.store.world.assetManifest[hash]).toMatchObject({ visibility: "gm", exportRights: "restricted" });
    await expect(exportWorldZip({ db, worldId: app.worldId, root, persister: app.persister }))
      .rejects.toThrow(/world-export rights.*premium\.webm/);
    expect((await app.assets.meta(hash))?.exportRights).toBe("restricted");
    await app.assets.describe(hash, { exportRights: "granted" });
    const archive = await exportWorldZip({ db, worldId: app.worldId, root, persister: app.persister });
    const files = parseZip(new Uint8Array(await archive.arrayBuffer()));
    const exported = JSON.parse(strFromU8(files.get("assets.json") as Uint8Array)) as Array<{
      hash: string; visibility: string; exportRights: string;
    }>;
    expect(exported.find((asset) => asset.hash === hash)).toMatchObject({
      hash, visibility: "gm", exportRights: "granted",
    });
    expect(files.get(`assets/${hash}`)).toEqual(bytes);
    await app.close();
    const copied = await importWorldZip({ db, file: archive, root, mode: "copy", worldId: "w-rights-copy" });
    const restored = (await listAssets(db, copied.worldId)).find((asset) => asset.hash === hash);
    expect(restored).toMatchObject({ visibility: "gm", exportRights: "restricted" });
    await expect(exportWorldZip({ db, worldId: copied.worldId, root }))
      .rejects.toThrow(/world-export rights/);
    await deleteWorldData(db, copied.worldId);
    // Every case in this file boots the most recent test world against an
    // independent in-memory OPFS root. Do not strand this case's asset row in
    // IDB for a later case whose root correctly has no such blob.
    await deleteWorldData(db, app.worldId);
  });

  test("archive copies and restores keep script source but require this host to review and republish", async () => {
    const root = new MemDirHandle();
    const app = await boot(root);
    const source = "await api.chat.say('from saved script', 'gm'); return 1;";
    const settings: Omit<ScriptPolicy, "approvedHash"> = { version: 1, sceneId: DEFAULT_SCENE_ID,
      runAs: "gm", playerCallable: true, grants: ["chat"], inputs: [] };
    const macro: MacroDocument = { _id: "reviewed", type: "macro", name: "Reviewed",
      ownership: { default: 1 }, flags: { core: { playerCallable: true } }, system: {},
      kind: "script", command: source,
      script: { ...settings, approvedHash: await scriptApprovalHash(source, settings) } };
    app.gm.client.submit([{ kind: "create", coll: "macros", data: macro }]);
    await settle();
    expect(app.store.get("macros", "reviewed")).toBeDefined();
    app.host.commitSystem([{ kind: "update", ref: { coll: "macros", id: "reviewed" },
      diff: { scriptState: { recent: [{ key: "player:prior", at: 100,
        revision: macro.script?.approvedHash ?? "" }] } } }]);
    await app.persister.flush();
    const archive = await exportWorldZip({ db, worldId: app.worldId, root, persister: app.persister });
    await app.close();

    for (const options of [{ mode: "copy" as const, worldId: "w-script-copy" },
      { mode: "replace" as const }]) {
      const result = await importWorldZip({ db, file: archive, root, ...options });
      const rows = await getAllDocumentRecords(db, result.worldId);
      const restored = rows.find((row) => row.coll === "macros" && row.id === "reviewed")?.doc as MacroDocument;
      expect(restored.command).toBe(source); // GM can inspect and explicitly republish
      expect(restored.script).toMatchObject({ ...settings, playerCallable: false,
        approvedHash: "0".repeat(64) });
      expect(restored.scriptState).toEqual({ recent: [] });
      expect(restored.ownership.default).toBe(0);
      expect((restored.flags.core as Record<string, unknown>).playerCallable).toBe(false);
      expect(validateScriptMacro(restored).ok).toBe(true);
      expect(await scriptApprovalHash(restored.command, { ...settings, playerCallable: false }))
        .not.toBe(restored.script?.approvedHash); // never trusted merely for matching bundled bytes
    }
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
    expect(meta.format).toBe(WORLD_FILE_FORMAT);
    expect(meta.worldId).toBe(app.worldId);
    // D-248: a world on the built-in ruleset says so, and carries an (empty) package index
    expect(meta.rules).toEqual({ active: null });
    expect(meta.system).toBe("mass-battle-basic");
    expect(JSON.parse(strFromU8(files.get("packages.json") as Uint8Array))).toEqual([]);
    const documents = JSON.parse(
      strFromU8(files.get("documents.json") as Uint8Array),
    ) as WorldFileDocuments;
    expect(documents.docs.length).toBeGreaterThan(0); // gm user + scene
    // map + derived thumb/mid artifacts, each with a blob in assets/
    const assetFiles = [...files.keys()].filter((k) => k.startsWith("assets/"));
    expect(assetFiles.length).toBeGreaterThanOrEqual(3);
    const worldId = app.worldId;
    const seqAtExport = meta.seq;
    await app.close();

    // ── keep mutating AFTER the export (world drifts ahead) ──
    const drifted = await boot(root);
    expect(drifted.worldId).toBe(worldId);
    await addToken(drifted, token("t-3", 900, 900));
    drifted.gm.client.submit([
      { kind: "update", ref: { coll: "scenes", id: DEFAULT_SCENE_ID }, diff: { name: "Drifted" } },
    ]);
    await settle();
    await drifted.persister.flush();
    await drifted.close();

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
    await restored.close();
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
    await app.close();

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
    await fresh.close();
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
  /**
   * D-179 regression — the restore must win over the persister's final flush.
   *
   * §8 persistence batches document writes (~500 ms) and `HostPersister.close()`
   * runs one FINAL flush. `App.importWorld` calls `close()` and then replaces
   * every world row with the archive's, so a `close()` that returns before that
   * flush settles lets it commit AFTER the restore's delete+put: the drifted
   * scene document (tokens are embedded in it) is written back over the
   * restored one, and the rebooted world carries a token the archive never
   * contained. In the browser that surfaced as `worldfile.spec.ts` polling
   * tokenCount 2 and timing out on 3 — intermittently, only under load.
   */
  test("close() settles the final flush before a restore replaces the rows", async () => {
    const root = new MemDirHandle();
    await HostPersister.createWorld(db, {
      worldId: "w-restore-race",
      name: "Restore Race",
      system: "mass-battle-basic",
      systemVersion: "1.0.0",
    });
    const app = await boot(root, "w-restore-race");
    const worldId = app.worldId;
    await addToken(app, token("t-1", 100, 100));
    await addToken(app, token("t-2", 400, 300));
    const archive = new Uint8Array(
      await (await exportWorldZip({ db, worldId, root, persister: app.persister })).arrayBuffer(),
    );
    const meta = JSON.parse(
      strFromU8(parseZip(archive).get("world.json") as Uint8Array),
    ) as WorldFileMeta;

    /** The persisted scene row's token ids — the documents store, not a boot. */
    const storedTokens = async (): Promise<string[]> => {
      const rows = await getAllDocumentRecords(db, worldId);
      const scene = rows.find((r) => r.coll === "scenes" && r.id === DEFAULT_SCENE_ID);
      const doc = scene?.doc as { tokens?: Array<{ _id: string }> } | undefined;
      return (doc?.tokens ?? []).map((t) => t._id).sort();
    };

    // Drift past the export point and leave the write DIRTY: the batch has not
    // run and nothing drains it, so this is the exact window the import raced.
    await addToken(app, token("t-3", 900, 900));
    expect(await storedTokens()).toEqual(["t-1", "t-2"]);

    // The fix: close() resolves only once that last flush has committed.
    await app.close();
    expect(await storedTokens()).toEqual(["t-1", "t-2", "t-3"]);

    // Nothing is in flight now, so the restore is the last writer.
    const imported = await importWorldZip({ db, file: archive, root });
    expect(imported).toMatchObject({ worldId, seq: meta.seq });

    const restored = await boot(root, worldId);
    expect(restored.store.seq).toBe(meta.seq);
    const scene = restored.gm.client.store.get("scenes", DEFAULT_SCENE_ID);
    expect(scene?.tokens.map((t) => t._id).sort()).toEqual(["t-1", "t-2"]);
    await restored.persister.flush();
    await restored.close();
  });
});

test("named action Revert persists through a compacted checkpoint, world-file copy and host reboot", async () => {
  const db = await openVttDb();
  const root = new MemDirHandle();
  const app = await boot(root);
  const sceneId = DEFAULT_SCENE_ID;
  const tile = { _id: "history-tile", type: "tile", name: "History tile",
    ownership: { default: 0 as const }, flags: {}, system: {},
    x: 100, y: 100, width: 100, height: 100, img: "", above: false,
    occlusion: { mode: "roof" as const, alpha: 0.5 } };
  app.gm.client.submit([{ kind: "create", coll: "tiles", parent: { coll: "scenes", id: sceneId },
    data: tile }]);
  await settle();
  app.gm.client.submit([{ kind: "create", coll: "automations", data: {
    _id: "history-graph", type: "automation", name: "Reversible history",
    ownership: { default: 0 }, flags: {}, system: {},
    definition: { version: 1, sceneId, tileId: tile._id, methods: ["manual"], steps: [
      { id: "tile", kind: "select", selector: { kind: "tile" } },
      { id: "mark", kind: "tags", edit: "add", tags: ["action-history"] },
    ] },
  } as AutomationDocument }]);
  await settle();
  const before = app.store.seq;
  app.gm.client.requestAutomation("history-graph", sceneId, "manual");
  await settle();
  expect(app.store.seq).toBe(before + 1);
  const receipt = app.store.getAll("actionReceipts")[0];
  if (!receipt) throw new Error("action receipt missing");
  expect(receipt).toMatchObject({ status: "ready", commits: 1 });
  expect(app.store.resolve({ coll: "tiles", id: tile._id,
    parent: { coll: "scenes", id: sceneId } })?.taggerTags).toEqual(["action-history"]);
  await app.persister.checkpoint();
  const archive = await exportWorldZip({ db, worldId: app.worldId, root, persister: app.persister });
  const archiveDocuments = parseZip(new Uint8Array(await archive.arrayBuffer())).get("documents.json");
  if (!archiveDocuments) throw new Error("archive documents missing");
  const docs = JSON.parse(strFromU8(archiveDocuments)) as WorldFileDocuments;
  expect(docs.docs.some((entry) => entry.coll === "actionReceipts" && entry.id === receipt?._id)).toBe(true);
  const worldId = app.worldId;
  await app.close();
  const copied = await importWorldZip({ db, file: archive, root, mode: "copy",
    worldId: `w-action-copy-${Date.now()}` });
  for (const id of [worldId, copied.worldId]) {
    const reopened = await boot(root, id);
    expect(reopened.store.getAll("actionReceipts")[0]?.inverses).toEqual(receipt?.inverses);
    reopened.gm.client.actionRevert(receipt._id);
    await settle();
    expect(reopened.store.getAll("actionReceipts")[0]?.status).toBe("reverted");
    expect(reopened.store.resolve({ coll: "tiles", id: tile._id,
      parent: { coll: "scenes", id: sceneId } })?.taggerTags).toBeUndefined();
    expect(reopened.store.get("automations", "history-graph")?.state).toBeUndefined();
    await reopened.close();
  }
  await deleteWorldData(db, copied.worldId);
  await deleteWorldData(db, worldId);
  db.close();
});
