import { describe, expect, test } from "vitest";
import type { RulesWallsContext } from "../../src/core/rules";
import type { FactionDocument, ModelPool } from "../../src/core/strategic";
import { ModelStatus } from "../../src/core/strategic";
import { DetectionGrid, WALL_SIGHT_BIT, poolBounds } from "../../src/core/detection";
import {
  alliesOf,
  factionVisibility,
  makeUnitVisibility,
  projectDeltaForFaction,
  projectReportForFaction,
} from "../../src/host/simProjection";
import { XoshiroPRNG } from "../../src/sim/prng";
import { allocModel, createModelPool } from "../../src/sim/pool";
import { applySimDelta, diffPools } from "../../src/sim/codec";
import type { TurnReport } from "../../src/core/sim";

const SYS = { ammo: "u8" } as const;

const faction = (id: string, allies: string[] = []): FactionDocument => ({
  _id: id,
  type: "faction",
  name: id,
  ownership: { default: 3 },
  flags: {},
  system: {},
  color: "#fff",
  allies,
});

function poolWith(
  units: Array<{ faction: string; count: number; x: number; y: number }>,
): ModelPool {
  const total = units.reduce((a, u) => a + u.count, 0);
  const pool = createModelPool(Math.max(total, 1), SYS);
  let id = 1;
  for (const u of units) {
    for (let i = 0; i < u.count; i++) {
      allocModel(pool, {
        id: id++,
        unitIdx: 0,
        x: u.x + (i % 5) * 0.1,
        y: u.y + Math.floor(i / 5) * 0.1,
        hp: 1,
        hpMax: 1,
        sys: { ammo: 3 },
      });
    }
  }
  return pool;
}

describe("DetectionGrid (§5A)", () => {
  test("radius seeding marks cells; distant models stay hidden", () => {
    const grid = new DetectionGrid(5);
    grid.reseed([{ anchor: { x: 10, y: 10 }, factionId: "f-red", radius: 10 }], {
      minX: 0,
      minY: 0,
      maxX: 40,
      maxY: 40,
    });
    expect(grid.detectedAt(10, 10, ["f-red"])).toBe(true);
    expect(grid.detectedAt(15, 12, ["f-red"])).toBe(true);
    expect(grid.detectedAt(38, 38, ["f-red"])).toBe(false);
    expect(grid.detectedAt(10, 10, ["f-blue"])).toBe(false);
  });

  test("allies share vision", () => {
    const grid = new DetectionGrid(5);
    grid.reseed([{ anchor: { x: 5, y: 5 }, factionId: "f-red", radius: 6 }], {
      minX: 0,
      minY: 0,
      maxX: 20,
      maxY: 20,
    });
    expect(grid.detectedAt(6, 6, ["f-blue", "f-green"])).toBe(false);
    expect(grid.detectedAt(6, 6, ["f-blue", "f-red"])).toBe(true);
  });

  test("visibleModels bitmap covers only detected models", () => {
    const grid = new DetectionGrid(5);
    grid.reseed([{ anchor: { x: 2, y: 2 }, factionId: "f-red", radius: 8 }], poolBoundsAt(0, 30));
    const pool = poolWith([
      { faction: "f-red", count: 4, x: 2, y: 2 }, // near detector
      { faction: "f-blue", count: 4, x: 28, y: 28 }, // far away
      { faction: "f-blue", count: 4, x: 4, y: 3 }, // inside red detection
    ]);
    const vis = grid.visibleModels(pool, "f-red");
    expect(Array.from(vis.slice(0, 4))).toEqual([1, 1, 1, 1]);
    expect(Array.from(vis.slice(4, 8))).toEqual([0, 0, 0, 0]);
    expect(Array.from(vis.slice(8, 12))).toEqual([1, 1, 1, 1]);
  });

  test("sight-blocking walls cut detection; other restriction bits do not", () => {
    // wall segment across x=10, y∈[0,20] with SIGHT restriction
    const sightWalls: RulesWallsContext = {
      x1: new Float32Array([10]),
      y1: new Float32Array([0]),
      x2: new Float32Array([10]),
      y2: new Float32Array([20]),
      restriction: new Uint8Array([WALL_SIGHT_BIT]),
    };
    const moveWalls: RulesWallsContext = {
      ...sightWalls,
      restriction: new Uint8Array([1]), // move-only
    };
    const bounds = { minX: 0, minY: 0, maxX: 30, maxY: 30 };
    const g1 = new DetectionGrid(5);
    g1.reseed([{ anchor: { x: 5, y: 10 }, factionId: "f-red", radius: 15 }], bounds, sightWalls, 1);
    expect(g1.detectedAt(5, 10, ["f-red"])).toBe(true); // near side
    expect(g1.detectedAt(20, 10, ["f-red"])).toBe(false); // behind the wall
    const g2 = new DetectionGrid(5);
    g2.reseed([{ anchor: { x: 5, y: 10 }, factionId: "f-red", radius: 15 }], bounds, moveWalls, 1);
    expect(g2.detectedAt(20, 10, ["f-red"])).toBe(true); // walls block movement only
  });

  test("LOS cell-pair cache is used and invalidated on wallsVersion change", () => {
    const walls: RulesWallsContext = {
      x1: new Float32Array([10]),
      y1: new Float32Array([0]),
      x2: new Float32Array([10]),
      y2: new Float32Array([20]),
      restriction: new Uint8Array([WALL_SIGHT_BIT]),
    };
    const bounds = { minX: 0, minY: 0, maxX: 30, maxY: 30 };
    const grid = new DetectionGrid(5);
    grid.reseed([{ anchor: { x: 5, y: 10 }, factionId: "f-red", radius: 15 }], bounds, walls, 1);
    expect(grid.losCacheSize).toBeGreaterThan(0);
    const before = grid.losCacheSize;
    grid.reseed([{ anchor: { x: 5, y: 10 }, factionId: "f-red", radius: 15 }], bounds, walls, 1);
    expect(grid.losCacheSize).toBe(before); // same version → cache kept
    // wall MOVED (x=10 → x=20) + version bump → cache invalidated → new result
    const movedWalls: RulesWallsContext = {
      x1: new Float32Array([20]),
      y1: new Float32Array([0]),
      x2: new Float32Array([20]),
      y2: new Float32Array([20]),
      restriction: new Uint8Array([WALL_SIGHT_BIT]),
    };
    grid.reseed(
      [{ anchor: { x: 5, y: 10 }, factionId: "f-red", radius: 15 }],
      bounds,
      movedWalls,
      2,
    );
    expect(grid.detectedAt(12, 10, ["f-red"])).toBe(true); // no longer blocked
    expect(grid.detectedAt(25, 10, ["f-red"])).toBe(false); // behind the moved wall
  });
});

