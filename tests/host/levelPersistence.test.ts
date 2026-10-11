import "fake-indexeddb/auto";
import { expect, test } from "vitest";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { draftLevel } from "../../src/core/levels";
import { planDuplicateSceneOps } from "../../src/core/sceneCopy";
import { openVttDb, deleteWorldData, getWorld } from "../../src/storage/idb";
import { MemDirHandle } from "../../src/storage/opfs";
import { DRAFT_LEVELS_FEATURE, exportWorldZip, importWorldZip } from "../../src/host/worldFile";
import { DEFAULT_SCENE_ID } from "../../src/app/hostBoot";
import { boot, settle } from "../app/fakes";

function json(entries: Record<string, Uint8Array>, name: string) {
  const data = entries[name]; if (!data) throw new Error(`missing ${name}`);
  return JSON.parse(strFromU8(data));
}

test("drafts survive save/reopen and scene/ZIP copy; format 3 prevents unsupported archive downgrade", async () => {
  const db = await openVttDb(), root = new MemDirHandle(), app = await boot(root);
  const archive = () => exportWorldZip({ db, root, worldId: app.worldId, persister: app.persister });
  const legacy = unzipSync(new Uint8Array(await (await archive()).arrayBuffer()));
  expect(json(legacy, "world.json").format).toBe(2);
  const base = draftLevel("draft-base", "Ground", 0, 10), upper = draftLevel("draft-upper", "Upper", 10, 20, 1);
  base.visibleLevelIds = [upper._id];
  app.gm.client.submit([base, upper].map((data) => ({ kind: "create" as const, coll: "levels" as const, parent: { coll: "scenes" as const, id: DEFAULT_SCENE_ID }, data })));
  await settle();
  const source = app.store.get("scenes", DEFAULT_SCENE_ID); if (!source) throw new Error("source");
  expect(source.levels).toEqual([base, upper]);
  const planned = planDuplicateSceneOps({ scene: source, id: "copied-scene" });
  if (!planned.ok) throw new Error(planned.error);
  app.gm.client.submit(planned.ops); await settle();
  const file = await archive(), worldId = app.worldId;
  const entries = unzipSync(new Uint8Array(await file.arrayBuffer()));
  expect(json(entries, "world.json")).toMatchObject({ format: 3, requiredFeatures: [DRAFT_LEVELS_FEATURE] });
  await app.close();
  const reopened = await boot(root, worldId);
  expect(reopened.store.get("scenes", DEFAULT_SCENE_ID)?.levels).toEqual([base, upper]);
  await reopened.close();
  const copy = await importWorldZip({ db, root, file, mode: "copy", worldId: "level-copy" });
  const copied = await boot(root, copy.worldId);
  expect(copied.store.get("scenes", DEFAULT_SCENE_ID)?.levels).toEqual([base, upper]);
  expect(copied.store.get("scenes", "copied-scene")?.levels).toEqual(planned.copy.levels);
  await copied.close();
  for (const variant of ["downgrade", "unknown-capability", "malformed"] as const) {
    const changed = { ...entries }, meta = json(changed, "world.json");
    if (variant === "downgrade") { meta.format = 2; delete meta.requiredFeatures; }
    else if (variant === "unknown-capability") meta.requiredFeatures = ["future-sealed-floors"];
    else {
      const docs = json(changed, "documents.json");
      docs.docs.find((r: { coll: string; id: string }) => r.coll === "scenes" && r.id === DEFAULT_SCENE_ID).doc.levels[0].top = 15;
      changed["documents.json"] = strToU8(JSON.stringify(docs));
    }
    changed["world.json"] = strToU8(JSON.stringify(meta));
    const badId = `level-bad-${variant}`;
    await expect(importWorldZip({ db, root, file: new Blob([new Uint8Array(zipSync(changed))]), mode: "copy", worldId: badId })).rejects.toThrow(variant === "malformed" ? /overlap/ : /format 3/);
    expect(await getWorld(db, badId)).toBeUndefined();
  }
  await deleteWorldData(db, worldId); await deleteWorldData(db, copy.worldId); db.close();
});

