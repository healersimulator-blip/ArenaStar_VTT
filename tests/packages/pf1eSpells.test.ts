import { describe, expect, test } from "vitest";
import { SpatialGrid } from "../../src/core/spatialGrid";
import { resolvePF1eAOESpell } from "../../src/packages/pf1e/spells";
import { PF1E_MODEL_SCHEMA, PF1eProfileRegistry } from "../../src/packages/pf1e/schema";
import { allocModel, createModelPool } from "../../src/sim/pool";

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
