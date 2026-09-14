/**
 * M06 (D-228) — the strategic nonlethal ladder and shared spell-resistance check:
 * §2.12 thresholds at the mass-battle grain, excess-past-max conversion, and one
 * A.16 implementation across both scales with the once-per-round overcome cache.
 */
import { describe, expect, test } from "vitest";
import { createModelPool, allocModel } from "../../src/sim/pool";
import {
  PF1E_MODEL_SCHEMA,
  PF1eCondition,
  PF1eDrType,
  PF1eProfileRegistry,
  type RawPF1eProfile,
} from "../../src/packages/pf1e/schema";
import {
  resolvePF1eAttacks,
  type PF1eRng,
} from "../../src/packages/pf1e/combatEngine";
import { SpatialGrid } from "../../src/core/spatialGrid";
import { resolvePF1eAOESpell } from "../../src/packages/pf1e/spells";

function scriptedDice(rolls: number[]): PF1eRng {
  let i = 0;
  return {
    d: (sides: number): number => {
      const v = rolls[i % rolls.length] ?? 1;
      i++;
      return Math.max(1, Math.min(sides, v));
    },
  };
}

const softBlow: RawPF1eProfile = {
  name: "Sap Master",
  bab: 0,
  strMod: -4,
  weapon: { damageDiceCount: 1, damageDiceSides: 6, damageMod: -1 }, // 1d6−5 → min-damage nonlethal
  ac: 30,
};

function duel(
  defenderSeed: { hp?: number; hpMax?: number; nonlethal?: number; dr?: { val: number; flags: number } },
  attacker: RawPF1eProfile = softBlow,
): {
  pool: ReturnType<typeof createModelPool>;
  atkIdx: number;
  defIdx: number;
  registry: PF1eProfileRegistry;
  pfCol: Uint32Array;
} {
  const registry = new PF1eProfileRegistry();
  const atk = registry.register(attacker);
  const def = registry.register({
    name: "Target",
    bab: 1,
    ac: 10,
    hp: defenderSeed.hp ?? 10,
    ...(defenderSeed.dr ? { dr: { typeFlags: defenderSeed.dr.flags, val: defenderSeed.dr.val } } : {}),
  });
  const pool = createModelPool(4, PF1E_MODEL_SCHEMA);
  const atkIdx = allocModel(pool, {
    id: 1,
    unitIdx: 0,
    x: 0,
    y: 0,
    hp: 20,
    hpMax: 20,
    sys: { profileIdx: atk.id },
  });
  const defIdx = allocModel(pool, {
    id: 2,
    unitIdx: 1,
    x: 5,
    y: 0,
    hp: defenderSeed.hp ?? 10,
    hpMax: defenderSeed.hpMax ?? defenderSeed.hp ?? 10,
    sys: {
      profileIdx: def.id,
      ...(defenderSeed.nonlethal !== undefined ? { nonlethal: defenderSeed.nonlethal } : {}),
    },
  });
  const pfCol = pool.sys.pfCondition as unknown as Uint32Array;
  return { pool, atkIdx, defIdx, registry, pfCol };
}

