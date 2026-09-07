import { describe, expect, test } from "vitest";
import {
  PF1E_MODEL_SCHEMA,
  PF1eDamageType,
  PF1eDrType,
  PF1eProfileRegistry,
  PRECREATED_PF1E_UNITS,
} from "../../src/packages/pf1e/schema";
import {
  resolvePF1eAttacks,
  resolvePF1eHealing,
  resolvePF1eTrample,
} from "../../src/packages/pf1e/combatEngine";
import { allocModel, createModelPool } from "../../src/sim/pool";

describe("PF1e Precreated Units & Advanced Mechanics (Fast Healing, Regeneration, Trample)", () => {
  test("precreated templates compile accurately", () => {
    const registry = new PF1eProfileRegistry();
    const infantry = registry.register(PRECREATED_PF1E_UNITS["infantry"] ?? {});
    const cavalry = registry.register(PRECREATED_PF1E_UNITS["cavalry"] ?? {});
    const troll = registry.register(PRECREATED_PF1E_UNITS["troll"] ?? {});
    const golem = registry.register(PRECREATED_PF1E_UNITS["golem"] ?? {});

    expect(infantry.bab).toBe(6);
    expect(cavalry.hasTrample).toBe(true);
    expect(troll.regenerationVal).toBe(5);
    expect(golem.drTypeFlags).toBe(PF1eDrType.ADAMANTINE);
  });

  test("Troll Regeneration converts ordinary damage to non-lethal and heals it, but Fire/Acid damage deals permanent Lethal damage", () => {
    const registry = new PF1eProfileRegistry();
    const trollProf = registry.register(PRECREATED_PF1E_UNITS["troll"] ?? {});
    const heroProf = registry.register({
      name: "Hero with Fire Sword",
      bab: 1, // Single attack
      strMod: 3,
      weapon: {
        elementalType: PF1eDamageType.FIRE, // Fire damage deals LETHAL damage to Troll!
        damageDiceCount: 1,
        damageDiceSides: 6,
        damageMod: 3,
      },
    });

    const pool = createModelPool(10, PF1E_MODEL_SCHEMA);
    const trollIdx = allocModel(pool, {
      id: 1,
      unitIdx: 0,
      x: 0,
      y: 0,
      hp: 10,
      hpMax: 30,
      sys: { profileIdx: trollProf.id, lethalDmg: 0 },
    });

    const heroIdx = allocModel(pool, {
      id: 2,
      unitIdx: 1,
      x: 1,
      y: 0,
      hp: 40,
      hpMax: 40,
      sys: { profileIdx: heroProf.id },
    });

    // 1. First turn: Regeneration heals 5 non-lethal HP (10 HP -> 15 HP)
    const healRes1 = resolvePF1eHealing(pool, [trollIdx], registry);
    expect(healRes1.totalHealed).toBe(5);
    expect(pool.hp[trollIdx]).toBe(15);

    // 2. Hero attacks Troll with Fire weapon -> deals LETHAL damage!
    resolvePF1eAttacks({
      pool,
      attackers: [heroIdx],
      defenders: [trollIdx],
      registry,
      seed: 42,
      highFidelity: true,
    });

    const lethalDamageTaken = pool.sys["lethalDmg"]?.[trollIdx] ?? 0;
    expect(lethalDamageTaken).toBeGreaterThan(0);

    // 3. Second turn: Regeneration CANNOT heal lethal fire damage! Max heal cap = 30 - lethalDamageTaken
    const maxEffectiveHp = 30 - lethalDamageTaken;
    resolvePF1eHealing(pool, [trollIdx], registry);
    expect(pool.hp[trollIdx]).toBeLessThanOrEqual(maxEffectiveHp);
  });

  test("Cavalry Trample deals automatic damage to infantry unless Reflex save passed", () => {
    const registry = new PF1eProfileRegistry();
    const cavalryProf = registry.register(PRECREATED_PF1E_UNITS["cavalry"] ?? {});
    const infantryProf = registry.register(PRECREATED_PF1E_UNITS["infantry"] ?? {});

    const pool = createModelPool(10, PF1E_MODEL_SCHEMA);
    const cavIdx = allocModel(pool, {
      id: 1,
      unitIdx: 0,
      x: 0,
      y: 0,
      hp: 30,
      hpMax: 30,
      sys: { profileIdx: cavalryProf.id },
    });

    const infIdx = allocModel(pool, {
      id: 2,
      unitIdx: 1,
      x: 5,
      y: 0,
      hp: 20,
      hpMax: 20,
      sys: { profileIdx: infantryProf.id, ref: 2 },
    });

    const trampleRes = resolvePF1eTrample(pool, [cavIdx], [infIdx], registry, 777);

    expect(trampleRes.totalTrampled).toBe(1);
    expect(trampleRes.totalDamage).toBeGreaterThan(0);
    expect(pool.hp[infIdx]).toBeLessThan(20);
  });
});
