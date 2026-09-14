import { describe, expect, test } from "vitest";
import { SpatialGrid } from "../../src/core/spatialGrid";
import { ModelStatus } from "../../src/core/strategic";
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

describe("M09 (D-230) — aura eligibility, authored values, and per-turn shape", () => {
  function mkPoolWithGrunts() {
    const pool = createModelPool(10, PF1E_MODEL_SCHEMA);
    const heroIdx = allocModel(pool, {
      id: 1, unitIdx: 0, x: 10, y: 10,
      sys: { ac: 20, touchAc: 14, fort: 8, ref: 6, will: 8 },
    });
    const nearIdx = allocModel(pool, {
      id: 2, unitIdx: 0, x: 12, y: 10,
      sys: { ac: 14, touchAc: 10, fort: 2, ref: 1, will: 0 },
    });
    // Enemy-unit model standing IN the default radius — spatially eligible but not allied.
    const enemyIdx = allocModel(pool, {
      id: 3, unitIdx: 1, x: 20, y: 10,
      sys: { ac: 14, touchAc: 10, fort: 2, ref: 1, will: 0 },
    });
    const grid = new SpatialGrid(5);
    grid.rebuild(pool);
    return { pool, grid, heroIdx, nearIdx, enemyIdx };
  }

  test("a dead leader radiates nothing (losing the leader removes the aura)", () => {
    const { pool, grid, heroIdx, nearIdx } = mkPoolWithGrunts();
    pool.status[heroIdx] = (pool.status[heroIdx] ?? 0) | ModelStatus.dead;
    grid.rebuild(pool);
    const res = applyHeroLeadershipAuras({ pool, grid, heroModelIdx: heroIdx });
    expect(res.buffedModels).toEqual([]);
    expect((pool.sys["fort"] as unknown as Float32Array)[nearIdx]).toBe(2);
    expect((pool.sys["will"] as unknown as Float32Array)[nearIdx]).toBe(0);
  });

  test("radius/bonus are honored as authored values (M09: data, not hardcoded)", () => {
    const { pool, grid, heroIdx, nearIdx, enemyIdx } = mkPoolWithGrunts();
    // Tight radius: only the model 2 ft away is eligible; morale bonus 5 authored.
    const res = applyHeroLeadershipAuras({
      pool, grid, heroModelIdx: heroIdx, radius: 5, moraleBonus: 5,
    });
    expect(res.buffedModels).toEqual([nearIdx]);
    expect((pool.sys["fort"] as unknown as Float32Array)[nearIdx]).toBe(7);
    expect((pool.sys["will"] as unknown as Float32Array)[nearIdx]).toBe(5);
    // The enemy-unit model at 10 ft is spatially eligible but a different unit: untouched.
    expect(res.buffedModels).not.toContain(enemyIdx);
    expect((pool.sys["fort"] as unknown as Float32Array)[enemyIdx]).toBe(2);
  });

  test("turn shape: reseeding resets saves so the aura never accumulates", async () => {
    const { buildUnitProfiles, seedPF1ePool } = await import("../../src/packages/pf1e/deploySeed");
    const unit = {
      id: "u1", armyId: "a1", factionId: "f1", type: "hero", name: "Led",
      profile: {},
      stats: { strength: 2, morale: 5, bab: 1, fort: 4, ref: 2, will: 3, hp: 10, move: 6 },
      orders: null, formation: "line", sceneId: null, modelRange: [0, 2] as [number, number],
      leaderTokenId: null,
    } as unknown as import("../../src/core/rules").UnitView;
    const pool = createModelPool(4, PF1E_MODEL_SCHEMA);
    allocModel(pool, { id: 1, unitIdx: 0, x: 0, y: 0, hp: 1, hpMax: 1 });
    allocModel(pool, { id: 2, unitIdx: 0, x: 10, y: 0, hp: 1, hpMax: 1 });
    const profiles = buildUnitProfiles([unit]);
    const grid = new SpatialGrid(5);
    const seedAura = () => {
      seedPF1ePool(pool, [unit], profiles);
      applyHeroLeadershipAuras({ pool, grid, heroModelIdx: 0, radius: 30, moraleBonus: 2 });
    };
    grid.rebuild(pool);
    seedAura(); // turn 1
    const ally = 1;
    expect((pool.sys["fort"] as unknown as Float32Array)[ally]).toBe(4 + 2);
    expect((pool.sys["will"] as unknown as Float32Array)[ally]).toBe(3 + 2);
    seedAura(); // turn 2: reseed + re-aura — must NOT become +4
    expect((pool.sys["fort"] as unknown as Float32Array)[ally]).toBe(4 + 2);
    expect((pool.sys["will"] as unknown as Float32Array)[ally]).toBe(3 + 2);
  });
});
