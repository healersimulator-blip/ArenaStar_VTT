/**
 * M03 — Gap §2.13 bit-collision fix: PF1eCondition bits no longer share pool.status.
 *
 * PF1eCondition previously reused ModelStatus bits 0-4 (DEAD/routed/pinned/engaged/hidden
 * = FLANKED/PRONE etc.), so a prone model was filtered as hidden and a flanked model
 * as pinned. After M03, PF1eCondition lives in its own sys column `pfCondition` (u32),
 * disjoint from ModelPool.status (ModelStatus).
 */
import { describe, expect, test } from "vitest";
import { createModelPool, allocModel, bytesPerModel } from "../../src/sim/pool";
import { ModelStatus } from "../../src/core/strategic";
import { PF1E_MODEL_SCHEMA, PF1eCondition } from "../../src/packages/pf1e/schema";
import { PF1E_STATUS_FLANKED, markPF1eFlanking } from "../../src/packages/pf1e/envelopment";
import { SpatialGrid } from "../../src/core/spatialGrid";
import { resolvePF1eAttacks, resolvePF1eCombatManeuver, SimpleRng } from "../../src/packages/pf1e/combatEngine";
import { PF1eProfileRegistry } from "../../src/packages/pf1e/schema";
import { ModelSpatialHash } from "../../src/canvas/spatial";
import { snapshotFromPool, poolFromSnapshot, diffPools, applySimDelta } from "../../src/sim/codec";

