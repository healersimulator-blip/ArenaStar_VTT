import "fake-indexeddb/auto";
import { describe, expect, test } from "vitest";
import {
  DB_NAME,
  DB_VERSION,
  STORES,
  deleteWorldData,
  getAllSettings,
  getFog,
  getSetting,
  getWorld,
  listWorlds,
  openVttDb,
  putFog,
  putSetting,
  putWorld,
  type WorldsRecord,
} from "../../src/storage/idb";

function world(n: number, flushedSeq = 0): WorldsRecord {
  return {
    worldId: `w${n}`,
    name: `World ${n}`,
    system: "mass-battle-basic",
    version: "1.0.0",
    lastOpened: n,
    flushedSeq,
    oplogBase: 0,
  };
}

describe("IndexedDB vtt schema (§8)", () => {
  test("opens with the §8 stores plus the §7 assets store at DB_VERSION", async () => {
    const db = await openVttDb();
    expect(db.name).toBe(DB_NAME);
    expect(db.version).toBe(DB_VERSION);
    for (const store of Object.values(STORES)) {
      expect(db.objectStoreNames.contains(store), store).toBe(true);
    }
    db.close();
  });

  test("worlds: put/get/list (sorted by lastOpened desc)", async () => {
    const db = await openVttDb();
    await putWorld(db, world(1));
    await putWorld(db, world(2));
    await putWorld(db, world(3));
    expect((await getWorld(db, "w2"))?.name).toBe("World 2");
    expect((await listWorlds(db)).map((w) => w.worldId)).toEqual(["w3", "w2", "w1"]);
    db.close();
  });

  test("fog: keyed [worldId, sceneId, userId], bytes survive", async () => {
    const db = await openVttDb();
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
    await putFog(db, { worldId: "w1", sceneId: "s1", userId: "u1", png });
    const back = await getFog(db, "w1", "s1", "u1");
    expect([...(back?.png ?? [])]).toEqual([...png]);
    expect(await getFog(db, "w1", "s1", "u2")).toBeUndefined();
    db.close();
  });

  test("settings: scope/key records round-trip and filter by scope", async () => {
    const db = await openVttDb();
    await putSetting(db, { scope: "client", key: "theme", value: "dark" });
    await putSetting(db, { scope: "world", key: "time", value: 2 });
    expect((await getSetting(db, "client", "theme"))?.value).toBe("dark");
    expect(await getAllSettings(db, "world").then((r) => r.map((x) => x.key))).toEqual(["time"]);
    db.close();
  });

  test("deleteWorldData removes world + all scoped rows", async () => {
    const db = await openVttDb();
    await putWorld(db, world(1));
    await putFog(db, { worldId: "w1", sceneId: "s1", userId: "u1", png: new Uint8Array([1]) });
    await db.put(STORES.documents, { worldId: "w1", coll: "scenes", id: "s1", doc: {} as never });
    await db.put(STORES.oplog, { worldId: "w1", seq: 1, env: {} as never, inverses: [] });
    await deleteWorldData(db, "w1");
    expect(await getWorld(db, "w1")).toBeUndefined();
    expect(await getFog(db, "w1", "s1", "u1")).toBeUndefined();
    expect(await db.count(STORES.documents)).toBe(0);
    expect(await db.count(STORES.oplog)).toBe(0);
    db.close();
  });
});
