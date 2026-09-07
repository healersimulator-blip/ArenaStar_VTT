import "fake-indexeddb/auto";
import { describe, expect, test } from "vitest";
import { HostPersister } from "../../src/storage/persistence";
import { openVttDb, STORES, type WorldsRecord } from "../../src/storage/idb";
import { DocumentStore, type StoreMeta } from "../../src/core/store";
import { OpLog } from "../../src/core/oplog";
import { jsonEqual } from "../../src/core/diff";
import type { Op, OpEnvelope } from "../../src/core/ops";
import type { ActorDocument, SceneDocument, TokenDocument } from "../../src/core/documents";
import type { Json } from "../../src/core/documents";

import type { IDBPDatabase } from "idb";

/** World-scoped row count (the fake IDB is shared across tests in this file). */
async function countFor(db: IDBPDatabase, store: string, worldId: string): Promise<number> {
  const keys = (await db.getAllKeys(
    store,
    IDBKeyRange.bound([worldId], [worldId, []]),
  )) as IDBValidKey[];
  return keys.length;
}

const baseMeta: StoreMeta = {
  worldId: "w0",
  name: "World",
  system: "mass-battle-basic",
  systemVersion: "1.0.0",
};
let worldCounter = 0;

function sceneDoc(id: string): SceneDocument {
  return {
    _id: id,
    type: "scene",
    name: `Scene ${id}`,
    ownership: { default: 2 },
    flags: {},
    system: {},
    active: true,
    img: null,
    width: 100,
    height: 100,
    darkness: 0,
    grid: {
      type: "square",
      size: 100,
      distance: 5,
      units: "ft",
      diagonals: "555",
      hexLayout: "oddQ",
    },
    tokens: [],
    walls: [],
    lights: [],
    sounds: [],
    tiles: [],
    drawings: [],
    templates: [],
    notes: [],
  };
}

function actorDoc(id: string): ActorDocument {
  return {
    _id: id,
    type: "actor",
    name: `Actor ${id}`,
    ownership: { default: 0 },
    flags: {},
    system: {},
    items: [],
    effects: [],
  };
}

function tokenDoc(id: string, x = 0): TokenDocument {
  return {
    _id: id,
    type: "token",
    name: `Token ${id}`,
    ownership: { default: 0 },
    flags: {},
    system: {},
    x,
    y: 0,
    rotation: 0,
    width: 100,
    height: 100,
    img: "",
    hidden: false,
    disposition: "neutral",
    vision: true,
    light: { radius: 0, color: "#ffffff", alpha: 0.5 },
  };
}

let txCounter = 0;
function env(seq: number, ops: Op[]): OpEnvelope {
  txCounter += 1;
  return { seq, ts: 0, by: "gm-key", ops, txId: `tx-${txCounter}` };
}

const sceneRef = { coll: "scenes" as const, id: "s1" };
const tokenRef = (id: string) => ({ coll: "tokens" as const, id, parent: sceneRef });

/** Apply an envelope to store + in-memory log (the HostSync commit sequence). */
function commit(store: DocumentStore, log: OpLog, e: OpEnvelope): void {
  const res = store.applyEnvelope(e);
  if (!res.ok) throw new Error(res.error);
  const appended = log.append(e, res.value.inverses);
  if (!appended.ok) throw new Error(appended.error);
}

let seqCounter = 0;
function envOf(ops: Op[]): OpEnvelope {
  seqCounter += 1;
  return env(seqCounter, ops);
}

async function freshSetup(): Promise<{
  worldId: string;
  store: DocumentStore;
  log: OpLog;
  persister: HostPersister;
  db: Awaited<ReturnType<typeof openVttDb>>;
}> {
  worldCounter += 1;
  const worldId = `wt${worldCounter}`;
  seqCounter = 0;
  const db = await openVttDb();
  const meta: StoreMeta = { ...baseMeta, worldId };
  const persister = await HostPersister.createWorld(db, meta);
  const store = new DocumentStore({ meta });
  const log = new OpLog();
  await persister.attach(store, log);
  return { worldId, store, log, persister, db };
}

