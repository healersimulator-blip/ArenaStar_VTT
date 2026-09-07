import { describe, expect, test } from "vitest";
import { PF1E_MODEL_SCHEMA, PF1eCondition, PF1eDrType, PF1eProfileRegistry } from "../../src/packages/pf1e/schema";
import { resolvePF1eAoO, resolvePF1eAttacks, resolvePF1eCombatManeuver, SimpleRng } from "../../src/packages/pf1e/combatEngine";
import { createModelPool, allocModel } from "../../src/sim/pool";

describe("PF1e Combat Engine (§12 / Task 3 & High-Fidelity Rules)", () => {
  test("resolves d20 attack against AC with iterative attacks and DR", () => {
    const registry = new PF1eProfileRegistry();
    const attackerProfile = registry.register({
      name: "Knight",
      bab: 6, // +6/+1
      strMod: 3, // +9/+4 Total AB
      weapon: { damageDiceCount: 1, damageDiceSides: 8, damageMod: 3, critThreatMin: 20, critMultiplier: 2 },
    });
    const defenderProfile = registry.register({
      name: "Orc",
      ac: 15,
      dr: { typeFlags: PF1eDrType.SLASHING, val: 2 }, // DR 2/Slashing
    });

    const pool = createModelPool(10, PF1E_MODEL_SCHEMA);
    const attackerIdx = allocModel(pool, {
      id: 1,
      unitIdx: 0,
      x: 0,
      y: 0,
      hp: 30,
      hpMax: 30,
      sys: { ac: 16, touchAc: 10, fort: 4, ref: 2, will: 1, sr: 0, drType: 0, drVal: 0, profileIdx: attackerProfile.id },
    });
    const defenderIdx = allocModel(pool, {
      id: 2,
      unitIdx: 1,
      x: 1,
      y: 0,
      hp: 20,
      hpMax: 20,
      sys: { ac: defenderProfile.ac, touchAc: 10, fort: 3, ref: 1, will: 0, sr: 0, drType: defenderProfile.drTypeFlags, drVal: defenderProfile.drVal, profileIdx: defenderProfile.id },
    });

    const result = resolvePF1eAttacks({
      pool,
      attackers: [attackerIdx],
      defenders: [defenderIdx],
      registry,
      seed: 42,
    });

    expect(result.attacksExecuted).toBeGreaterThan(0);
    expect(result.metrics.totalAttacks).toBeGreaterThan(0);
    expect(pool.hp[defenderIdx]).toBeLessThanOrEqual(20);
  });

  test("resolves Firearms range increments, Touch AC targeting, and misfires", () => {
    const registry = new PF1eProfileRegistry();
    const gunnerProfile = registry.register({
      name: "Gunslinger",
      bab: 5,
      dexMod: 4,
      weapon: {
        isFirearm: true,
        misfireMin: 2, // Misfire on 1-2
        rangeIncrement: 20,
        damageDiceCount: 1,
        damageDiceSides: 8,
      },
    });

    const defenderProfile = registry.register({
      name: "Armored Golem",
      ac: 25,
      touchAc: 10,
    });

    const pool = createModelPool(10, PF1E_MODEL_SCHEMA);
    const gunnerIdx = allocModel(pool, {
      id: 1,
      unitIdx: 0,
      x: 0,
      y: 0,
      hp: 20,
      hpMax: 20,
      sys: { profileIdx: gunnerProfile.id },
    });

    const defenderIdx = allocModel(pool, {
      id: 2,
      unitIdx: 1,
      x: 10, // Within 20ft 1st range increment -> targets Touch AC 10!
      y: 0,
      hp: 30,
      hpMax: 30,
      sys: { ac: 25, touchAc: 10, profileIdx: defenderProfile.id },
    });

    const result = resolvePF1eAttacks({
      pool,
      attackers: [gunnerIdx],
      defenders: [defenderIdx],
      registry,
      seed: 12345,
      highFidelity: true,
    });

    expect(result.metrics.totalAttacks).toBe(1);
    expect(result.metrics.misfiresCount + result.metrics.hits).toBeGreaterThan(0);
  });

  test("resolves Weapon Enhancement & Material DR Bypass", () => {
    const registry = new PF1eProfileRegistry();
    const paladinProfile = registry.register({
      name: "Paladin",
      bab: 15,
      strMod: 5,
      weapon: {
        enhancementBonus: 3, // +3 weapon bypasses DR/silver and DR/cold_iron
        material: "cold_iron",
        damageType: "slashing",
        damageDiceCount: 2,
        damageDiceSides: 6,
      },
    });

    const feyProfile = registry.register({
      name: "Fey Champion",
      ac: 10,
      dr: { typeFlags: PF1eDrType.COLD_IRON, val: 10 }, // DR 10/Cold Iron
    });

    const pool = createModelPool(10, PF1E_MODEL_SCHEMA);
    const paladinIdx = allocModel(pool, {
      id: 1,
      unitIdx: 0,
      x: 0,
      y: 0,
      hp: 50,
      hpMax: 50,
      sys: { profileIdx: paladinProfile.id },
    });

    const feyIdx = allocModel(pool, {
      id: 2,
      unitIdx: 1,
      x: 1,
      y: 0,
      hp: 50,
      hpMax: 50,
      sys: { profileIdx: feyProfile.id, drVal: 10, drType: PF1eDrType.COLD_IRON },
    });

    const result = resolvePF1eAttacks({
      pool,
      attackers: [paladinIdx],
      defenders: [feyIdx],
      registry,
      seed: 42,
      highFidelity: true,
    });

    expect(result.metrics.hits).toBeGreaterThan(0);
    expect(result.metrics.drBypassed).toBeGreaterThan(0);
  });

  test("resolves Combat Maneuvers (Trip/Grapple) applying condition status", () => {
    const registry = new PF1eProfileRegistry();
    const fighterProfile = registry.register({
      name: "Fighter",
      bab: 5,
      strMod: 4,
      cmb: 9,
    });
    const defenderProfile = registry.register({
      name: "Target",
      cmd: 15,
    });

    const pool = createModelPool(10, PF1E_MODEL_SCHEMA);
    const fIdx = allocModel(pool, { id: 1, unitIdx: 0, x: 0, y: 0, sys: { profileIdx: fighterProfile.id } });
    const dIdx = allocModel(pool, { id: 2, unitIdx: 1, x: 1, y: 0, sys: { profileIdx: defenderProfile.id } });

    const rng = new SimpleRng(999);
    const res = resolvePF1eCombatManeuver(pool, fIdx, dIdx, "trip", registry, rng);

    expect(res.success).toBe(true);
    expect(((pool.status[dIdx] ?? 0) & PF1eCondition.PRONE)).not.toBe(0);
  });

  test("resolves Attack of Opportunity (AoO) against provoking caster", () => {
    const registry = new PF1eProfileRegistry();
    const guardProfile = registry.register({
      name: "Guard",
      bab: 3,
      strMod: 2,
      weapon: { damageDiceCount: 1, damageDiceSides: 6, damageMod: 2 },
    });

    const pool = createModelPool(10, PF1E_MODEL_SCHEMA);
    const casterIdx = allocModel(pool, { id: 1, unitIdx: 0, x: 0, y: 0, hp: 15, sys: { ac: 12 } });
    const guardIdx = allocModel(pool, { id: 2, unitIdx: 1, x: 1, y: 0, hp: 20, sys: { profileIdx: guardProfile.id } });

    const rng = new SimpleRng(555);
    const aoo = resolvePF1eAoO(pool, casterIdx, [guardIdx], registry, rng);

    expect(aoo.hits).toBeGreaterThan(0);
    expect(aoo.totalDamage).toBeGreaterThan(0);
    expect(pool.hp[casterIdx]).toBeLessThan(15);
  });
});
