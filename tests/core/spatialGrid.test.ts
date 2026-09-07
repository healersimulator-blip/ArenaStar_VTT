import { describe, expect, test } from "vitest";
import { SpatialGrid } from "../../src/core/spatialGrid";
import { allocModel, createModelPool } from "../../src/sim/pool";

describe("SpatialGrid (§9A / Core)", () => {
  test("inserts and queries points within radius", () => {
    const grid = new SpatialGrid(5);
    const pool = createModelPool(5);
    allocModel(pool, { id: 1, unitIdx: 0, x: 10, y: 10 });
    allocModel(pool, { id: 2, unitIdx: 0, x: 12, y: 10 });
    allocModel(pool, { id: 3, unitIdx: 0, x: 25, y: 25 });
    grid.rebuild(pool);

    const hits = grid.queryPoint(10, 10, 3);
    expect(hits.map((h) => h.index)).toEqual([0, 1]);
  });

  test("queries rect bounds accurately", () => {
    const grid = new SpatialGrid(5);
    const pool = createModelPool(3);
    allocModel(pool, { id: 1, unitIdx: 0, x: 0, y: 0 });
    allocModel(pool, { id: 2, unitIdx: 0, x: 10, y: 10 });
    allocModel(pool, { id: 3, unitIdx: 0, x: 100, y: 100 });
    grid.rebuild(pool);

    const inside = grid.queryRect({ x: -1, y: -1, width: 12, height: 12 });
    expect(inside).toEqual([0, 1]);
  });
});
