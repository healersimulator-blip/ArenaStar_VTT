import "fake-indexeddb/auto";
import { describe, expect, test } from "vitest";
import { SaveCoordinator, SaveWork } from "../../src/storage/saveCoordinator";
import { HostPersister } from "../../src/storage/persistence";
import { openVttDb } from "../../src/storage/idb";
import { DocumentStore } from "../../src/core/store";
import { OpLog } from "../../src/core/oplog";

async function setup() {
  const db = await openVttDb();
  const meta = { worldId: crypto.randomUUID(), name: "Save tests", system: "basic", systemVersion: "1" };
  const persister = await HostPersister.createWorld(db, meta);
  await persister.attach(new DocumentStore({ meta }), new OpLog());
  return { saves: new SaveCoordinator(persister), persister, db };
}
function deferred() {
  let release = () => {};
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}

describe("quiet local save coordinator", () => {
  test("waits for preparation and active upload work before issuing a receipt; coalesces clicks", async () => {
    const { saves, persister, db } = await setup();
    const work = new SaveWork();
    const wait = deferred();
    let stored = false;
    const uploading = work.run(async () => { await wait.promise; stored = true; });
    saves.addDomain(() => work.drain());
    let prepared = false;
    saves.beforeSave(async () => { prepared = true; });
    const result = saves.saveNow();
    expect(saves.saveNow()).toBe(result);
    await Promise.resolve();
    expect(prepared).toBe(true);
    expect(saves.status.saving).toBe(true);
    expect(persister.status.lastSavedAt).toBeNull();
    wait.release();
    await uploading;
    const receipt = await result;
    expect(stored).toBe(true);
    expect(receipt.savedAt).toBeGreaterThan(0);
    expect(saves.status.saving).toBe(false);
    await persister.close(); db.close();
  });

  test("failed fog writes stay queued, are visible as one error, and retry the newest value", async () => {
    const { saves, persister, db } = await setup();
    let fail = true;
    let value = "";
    saves.write("fog", async () => { if (fail) throw new Error("quota exceeded"); value = "old"; });
    await expect(saves.saveNow()).rejects.toThrow("quota exceeded");
    expect(saves.status.error).toContain("quota exceeded");
    expect(saves.status.unsaved).toBe(true);
    fail = false;
    saves.write("fog", async () => { value = "latest"; });
    await saves.saveNow();
    expect(value).toBe("latest");
    expect(saves.status.error).toBeNull();
    expect(saves.status.unsaved).toBe(false);
    await persister.close(); db.close();
  });

  test("an older in-flight fog write cannot erase a newer queued write", async () => {
    const { saves, persister, db } = await setup();
    const wait = deferred();
    const values: string[] = [];
    saves.write("fog", async () => { await wait.promise; values.push("old"); });
    await Promise.resolve();
    saves.write("fog", async () => { values.push("new"); });
    wait.release();
    await saves.saveNow();
    expect(values).toEqual(["old", "new"]);
    await persister.close(); db.close();
  });

  test("failed canvas readback refuses the save without swallowing the error", async () => {
    const { saves, persister, db } = await setup();
    const unregister = saves.beforeSave(async () => { throw new Error("fog readback failed"); });
    await expect(saves.saveNow()).rejects.toThrow("fog readback failed");
    expect(persister.status.lastSavedAt).toBeNull();
    expect(saves.status.error).toBe("fog readback failed");
    unregister();
    await saves.saveNow();
    expect(saves.status.error).toBeNull();
    await persister.close(); db.close();
  });

  test("active domain rejection is not a successful save; later attempts can proceed", async () => {
    const { saves, persister, db } = await setup();
    let fail = true;
    saves.addDomain(async () => { if (fail) throw new Error("asset write failed"); });
    await expect(saves.saveNow()).rejects.toThrow("asset write failed");
    expect(saves.status.error).toBe("asset write failed");
    fail = false;
    await saves.saveNow();
    expect(saves.status.error).toBeNull();
    await persister.close(); db.close();
  });
});
