import "fake-indexeddb/auto";
import { openDB, deleteDB } from "idb";
import { expect, test } from "vitest";
import { DB_NAME, openVttDb, getFog, putFog, listFogForWorld, deleteWorldData } from "../../src/storage/idb";

test("v4 upgrade preserves legacy fog without spreading it into new floors", async () => {
  await deleteDB(DB_NAME);
  const old = await openDB(DB_NAME, 4, { upgrade(db) { db.createObjectStore("fog", { keyPath: ["worldId", "sceneId", "userId"] }); } });
  await old.put("fog", { worldId: "w", sceneId: "s", userId: "u", png: new Uint8Array([7]) }); old.close();
  const db = await openVttDb();
  expect((await getFog(db, "w", "s", "u"))?.png).toEqual(new Uint8Array([7]));
  expect(await getFog(db, "w", "s", "u", "upper")).toBeUndefined();
  await putFog(db, { worldId: "w", sceneId: "s", userId: "u", levelId: "upper", png: new Uint8Array([9]) });
  expect(await listFogForWorld(db, "w")).toHaveLength(2);
  await deleteWorldData(db, "w"); expect(await listFogForWorld(db, "w")).toEqual([]); db.close();
});
