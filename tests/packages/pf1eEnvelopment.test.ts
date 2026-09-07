import { describe, expect, test } from "vitest";
import { SpatialGrid } from "../../src/core/spatialGrid";
import { calculatePF1eEnvelopment } from "../../src/packages/pf1e/envelopment";
import { allocModel, createModelPool } from "../../src/sim/pool";

describe("PF1e Envelopment & Flanking Engine (§12 / Task 4)", () => {
  test("calculates perimeter contact and marks flanked/enveloped models", () => {
    const grid = new SpatialGrid(5);
    const pool = createModelPool(10);

    // Unit 0 (Attacker: 4 models wide)
    allocModel(pool, { id: 1, unitIdx: 0, x: 1, y: 0 });
    allocModel(pool, { id: 2, unitIdx: 0, x: 2, y: 0 });
    allocModel(pool, { id: 3, unitIdx: 0, x: 10, y: 0 }); // Unengaged flanker

    // Unit 1 (Defender: 2 models wide)
    allocModel(pool, { id: 4, unitIdx: 1, x: 1, y: 1 });
    allocModel(pool, { id: 5, unitIdx: 1, x: 2, y: 1 });

    grid.rebuild(pool);

    const res = calculatePF1eEnvelopment({
      pool,
      grid,
      attackerUnitIdx: 0,
      defenderUnitIdx: 1,
      reach: 1.5,
    });

    expect(res.contactPairs.length).toBeGreaterThan(0);
    expect(res.flankingModels.length).toBeGreaterThan(0);
  });
});
