import { describe, expect, test } from "vitest";
import { SpatialGrid } from "../../src/core/spatialGrid";
import { applyHeroLeadershipAuras, applyHeroCleaveOverkill } from "../../src/packages/pf1e/heroBridge";
import { PF1E_MODEL_SCHEMA } from "../../src/packages/pf1e/schema";
import { allocModel, createModelPool } from "../../src/sim/pool";

describe("PF1e Hero Integration & Sync Bridge (§12 / Task 7)", () => {
  test("broadcasts leadership morale aura to friendly models in 30ft radius", () => {
    const grid = new SpatialGrid(5);
    const pool = createModelPool(10, PF1E_MODEL_SCHEMA);

    // Hero at (10, 10)
    const heroIdx = allocModel(pool, {
      id: 1,
      unitIdx: 0,
      x: 10,
      y: 10,
      sys: { ac: 20, touchAc: 14, fort: 8, ref: 6, will: 8, sr: 0, drType: 0, drVal: 0, profileIdx: 1 },
    });

    // Friendly grunt at (12, 10)
    const gruntIdx = allocModel(pool, {
      id: 2,
      unitIdx: 0,
      x: 12,
      y: 10,
      sys: { ac: 14, touchAc: 10, fort: 2, ref: 1, will: 0, sr: 0, drType: 0, drVal: 0, profileIdx: 2 },
    });

    grid.rebuild(pool);

    const res = applyHeroLeadershipAuras({
      pool,
      grid,
      heroModelIdx: heroIdx,
      radius: 30,
      moraleBonus: 2,
    });

    expect(res.buffedModels).toContain(gruntIdx);
  });

  test("cleaves overkill damage into adjacent enemy model slots", () => {
    const grid = new SpatialGrid(5);
    const pool = createModelPool(10, PF1E_MODEL_SCHEMA);

    // Enemy grunt 1 (5 HP)
    const e1 = allocModel(pool, { id: 10, unitIdx: 1, x: 10, y: 10, hp: 5, hpMax: 5 });
    // Enemy grunt 2 (5 HP, adjacent)
    const e2 = allocModel(pool, { id: 11, unitIdx: 1, x: 11, y: 10, hp: 5, hpMax: 5 });

    grid.rebuild(pool);

    // Hero hits e1 for 8 damage (5 HP kills e1, 3 overkill cleaves to e2)
    const res = applyHeroCleaveOverkill({
      pool,
      grid,
      targetModelIdx: e1,
      damageDealt: 8,
      enemyUnitIdx: 1,
    });

    expect(res.modelsSlain).toContain(e1);
    expect(pool.hp[e2]).toBe(2); // 5 - 3 = 2
  });
});