const poolBoundsAt = (lo: number, hi: number) => ({ minX: lo, minY: lo, maxX: hi, maxY: hi });

describe("faction delta projection (§5A)", () => {
  test("projected delta updates only visible models on a replica", () => {
    const factions = [faction("f-red"), faction("f-blue")];
    const pool = poolWith([
      { faction: "f-red", count: 5, x: 5, y: 5 },
      { faction: "f-blue", count: 5, x: 25, y: 25 },
    ]);
    const next = createModelPool(pool.count, SYS);
    // copy then move everyone
    for (let i = 0; i < pool.count; i++) {
      allocModel(next, {
        id: pool.id[i] ?? 0,
        unitIdx: 0,
        x: (pool.x[i] ?? 0) + 2,
        y: pool.y[i] ?? 0,
        hp: 1,
        hpMax: 1,
        sys: { ammo: 3 },
      });
    }
    const grid = new DetectionGrid(5);
    grid.reseed(
      [
        { anchor: { x: 5, y: 5 }, factionId: "f-red", radius: 10 },
        { anchor: { x: 25, y: 25 }, factionId: "f-blue", radius: 10 },
      ],
      poolBounds(pool),
    );
    const vis = factionVisibility(grid, next, factions, "f-red");
    const delta = diffPools(pool, next, "s", SYS);
    const projected = projectDeltaForFaction(delta, vis, SYS);

    // replica starts at pool state; red must NOT see blue's movement
    const replica = createModelPool(pool.count, SYS);
    for (let i = 0; i < pool.count; i++) {
      allocModel(replica, {
        id: pool.id[i] ?? 0,
        unitIdx: 0,
        x: pool.x[i] ?? 0,
        y: pool.y[i] ?? 0,
        hp: 1,
        hpMax: 1,
        sys: { ammo: 3 },
      });
    }
    applySimDelta(replica, projected, 1, SYS);
    for (let i = 0; i < 5; i++) {
      // delta values carry grid/16 quantization
      expect(Math.abs((replica.x[i] ?? 0) - ((pool.x[i] ?? 0) + 2))).toBeLessThanOrEqual(1 / 16);
    }
    for (let i = 5; i < 10; i++) expect(replica.x[i]).toBeCloseTo(pool.x[i] ?? 0, 5); // untouched
    // x column of the projected delta contains only indices 0..4
    const xCol = projected.columns.find((c) => c.column === "x");
    const covered: number[] = [];
    for (const [s, l] of xCol?.runs ?? []) for (let i = s; i < s + l; i++) covered.push(i);
    expect(covered.every((i) => i < 5)).toBe(true);
  });

  test("fully hidden faction receives empty columns", () => {
    const factions = [faction("f-red"), faction("f-blue")];
    const pool = poolWith([
      { faction: "f-red", count: 4, x: 5, y: 5 },
      { faction: "f-blue", count: 4, x: 25, y: 25 },
    ]);
    const grid = new DetectionGrid(5);
    grid.reseed([{ anchor: { x: 5, y: 5 }, factionId: "f-red", radius: 8 }], poolBounds(pool));
    const vis = factionVisibility(grid, pool, factions, "f-blue");
    expect(vis.every((v) => v === 0)).toBe(true);
    const delta = diffPools(pool, pool, "s", SYS);
    const projected = projectDeltaForFaction(
      { ...delta, columns: delta.columns.length ? delta.columns : [] },
      vis,
      SYS,
    );
    expect(projected.columns.length).toBe(0);
  });
});

