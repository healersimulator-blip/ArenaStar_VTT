/**
 * SRD Combat-chapter fidelity tests for the fixes in
 * PF1e_Combat_Fidelity_GapList.md §2.1 (flat-footed AC), §2.2 (flanking is a bonus on the
 * attack roll only) and §2.3 (minimum damage becomes nonlethal).
 *
 * Each test names the SRD heading it is asserting, and every dice source is a fixed stub so
 * the assertions are about the rule rather than about luck.
 */
import { describe, expect, test } from "vitest";
import {
  PF1E_MODEL_SCHEMA,
  PF1eCondition,
  PF1eProfileRegistry,
  compilePF1eProfile,
} from "../../src/packages/pf1e/schema";
import {
  resolvePF1eAttacks,
  resolveTargetAc,
  pf1eAcColumn,
  type PF1eRng,
} from "../../src/packages/pf1e/combatEngine";
import { allocModel, createModelPool } from "../../src/sim/pool";
import type { ModelPool } from "../../src/core/strategic";

/** `d20 = hit`, every damage die = 1 — deterministic, no critical threat. */
const fixed = (d20: number, die = 1): PF1eRng => ({
  d: (sides: number) => (sides === 20 ? d20 : die),
});

function twoModelArena(defenderSys: Record<string, number>, attackerSys: Record<string, number> = {}) {
  const pool: ModelPool = createModelPool(8, PF1E_MODEL_SCHEMA);
  const attacker = allocModel(pool, {
    id: 1,
    unitIdx: 0,
    x: 0,
    y: 0,
    hp: 20,
    hpMax: 20,
    sys: attackerSys,
  });
  const defender = allocModel(pool, {
    id: 2,
    unitIdx: 1,
    x: 1,
    y: 0,
    hp: 40,
    hpMax: 40,
    sys: defenderSys,
  });
  return { pool, attacker, defender };
}

describe("Combat Statistics > Armor Class — the three AC flavours (§2.1)", () => {
  test("flat-footed AC excludes Dexterity and dodge, touch AC excludes armor", () => {
    const profile = compilePF1eProfile(1, {
      name: "Sleuth in studded leather",
      dexMod: 4,
      dodgeBonus: 1,
      armorBonus: 3,
      shieldBonus: 1,
      naturalArmor: 2,
      sizeMod: 0,
      miscAc: 1,
    });
    // 10 + 3 armor + 1 shield + 4 Dex + 2 natural + 1 misc + 1 dodge
    expect(profile.ac).toBe(22);
    // touch: no armor/shield/natural
    expect(profile.touchAc).toBe(16);
    // flat-footed: no Dex, no dodge
    expect(profile.flatFootedAc).toBe(17);
  });

  test("targetAcType selects the defender's column, never the attacker's profile", () => {
    const registry = new PF1eProfileRegistry();
    const attacker = registry.register({ name: "Knight", bab: 1, ac: 30, touchAc: 26, flatFootedAc: 24 });
    const defender = registry.register({ name: "Goblin", ac: 15, touchAc: 12, flatFootedAc: 11 });
    const { pool, attacker: aIdx, defender: dIdx } = twoModelArena(
      { profileIdx: defender.id },
      { profileIdx: attacker.id, ac: 30, touchAc: 26, flatFootedAc: 24 },
    );

    expect(resolveTargetAc(pool, defender, dIdx, "ac")).toBe(15);
    expect(resolveTargetAc(pool, defender, dIdx, "flatFootedAc")).toBe(11);
    // The pre-fix code read the non-existent `pool.sys["flatFooted"]` and fell back to the
    // ATTACKER's AC (30). Assert that is impossible now.
    expect(resolveTargetAc(pool, defender, dIdx, "flatFooted")).toBe(11);
    expect(resolveTargetAc(pool, defender, dIdx, "flatFooted")).not.toBe(30);
    expect(aIdx).toBeGreaterThanOrEqual(0);
  });

  test("an unset (zero) column falls back to the base AC 10, not to a random defender's AC", () => {
    const { pool } = twoModelArena({});
    expect(resolveTargetAc(pool, undefined, 1, "ac")).toBe(10);
    expect(pf1eAcColumn("flatFooted")).toBe("flatFootedAc");
    expect(() => pf1eAcColumn("armorClass" as "ac")).toThrow(/unknown targetAcType/);
  });

  test("attacking a flat-footed target hits where the same roll misses its normal AC", () => {
    const registry = new PF1eProfileRegistry();
    const attacker = registry.register({ name: "Rogue", bab: 12, strMod: 0 });
    const defender = registry.register({ name: "Guard", ac: 25, flatFootedAc: 12 });

    // 1d20 = 2 with +12 BAB → a total of 14. Same roll, two different AC flavours:
    // 14 vs AC 25 → miss; 14 vs flat-footed AC 12 → hit.
    const attempt = (targetAcType: "ac" | "flatFootedAc") => {
      const { pool, attacker: aIdx, defender: dIdx } = twoModelArena(
        { profileIdx: defender.id },
        { profileIdx: attacker.id },
      );
      return resolvePF1eAttacks({
        pool,
        attackers: [aIdx],
        defenders: [dIdx],
        registry,
        rng: fixed(2),
        targetAcType,
        highFidelity: true,
      }).metrics;
    };

    expect(attempt("ac").hits).toBe(0);
    expect(attempt("flatFootedAc").hits).toBe(1);
  });
});

