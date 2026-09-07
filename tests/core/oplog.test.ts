import { describe, expect, test } from "vitest";
import { OpLog, computeInverse, replayLog } from "../../src/core/oplog";
import { DocumentStore, type StoreMeta } from "../../src/core/store";
import type { Op, OpEnvelope } from "../../src/core/ops";
import type { SceneDocument, TokenDocument } from "../../src/core/documents";
import { jsonEqual } from "../../src/core/diff";

const meta: StoreMeta = { worldId: "w1", name: "World", system: "x", systemVersion: "1" };

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

/** Apply env to store AND append to log with the store-captured inverses. */
function commit(store: DocumentStore, log: OpLog, e: OpEnvelope) {
  const res = store.applyEnvelope(e);
  if (!res.ok) throw new Error(res.error);
  const appended = log.append(e, res.value.inverses);
  if (!appended.ok) throw new Error(appended.error);
  return res.value;
}

describe("OpLog (§5, §8)", () => {
  test("append enforces monotonic seq", () => {
    const log = new OpLog();
    expect(log.append(env(1, [])).ok).toBe(true);
    expect(log.append(env(3, [])).ok).toBe(false);
    expect(log.append(env(1, [])).ok).toBe(false);
    expect(log.append(env(2, [])).ok).toBe(true);
    expect(log.lastSeq).toBe(2);
  });

  test("since() returns only newer envelopes (late join, §5)", () => {
    const log = new OpLog();
    for (let seq = 1; seq <= 5; seq++)
      log.append(env(seq, [{ kind: "update", ref: sceneRef, diff: { name: `n${seq}` } }]));
    expect(log.since(3).map((e) => e.seq)).toEqual([4, 5]);
    expect(log.since(0).map((e) => e.seq)).toEqual([1, 2, 3, 4, 5]);
    expect(log.since(5)).toEqual([]);
  });

  test("compact() drops superseded entries and tracks baseSeq", () => {
    const log = new OpLog();
    for (let seq = 1; seq <= 5; seq++) log.append(env(seq, []));
    log.compact(3);
    expect(log.size).toBe(2);
    expect(log.baseSeq).toBe(3);
    expect(log.lastSeq).toBe(5);
    expect(log.since(0).map((e) => e.seq)).toEqual([4, 5]);
    log.compact(2); // no-op (already past)
    expect(log.baseSeq).toBe(3);
  });

  test("undo of an update restores the previous value via pre-images", () => {
    const store = new DocumentStore({ meta });
    const log = new OpLog();
    commit(store, log, env(1, [{ kind: "create", coll: "scenes", data: sceneDoc("s1") }]));
    commit(store, log, env(2, [{ kind: "update", ref: sceneRef, diff: { name: "Renamed" } }]));
    expect(store.get("scenes", "s1")?.name).toBe("Renamed");

    const last = log.lastInverse();
    expect(last?.undoOf).toBe(2);
    const undoEnv = env(3, last?.ops ?? []);
    expect(store.applyEnvelope(undoEnv).ok).toBe(true);
    expect(store.get("scenes", "s1")?.name).toBe("Scene s1");
  });

  test("undo of a create deletes; undo of a (embedded) delete recreates", () => {
    const store = new DocumentStore({ meta });
    const log = new OpLog();
    commit(store, log, env(1, [{ kind: "create", coll: "scenes", data: sceneDoc("s1") }]));
    commit(
      store,
      log,
      env(2, [{ kind: "create", coll: "tokens", parent: sceneRef, data: tokenDoc("t1", 42) }]),
    );

    // undo the token create (as a real envelope, logged like HostSync would)
    commit(store, log, env(3, log.lastInverse()?.ops ?? []));
    expect(store.get("scenes", "s1")?.tokens).toHaveLength(0);

    // a delete whose inverse recreates
    commit(
      store,
      log,
      env(4, [{ kind: "create", coll: "tokens", parent: sceneRef, data: tokenDoc("t1", 42) }]),
    );
    commit(store, log, env(5, [{ kind: "delete", ref: tokenRef("t1") }]));
    commit(store, log, env(6, log.lastInverse()?.ops ?? []));
    expect(store.get("scenes", "s1")?.tokens[0]?.x).toBe(42);
  });

  test("multi-op envelope undo applies inverses reversed", () => {
    const store = new DocumentStore({ meta });
    const log = new OpLog();
    commit(store, log, env(1, [{ kind: "create", coll: "scenes", data: sceneDoc("s1") }]));
    commit(
      store,
      log,
      env(2, [
        { kind: "update", ref: sceneRef, diff: { name: "A" } },
        { kind: "update", ref: sceneRef, diff: { name: "B", darkness: 0.5 } },
      ]),
    );
    store.applyEnvelope(env(3, log.lastInverse()?.ops ?? []));
    expect(store.get("scenes", "s1")?.name).toBe("Scene s1");
    expect(store.get("scenes", "s1")?.darkness).toBe(0);
  });

  test("computeInverse: no-op updates have no inverse", () => {
    const store = new DocumentStore({ meta });
    store.applyEnvelope(env(1, [{ kind: "create", coll: "scenes", data: sceneDoc("s1") }]));
    const inverse = computeInverse(store, {
      kind: "update",
      ref: sceneRef,
      diff: { "-=system.ghost": null },
    });
    expect(inverse).toBeNull();
  });

  test("replayLog reproduces an identical world (§8 startup / M1 acceptance)", () => {
    const storeA = new DocumentStore({ meta });
    const log = new OpLog();
    commit(storeA, log, env(1, [{ kind: "create", coll: "scenes", data: sceneDoc("s1") }]));
    commit(
      storeA,
      log,
      env(2, [{ kind: "create", coll: "tokens", parent: sceneRef, data: tokenDoc("t1") }]),
    );
    commit(
      storeA,
      log,
      env(3, [{ kind: "update", ref: tokenRef("t1"), diff: { x: 313, "system.hp": 2 } }]),
    );
    commit(storeA, log, env(4, [{ kind: "delete", ref: tokenRef("t1") }]));
    commit(storeA, log, env(5, [{ kind: "update", ref: sceneRef, diff: { darkness: 0.8 } }]));

    const storeB = new DocumentStore({ meta });
    expect(replayLog(storeB, log).ok).toBe(true);
    expect(storeB.seq).toBe(storeA.seq);
    expect(jsonEqual(storeB.world.scenes as never, storeA.world.scenes as never)).toBe(true);
  });

  test("replayLog surfaces the first rejected envelope", () => {
    const store = new DocumentStore({ meta });
    const log = new OpLog();
    log.append(env(1, [{ kind: "update", ref: sceneRef, diff: { name: "X" } }])); // ref doesn't exist
    const res = replayLog(store, log);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toContain("seq=1");
  });
});
