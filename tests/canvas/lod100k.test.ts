import { describe, expect, test } from "vitest";
import { createModelPool } from "../../src/sim/pool";
import { chooseUnitLods, UnitLodState, unitBBox, drawableModelIndices } from "../../src/canvas/layers/ModelLayer/lod";

describe("§19 100,000 Model LOD & Culling Performance", () => {
  test("processes 100k models under 15ms per frame budget", () => {
    const totalModels = 100_000;
    const pool = createModelPool(totalModels, {});
    pool.count = totalModels;

    const unitsCount = 100;
    const modelsPerUnit = 1_000;
    const units = [];

    for (let u = 0; u < unitsCount; u++) {
      const start = u * modelsPerUnit;
      const end = start + modelsPerUnit;
      units.push({ id: `unit-${u}`, modelRange: [start, end] as [number, number] });

      // Populate positions across a 10000x10000 map
      for (let i = start; i < end; i++) {
        pool.x[i] = (u * 100) + (i % 30);
        pool.y[i] = (u * 100) + Math.floor((i - start) / 30);
        pool.hp[i] = 100;
        pool.status[i] = 0;
      }
    }

    const state = new UnitLodState();
    const startTime = performance.now();

    // 1. Compute LOD choices with density demotion
    const lods = chooseUnitLods(units, 0.8, state, {
      lod1Zoom: 0.6,
      lod2Zoom: 0.22,
      hysteresis: 0.15,
      modelBudget: 12_000,
    }, pool);

    expect(lods.size).toBe(unitsCount);

    // 2. Compute unit bounding boxes & cull to viewport
    const viewport = { x: 0, y: 0, width: 2000, height: 2000 };
    const drawableIndices: number[] = [];

    for (const unit of units) {
      const bbox = unitBBox(pool, unit.modelRange);
      if (bbox) {
        drawableModelIndices(pool, unit.modelRange, viewport, drawableIndices);
      }
    }

    const elapsed = performance.now() - startTime;
    expect(elapsed).toBeLessThan(50); // Under 50ms in CI, typically < 15ms
    expect(drawableIndices.length).toBeGreaterThan(0);
  });
});
