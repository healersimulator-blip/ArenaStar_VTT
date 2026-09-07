import "fake-indexeddb/auto";
import { afterAll, describe, expect, test } from "vitest";
import type { IDBPDatabase } from "idb";
import { openVttDb } from "../../src/storage/idb";
import { SimBridge } from "../../src/host/simBridge";
import { InlineSimRunner } from "../../src/workers/simWorkerClient";
import { getReport, latestCheckpoint, listDeltas } from "../../src/storage/strategicStore";
import { MASS_BATTLE_SCHEMA_COLUMNS } from "../../src/packages/massBattleBasic";
import type { RulesContext, UnitView } from "../../src/core/rules";
import { allocModel, createModelPool } from "../../src/sim/pool";
import {
  applySimDelta,
  decodeSimDelta,
  decodeSimSnapshot,
  encodeSimSnapshot,
  poolFromSnapshot,
  snapshotFromPool,
} from "../../src/sim/codec";
import type { ModelPool, OrderQueue } from "../../src/core/strategic";
import { hashPool } from "../../src/sim/pool";

const dbs: IDBPDatabase[] = [];
const newDb = async (): Promise<IDBPDatabase> => {
  const d = await openVttDb();
  dbs.push(d);
  return d;
};
afterAll(() => {
  for (const d of dbs) d.close();
});

const ctx = (): RulesContext => ({
  sceneId: "scene-1",
  grid: { type: "square", size: 100, distance: 1, units: "sq", diagonals: "5105" },
  walls: {
    x1: new Float32Array(0),
    y1: new Float32Array(0),
    x2: new Float32Array(0),
    y2: new Float32Array(0),
    restriction: new Uint8Array(0),
  },
  factions: [
    {
      _id: "f-red",
      type: "faction",
      name: "red",
      ownership: { default: 3 },
      flags: {},
      system: {},
      color: "#f00",
      allies: [],
    },
    {
      _id: "f-blue",
      type: "faction",
      name: "blue",
      ownership: { default: 3 },
      flags: {},
      system: {},
      color: "#00f",
      allies: [],
    },
  ],
  armies: [
    {
      _id: "army-red",
      type: "army",
      name: "Red",
      ownership: { default: 3 },
      flags: {},
      system: {},
      factionId: "f-red",
      commander: [],
      supply: { level: 1 },
      units: [],
    },
    {
      _id: "army-blue",
      type: "army",
      name: "Blue",
      ownership: { default: 3 },
      flags: {},
      system: {},
      factionId: "f-blue",
      commander: [],
      supply: { level: 1 },
      units: [],
    },
  ],
  leaderActors: {},
  worldSettings: {},
});

const unitView = (id: string, factionId: string, armyId: string, type: string): UnitView => ({
  id,
  armyId,
  factionId,
  type,
  name: id,
  profile: {},
  stats: {},
  orders: null,
  formation: "line",
  sceneId: "scene-1",
  modelRange: null,
  leaderTokenId: null,
});

/** Seed pool snapshot bytes for two opposed units in shooting range. */
function seedSnapshot(): { bytes: Uint8Array; maxHpMax: number; units: UnitView[] } {
  const pool: ModelPool = createModelPool(64, MASS_BATTLE_SCHEMA_COLUMNS);
  const red = unitView("u-red", "f-red", "army-red", "infantry");
  const blue = unitView("u-blue", "f-blue", "army-blue", "infantry");
  const units = [red, blue];
  for (let i = 0; i < 10; i++) {
    allocModel(pool, {
      id: i + 1,
      unitIdx: 0,
      x: i * 0.2,
      y: 0,
      hp: 1,
      hpMax: 1,
      sys: { ammo: 6 },
    });
  }
  for (let i = 0; i < 10; i++) {
    allocModel(pool, {
      id: 101 + i,
      unitIdx: 1,
      x: 0.5 + i * 0.2,
      y: 0.3,
      hp: 1,
      hpMax: 1,
      sys: { ammo: 6 },
    });
  }
  red.modelRange = [0, 10];
  blue.modelRange = [10, 20];
  const bytes = encodeSimSnapshot(
    snapshotFromPool(pool, "scene-1", 0, MASS_BATTLE_SCHEMA_COLUMNS),
    1,
  );
  return { bytes, maxHpMax: 1, units };
}

