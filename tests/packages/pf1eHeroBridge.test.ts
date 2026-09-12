import { describe, expect, test } from "vitest";
import { SpatialGrid } from "../../src/core/spatialGrid";
import { applyHeroLeadershipAuras } from "../../src/packages/pf1e/heroBridge";
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

    // Friendly grunt at (12, 10) — 2 ft out
    const gruntIdx = allocModel(pool, {
      id: 2,
      unitIdx: 0,
      x: 12,
      y: 10,
      sys: { ac: 14, touchAc: 10, fort: 2, ref: 1, will: 0, sr: 0, drType: 0, drVal: 0, profileIdx: 2 },
    });

    // Friendly grunt at (30, 10) — 20 ft out: inside the documented 30-ft aura. The old
    // `radius / 5` unit error shrank the query to 6 ft and silently excluded this model
    // (D-172); a radius measured in feet must reach it.
    const midIdx = allocModel(pool, {
      id: 3,
      unitIdx: 0,
      x: 30,
      y: 10,
      sys: { ac: 14, touchAc: 10, fort: 2, ref: 1, will: 0, sr: 0, drType: 0, drVal: 0, profileIdx: 2 },
    });

    // Friendly grunt at (40, 10) — exactly 30 ft out: the radius edge is inclusive.
    const edgeIdx = allocModel(pool, {
      id: 4,
      unitIdx: 0,
      x: 40,
      y: 10,
      sys: { ac: 14, touchAc: 10, fort: 2, ref: 1, will: 0, sr: 0, drType: 0, drVal: 0, profileIdx: 2 },
    });

    // Friendly grunt at (41, 10) — 31 ft out: beyond the aura, stays unbuffed.
    const outIdx = allocModel(pool, {
      id: 5,
      unitIdx: 0,
      x: 41,
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
    expect(res.buffedModels).toContain(midIdx);
    expect(res.buffedModels).toContain(edgeIdx);
    expect(res.buffedModels).not.toContain(outIdx);
    // The +2 morale bonus lands on Fort/Will of the buffed models only.
    expect(pool.sys["fort"]?.[midIdx]).toBe(4);
    expect(pool.sys["will"]?.[edgeIdx]).toBe(2);
    expect(pool.sys["fort"]?.[outIdx]).toBe(2);
  });

});
