import { describe, expect, it } from "vitest";
import { openVttDb, putWorld } from "../../src/storage/idb";
import { exportWorldToFolder } from "../../src/host/worldFile";
import { MemDirHandle } from "../../src/storage/opfs";
import "fake-indexeddb/auto";

describe("File System Access API Save to Folder (§8)", () => {
  it("exports world metadata, documents, and assets to a folder handle", async () => {
    const db = await openVttDb();
    const worldId = "world-folder-1";

    await putWorld(db, {
      worldId,
      name: "Folder Test World",
      system: "mass-battle-basic",
      version: "1.0.0",
      lastOpened: Date.now(),
      flushedSeq: 5,
      oplogBase: 0,
    });

    const tx = db.transaction(["documents"], "readwrite");
    await tx.objectStore("documents").put({
      worldId,
      coll: "scenes",
      id: "scene-1",
      doc: {
        _id: "scene-1",
        type: "scene",
        name: "Main Scene",
        ownership: { default: 3 },
        flags: {},
        system: {},
      },
    });
    await tx.done;

    const memDir = new MemDirHandle();
    const result = await exportWorldToFolder({ db, worldId }, memDir);

    expect(result.filesCount).toBeGreaterThanOrEqual(3);
    expect(memDir.files.has("world.json")).toBe(true);
    expect(memDir.files.has("documents.json")).toBe(true);
    expect(memDir.files.has("assets.json")).toBe(true);
  });
});