describe("M03 Gap §2.13 — PF1e condition/status bit collisions (separate column)", () => {
  test("PF1eCondition bits do not alias ModelStatus bits in the same column", () => {
    // In the old layout, PRONE (1<<4) == hidden (1<<4) and FLANKED (1<<2) == pinned (1<<2).
    // With the separate column, setting one must not set the other.
    expect(PF1eCondition.PRONE).toBe(ModelStatus.hidden);
    expect(PF1eCondition.FLANKED).toBe(ModelStatus.pinned);
    expect(PF1eCondition.GRAPPLED).toBe(ModelStatus.engaged);
    expect(PF1eCondition.DISRUPTED).toBe(ModelStatus.routed);
    expect(PF1eCondition.DEAD).toBe(ModelStatus.dead);
    // The values still numerically collide — the fix is that they are stored in *different* columns.
    const pool = createModelPool(2, PF1E_MODEL_SCHEMA);
    allocModel(pool, { id: 1, unitIdx: 0, x: 0, y: 0, hp: 10, hpMax: 10 });
    allocModel(pool, { id: 2, unitIdx: 0, x: 5, y: 0, hp: 10, hpMax: 10 });
    // Set PRONE via pfCondition column
    const pfCol = pool.sys.pfCondition as unknown as Uint32Array | Int32Array;
    pfCol[0] = PF1eCondition.PRONE;
    expect((pool.status[0] ?? 0) & ModelStatus.hidden).toBe(0);
    expect((pfCol[0] ?? 0) & PF1eCondition.PRONE).not.toBe(0);

    // Set hidden via status column
    pool.status[1] = ModelStatus.hidden;
    expect((pfCol[1] ?? 0) & PF1eCondition.PRONE).toBe(0);
    expect((pool.status[1] ?? 0) & ModelStatus.hidden).not.toBe(0);
  });

  test("FLANKED via envelopment does not set ModelStatus.pinned", () => {
    const CELL = 5;
    const pool = createModelPool(4, PF1E_MODEL_SCHEMA);
    allocModel(pool, { id: 1, unitIdx: 0, x: 20, y: 25, hp: 10, hpMax: 10 });
    allocModel(pool, { id: 2, unitIdx: 0, x: 30, y: 25, hp: 10, hpMax: 10 });
    allocModel(pool, { id: 3, unitIdx: 1, x: 25, y: 25, hp: 10, hpMax: 10 });
    const grid = new SpatialGrid(CELL);
    grid.rebuild(pool);
    const res = markPF1eFlanking({
      pool,
      grid,
      cellFeet: CELL,
      factionByUnitIdx: ["red", "blue"],
      reachSquaresByUnitIdx: [1, 1],
    });
    expect(res.flankedDefenders).toEqual([2]);
    const pf = (pool.sys.pfCondition as unknown as Uint32Array)[2] ?? 0;
    const st = pool.status[2] ?? 0;
    expect(pf & PF1E_STATUS_FLANKED).not.toBe(0);
    expect(pf & PF1eCondition.FLANKED).not.toBe(0);
    expect(st & ModelStatus.pinned).toBe(0);
    expect(st & ModelStatus.hidden).toBe(0);
  });

  test("PRONE defender still participates in spatial queries (not hidden-filtered)", () => {
    const pool = createModelPool(4, PF1E_MODEL_SCHEMA);
    allocModel(pool, { id: 1, unitIdx: 0, x: 0, y: 0, hp: 10, hpMax: 10 });
    allocModel(pool, { id: 2, unitIdx: 0, x: 5, y: 0, hp: 10, hpMax: 10 });
    // Make model 0 prone via pfCondition
    const pfCol = pool.sys.pfCondition as unknown as Uint32Array;
    pfCol[0] = PF1eCondition.PRONE;
    const hash = new ModelSpatialHash(5);
    hash.rebuild(pool);
    const hits = hash.queryPoint(0, 0, 5, pool);
    expect(hits.map((h) => h.index)).toContain(0);
    const unitsInRect = hash.unitsInRect({ x: -1, y: -1, width: 6, height: 6 }, [{ id: "u0", modelRange: [0, 2] } as const], pool);
    expect(unitsInRect.has("u0")).toBe(true);
  });

  test("combat maneuver PRONE goes to pfCondition, not to hidden", () => {
    const registry = new PF1eProfileRegistry();
    const atk = registry.register({ name: "Fighter", bab: 10, strMod: 5, cmb: 15 });
    const def = registry.register({ name: "Goblin", cmd: 10 });
    const pool = createModelPool(4, PF1E_MODEL_SCHEMA);
    const aIdx = allocModel(pool, { id: 1, unitIdx: 0, x: 0, y: 0, sys: { profileIdx: atk.id } });
    const dIdx = allocModel(pool, { id: 2, unitIdx: 1, x: 1, y: 0, sys: { profileIdx: def.id } });
    const rng = new SimpleRng(1);
    // Force success: trip with +15 vs CMD 10, d20=10 always succeeds
    const res = resolvePF1eCombatManeuver(pool, aIdx, dIdx, "trip", registry, rng);
    expect(res.success).toBe(true);
    const pf = (pool.sys.pfCondition as unknown as Uint32Array)[dIdx] ?? 0;
    const st = pool.status[dIdx] ?? 0;
    expect(pf & PF1eCondition.PRONE).not.toBe(0);
    expect(st & ModelStatus.hidden).toBe(0);
  });

  test("bytesPerModel with pfCondition stays ≤200 B (budget)", () => {
    const pool = createModelPool(10000, PF1E_MODEL_SCHEMA);
    const bytes = bytesPerModel(pool);
    expect(bytes).toBeGreaterThan(0);
    expect(bytes).toBeLessThanOrEqual(200);
    // Record: 66 B before M03, +4 B for pfCondition (u32) [+4 for pendingRoll] = ~70-72 B
    expect(bytes).toBeGreaterThanOrEqual(70);
    expect(bytes).toBeLessThanOrEqual(72);
  });

  test("codec round-trips pfCondition via snapshot/delta", () => {
    const pool = createModelPool(4, PF1E_MODEL_SCHEMA);
    allocModel(pool, { id: 1, unitIdx: 0, x: 10, y: 10, hp: 20, hpMax: 20, sys: { pfCondition: PF1eCondition.FLANKED | PF1eCondition.PRONE } });
    allocModel(pool, { id: 2, unitIdx: 1, x: 20, y: 10, hp: 20, hpMax: 20, sys: { pfCondition: PF1eCondition.SHAKEN } });
    const snap = snapshotFromPool(pool, "scene-1", 1, PF1E_MODEL_SCHEMA);
    const replica = poolFromSnapshot(snap, 20, PF1E_MODEL_SCHEMA);
    expect((replica.sys.pfCondition as unknown as Uint32Array)[0]).toBe(PF1eCondition.FLANKED | PF1eCondition.PRONE);
    expect((replica.sys.pfCondition as unknown as Uint32Array)[1]).toBe(PF1eCondition.SHAKEN);

    // Delta: change one model's pfCondition from 0 to GRAPPLED
    const prev = createModelPool(4, PF1E_MODEL_SCHEMA);
    allocModel(prev, { id: 1, unitIdx: 0, x: 10, y: 10, hp: 20, hpMax: 20, sys: { pfCondition: 0 } });
    allocModel(prev, { id: 2, unitIdx: 1, x: 20, y: 10, hp: 20, hpMax: 20, sys: { pfCondition: 0 } });
    const next = createModelPool(4, PF1E_MODEL_SCHEMA);
    allocModel(next, { id: 1, unitIdx: 0, x: 10, y: 10, hp: 20, hpMax: 20, sys: { pfCondition: PF1eCondition.GRAPPLED } });
    allocModel(next, { id: 2, unitIdx: 1, x: 20, y: 10, hp: 20, hpMax: 20, sys: { pfCondition: 0 } });
    const sysSchema = PF1E_MODEL_SCHEMA;
    const delta = diffPools(prev, next, "scene-1", sysSchema);
    const pfDelta = delta.columns.find((c) => c.column === "pfCondition");
    expect(pfDelta).toBeDefined();
    const target = createModelPool(4, PF1E_MODEL_SCHEMA);
    allocModel(target, { id: 1, unitIdx: 0, x: 10, y: 10, hp: 20, hpMax: 20, sys: { pfCondition: 0 } });
    allocModel(target, { id: 2, unitIdx: 1, x: 20, y: 10, hp: 20, hpMax: 20, sys: { pfCondition: 0 } });
    applySimDelta(target, delta, 20, sysSchema);
    expect((target.sys.pfCondition as unknown as Uint32Array)[0]).toBe(PF1eCondition.GRAPPLED);
  });

  test("combatEngine FLANKED attack bonus reads pfCondition, not status", () => {
    const registry = new PF1eProfileRegistry();
    const atk = registry.register({ name: "Fighter", bab: 5, strMod: 0 });
    const defHigh = registry.register({ name: "HighAC", ac: 20 });
    // Defender that is merely pinned (ModelStatus.pinned via status) — NOT flanked — must NOT get +2.
    const poolPinned = createModelPool(4, PF1E_MODEL_SCHEMA);
    const aPinned = allocModel(poolPinned, { id: 1, unitIdx: 0, x: 0, y: 0, hp: 20, hpMax: 20, sys: { profileIdx: atk.id } });
    const dPinned = allocModel(poolPinned, { id: 2, unitIdx: 1, x: 1, y: 0, hp: 20, hpMax: 20, sys: { profileIdx: defHigh.id } });
    poolPinned.status[dPinned] = ModelStatus.pinned;
    // Defender that IS flanked (pfCondition) — should get +2.
    const poolFlanked = createModelPool(4, PF1E_MODEL_SCHEMA);
    const aFlanked = allocModel(poolFlanked, { id: 1, unitIdx: 0, x: 0, y: 0, hp: 20, hpMax: 20, sys: { profileIdx: atk.id } });
    const dFlanked = allocModel(poolFlanked, { id: 2, unitIdx: 1, x: 1, y: 0, hp: 20, hpMax: 20, sys: { profileIdx: defHigh.id } });
    (poolFlanked.sys.pfCondition as unknown as Uint32Array)[dFlanked] = PF1eCondition.FLANKED;
    // Fixed rng: d20=13, BAB 5 => 18 raw. Without +2 vs AC 20 = miss; with +2 => 20 vs 20 = hit.
    const fixed13 = { d: (s: number) => (s === 20 ? 13 : 1) };
    const missWithout = resolvePF1eAttacks({ pool: poolPinned, attackers: [aPinned], defenders: [dPinned], registry, rng: fixed13, highFidelity: true });
    expect(missWithout.metrics.hits).toBe(0);
    const hitWith = resolvePF1eAttacks({ pool: poolFlanked, attackers: [aFlanked], defenders: [dFlanked], registry, rng: fixed13, highFidelity: true });
    expect(hitWith.metrics.hits).toBe(1);
  });
});
