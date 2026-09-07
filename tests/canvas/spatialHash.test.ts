import { describe, expect, test } from "vitest";
import { ModelSpatialHash } from "../../src/canvas/spatial";
import { allocModel, compactPool, createModelPool, freeModel, clonePool } from "../../src/sim/pool";
import { diffPools } from "../../src/sim/codec";
import { ModelStatus } from "../../src/core/strategic";
import type { ModelPool } from "../../src/core/strategic";

function poolOf(positions: Array<[number, number]>): ModelPool {
  const pool = createModelPool(positions.length * 2);
  positions.forEach(([x, y], i) => {
    allocModel(pool, { id: i + 1, unitIdx: 0, x, y, hp: 1, hpMax: 1 });
  });
  return pool;
}

describe("ModelSpatialHash (§9A)", () => {
  test("queryRect returns exactly the models inside the rect", () => {
    const pool = poolOf([
      [1, 1],
      [7, 3],
      [12, 12],
      [7.5, 3.5],
      [100, 100],
    ]);
    const hash = new ModelSpatialHash(5);
    hash.rebuild(pool);
    const hits = hash.queryRect({ x: 5, y: 0, width: 10, height: 10 }).sort((a, b) => a - b);
    expect(hits).toEqual([1, 3]);
  });

  test("queryPoint is nearest-first and respects radius", () => {
    const pool = poolOf([
      [10, 10],
      [10.4, 10],
      [11, 10],
      [50, 50],
    ]);
    const hash = new ModelSpatialHash(5);
    hash.rebuild(pool);
    const hits = hash.queryPoint(10, 10, 1.01);
    expect(hits.map((h) => h.index)).toEqual([0, 1, 2]);
    expect(hash.queryPoint(10, 10, 0.3).map((h) => h.index)).toEqual([0]);
  });

  test("queryPoint filters dead and hidden models when a pool is given", () => {
    const pool = poolOf([
      [10, 10],
      [10.2, 10],
      [10.4, 10],
    ]);
    pool.status[0] = (pool.status[0] ?? 0) | ModelStatus.dead;
    pool.status[1] = (pool.status[1] ?? 0) | ModelStatus.hidden;
    const hash = new ModelSpatialHash(5);
    hash.rebuild(pool);
    const hits = hash.queryPoint(10, 10, 1, pool);
    expect(hits.map((h) => h.index)).toEqual([2]);
  });

  test("incremental applyDelta equals a full rebuild across random moves", () => {
    let seed = 12345;
    const rnd = (): number => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    const n = 200;
    const positions: Array<[number, number]> = [];
    for (let i = 0; i < n; i++) positions.push([rnd() * 100, rnd() * 100]);
    const pool = poolOf(positions);

    const incremental = new ModelSpatialHash(5);
    const control = new ModelSpatialHash(5);
    incremental.rebuild(pool);
    control.rebuild(pool);

    for (let step = 0; step < 4; step++) {
      const before = clonePool(pool);
      // move ~40 random models
      for (let m = 0; m < 40; m++) {
        const i = Math.floor(rnd() * pool.count);
        pool.x[i] = rnd() * 100;
        pool.y[i] = rnd() * 100;
      }
      const after = clonePool(pool);
      const delta = {
        ...diffPools(before, after, "sc", {}),
        fromVersion: step,
        toVersion: step + 1,
      };
      incremental.applyDelta(pool, delta);
      control.rebuild(pool);
      // compare over a grid of sample rects
      for (let r = 0; r < 12; r++) {
        const x = rnd() * 60;
        const y = rnd() * 60;
        const rect = { x, y, width: 20 + rnd() * 30, height: 20 + rnd() * 30 };
        expect(incremental.queryRect(rect).sort((a, b) => a - b)).toEqual(
          control.queryRect(rect).sort((a, b) => a - b),
        );
      }
      expect(incremental.cellEntries().length).toBe(control.cellEntries().length);
    }
  });

  test("count change (compaction/free) falls back to rebuild", () => {
    const pool = poolOf([
      [1, 1],
      [2, 2],
      [60, 60],
    ]);
    const hash = new ModelSpatialHash(5);
    hash.rebuild(pool);
    freeModel(pool, 0); // mark dead …
    compactPool(pool); // … then compaction shifts indices and drops count
    const delta = {
      sceneId: "sc",
      fromVersion: 0,
      toVersion: 1,
      count: pool.count,
      columns: [],
    };
    hash.applyDelta(pool, delta);
    // compacted pool: (1,1) gone, (2,2)→idx 0, (60,60)→idx 1
    expect(hash.queryPoint(1, 1, 0.4)).toEqual([]);
    expect(hash.queryPoint(2, 2, 0.4).map((h) => h.index)).toEqual([0]);
    expect(hash.queryRect({ x: 0, y: 0, width: 100, height: 100 }).length).toBe(2);
  });

  test("unitAtPoint maps a model hit to the owning unit", () => {
    const pool = poolOf([
      [10, 10],
      [40, 40],
    ]);
    const units = [
      { id: "u-a", modelRange: [0, 1] as [number, number] },
      { id: "u-b", modelRange: [1, 2] as [number, number] },
    ];
    const hash = new ModelSpatialHash(5);
    hash.rebuild(pool);
    expect(hash.unitAtPoint(10, 10, units, pool)).toBe("u-a");
    expect(hash.unitAtPoint(40, 40, units, pool)).toBe("u-b");
    expect(hash.unitAtPoint(30, 30, units, pool)).toBeNull();
  });

  test("unitsInRect collects owning units and skips dead models", () => {
    const pool = poolOf([
      [10, 10],
      [12, 12],
      [40, 40],
    ]);
    pool.status[1] = (pool.status[1] ?? 0) | ModelStatus.dead;
    const units = [
      { id: "u-a", modelRange: [0, 2] as [number, number] },
      { id: "u-b", modelRange: [2, 3] as [number, number] },
    ];
    const hash = new ModelSpatialHash(5);
    hash.rebuild(pool);
    expect(hash.unitsInRect({ x: 5, y: 5, width: 10, height: 10 }, units, pool)).toEqual(
      new Set(["u-a"]),
    );
  });

  test("cellEntries exposes occupied cells for DetectionGrid seeding", () => {
    const pool = poolOf([
      [1, 1],
      [2, 2],
      [30, 30],
    ]);
    const hash = new ModelSpatialHash(5);
    hash.rebuild(pool);
    const cells = hash.cellEntries();
    expect(cells.length).toBe(2); // (0,0) holds indices 0,1; (6,6) holds 2
    const origin = cells.find((c) => c.cx === 0 && c.cy === 0);
    expect(origin?.indices.length).toBe(2);
  });
});