describe("M06 §2.12 — nonlethal thresholds at the strategic scale", () => {
  test("nonlethal exactly equal to current HP staggers, not knocks out", () => {
    // Target has 5 HP and already 4 nonlethal; a 1-point subdue hit lands exactly at 5.
    const { pool, atkIdx, defIdx, registry, pfCol } = duel({ hp: 5, nonlethal: 4 });
    const res = resolvePF1eAttacks({
      pool,
      attackers: [atkIdx],
      defenders: [defIdx],
      registry,
      rng: scriptedDice([15, 2]), // hits (15−4 = 11 ≥ 10); base 2−5 < 1 → 1 nonlethal
      highFidelity: true,
    });
    expect(res.metrics.nonlethalDealt).toBe(1);
    expect((pfCol[defIdx] ?? 0) & PF1eCondition.STAGGERED).not.toBe(0);
    expect((pfCol[defIdx] ?? 0) & PF1eCondition.UNCONSCIOUS).toBe(0);
  });

  test("nonlethal exceeding current HP knocks out (and replaces staggered)", () => {
    const { pool, atkIdx, defIdx, registry, pfCol } = duel({ hp: 5, nonlethal: 3 });
    pfCol[defIdx] = PF1eCondition.STAGGERED; // already staggered at an earlier equal-hit
    // Two hits: first lands 1 nonlethal (4 total < 5), second lands 2 (6 total > 5 ⇒ out).
    // The sap's minimum-damage hit only ever deals 1, so give the attacker a stronger swing
    // by attacking twice: totals 4 then 5-armed... use two separate attacks from one model
    // with iteratives [0, 0] only one — simpler: run two resolve calls.
    const swing = (): void => {
      resolvePF1eAttacks({
        pool,
        attackers: [atkIdx],
        defenders: [defIdx],
        registry,
        rng: scriptedDice([15, 2]),
        highFidelity: true,
      });
    };
    swing();
    expect((pool.sys["nonlethal"] as unknown as Uint16Array)[defIdx]).toBe(4);
    expect((pfCol[defIdx] ?? 0) & PF1eCondition.UNCONSCIOUS).toBe(0);
    // Manually bump pre-existing tally past the threshold to model a second source landing
    // the knockout point-wise (available sources land 1 at a time here).
    (pool.sys["nonlethal"] as unknown as Uint16Array)[defIdx] = 5;
    swing(); // 1 damage: total 6 > hp 5 ⇒ UNCONSCIOUS, staggered cleared
    expect((pfCol[defIdx] ?? 0) & PF1eCondition.UNCONSCIOUS).not.toBe(0);
    expect((pfCol[defIdx] ?? 0) & PF1eCondition.STAGGERED).toBe(0);
  });

  test("an unconscious model takes no attacks", () => {
    const { pool, atkIdx, registry, pfCol } = duel({});
    pfCol[atkIdx] = PF1eCondition.UNCONSCIOUS;
    const res = resolvePF1eAttacks({
      pool,
      attackers: [atkIdx],
      defenders: [1],
      registry,
      rng: scriptedDice([20, 6]),
      highFidelity: true,
    });
    expect(res.metrics.totalAttacks).toBe(0);
  });

  test("a staggered attacker makes exactly one attack where a healthy one marches the full ladder", () => {
    const registry = new PF1eProfileRegistry();
    const hale = registry.register({
      name: "Hale Brute",
      bab: 11,
      strMod: 4,
      weapon: { damageDiceCount: 1, damageDiceSides: 8 },
    });
    const victim = registry.register({ name: "Victim", bab: 1, ac: 10, hp: 60 });
    const mkPool = (staggered: boolean) => {
      const pool = createModelPool(4, PF1E_MODEL_SCHEMA);
      const a = allocModel(pool, {
        id: 1,
        unitIdx: 0,
        x: 0,
        y: 0,
        hp: 20,
        hpMax: 20,
        sys: { profileIdx: hale.id },
      });
      allocModel(pool, {
        id: 2,
        unitIdx: 1,
        x: 5,
        y: 0,
        hp: 60,
        hpMax: 60,
        sys: { profileIdx: victim.id },
      });
      if (staggered) (pool.sys.pfCondition as unknown as Uint32Array)[a] = PF1eCondition.STAGGERED;
      return { pool, a };
    };
    const full = resolvePF1eAttacks({
      ...(() => {
        const { pool, a } = mkPool(false);
        return { pool, attackers: [a] };
      })(),
      defenders: [1],
      registry,
      rng: scriptedDice([20, 20, 20, 8, 8, 8, 8, 8, 8]),
      highFidelity: true,
    });
    expect(full.metrics.totalAttacks).toBe(3); // BAB 11/6/1
    const half = resolvePF1eAttacks({
      ...(() => {
        const { pool, a } = mkPool(true);
        return { pool, attackers: [a] };
      })(),
      defenders: [1],
      registry,
      rng: scriptedDice([20, 20, 8, 8]),
      highFidelity: true,
    });
    expect(half.metrics.totalAttacks).toBe(1); // one move OR standard at this grain
  });

  test("past the HP maximum the excess converts to lethal and faces leftover DR", () => {
    // 10/10 HP, 8 nonlethal banked; a 1-point blow: 8+1 = 9 < max 10 — nothing converts.
    const first = duel({ hp: 10, hpMax: 10, nonlethal: 8, dr: { val: 1, flags: PF1eDrType.NONE } });
    resolvePF1eAttacks({
      pool: first.pool,
      attackers: [first.atkIdx],
      defenders: [first.defIdx],
      registry: first.registry,
      rng: scriptedDice([15, 2]),
      highFidelity: true,
    });
    expect(first.pool.hp[first.defIdx]).toBe(10); // still untouched: 9 < 10 max
    // Second 1-point blow: tally 9→10... at exactly max the NEXT point converts. Bucket: max(0, 10−max(9,10)) = 0.
    resolvePF1eAttacks({
      pool: first.pool,
      attackers: [first.atkIdx],
      defenders: [first.defIdx],
      registry: first.registry,
      rng: scriptedDice([15, 2]),
      highFidelity: true,
    });
    expect(first.pool.hp[first.defIdx]).toBe(10); // exactly at max: exhausted conversions started only beyond
    // Third blow: tally 10→11 ⇒ 1 converts; DR 1 (fresh per-attack) had nothing to chew on the
    // weapon blow (nonlethal-only), so residual 1 point swallows the converted point.
    // A fourth blow converts again; without DR it would draw blood.
    resolvePF1eAttacks({
      pool: first.pool,
      attackers: [first.atkIdx],
      defenders: [first.defIdx],
      registry: first.registry,
      rng: scriptedDice([15, 2]),
      highFidelity: true,
    });
    expect(first.pool.hp[first.defIdx]).toBe(10); // residual DR ate the converted point
    const bare = duel({ hp: 10, hpMax: 10, nonlethal: 10 }); // no DR this time
    const res = resolvePF1eAttacks({
      pool: bare.pool,
      attackers: [bare.atkIdx],
      defenders: [bare.defIdx],
      registry: bare.registry,
      rng: scriptedDice([15, 2]),
      highFidelity: true,
    });
    // tally 10→11: 1 converts with no DR in the way → hp 9.
    expect(bare.pool.hp[bare.defIdx]).toBe(9);
    expect(res.metrics.nonlethalDealt).toBe(1);
  });
});