test("scoped wall archives require their own capability and survive reopen/import", async () => {
  const { LEVEL_SCOPES_FEATURE } = await import("../../src/core/capabilities");
  const { wallFieldsFor } = await import("../../src/canvas/vision/wallKinds");
  const db = await openVttDb(), root = new MemDirHandle(), app = await boot(root);
  const worldId = app.worldId, parent = { coll: "scenes" as const, id: DEFAULT_SCENE_ID };
  await app.gm.client.submitAndWait([
    { kind: "create", coll: "levels", parent, data: draftLevel("base", "Base") },
    { kind: "create", coll: "walls", parent, data: { _id: "scoped", type: "wall", name: "Scoped", flags: {}, system: {}, ownership: { default: 0 }, ...wallFieldsFor("wall", [0, 0, 100, 0]), levelScope: { mode: "levels", ids: ["base"] } } as never },
  ]);
  const file = await exportWorldZip({ db, root, worldId, persister: app.persister });
  const entries = unzipSync(new Uint8Array(await file.arrayBuffer()));
  expect(json(entries, "world.json").requiredFeatures).toEqual([DRAFT_LEVELS_FEATURE, LEVEL_SCOPES_FEATURE]);
  await app.close();
  const reopened = await boot(root, worldId);
  expect(reopened.store.get("scenes", DEFAULT_SCENE_ID)?.walls[0]?.levelScope).toEqual({ mode: "levels", ids: ["base"] });
  await reopened.close();
  const copied = await importWorldZip({ db, root, file, mode: "copy", worldId: "scopes-copy" });
  const copyApp = await boot(root, copied.worldId);
  expect(copyApp.store.get("scenes", DEFAULT_SCENE_ID)?.walls[0]?.levelScope).toEqual({ mode: "levels", ids: ["base"] });
  await copyApp.close();
  const meta = json(entries, "world.json"); meta.requiredFeatures = [DRAFT_LEVELS_FEATURE];
  entries["world.json"] = strToU8(JSON.stringify(meta));
  await expect(importWorldZip({ db, root, file: new Blob([new Uint8Array(zipSync(entries))]), mode: "copy", worldId: "scopes-invalid" })).rejects.toThrow("missing required scene feature");
  expect(await getWorld(db, "scopes-invalid")).toBeUndefined();
  await deleteWorldData(db, worldId); await deleteWorldData(db, copied.worldId); db.close();
});

test("ambient overrides persist and archives reject a missing ambient capability before writing", async () => {
  const { LEVEL_AMBIENT_FEATURE } = await import("../../src/core/capabilities");
  const db = await openVttDb(), root = new MemDirHandle(), app = await boot(root), worldId = app.worldId;
  const level = { ...draftLevel("dark", "Dark"), darkness: 1 };
  await app.gm.client.submitAndWait([{ kind: "create", coll: "levels", parent: { coll: "scenes", id: DEFAULT_SCENE_ID }, data: level }]);
  const file = await exportWorldZip({ db, root, worldId, persister: app.persister });
  const entries = unzipSync(new Uint8Array(await file.arrayBuffer()));
  expect(json(entries, "world.json").requiredFeatures).toEqual([DRAFT_LEVELS_FEATURE, LEVEL_AMBIENT_FEATURE]);
  await app.close(); const reopened = await boot(root, worldId);
  expect(reopened.store.get("scenes", DEFAULT_SCENE_ID)?.levels?.[0]?.darkness).toBe(1); await reopened.close();
  const copied = await importWorldZip({ db, root, file, mode: "copy", worldId: "ambient-copy" });
  const copy = await boot(root, copied.worldId); expect(copy.store.get("scenes", DEFAULT_SCENE_ID)?.levels?.[0]?.darkness).toBe(1); await copy.close();
  const meta = json(entries, "world.json"); meta.requiredFeatures = [DRAFT_LEVELS_FEATURE]; entries["world.json"] = strToU8(JSON.stringify(meta));
  await expect(importWorldZip({ db, root, file: new Blob([new Uint8Array(zipSync(entries))]), mode: "copy", worldId: "ambient-invalid" })).rejects.toThrow("missing required scene feature");
  expect(await getWorld(db, "ambient-invalid")).toBeUndefined();
  await deleteWorldData(db, worldId); await deleteWorldData(db, copied.worldId); db.close();
});
