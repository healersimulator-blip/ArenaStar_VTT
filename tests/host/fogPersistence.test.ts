/**
 * §9 explored fog persistence (D-250): fog.put lands in the world's `fog` store per user +
 * scene, fog.get hands it back — through the GM loopback, across a reboot of the world, and
 * for a player over the real join path — and the world file carries every map (a tactical
 * AND a strategic scene in one world, D-248's mixed-scene rule) through replace and copy
 * imports. Archives written before D-250 (no fog.json) still import.
 */
import "fake-indexeddb/auto";
import { strFromU8, unzipSync, zipSync } from "fflate";
import { afterEach, describe, expect, test } from "vitest";
import { bootHostApp, DEFAULT_SCENE_ID, type HostApp } from "../../src/app/hostBoot";
import type { SceneDocument } from "../../src/core/documents";
import { MAX_FOG_PNG_BYTES } from "../../src/core/fogExploration";
import { exportWorldZip, importWorldZip, type WorldFileFog } from "../../src/host/worldFile";
import { deleteWorldData, getFog, listFogForWorld, openVttDb } from "../../src/storage/idb";
import { MemDirHandle } from "../../src/storage/opfs";
import { HostPersister } from "../../src/storage/persistence";
import { InlineSimRunner } from "../../src/workers/simWorkerClient";
import { FakeCodec, joinHostPlayer, settle } from "../app/fakes";

const png = (...bytes: number[]): Uint8Array => new Uint8Array([0x89, 0x50, 0x4e, 0x47, ...bytes]);

const bootWorld = async (worldId: string, root: MemDirHandle): Promise<HostApp> =>
  bootHostApp({
    db: await openVttDb(),
    root,
    codec: new FakeCodec(),
    simRunner: new InlineSimRunner(),
    worldId: worldId as HostApp["worldId"],
  });

const cleanup: string[] = [];
afterEach(async () => {
  const db = await openVttDb();
  for (const id of cleanup.splice(0)) await deleteWorldData(db, id);
});

describe("fog.put / fog.get through the host (D-250)", () => {
  test("GM loopback: fog.put persists to the fog store; fog.get answers from it after a reboot", async () => {
    const root = new MemDirHandle();
    const db = await openVttDb();
    await HostPersister.createWorld(db, {
      worldId: "w-fog" as HostApp["worldId"],
      name: "Fog",
      system: "mass-battle-basic",
      systemVersion: "1.0.0",
    });
    cleanup.push("w-fog");
    const app = await bootWorld("w-fog", root);
    const client = app.gm.client;

    // nothing stored yet
    expect(await client.requestFog(DEFAULT_SCENE_ID)).toBeNull();

    client.sendFogPng(DEFAULT_SCENE_ID, png(1, 2, 3));
    await settle();
    const row = await getFog(db, app.worldId, DEFAULT_SCENE_ID, "gm");
    expect(row && [...row.png]).toEqual([...png(1, 2, 3)]);
    expect(await client.requestFog(DEFAULT_SCENE_ID).then((p) => p && [...p])).toEqual([...png(1, 2, 3)]);

    // a newer map replaces the old one (latest wins; the client's own texture is the union)
    client.sendFogPng(DEFAULT_SCENE_ID, png(9));
    await settle();
    expect((await getFog(db, app.worldId, DEFAULT_SCENE_ID, "gm"))?.png.length).toBe(5);

    // §16: empty and oversized payloads are dropped, other scenes untouched
    client.sendFogPng(DEFAULT_SCENE_ID, new Uint8Array(0));
    client.sendFogPng("scene-other", new Uint8Array(MAX_FOG_PNG_BYTES + 1));
    await settle();
    expect((await getFog(db, app.worldId, DEFAULT_SCENE_ID, "gm"))?.png.length).toBe(5);
    expect(await getFog(db, app.worldId, "scene-other", "gm")).toBeUndefined();
    expect(await client.requestFog("scene-other")).toBeNull();
    await app.close();

    // reboot: the in-memory cache is gone, the store answers
    const again = await bootWorld("w-fog", root);
    expect(await again.gm.client.requestFog(DEFAULT_SCENE_ID).then((p) => p && [...p])).toEqual([...png(9)]);
    await again.close();
  });

  test("player over the real join path: their own map, keyed by their user id, never another's", async () => {
    const { hostApp, playerApp, share, pump } = await joinHostPlayer();
    cleanup.push(hostApp.worldId);
    try {
      const db = await openVttDb();
      const playerId = playerApp.client.user?.id;
      if (!playerId) throw new Error("player not authenticated");
      hostApp.gm.client.sendFogPng(DEFAULT_SCENE_ID, png(0xaa));
      playerApp.client.sendFogPng(DEFAULT_SCENE_ID, png(0xbb, 0xbb));
      await settle(6);

      const rows = await listFogForWorld(db, hostApp.worldId);
      expect(rows.map((r) => [r.sceneId, r.userId, r.png.length]).sort()).toEqual(
        [
          [DEFAULT_SCENE_ID, "gm", 5],
          [DEFAULT_SCENE_ID, playerId, 6],
        ].sort(),
      );
      // each side gets its own map back
      const mine = await playerApp.client.requestFog(DEFAULT_SCENE_ID);
      expect(mine && [...mine]).toEqual([...png(0xbb, 0xbb)]);
      const gms = await hostApp.gm.client.requestFog(DEFAULT_SCENE_ID);
      expect(gms && [...gms]).toEqual([...png(0xaa)]);
      // concurrent requests for one scene share one answer
      const [a, b] = await Promise.all([
        playerApp.client.requestFog("scene-2"),
        playerApp.client.requestFog("scene-2"),
      ]);
      expect(a).toBeNull();
      expect(b).toBeNull();
    } finally {
      pump.stop();
      playerApp.close();
      share.close();
      await hostApp.close();
    }
  });
});

