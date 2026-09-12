import { describe, expect, test } from "vitest";
import { SpatialGrid } from "../../src/core/spatialGrid";
import { resolvePF1eAOESpell } from "../../src/packages/pf1e/spells";
import { PF1E_MODEL_SCHEMA, PF1eProfileRegistry } from "../../src/packages/pf1e/schema";
import { allocModel, createModelPool } from "../../src/sim/pool";
import type { RulesWallsContext } from "../../src/core/rules";

describe("PF1e AOE Spell & Avoidance Engine (§12 / Task 5 & High-Fidelity Rules)", () => {
  test("resolves circle Fireball AOE with Reflex saves", () => {
    const grid = new SpatialGrid(5);
    const pool = createModelPool(10, PF1E_MODEL_SCHEMA);
    const registry = new PF1eProfileRegistry();
    const defenderProfile = registry.register({
      name: "Goblin",
      ref: 5,
      ac: 14,
    });

    allocModel(pool, {
      id: 1,
      unitIdx: 0,
      x: 10,
      y: 10,
      hp: 15,
      hpMax: 15,
      sys: { ac: 14, touchAc: 12, fort: 1, ref: 5, will: 0, sr: 0, drType: 0, drVal: 0, profileIdx: defenderProfile.id },
    });

    grid.rebuild(pool);

    const res = resolvePF1eAOESpell({
      pool,
      grid,
      spell: {
        spellName: "Fireball",
        shape: "circle",
        x: 10,
        y: 10,
        radius: 15,
        dc: 15,
        damageDiceCount: 6,
        damageDiceSides: 6,
        saveType: "ref",
      },
      seed: 12345,
    });

    expect(res.affectedModels.length).toBeGreaterThan(0);
    expect(res.metrics.damageDealt).toBeGreaterThan(0);
  });

  test("perModel attributes each model's outcome so callers can book it per unit (D-165)", () => {
    const grid = new SpatialGrid(5);
    const pool = createModelPool(10, PF1E_MODEL_SCHEMA);
    // Two models in the area; the second has 1 HP so any damage kills it.
    allocModel(pool, {
      id: 1,
      unitIdx: 0,
      x: 10,
      y: 10,
      hp: 60,
      hpMax: 60,
      sys: { ac: 14, touchAc: 12, fort: 1, ref: 0, will: 0, sr: 0, drType: 0, drVal: 0, profileIdx: 0 },
    });
    allocModel(pool, {
      id: 2,
      unitIdx: 1,
      x: 12,
      y: 10,
      hp: 1,
      hpMax: 1,
      sys: { ac: 14, touchAc: 12, fort: 1, ref: 0, will: 0, sr: 0, drType: 0, drVal: 0, profileIdx: 0 },
    });
    grid.rebuild(pool);

    const res = resolvePF1eAOESpell({
      pool,
      grid,
      spell: {
        spellName: "Fireball",
        shape: "circle",
        x: 10,
        y: 10,
        radius: 15,
        dc: 15,
        damageDiceCount: 5,
        damageDiceSides: 6,
        saveType: "ref",
      },
      seed: 99,
      highFidelity: false,
    });

    // One outcome per affected model, and the outcomes reconstruct the aggregates.
    expect(res.perModel.length).toBe(res.affectedModels.length);
    expect(res.perModel.map((o) => o.idx)).toEqual(res.affectedModels);
    const totalDamage = res.perModel.reduce((sum, o) => sum + o.damageDealt, 0);
    expect(totalDamage).toBe(res.metrics.damageDealt);
    expect(res.perModel.filter((o) => o.killed).length).toBe(res.metrics.killsCount);
    // The 1 HP model took at least 1 damage (5d6), so its outcome says killed and the
    // pool agrees.
    const fragile = res.perModel.find((o) => o.idx === 1);
    expect(fragile).toBeDefined();
    expect(fragile?.killed).toBe(true);
    expect(fragile?.damageDealt).toBeGreaterThanOrEqual(1);
    expect(pool.hp[1]).toBe(0);
  });

  test("cone membership is the quarter-circle: within 45° of the aim, out to the length (D-167)", () => {
    const grid = new SpatialGrid(5);
    const pool = createModelPool(10, PF1E_MODEL_SCHEMA);
    const sys = { ac: 14, touchAc: 12, fort: 1, ref: 0, will: 0, sr: 0, drType: 0, drVal: 0, profileIdx: 0 };
    // Aim is +x from (0,0), length 30.
    allocModel(pool, { id: 1, unitIdx: 0, x: 25, y: 15, hp: 60, hpMax: 60, sys }); // 18° off the aim, in
    allocModel(pool, { id: 2, unitIdx: 0, x: 20, y: 35, hp: 60, hpMax: 60, sys }); // 60° off the aim, out
    allocModel(pool, { id: 3, unitIdx: 0, x: 45, y: 10, hp: 60, hpMax: 60, sys }); // past the 30-ft length
    allocModel(pool, { id: 4, unitIdx: 0, x: -5, y: 10, hp: 60, hpMax: 60, sys }); // behind the caster
    grid.rebuild(pool);

    const res = resolvePF1eAOESpell({
      pool,
      grid,
      spell: { spellName: "Cone", shape: "cone", x: 0, y: 0, radius: 30, dirX: 1, dirY: 0, dc: 15, damageDiceCount: 1, damageDiceSides: 6, saveType: "ref" },
      seed: 3,
      highFidelity: false,
    });

    expect(res.affectedModels).toEqual([0]); // only the model 18° off the aim
  });

  test("line membership is the corridor the line passes through (D-167)", () => {
    const grid = new SpatialGrid(5);
    const pool = createModelPool(10, PF1E_MODEL_SCHEMA);
    const sys = { ac: 14, touchAc: 12, fort: 1, ref: 0, will: 0, sr: 0, drType: 0, drVal: 0, profileIdx: 0 };
    // Aim is +x from (0,0): 60 ft long, 5 ft wide.
    allocModel(pool, { id: 1, unitIdx: 0, x: 40, y: 2, hp: 60, hpMax: 60, sys }); // 2 ft off the axis, in
    allocModel(pool, { id: 2, unitIdx: 0, x: 40, y: 4, hp: 60, hpMax: 60, sys }); // 4 ft off the axis, out
    allocModel(pool, { id: 3, unitIdx: 0, x: 65, y: 0, hp: 60, hpMax: 60, sys }); // past the 60-ft length
    allocModel(pool, { id: 4, unitIdx: 0, x: -5, y: 0, hp: 60, hpMax: 60, sys }); // behind the caster
    grid.rebuild(pool);

    const res = resolvePF1eAOESpell({
      pool,
      grid,
      spell: { spellName: "Line", shape: "line", x: 0, y: 0, radius: 60, widthFeet: 5, dirX: 1, dirY: 0, dc: 15, damageDiceCount: 1, damageDiceSides: 6, saveType: "ref" },
      seed: 3,
      highFidelity: false,
    });

    expect(res.affectedModels).toEqual([0]); // only the model inside the corridor
  });

  test("sight-blocking walls give total cover from the point of origin (D-166)", () => {
    const wall: RulesWallsContext = {
      x1: new Float32Array([-50]),
      y1: new Float32Array([15]),
      x2: new Float32Array([60]),
      y2: new Float32Array([15]),
      restriction: new Uint8Array([2]), // bit 1 = sight (§0 convention)
    };
    const cast = (walls?: RulesWallsContext) => {
      const grid = new SpatialGrid(5);
      const pool = createModelPool(10, PF1E_MODEL_SCHEMA);
      // (12,10) is on the origin's side of the wall; (10,20) is on the far side.
      allocModel(pool, { id: 1, unitIdx: 0, x: 12, y: 10, hp: 60, hpMax: 60, sys: { ac: 14, touchAc: 12, fort: 1, ref: 0, will: 0, sr: 0, drType: 0, drVal: 0, profileIdx: 0 } });
      allocModel(pool, { id: 2, unitIdx: 1, x: 10, y: 20, hp: 60, hpMax: 60, sys: { ac: 14, touchAc: 12, fort: 1, ref: 0, will: 0, sr: 0, drType: 0, drVal: 0, profileIdx: 0 } });
      grid.rebuild(pool);
      return resolvePF1eAOESpell({
        pool,
        grid,
        spell: { spellName: "Fireball", shape: "circle", x: 10, y: 10, radius: 15, dc: 15, damageDiceCount: 5, damageDiceSides: 6, saveType: "ref" },
        seed: 7,
        highFidelity: false,
        ...(walls ? { walls } : {}),
      });
    };

    // Open field: both models are in the 15-ft spread.
    expect(cast().metrics.modelsTargeted).toBe(2);
    // With the wall: the far model has total cover and is neither targeted nor rolled
    // against; it is reported as cover-blocked instead.
    const walled = cast(wall);
    expect(walled.metrics.modelsTargeted).toBe(1);
    expect(walled.metrics.modelsBlockedByCover).toBe(1);
    expect(walled.perModel.length).toBe(1);
  });

  test("resolves Caster Level vs Spell Resistance (CL vs SR) check", () => {
    const grid = new SpatialGrid(5);
    const pool = createModelPool(10, PF1E_MODEL_SCHEMA);
    const registry = new PF1eProfileRegistry();

    const dIdx = allocModel(pool, {
      id: 1,
      unitIdx: 0,
      x: 10,
      y: 10,
      hp: 20,
      sys: { sr: 25, ref: 2 }, // High SR 25
    });

    grid.rebuild(pool);

    const res = resolvePF1eAOESpell({
      pool,
      grid,
      spell: {
        spellName: "Fireball",
        shape: "circle",
        x: 10,
        y: 10,
        radius: 15,
        dc: 15,
        damageDiceCount: 6,
        damageDiceSides: 6,
        saveType: "ref",
        casterLevel: 3, // CL 3 + d20 < 25 SR -> blocked!
      },
      seed: 100,
      registry,
      highFidelity: true,
    });

    expect(res.metrics.srBlocked).toBe(1);
    expect(pool.hp[dIdx]).toBe(20); // Takes 0 damage due to SR
  });

  test("resolves Defensive Casting Concentration check and AoO spell interruption", () => {
    const grid = new SpatialGrid(5);
    const pool = createModelPool(10, PF1E_MODEL_SCHEMA);
    const registry = new PF1eProfileRegistry();

    const guardProfile = registry.register({
      name: "Guard",
      bab: 5,
      strMod: 3,
      weapon: { damageDiceCount: 2, damageDiceSides: 6, damageMod: 4 },
    });

    const casterIdx = allocModel(pool, { id: 1, unitIdx: 0, x: 10, y: 10, hp: 30, sys: { ac: 10 } });
    const guardIdx = allocModel(pool, { id: 2, unitIdx: 1, x: 10, y: 11, hp: 30, sys: { profileIdx: guardProfile.id } });

    grid.rebuild(pool);

    const res = resolvePF1eAOESpell({
      pool,
      grid,
      spell: {
        spellName: "Fireball",
        shape: "circle",
        x: 10,
        y: 10,
        radius: 15,
        dc: 15,
        spellLevel: 3,
        casterIdx,
        casterLevel: 1,
        castingStatMod: 0, // Low concentration +1 vs DC 21 -> fails defensive casting!
        damageDiceCount: 6,
        damageDiceSides: 6,
        saveType: "ref",
      },
      seed: 12,
      registry,
      casterAdjacentEnemies: [guardIdx],
      highFidelity: true,
    });

    expect(res.metrics.concentrationFailed).toBe(1);
  });

  // ---- C05: DEVIATIONS D-1 and the strategic save semantics -------------------

  /** Deterministic dice: `d20Face` for a d20, `damageFace` for anything smaller. */
  const fixedRng = (d20Face: number, damageFace = 6) => ({ d: (sides: number) => (sides === 20 ? d20Face : Math.min(damageFace, sides)) });

  test("never moves a model, so a model at the edge of the radius is still caught (D-1)", () => {
    const grid = new SpatialGrid(5);
    const pool = createModelPool(10, PF1E_MODEL_SCHEMA);
    // 14.5 ft from the epicenter, inside a 15-ft radius. The deleted scatter step would
    // have pushed it to 15.5 ft and reported it as having escaped the blast.
    const idx = allocModel(pool, { id: 1, unitIdx: 0, x: 10, y: 24.5, hp: 50, sys: { ref: 0 } });
    grid.rebuild(pool);

    const res = resolvePF1eAOESpell({
      pool,
      grid,
      spell: { spellName: "Fireball", shape: "circle", x: 10, y: 10, radius: 15, dc: 15, damageDiceCount: 2, damageDiceSides: 6, saveType: "ref" },
      rng: fixedRng(1), // fails the save, takes full damage
    });

    expect(res.affectedModels).toEqual([idx]);
    expect(res.metrics.modelsTargeted).toBe(1);
    expect(res.metrics.damageDealt).toBe(12);
    // The spell resolves in the square the model occupies.
    expect(pool.x[idx]).toBe(10);
    expect(pool.y[idx]).toBe(24.5);
    expect("modelsScattered" in res.metrics).toBe(false);
  });

  test("a natural 20 caster level check no longer overcomes spell resistance", () => {
    const grid = new SpatialGrid(5);
    const pool = createModelPool(10, PF1E_MODEL_SCHEMA);
    const idx = allocModel(pool, { id: 1, unitIdx: 0, x: 10, y: 10, hp: 20, sys: { sr: 25, ref: 0 } });
    grid.rebuild(pool);

    // CL 3 + a natural 20 = 23, which does not reach SR 25. A caster level check has no
    // automatic success on a 20; the old `srRoll !== 20` short-circuit gave it one.
    const res = resolvePF1eAOESpell({
      pool,
      grid,
      spell: { spellName: "Fireball", shape: "circle", x: 10, y: 10, radius: 15, dc: 15, damageDiceCount: 2, damageDiceSides: 6, saveType: "ref", casterLevel: 3 },
      rng: fixedRng(20),
      highFidelity: true,
    });

    expect(res.metrics.srBlocked).toBe(1);
    expect(res.metrics.damageDealt).toBe(0);
    expect(pool.hp[idx]).toBe(20);
  });

  test("Evasion does nothing to a Fortitude-half spell", () => {
    const grid = new SpatialGrid(5);
    const pool = createModelPool(10, PF1E_MODEL_SCHEMA);
    allocModel(pool, { id: 1, unitIdx: 0, x: 10, y: 10, hp: 50, sys: { fort: 0 } });
    grid.rebuild(pool);

    const res = resolvePF1eAOESpell({
      pool,
      grid,
      spell: { spellName: "Cloudkill", shape: "circle", x: 10, y: 10, radius: 15, dc: 15, damageDiceCount: 2, damageDiceSides: 6, saveType: "fort", evasion: true, improvedEvasion: true },
      rng: fixedRng(20), // natural 20 always saves
    });

    // Evasion is defined against a Reflex save for half damage, so 12 halves to 6
    // rather than being negated.
    expect(res.metrics.savesPassed).toBe(1);
    expect(res.metrics.damageDealt).toBe(6);
  });

  test("a successful save on a negates spell deals no damage; a failure deals it all", () => {
    const build = (d20Face: number) => {
      const grid = new SpatialGrid(5);
      const pool = createModelPool(10, PF1E_MODEL_SCHEMA);
      allocModel(pool, { id: 1, unitIdx: 0, x: 10, y: 10, hp: 50, sys: { will: 0 } });
      grid.rebuild(pool);
      return resolvePF1eAOESpell({
        pool,
        grid,
        spell: { spellName: "Hold Person", shape: "circle", x: 10, y: 10, radius: 15, dc: 15, damageDiceCount: 2, damageDiceSides: 6, saveType: "will", halfOnSave: false },
        rng: fixedRng(d20Face),
      });
    };

    expect(build(20).metrics.damageDealt).toBe(0); // saved: negated
    expect(build(1).metrics.damageDealt).toBe(12); // natural 1: full effect
  });
});