describe("HostPersister — write-behind (§8)", () => {
  test("oplog entry is durable immediately; documents only after flush", async () => {
    const { worldId, store, log, persister, db } = await freshSetup();
    commit(store, log, envOf([{ kind: "create", coll: "scenes", data: sceneDoc("s1") }]));

    // oplog written immediately (before any flush)
    await persister.drain();
    expect(await countFor(db, STORES.oplog, worldId)).toBe(1);
    // documents store still empty, flushedSeq still 0
    expect(await countFor(db, STORES.documents, worldId)).toBe(0);
    expect(persister.flushedSeq).toBe(0);

    await persister.flush();
    expect(await countFor(db, STORES.documents, worldId)).toBe(1);
    expect(persister.flushedSeq).toBe(1);

    await persister.close();
    db.close();
  });

  test("flush is batched: many envelopes → one flush writes all dirty roots", async () => {
    const { worldId, store, log, persister, db } = await freshSetup();
    commit(store, log, envOf([{ kind: "create", coll: "scenes", data: sceneDoc("s1") }]));
    commit(
      store,
      log,
      envOf([{ kind: "create", coll: "tokens", parent: sceneRef, data: tokenDoc("t1") }]),
    );
    commit(store, log, envOf([{ kind: "update", ref: tokenRef("t1"), diff: { x: 42 } }]));
    commit(
      store,
      log,
      envOf([{ kind: "create", coll: "tokens", parent: sceneRef, data: tokenDoc("t2") }]),
    );

    await persister.flush();
    // one scene root, not per-op copies of stale scenes
    expect(await countFor(db, STORES.documents, worldId)).toBe(1);
    const rec = await db.get(STORES.documents, [worldId, "scenes", "s1"]);
    const scene = rec?.doc as SceneDocument;
    expect(scene.tokens).toHaveLength(2);
    expect(scene.tokens[0]?.x).toBe(42);
    expect(persister.flushedSeq).toBe(4);

    await persister.close();
    db.close();
  });

  test("deleted documents are removed from the documents store on flush", async () => {
    const { worldId, store, log, persister, db } = await freshSetup();
    commit(store, log, envOf([{ kind: "create", coll: "scenes", data: sceneDoc("s1") }]));
    commit(store, log, envOf([{ kind: "create", coll: "actors", data: actorDoc("a1") }]));
    await persister.flush();
    expect(await countFor(db, STORES.documents, worldId)).toBe(2);

    commit(store, log, envOf([{ kind: "delete", ref: { coll: "actors", id: "a1" } }]));
    await persister.flush();
    expect(await countFor(db, STORES.documents, worldId)).toBe(1);
    expect(await db.get(STORES.documents, [worldId, "actors", "a1"])).toBeUndefined();

    await persister.close();
    db.close();
  });
});

describe("HostPersister — crash recovery / startup replay (§8)", () => {
  test("reopen without flush: documents at flushedSeq + oplog tail replayed", async () => {
    const { worldId, store, log, persister, db } = await freshSetup();
    commit(store, log, envOf([{ kind: "create", coll: "scenes", data: sceneDoc("s1") }]));
    await persister.flush(); // documents durable through seq 1
    commit(
      store,
      log,
      envOf([{ kind: "create", coll: "tokens", parent: sceneRef, data: tokenDoc("t1", 7) }]),
    );
    commit(
      store,
      log,
      envOf([{ kind: "update", ref: tokenRef("t1"), diff: { x: 99, "system.hp": 3 } }]),
    );
    await persister.drain(); // queued oplog writes complete…
    // CRASH: no flush(), no close() — seq 2–3 exist only in the oplog
    db.close();

    // Reopen fresh: the oplog tail must replay on top of the flushed documents.
    const db2 = await openVttDb();
    const reopened = await HostPersister.open(db2, worldId);
    const store2 = new DocumentStore({ meta: { ...baseMeta, worldId } });
    const log2 = new OpLog();
    await reopened.attach(store2, log2);

    expect(store2.seq).toBe(3);
    const scene = store2.get("scenes", "s1") as SceneDocument;
    expect(scene.tokens).toHaveLength(1);
    expect(scene.tokens[0]?.x).toBe(99);
    expect(scene.tokens[0]?.system.hp).toBe(3);
    expect(log2.lastSeq).toBe(3);
    expect(log2.baseSeq).toBe(1);

    await reopened.close();
    db2.close();
  });

  test("full crash-recovery round trip reproduces the identical world", async () => {
    const { worldId, store, log, persister, db } = await freshSetup();
    commit(store, log, envOf([{ kind: "create", coll: "scenes", data: sceneDoc("s1") }]));
    commit(
      store,
      log,
      envOf([{ kind: "create", coll: "tokens", parent: sceneRef, data: tokenDoc("t1") }]),
    );
    commit(store, log, envOf([{ kind: "update", ref: tokenRef("t1"), diff: { x: 5 } }]));
    commit(store, log, envOf([{ kind: "delete", ref: tokenRef("t1") }]));
    commit(store, log, envOf([{ kind: "update", ref: sceneRef, diff: { darkness: 0.5 } }]));
    await persister.drain();
    // CRASH: no flush, no close
    db.close();

    const db2 = await openVttDb();
    const reopened = await HostPersister.open(db2, worldId);
    const store2 = new DocumentStore({ meta: { ...baseMeta, worldId } });
    await reopened.attach(store2, new OpLog());
    expect(store2.seq).toBe(store.seq);
    expect(
      jsonEqual(store2.world.scenes as unknown as Json, store.world.scenes as unknown as Json),
    ).toBe(true);
    await reopened.close();
    db2.close();
  });
});

