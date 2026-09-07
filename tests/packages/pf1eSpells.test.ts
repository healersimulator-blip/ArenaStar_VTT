import { describe, expect, test } from "vitest";
import { SpatialGrid } from "../../src/core/spatialGrid";
import { resolvePF1eAOESpell } from "../../src/packages/pf1e/spells";
import { PF1E_MODEL_SCHEMA, PF1eProfileRegistry } from "../../src/packages/pf1e/schema";
import { allocModel, createModelPool } from "../../src/sim/pool";

describe("PF1e AOE Spell & Avoidance Engine (§12 / Task 5 & High-Fidelity Rules)", () => {
  test("resolves circle Fireball AOE with 5ft scatter step and Reflex saves", () => {
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
});