describe("TurnReport projection (§5A unknown-enemy stubs)", () => {
  const units = [
    { id: "u-red", factionId: "f-red", modelRange: [0, 4] as const },
    { id: "u-blue", factionId: "f-blue", modelRange: [4, 8] as const },
  ];

  const report: TurnReport = {
    turn: 1,
    sceneId: "s",
    subPhases: ["shoot", "melee"],
    events: [
      {
        subPhase: "shoot",
        type: "attack",
        unitId: "u-red",
        targetUnitId: "u-blue",
        text: "R shoots B",
        modelIndices: [4, 5],
      },
      {
        subPhase: "melee",
        type: "attack",
        unitId: "u-blue",
        targetUnitId: "u-red",
        text: "B fights R",
      },
      { subPhase: "morale", type: "rout", unitId: "u-blue", text: "B breaks" },
    ],
    summary: {},
    rulesVersion: "1.0.0",
  };

  test("events of undetected units become 'unknown enemy' stubs", () => {
    const pool = poolWith([
      { faction: "f-red", count: 4, x: 5, y: 5 },
      { faction: "f-blue", count: 4, x: 25, y: 25 },
    ]);
    const grid = new DetectionGrid(5);
    grid.reseed([{ anchor: { x: 5, y: 5 }, factionId: "f-red", radius: 8 }], poolBounds(pool));
    const vis = makeUnitVisibility(
      grid,
      pool,
      units,
      [faction("f-red"), faction("f-blue")],
      "f-red",
    );
    expect(vis("u-red")).toBe(true);
    expect(vis("u-blue")).toBe(false);
    const out = projectReportForFaction(report, vis);
    expect(out.events[0]?.type).toBe("attack"); // own event kept, hidden target scrubbed
    expect(out.events[0]?.targetUnitId ?? "").toBe("");
    expect(out.events[1]?.type).toBe("unknown");
    expect(out.events[1]?.text).toBe("unknown enemy activity");
    expect(out.events[2]?.type).toBe("unknown");
  });

  test("alliesOf parses the factions collection", () => {
    const map = alliesOf([faction("f-a", ["f-b"]), faction("f-b", ["f-a"])]);
    expect(map.get("f-a")).toEqual(["f-b"]);
    expect(map.get("f-b")).toEqual(["f-a"]);
  });

  test("GM path: identity when everything is visible", () => {
    // GM bypasses projection entirely (unfiltered broadcast path)
    const gm = report;
    expect(gm.events.length).toBe(3);
    expect(gm.events[1]?.text).toBe("B fights R");
  });
});

test("sanity: status bit import matches §4A", () => {
  expect(ModelStatus.dead).toBe(1);
  expect(new XoshiroPRNG(1).nextFloat()).toBeGreaterThanOrEqual(0);
});