describe("Combat Modifiers > Flanking (§2.2)", () => {
  // Flanked attacker: total = d20 + BAB 0 + 2. Defender AC 19.
  //   d20 = 16 → 18: MISS (the pre-fix code also subtracted 2 from AC → 18 ≥ 17 → hit).
  //   d20 = 17 → 19: HIT (the +2 flanking bonus is doing the work).
  const flankCase = (d20: number, viaStatusBit = false) => {
    const registry = new PF1eProfileRegistry();
    const attacker = registry.register({ name: "Duelist", bab: 0, strMod: 0 });
    const defender = registry.register({ name: "Sergeant", ac: 19 });
    const { pool, attacker: aIdx, defender: dIdx } = twoModelArena(
      { profileIdx: defender.id },
      { profileIdx: attacker.id },
    );
    if (viaStatusBit) {
      pool.status[dIdx] = (pool.status[dIdx] ?? 0) | PF1eCondition.FLANKED;
    }
    return resolvePF1eAttacks({
      pool,
      attackers: [aIdx],
      defenders: [dIdx],
      registry,
      rng: fixed(d20),
      isFlanked: !viaStatusBit,
      highFidelity: true,
    }).metrics;
  };

  test("flanking grants +2 on the attack roll and no AC penalty", () => {
    expect(flankCase(16).hits).toBe(0);
    expect(flankCase(16).misses).toBe(1);
    expect(flankCase(17).hits).toBe(1);
  });

  test("the FLANKED condition bit grants the same +2 (geometry, not a caller flag)", () => {
    expect(flankCase(16, true).hits).toBe(0);
    expect(flankCase(17, true).hits).toBe(1);
  });
});

describe("Combat Statistics > Damage — Minimum Damage (§2.3)", () => {
  const weakShot = () => {
    const registry = new PF1eProfileRegistry();
    // 1d6 - 10 can never reach 1: the SRD converts that into 1 point of nonlethal damage.
    const attacker = registry.register({
      name: "Weakened Archer",
      bab: 0,
      strMod: 0,
      weapon: { damageDiceCount: 1, damageDiceSides: 6, damageMod: -10 },
    });
    const defender = registry.register({
      name: "Ogre",
      ac: 10,
      dr: { val: 5, typeFlags: 0 },
    });
    const { pool, attacker: aIdx, defender: dIdx } = twoModelArena(
      { profileIdx: defender.id },
      { profileIdx: attacker.id },
    );
    const run = () =>
      resolvePF1eAttacks({
        pool,
        attackers: [aIdx],
        defenders: [dIdx],
        registry,
        rng: fixed(15, 6), // hits (15 + 0 ≥ 10), rolls a 6 on the damage die
        highFidelity: true,
      });
    return { pool, dIdx, run };
  };

  test("a penalty that reduces damage below 1 deals 1 nonlethal instead of 1 lethal", () => {
    const { pool, dIdx, run } = weakShot();
    const hpBefore = pool.hp[dIdx] ?? 0;

    const metrics = run().metrics;
    expect(metrics.hits).toBe(1);
    expect(metrics.rawDamageDealt).toBe(0); // no lethal damage was dealt
    expect(metrics.nonlethalDealt).toBe(1);
    expect(pool.hp[dIdx]).toBe(hpBefore); // nonlethal damage does not reduce hit points
    expect(pool.sys["nonlethal"]?.[dIdx]).toBe(1);
  });

  test("nonlethal damage bypasses damage reduction and accumulates to unconsciousness", () => {
    const { pool, dIdx, run } = weakShot();
    pool.hp[dIdx] = 1; // current hit points, for the nonlethal threshold

    run();
    expect(pool.sys["nonlethal"]?.[dIdx]).toBe(1);
    expect((pool.status[dIdx] ?? 0) & PF1eCondition.UNCONSCIOUS).toBe(0); // equal ⇒ staggered (§2.12)

    run();
    expect(pool.sys["nonlethal"]?.[dIdx]).toBe(2); // DR 5 never touched the nonlethal bucket
    expect((pool.status[dIdx] ?? 0) & PF1eCondition.UNCONSCIOUS).not.toBe(0);
    expect(pool.hp[dIdx]).toBe(1); // ...and it is still not dead
    expect((pool.status[dIdx] ?? 0) & 1 /* ModelStatus.dead */).toBe(0);
  });
});