describe("SimBridge + InlineSimRunner (§5A steps 2–4, §8A)", () => {
  test("resolveTurn persists checkpoint + report + delta and returns artifacts", async () => {
    const db = await newDb();
    const seed = seedSnapshot();
    const bridge = new SimBridge("scene-1", {
      db,
      worldId: "w1",
      runner: new InlineSimRunner(),
      sys: MASS_BATTLE_SCHEMA_COLUMNS,
    });
    const resumed = await bridge.start(ctx(), seed.units, seed);
    expect(resumed).toBe(0); // fresh scene

    const orders: Array<[string, OrderQueue]> = [
      [
        "u-red",
        { pending: [{ kind: "attack", targetUnitId: "u-blue" }], issuedBy: "p1", issuedTurn: 1 },
      ],
    ];
    const r1 = await bridge.resolveTurn({ orders, seed: 42, turnNumber: 1 }, ctx(), seed.units);
    expect(r1.fromVersion).toBe(0);
    expect(r1.toVersion).toBe(1);
    expect(r1.report.events.length).toBeGreaterThan(0);
    expect(r1.report.subPhases).toEqual(["move", "shoot", "melee", "morale", "supply"]);

    // store contents
    const cp = await latestCheckpoint(db, "w1", "scene-1");
    expect(cp?.turnNumber).toBe(1);
    expect(cp?.hash).toBe(r1.freezeHash); // §8A stores the freeze (Checkpoint N)
    expect(cp?.seed).toBe(42);
    const rep = await getReport(db, "w1", "scene-1", 1);
    expect(rep?.turn).toBe(1);
    const deltas = await listDeltas(db, "w1", "scene-1");
    expect(deltas.map((x) => x.version)).toEqual([1]);
    expect(bridge.poolVersion).toBe(1);
  });

  test("§8A restart resume: new bridge reloads checkpoint; mid-resolution re-run is identical", async () => {
    const db = await newDb();
    const seed = seedSnapshot();
    const mk = (): SimBridge =>
      new SimBridge("scene-1", {
        db,
        worldId: "w2",
        runner: new InlineSimRunner(),
        sys: MASS_BATTLE_SCHEMA_COLUMNS,
      });
    const b1 = mk();
    await b1.start(ctx(), seed.units, seed);
    const orders: Array<[string, OrderQueue]> = [
      [
        "u-red",
        { pending: [{ kind: "attack", targetUnitId: "u-blue" }], issuedBy: "p1", issuedTurn: 1 },
      ],
    ];
    const first = await b1.resolveTurn({ orders, seed: 99, turnNumber: 1 }, ctx(), seed.units);
    // (host tab crashes — b1 and its runner are simply dropped)

    // host restarts: fresh bridge resumes from the stored checkpoint
    const b2 = mk();
    const resumedTurn = await b2.start(ctx(), seed.units);
    expect(resumedTurn).toBe(1);
    // the turn was mid-resolution → re-run deterministically (§8A)
    const rerun = await b2.resolveTurn({ orders, seed: 99, turnNumber: 1 }, ctx(), seed.units);
    expect(rerun.poolHash).toBe(first.poolHash); // determinism ⇒ identical result
    expect(rerun.report).toEqual(first.report);
  });

  test("client replica applies the broadcast delta to reach the host pool hash", async () => {
    const db = await newDb();
    const seed = seedSnapshot();
    const bridge = new SimBridge("scene-1", {
      db,
      worldId: "w3",
      runner: new InlineSimRunner(),
      sys: MASS_BATTLE_SCHEMA_COLUMNS,
    });
    await bridge.start(ctx(), seed.units, seed);
    const orders: Array<[string, OrderQueue]> = [
      [
        "u-red",
        {
          pending: [{ kind: "move", path: [{ x: 1.5, y: 0 }], pace: "march" }],
          issuedBy: "p1",
          issuedTurn: 1,
        },
      ],
    ];
    const r = await bridge.resolveTurn({ orders, seed: 7, turnNumber: 1 }, ctx(), seed.units);

    // replica: start from the seed snapshot, apply the delta
    const { snapshot } = decodeSimSnapshot(seed.bytes);
    const replica = poolFromSnapshot(snapshot, seed.maxHpMax, MASS_BATTLE_SCHEMA_COLUMNS);
    const { delta, maxHpMax } = decodeSimDelta(r.deltaBytes);
    expect(delta.fromVersion).toBe(0);
    expect(delta.toVersion).toBe(1);
    applySimDelta(replica, delta, maxHpMax, MASS_BATTLE_SCHEMA_COLUMNS);
    // hp=1/hpMax=1 fixtures are exact in the permille domain → hashes match
    expect(hashPool(replica)).toBe(r.poolHash);
  });
});