describe("M06 §2.11 — one A.16 checker across both scales; overcome once per round", () => {
  function spellDuel(sr: number): {
    pool: ReturnType<typeof createModelPool>;
    grid: SpatialGrid;
    registry: PF1eProfileRegistry;
    casterIdx: number;
    targetIdx: number;
  } {
    const registry = new PF1eProfileRegistry();
    const caster = registry.register({
      name: "Wizard",
      bab: 1,
      casterLevel: 5,
      hp: 8,
    });
    const target = registry.register({ name: "Golem", bab: 1, ac: 10, sr, hp: 20 });
    const pool = createModelPool(4, PF1E_MODEL_SCHEMA);
    // Caster stands far outside his own area (origin (5,0), radius 20): only the target
    // model is inside, so every die in the scripted queue is the target's.
    const casterIdx = allocModel(pool, {
      id: 1,
      unitIdx: 0,
      x: 5,
      y: 40,
      hp: 8,
      hpMax: 8,
      sys: { profileIdx: caster.id, sr: 0 },
    });
    const targetIdx = allocModel(pool, {
      id: 2,
      unitIdx: 1,
      x: 5,
      y: 0,
      hp: 20,
      hpMax: 20,
      sys: { profileIdx: target.id, sr, ref: 0 },
    });
    const grid = new SpatialGrid(5);
    grid.rebuild(pool);
    return { pool, grid, registry, casterIdx, targetIdx };
  }

  const fireball = (casterIdx: number) => ({
    spellName: "fireball",
    shape: "circle" as const,
    x: 5,
    y: 0,
    radius: 20,
    dc: 13,
    damageDiceCount: 5,
    damageDiceSides: 6,
    saveType: "ref" as const,
    halfOnSave: true,
    casterLevel: 5,
    casterIdx,
  });

  test("a natural 20 can still fail and a natural 1 can still succeed with the shared checker", () => {
    // CL 5 vs SR 26: 20 + 5 = 25 < 26 ⇒ resisted (the old sim treated nat 20 as auto-success).
    const high = spellDuel(26);
    const resisted = resolvePF1eAOESpell({
      pool: high.pool,
      grid: high.grid,
      spell: fireball(high.casterIdx),
      registry: high.registry,
      rng: scriptedDice([20, 20, 20, 20, 6, 6, 6, 6, 6]),
      highFidelity: true,
    });
    expect(resisted.metrics.srBlocked).toBe(1);
    expect(resisted.metrics.damageDealt).toBe(0);
    // CL 5 vs SR 6: 1 + 5 = 6 ≥ 6 ⇒ overcomes even on the floor die (no nat-1 auto-fail).
    const low = spellDuel(6);
    (low.pool.sys["ref"] ?? [])[low.targetIdx] = 50; // save auto-passes to isolate the SR leg
    const overcomes = resolvePF1eAOESpell({
      pool: low.pool,
      grid: low.grid,
      spell: fireball(low.casterIdx),
      registry: low.registry,
      rng: scriptedDice([1, 20, 6, 6, 6, 6, 6]),
      highFidelity: true,
    });
    expect(overcomes.metrics.srBlocked).toBe(0);
    expect(overcomes.metrics.damageDealt).toBe(15); // 5 × 3
  });

  test("a second spell from the same caster skips the overcome check against an already-broken model", () => {
    const sr = 24; // CL 5 needs a natural 19+ — the first cast rolls 19 and overcomes.
    const { pool, grid, registry, casterIdx, targetIdx } = spellDuel(sr);
    (pool.sys["ref"] ?? [])[targetIdx] = 50; // saves always pass: the SR leg is what the queue truths prove
    const srRoundCache = new Set<string>();
    const firstCast = resolvePF1eAOESpell({
      pool,
      grid,
      spell: fireball(casterIdx),
      registry,
      rng: scriptedDice([19, 20, 6, 6, 6, 6, 6]), // SR roll 19 (19+5 = 24 ≥ 24 overcomes)
      highFidelity: true,
      srRoundCache,
    });
    expect(firstCast.metrics.srBlocked).toBe(0);
    expect(srRoundCache.size).toBe(1);
    // The second cast against the same model in the same turn: NO SR die is consumed at all —
    // the scripted queue leads with a 2, which would fail as an SR check (2+5 = 7 < 24) but
    // passes as the save (saves auto-fail only on a natural 1).
    const secondCast = resolvePF1eAOESpell({
      pool,
      grid,
      spell: fireball(casterIdx),
      registry,
      rng: scriptedDice([2, 20, 6, 6, 6, 6, 6]), // 2 would be the SR die if the cache were broken
      highFidelity: true,
      srRoundCache,
    });
    expect(secondCast.metrics.srBlocked).toBe(0);
    expect(secondCast.metrics.damageDealt).toBe(15); // resolved: 5d6 + save-half with ref 50
    expect(srRoundCache.size).toBe(1);
  });

  test("different casters still check independently against the same model", () => {
    const sr = 30;
    const { pool, grid, registry, casterIdx, targetIdx } = spellDuel(sr);
    const srRoundCache = new Set<string>();
    const first = resolvePF1eAOESpell({
      pool,
      grid,
      spell: fireball(casterIdx),
      registry,
      rng: scriptedDice([20, 6, 6, 6, 6, 6]),
      highFidelity: true,
      srRoundCache,
    });
    expect(first.metrics.srBlocked).toBe(1);
    expect(srRoundCache.size).toBe(0); // a RESISTED caster never poisons the cache for others
    // A second caster model with a better die still fails — but its fate is its own.
    const secondCasterIdx = allocModel(
      pool,
      { id: 3, unitIdx: 0, x: 5, y: 60, hp: 8, hpMax: 8, sys: { profileIdx: 1, sr: 0 } },
    );
    grid.rebuild(pool); // the second caster entered the pool after the first rebuild
    const second = resolvePF1eAOESpell({
      pool,
      grid,
      spell: fireball(secondCasterIdx),
      registry,
      rng: scriptedDice([20, 6, 6, 6, 6, 6]),
      highFidelity: true,
      srRoundCache,
    });
    expect(second.metrics.srBlocked).toBe(1);
    void targetIdx;
  });
});
