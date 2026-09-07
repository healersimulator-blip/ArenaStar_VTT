import "fake-indexeddb/auto";
import { afterAll, describe, expect, test } from "vitest";
import { openVttDb, type WorldsRecord } from "../../src/storage/idb";
import {
  CHECKPOINT_RECENT_TURNS,
  CHECKPOINT_STRIDE,
  SIMDELTA_RING,
  applyCheckpointRetention,
  decodeReport,
  encodeReport,
  getReport,
  latestCheckpoint,
  listCheckpoints,
  listDeltas,
  listReports,
  putCheckpoint,
  putDelta,
  putReport,
  type CheckpointRecord,
} from "../../src/storage/strategicStore";
import type { TurnReport } from "../../src/core/sim";

const dbs: Array<Awaited<ReturnType<typeof openVttDb>>> = [];
const db = async (): Promise<Awaited<ReturnType<typeof openVttDb>>> => {
  const d = await openVttDb();
  dbs.push(d);
  return d;
};

afterAll(async () => {
  for (const d of dbs) d.close();
});

const cp = (slot: number, worldId = "w1", sceneId = "s1"): CheckpointRecord => ({
  worldId,
  sceneId,
  slot,
  turnNumber: slot,
  tick: null,
  pool: new Uint8Array([slot & 0xff]),
  maxHpMax: 4,
  version: slot,
  unitStats: {},
  seed: slot,
  rulesVersion: "1.0.0",
  hash: `hash-${slot}`,
});

const report = (turn: number): TurnReport => ({
  turn,
  sceneId: "s1",
  subPhases: ["move", "shoot"],
  events: [
    { subPhase: "move", type: "arrive", unitId: "u1", text: `turn ${turn} move` },
    { subPhase: "shoot", type: "attack", unitId: "u1", targetUnitId: "u2", text: "loose" },
  ],
  summary: { events: 2 },
  rulesVersion: "1.0.0",
});

describe("§8A checkpoints store", () => {
  test("put + latest + list round-trips by [worldId, sceneId, slot]", async () => {
    const d = await db();
    await putCheckpoint(d, cp(1, "wA"));
    await putCheckpoint(d, cp(2, "wA"));
    await putCheckpoint(d, cp(9, "wA"));
    await putCheckpoint(d, cp(3, "wA", "s2")); // different scene, excluded
    const latest = await latestCheckpoint(d, "wA", "s1");
    expect(latest?.slot).toBe(9);
    expect(latest?.hash).toBe("hash-9");
    const all = await listCheckpoints(d, "wA", "s1");
    expect(all.map((r) => r.slot)).toEqual([1, 2, 9]);
  });

  test(`retention: keep last ${CHECKPOINT_RECENT_TURNS} turns, then every ${CHECKPOINT_STRIDE}th`, async () => {
    const d = await db();
    // turns 1..30 exist; current turn 30 → recent = 21..30 all kept,
    // 1..20 kept only when divisible by 5
    for (let t = 1; t <= 30; t++) await putCheckpoint(d, cp(t, "wR"));
    const removed = await applyCheckpointRetention(d, "wR", "s1", 30);
    expect(removed).toBe(16); // 20 old − 4 strides (5,10,15,20)
    const kept = (await listCheckpoints(d, "wR", "s1")).map((r) => r.turnNumber);
    expect(kept).toEqual([5, 10, 15, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30]);
  });
});

describe("§8A turnReports store (compressed JSON)", () => {
  test("round-trips a TurnReport byte-exact via fflate", async () => {
    const d = await db();
    const r = report(4);
    const bytes = encodeReport(r);
    expect(decodeReport(bytes)).toEqual(r);
    await putReport(d, "wT", "s1", r);
    const got = await getReport(d, "wT", "s1", 4);
    expect(got).toEqual(r);
    expect(await getReport(d, "wT", "s1", 5)).toBeNull();
    await putReport(d, "wT", "s1", report(5));
    const list = await listReports(d, "wT", "s1");
    expect(list.map((x) => x.turn)).toEqual([4, 5]);
  });
});

describe("§8A simdeltas ring buffer", () => {
  test(`prunes to the last ${SIMDELTA_RING} versions per scene`, async () => {
    const d = await db();
    for (let v = 1; v <= SIMDELTA_RING + 10; v++) {
      await putDelta(d, {
        worldId: "wD",
        sceneId: "s1",
        version: v,
        bytes: new Uint8Array([v & 0xff]),
        maxHpMax: 4,
        at: v,
      });
    }
    const kept = await listDeltas(d, "wD", "s1");
    expect(kept.length).toBe(SIMDELTA_RING);
    expect(kept[0]?.version).toBe(11);
    expect(kept[kept.length - 1]?.version).toBe(SIMDELTA_RING + 10);
  });
});

describe("DB v3 upgrade", () => {
  test("worlds store still works alongside the new stores", async () => {
    const d = await db();
    const rec: WorldsRecord = {
      worldId: "wX",
      name: "X",
      system: "mass-battle-basic",
      version: "1",
      lastOpened: 1,
      flushedSeq: 0,
      oplogBase: 0,
    };
    await d.put("worlds", rec);
    expect(await d.get("worlds", "wX")).toEqual(rec);
    expect(d.objectStoreNames.contains("checkpoints")).toBe(true);
    expect(d.objectStoreNames.contains("turnReports")).toBe(true);
    expect(d.objectStoreNames.contains("simdeltas")).toBe(true);
  });
});
