/* eslint-disable @typescript-eslint/no-non-null-assertion -- explicit fixtures and required renderer readbacks; absence fails the test */
import "fake-indexeddb/auto";
import { expect, test } from "vitest";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import type { RegionDocument } from "../../src/core/documents";
import { planDuplicateSceneOps } from "../../src/core/sceneCopy";
import { openVttDb, deleteWorldData } from "../../src/storage/idb";
import { MemDirHandle } from "../../src/storage/opfs";
import { exportWorldZip, importWorldZip } from "../../src/host/worldFile";
import { DEFAULT_SCENE_ID } from "../../src/app/hostBoot";
import { boot, settle } from "../app/fakes";

test("native cover survives scene copy, save/reopen and ZIP copy; malformed imported covers are rejected", async () => {
  const db = await openVttDb(),
    root = new MemDirHandle();
  const app = await boot(root);
  const region: RegionDocument = {
    _id: "roof",
    type: "region",
    name: "Bridge cover",
    ownership: { default: 1 },
    flags: {},
    system: {},
    x: 0,
    y: 0,
    width: 100,
    height: 100,
    shape: {
      kind: "polygon",
      points: [
        [0, 0],
        [1, 0],
        [1, 1],
        [0, 1],
      ],
    },
    fauxOverhead: {
      kind: "fauxOverhead",
      coverZ: 12,
      affectedElevation: { bottom: -2, top: 10 },
      footprint: {
        version: 2,
        components: [
          {
            outer: [
              { x: 0, y: 0 },
              { x: 1, y: 0 },
              { x: 1, y: 1 },
              { x: 0, y: 1 },
            ],
            holes: [
              [
                { x: 0.2, y: 0.2 },
                { x: 0.8, y: 0.2 },
                { x: 0.8, y: 0.8 },
                { x: 0.2, y: 0.8 },
              ],
            ],
          },
        ],
      },
    },
  };
  app.gm.client.submit([
    {
      kind: "create",
      coll: "regions",
      parent: { coll: "scenes", id: DEFAULT_SCENE_ID },
      data: region,
    },
  ]);
  await settle();
  const source = app.store.get("scenes", DEFAULT_SCENE_ID)!;
  const plan = planDuplicateSceneOps({ scene: source, id: "copy-native" });
  expect(plan.ok).toBe(true);
  if (!plan.ok) throw new Error(plan.error);
  expect(plan.copy.regions![0]!._id).not.toBe(region._id);
  expect(plan.copy.regions![0]!.fauxOverhead).toEqual(region.fauxOverhead);
  app.gm.client.submit(plan.ops);
  await settle();
  const archive = await exportWorldZip({
    db,
    root,
    worldId: app.worldId,
    persister: app.persister,
  });
  const worldId = app.worldId;
  await app.close();
  const reopened = await boot(root, worldId);
  expect(reopened.store.get("scenes", DEFAULT_SCENE_ID)?.regions?.[0]).toEqual(
    region,
  );
  await reopened.close();
  const copied = await importWorldZip({
    db,
    root,
    file: archive,
    mode: "copy",
    worldId: "w-native-overhead-copy",
  });
  const copy = await boot(root, copied.worldId);
  expect(
    copy.store.get("scenes", "copy-native")?.regions?.[0]?.fauxOverhead,
  ).toEqual(region.fauxOverhead);
  await copy.close();
  const entries = unzipSync(new Uint8Array(await archive.arrayBuffer()));
  const docs = JSON.parse(strFromU8(entries["documents.json"]!));
  docs.docs.find(
    (r: { coll: string; id: string }) =>
      r.coll === "scenes" && r.id === DEFAULT_SCENE_ID,
  ).doc.regions[0].fauxOverhead.footprint.components[0].outer[0].x = -1;
  entries["documents.json"] = strToU8(JSON.stringify(docs));
  const bad = zipSync(entries);
  await expect(
    importWorldZip({
      db,
      root,
      file: new Blob([new Uint8Array(bad)]),
      mode: "copy",
      worldId: "w-native-bad",
    }),
  ).rejects.toThrow("normalized");
  await deleteWorldData(db, worldId);
  await deleteWorldData(db, copied.worldId);
  db.close();
});