describe("fog rides the world file (D-250)", () => {
  test("mixed tactical + strategic world: every user × scene map exports, restores, and copies", async () => {
    const root = new MemDirHandle();
    const db = await openVttDb();
    await HostPersister.createWorld(db, {
      worldId: "w-fogfile" as HostApp["worldId"],
      name: "Fog file",
      system: "mass-battle-basic",
      systemVersion: "1.0.0",
    });
    cleanup.push("w-fogfile");
    const app = await bootWorld("w-fogfile", root);
    const client = app.gm.client;
    const scene1 = client.store.get("scenes", DEFAULT_SCENE_ID) as SceneDocument;
    // scene-1 stays tactical with fog on; scene-2 is a strategic (heroes + units) scene with
    // fog on as well — both flags travel as scene documents, the maps as fog rows
    client.submit([
      {
        kind: "update",
        ref: { coll: "scenes", id: DEFAULT_SCENE_ID },
        diff: { flags: { core: { fog: true, fogRange: 6 } } },
      },
      {
        kind: "create",
        coll: "scenes",
        data: {
          ...scene1,
          _id: "scene-strategic",
          name: "The Field",
          active: false,
          flags: { core: { scale: "strategic", fog: true } },
        },
      },
    ]);
    await settle();
    client.sendFogPng(DEFAULT_SCENE_ID, png(1));
    client.sendFogPng("scene-strategic", png(2, 2));
    await settle();
    // a player's map for the tactical scene, written straight to the store (as the host does)
    const { putFog } = await import("../../src/storage/idb");
    await putFog(db, { worldId: app.worldId, sceneId: DEFAULT_SCENE_ID, userId: "npub-rex", png: png(3, 3, 3) });

    const archive = new Uint8Array(
      await (await exportWorldZip({ db, worldId: app.worldId, root, persister: app.persister })).arrayBuffer(),
    );
    await app.close();

    const files = new Map(Object.entries(unzipSync(archive)));
    const index = JSON.parse(strFromU8(files.get("fog.json") as Uint8Array)) as WorldFileFog[];
    expect(index.map((e) => [e.sceneId, e.userId]).sort()).toEqual(
      [
        [DEFAULT_SCENE_ID, "gm"],
        [DEFAULT_SCENE_ID, "npub-rex"],
        ["scene-strategic", "gm"],
      ].sort(),
    );
    for (const e of index) expect(files.get(e.file)).toBeDefined();
    const byKey = new Map(index.map((e) => [`${e.sceneId}/${e.userId}`, [...(files.get(e.file) as Uint8Array)]]));
    expect(byKey.get(`${DEFAULT_SCENE_ID}/npub-rex`)).toEqual([...png(3, 3, 3)]);
    expect(byKey.get("scene-strategic/gm")).toEqual([...png(2, 2)]);

    // ── restore: wipe, import in place ──
    await deleteWorldData(db, "w-fogfile");
    expect(await listFogForWorld(db, "w-fogfile")).toEqual([]);
    const restored = await importWorldZip({ db, file: archive, root: new MemDirHandle() });
    expect(restored.fogRecords).toBe(3);
    const rows = await listFogForWorld(db, "w-fogfile");
    expect(rows.map((r) => [r.sceneId, r.userId, [...r.png]]).sort()).toEqual(
      [
        [DEFAULT_SCENE_ID, "gm", [...png(1)]],
        [DEFAULT_SCENE_ID, "npub-rex", [...png(3, 3, 3)]],
        ["scene-strategic", "gm", [...png(2, 2)]],
      ].sort(),
    );
    // the scene flags came back with the documents, so fog is on in both scenes after boot
    const back = await bootWorld("w-fogfile", new MemDirHandle());
    const s1 = back.gm.client.store.get("scenes", DEFAULT_SCENE_ID);
    const s2 = back.gm.client.store.get("scenes", "scene-strategic");
    expect(s1?.flags).toEqual({ core: { fog: true, fogRange: 6 } });
    expect(s2?.flags).toEqual({ core: { scale: "strategic", fog: true } });
    // …and the host hands the GM its stored map for either scene
    expect(await back.gm.client.requestFog("scene-strategic").then((p) => p && [...p])).toEqual([...png(2, 2)]);
    expect(await back.gm.client.requestFog(DEFAULT_SCENE_ID).then((p) => p && [...p])).toEqual([...png(1)]);
    await back.close();

    // ── copy: the maps land under the new world id, the original keeps its own ──
    const copy = await importWorldZip({ db, file: archive, mode: "copy", worldId: "w-fogcopy", root: new MemDirHandle() });
    cleanup.push("w-fogcopy");
    expect(copy.worldId).toBe("w-fogcopy");
    expect(copy.fogRecords).toBe(3);
    expect((await listFogForWorld(db, "w-fogcopy")).map((r) => r.userId).sort()).toEqual(["gm", "gm", "npub-rex"]);
    expect((await listFogForWorld(db, "w-fogfile")).length).toBe(3);
  });

  test("archives without fog.json import with no fog rows; a broken index is rejected", async () => {
    const root = new MemDirHandle();
    const db = await openVttDb();
    await HostPersister.createWorld(db, {
      worldId: "w-nofog" as HostApp["worldId"],
      name: "No fog",
      system: "mass-battle-basic",
      systemVersion: "1.0.0",
    });
    cleanup.push("w-nofog");
    const app = await bootWorld("w-nofog", root);
    const archive = new Uint8Array(
      await (await exportWorldZip({ db, worldId: app.worldId, root, persister: app.persister })).arrayBuffer(),
    );
    await app.close();
    const files = unzipSync(archive);
    // pre-D-250 shape: strip the fog entries
    const legacy: Record<string, Uint8Array> = {};
    for (const [k, v] of Object.entries(files)) if (k !== "fog.json" && !k.startsWith("fog/")) legacy[k] = v;
    const imported = await importWorldZip({ db, file: zipSync(legacy), root: new MemDirHandle() });
    expect(imported.fogRecords).toBe(0);

    const broken = { ...legacy, "fog.json": new TextEncoder().encode(JSON.stringify([{ sceneId: "s", userId: "u", file: "fog/0.png" }])) };
    await expect(importWorldZip({ db, file: zipSync(broken), root: new MemDirHandle() })).rejects.toThrow(/fog\/0\.png/);
  });
});