describe("HostPersister — checkpoint & compaction (§8)", () => {
  test("checkpoint rewrites documents, compacts the oplog, updates the base", async () => {
    const { worldId, store, log, persister, db } = await freshSetup();
    commit(store, log, envOf([{ kind: "create", coll: "scenes", data: sceneDoc("s1") }]));
    commit(
      store,
      log,
      envOf([{ kind: "create", coll: "tokens", parent: sceneRef, data: tokenDoc("t1", 8) }]),
    );
    await persister.checkpoint();

    expect(await countFor(db, STORES.oplog, worldId)).toBe(0); // compacted ≤ seq 2
    expect(await countFor(db, STORES.documents, worldId)).toBe(1); // full rewrite
    const world = await db.get(STORES.worlds, worldId);
    expect(world?.flushedSeq).toBe(2);
    expect(world?.oplogBase).toBe(2);
    expect(log.baseSeq).toBe(2);
    expect(log.size).toBe(0);

    // restart after checkpoint: loads cleanly with no tail
    db.close();
    const db2 = await openVttDb();
    const reopened = await HostPersister.open(db2, worldId);
    const store2 = new DocumentStore({ meta: { ...baseMeta, worldId } });
    const log2 = new OpLog();
    await reopened.attach(store2, log2);
    expect(store2.seq).toBe(2);
    expect((store2.get("scenes", "s1") as SceneDocument).tokens[0]?.x).toBe(8);
    expect(log2.lastSeq).toBe(2);

    // and new envelopes continue from the compacted base
    commit(store2, log2, envOf([{ kind: "update", ref: tokenRef("t1"), diff: { x: 10 } }]));
    await reopened.drain();
    expect(await countFor(db2, STORES.oplog, worldId)).toBe(1);
    await reopened.close();
    db2.close();
  });
});

describe("HostPersister — lifecycle", () => {
  test("createWorld rejects duplicates; open rejects unknown worlds", async () => {
    const db = await openVttDb();
    await HostPersister.createWorld(db, { ...baseMeta, worldId: "wdup" });
    await expect(HostPersister.createWorld(db, { ...baseMeta, worldId: "wdup" })).rejects.toThrow(
      /already exists/,
    );
    await expect(HostPersister.open(db, "ghost")).rejects.toThrow(/unknown world/);
    db.close();
  });

  test("close() performs a final flush and detaches", async () => {
    const { worldId, store, log, persister, db } = await freshSetup();
    commit(store, log, envOf([{ kind: "create", coll: "scenes", data: sceneDoc("s1") }]));
    await persister.close();
    expect(await countFor(db, STORES.documents, worldId)).toBe(1);
    // further envelopes are not persisted (detached)
    commit(store, log, envOf([{ kind: "update", ref: sceneRef, diff: { name: "X" } }]));
    await persister.flush();
    expect(await countFor(db, STORES.oplog, worldId)).toBe(1);
    db.close();
  });

  test("start() batches on an interval (500 ms default)", async () => {
    const { worldId, store, log, persister, db } = await freshSetup();
    persister.start();
    try {
      commit(store, log, envOf([{ kind: "create", coll: "scenes", data: sceneDoc("s1") }]));
      expect(await countFor(db, STORES.documents, worldId)).toBe(0);
      await new Promise((resolve) => setTimeout(resolve, 650));
      expect(await countFor(db, STORES.documents, worldId)).toBe(1);
    } finally {
      await persister.close();
      db.close();
    }
  });
  test("patchWorld survives the next flush; a direct putWorld does not (§12 activation)", async () => {
    // The §12 world-record fields (activeRulesPackage, trustedPackages, migration version) are
    // written while the persister is live, and every flush rewrites the persister's OWN cached
    // record — which used to silently revert an activation on the next write-behind tick.
    const { worldId, store, log, persister, db } = await freshSetup();
    commit(store, log, envOf([{ kind: "create", coll: "scenes", data: sceneDoc("s1") }]));
    await persister.flush();
    const cached = { ...(await db.get(STORES.worlds, worldId)) } as WorldsRecord;

    // (1) bypassing the persister: the write lands, then a plain flush loses it
    await db.put(STORES.worlds, { ...cached, activeRulesPackage: "bypass" });
    expect((await db.get(STORES.worlds, worldId))?.activeRulesPackage).toBe("bypass");
    await persister.flush();
    expect((await db.get(STORES.worlds, worldId))?.activeRulesPackage).toBeUndefined();

    // (2) through patchWorld: it updates the cached record, so flushes keep it
    await persister.patchWorld({ activeRulesPackage: "pf1e-mass-battles" });
    await persister.flush();
    expect((await db.get(STORES.worlds, worldId))?.activeRulesPackage).toBe("pf1e-mass-battles");

    // (3) clearing a key deletes it rather than storing undefined (package deactivation)
    await persister.patchWorld({ activeRulesPackage: undefined });
    const cleared = await db.get(STORES.worlds, worldId);
    expect(cleared).not.toHaveProperty("activeRulesPackage");

    // (4) the flush-owned fields stay untouched by a patch
    const before = (await db.get(STORES.worlds, worldId)) as WorldsRecord;
    await persister.patchWorld({ name: "Renamed" });
    const after = (await db.get(STORES.worlds, worldId)) as WorldsRecord;
    expect(after.name).toBe("Renamed");
    expect(after.flushedSeq).toBe(before.flushedSeq);
    expect(after.oplogBase).toBe(before.oplogBase);

    await persister.close();
    db.close();
  });
});
