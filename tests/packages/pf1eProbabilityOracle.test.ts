/**
 * V02 — Seeded probability oracles at 100k iterations for fixed builds/defenses
 * with tolerances, plus exact single-roll assertions.
 *
 * Covers:
 *  - @srd Combat > Attack Roll > Armor Class 22/16/17 trio (I P3 §6.2 fixture 1)
 *  - @srd Combat > Attack Roll > Flanking +2 boundary (16+0+2=18 vs AC19 miss, 17→19 hit)
 *  - @srd Combat > Damage > Minimum Damage 1 nonlethal (1d6−10 ⇒ 1 nonlethal)
 *  - @srd Combat > Attack Roll > Natural 1/20
 *
 * Tests tactical (src/packages/pf1e/tactical.ts + resolve.ts) and strategic
 * (src/packages/pf1e/combatEngine.ts via PF1eProfileRegistry) independently,
 * with seeded XoshiroPRNG (never Math.random) per I P3 §6 verification
 * strategy #4 and Gap List §7.3.
 */

import { describe, expect, test } from "vitest";
import { createModelPool, allocModel } from "../../src/sim/pool";
import { PF1E_MODEL_SCHEMA, type RawPF1eProfile, PF1eProfileRegistry } from "../../src/packages/pf1e/schema";
import { resolveAttackRoll, resolveDamageRoll } from "../../src/packages/pf1e/tactical";
import { pf1eResolveAttack, type PF1eResolveDefender } from "../../src/packages/pf1e/resolve";
import { pf1eRngFromPrng, resolvePF1eAttacks, type PF1eRng } from "../../src/packages/pf1e/combatEngine";
import { XoshiroPRNG } from "../../src/sim/prng";
import type { PRNG } from "../../src/core/sim";

// ── Oracle helpers ───────────────────────────────────────────────────────────

/** Algebraic hit chance for one attack bonus vs AC (CRB p.182, nat1 auto miss, nat20 auto hit). */
function algebraicHitRate(bonus: number, ac: number): number {
  let hits = 0;
  for (let die = 1; die <= 20; die++) {
    if (die === 1) continue; // auto miss
    if (die === 20) { hits++; continue; } // auto hit
    if (die + bonus >= ac) hits++;
  }
  return hits / 20;
}

function d20From(prng: PRNG): number {
  return Math.floor(prng.nextFloat() * 20) + 1;
}

const ITERATIONS = 100_000;
const TOLERANCE = 0.015; // ±1.5% absolute — 3σ for p=0.5 is 0.0047, so 0.05 off-by-one-face fails loud
const SEED_TACTICAL = 0x5eed_beef >>> 0;
const SEED_STRATEGIC = 0x7a11_c0de >>> 0;

// ── Tactical oracle ─────────────────────────────────────────────────────────
// @srd Combat > Attack Roll
describe("V02 — Tactical probability oracle (100k seeded, @srd Combat > Attack Roll)", () => {
  function tacticalMonteCarlo(bonus: number, ac: number, seed: number, iterations = ITERATIONS): number {
    const prng = new XoshiroPRNG(seed);
    let hits = 0;
    for (let i = 0; i < iterations; i++) {
      const die = d20From(prng);
      const res = resolveAttackRoll({ die, bonus, ac });
      if (!res.ok) throw new Error(res.error);
      if (res.hits) hits++;
    }
    return hits / iterations;
  }

  test("AC 22 @ +16 → p=0.75 within tolerance (trio normal)", () => {
    const bonus = 16;
    const ac = 22;
    const expected = algebraicHitRate(bonus, ac); // 15/20 = 0.75
    expect(expected).toBeCloseTo(0.75, 10);
    const observed = tacticalMonteCarlo(bonus, ac, SEED_TACTICAL);
    expect(Math.abs(observed - expected)).toBeLessThan(TOLERANCE);
  });

  test("Touch AC 16 @ +16 → p=0.95 within tolerance (trio touch)", () => {
    const expected = algebraicHitRate(16, 16); // 19/20
    expect(expected).toBeCloseTo(0.95, 10);
    const observed = tacticalMonteCarlo(16, 16, SEED_TACTICAL + 1);
    expect(Math.abs(observed - expected)).toBeLessThan(TOLERANCE);
  });

  test("Flat-footed AC 17 @ +16 → p=0.95 within tolerance (trio flat-footed)", () => {
    const expected = algebraicHitRate(16, 17);
    expect(expected).toBeCloseTo(0.95, 10);
    const observed = tacticalMonteCarlo(16, 17, SEED_TACTICAL + 2);
    expect(Math.abs(observed - expected)).toBeLessThan(TOLERANCE);
  });

  test("AC 19 @ +14 (no flank) → p=0.80 vs flanked +16 → p=0.90 (boundary discrimination)", () => {
    const ac = 19;
    const without = algebraicHitRate(14, ac); // 16/20 = 0.80 (die 5..20)
    const withFlank = algebraicHitRate(16, ac); // 18/20 = 0.90 (die 3..20)
    expect(without).toBeCloseTo(0.80, 10);
    expect(withFlank).toBeCloseTo(0.90, 10);
    const obsWithout = tacticalMonteCarlo(14, ac, SEED_TACTICAL + 10);
    const obsWith = tacticalMonteCarlo(16, ac, SEED_TACTICAL + 11);
    expect(Math.abs(obsWithout - without)).toBeLessThan(TOLERANCE);
    expect(Math.abs(obsWith - withFlank)).toBeLessThan(TOLERANCE);
    // The 0.10 gap must be visible, not swallowed by tolerance
    expect(Math.abs(obsWith - obsWithout)).toBeGreaterThan(0.07);
  });

  test("moderate build BAB+6 vs AC 18 → p≈0.45 within tolerance", () => {
    // bonus 10 vs AC 18: need 8 => 13 faces? 8..20 inclusive =13 => 0.65? Let's fix 8 vs 18
    // Use bonus 8 vs AC 18 => need 10 => 11 faces => 0.55 with nat1 rule? die1 would be 9 miss anyway.
    const bonus = 8;
    const ac = 18;
    const expected = algebraicHitRate(bonus, ac);
    expect(expected).toBeCloseTo(0.55, 10); // 1 miss, 9 miss, 10..20 hit =11 hits =0.55
    const observed = tacticalMonteCarlo(bonus, ac, SEED_TACTICAL + 20);
    expect(Math.abs(observed - expected)).toBeLessThan(TOLERANCE);
  });

  test("low hit chance +2 vs AC 18 → ~0.25 within tolerance", () => {
    const expected = algebraicHitRate(2, 18); // need 16 => 5 faces 16..20 =0.25
    expect(expected).toBeCloseTo(0.25, 10);
    const observed = tacticalMonteCarlo(2, 18, SEED_TACTICAL + 21);
    expect(Math.abs(observed - expected)).toBeLessThan(TOLERANCE);
  });
});

// ── Strategic oracle ────────────────────────────────────────────────────────
// @srd Combat > Mass Combat > Attack Resolution
describe("V02 — Strategic probability oracle (100k seeded, @srd Combat > Mass Combat)", () => {
  function scriptedRng(values: number[]): PF1eRng {
    let i = 0;
    return {
      d(sides: number): number {
        const v = values[i % values.length] ?? 1;
        i++;
        return Math.max(1, Math.min(sides, v));
      },
    };
  }

  function strategicMonteCarlo(input: {
    attacker: RawPF1eProfile;
    defenderAc: number;
    seed: number;
    iterations?: number;
    isFlanked?: boolean;
  }): number {
    const attackerRaw: RawPF1eProfile = {
      ...input.attacker,
      // Avoid extra rng consumption: no damage dice, never th reats (21 > max face)
      weapon: {
        ...(input.attacker.weapon ?? {}),
        damageDiceCount: 0,
        damageDiceSides: 1,
        critThreatMin: 21,
        bonusDice: undefined,
      },
    };
    const defenderRaw: RawPF1eProfile = {
      name: "Defender",
      ac: input.defenderAc,
      touchAc: input.defenderAc,
      flatFootedAc: input.defenderAc,
      hp: 1_000_000,
    };
    const registry = new PF1eProfileRegistry();
    const atk = registry.register(attackerRaw);
    const def = registry.register(defenderRaw);
    const pool = createModelPool(4, PF1E_MODEL_SCHEMA);
    const atkIdx = allocModel(pool, {
      id: 1,
      unitIdx: 0,
      x: 0,
      y: 0,
      hp: 1_000_000,
      hpMax: 1_000_000,
      sys: { profileIdx: atk.id },
    });
    const defIdx = allocModel(pool, {
      id: 2,
      unitIdx: 1,
      x: 5,
      y: 0,
      hp: 1_000_000,
      hpMax: 1_000_000,
      sys: { profileIdx: def.id },
    });
    // Ensure ammo/weaponState clean (firearm gate would refuse 0-ammo attacks)
    const ammoCol = pool.sys["ammo"] as unknown as Uint8Array | undefined;
    if (ammoCol) ammoCol[atkIdx] = 1;
    const wsCol = pool.sys["weaponState"] as unknown as Uint8Array | undefined;
    if (wsCol) wsCol[atkIdx] = 0;

    const prng = new XoshiroPRNG(input.seed);
    const rng = pf1eRngFromPrng(prng);
    let hits = 0;
    let total = 0;
    const iters = input.iterations ?? ITERATIONS;
    for (let i = 0; i < iters; i++) {
      // Reset damage state so death never stops the stream (engine writes hp/status/conditions)
      pool.hp[defIdx] = 1_000_000;
      pool.status[defIdx] = 0;
      const pfC = pool.sys["pfCondition"] as unknown as Uint32Array | undefined;
      if (pfC) pfC[defIdx] = 0;
      const non = pool.sys["nonlethal"] as unknown as Uint16Array | Float32Array | undefined;
      if (non) (non as unknown as { [k:number]: number})[defIdx] = 0 as unknown as number;
      const lethal = pool.sys["lethalDmg"] as unknown as Uint16Array | Float32Array | undefined;
      if (lethal) (lethal as unknown as {[k:number]: number})[defIdx] = 0 as unknown as number;
      if (ammoCol) ammoCol[atkIdx] = 1;
      if (wsCol) wsCol[atkIdx] = 0;

      const res = resolvePF1eAttacks({
        pool,
        attackers: [atkIdx],
        defenders: [defIdx],
        registry,
        rng,
        isFlanked: input.isFlanked ?? false,
        highFidelity: true,
        maxIterativeAttacks: 1,
      });
      hits += res.metrics.hits;
      total += res.metrics.totalAttacks;
    }
    if (total === 0) throw new Error("strategic oracle: no attacks registered (out of range?)");
    return hits / total;
  }

  test("AC 22 @ +16 → p=0.75 within tolerance (mirrors tactical trio)", () => {
    const attacker: RawPF1eProfile = { name: "Swordsman", bab: 16, ac: 10 };
    const expected = algebraicHitRate(16, 22);
    expect(expected).toBeCloseTo(0.75, 10);
    const observed = strategicMonteCarlo({ attacker, defenderAc: 22, seed: SEED_STRATEGIC });
    expect(Math.abs(observed - expected)).toBeLessThan(TOLERANCE);
  });

  test("AC 16 @ +16 → p=0.95 within tolerance", () => {
    const attacker: RawPF1eProfile = { name: "Swordsman", bab: 16, ac: 10 };
    const expected = algebraicHitRate(16, 16);
    expect(expected).toBeCloseTo(0.95, 10);
    const observed = strategicMonteCarlo({ attacker, defenderAc: 16, seed: SEED_STRATEGIC + 1 });
    expect(Math.abs(observed - expected)).toBeLessThan(TOLERANCE);
  });

  test("AC 17 @ +16 → p=0.95 within tolerance", () => {
    const attacker: RawPF1eProfile = { name: "Swordsman", bab: 16, ac: 10 };
    const expected = algebraicHitRate(16, 17);
    expect(expected).toBeCloseTo(0.95, 10);
    const observed = strategicMonteCarlo({ attacker, defenderAc: 17, seed: SEED_STRATEGIC + 2 });
    expect(Math.abs(observed - expected)).toBeLessThan(TOLERANCE);
  });

  test("AC 19 @ +14 vs flanked +16 discriminates 0.80 → 0.90", () => {
    const base: RawPF1eProfile = { name: "Swordsman", bab: 14, ac: 10 };
    const expectedNoFlank = algebraicHitRate(14, 19);
    const expectedFlank = algebraicHitRate(16, 19);
    expect(expectedNoFlank).toBeCloseTo(0.80, 10);
    expect(expectedFlank).toBeCloseTo(0.90, 10);
    const obsNo = strategicMonteCarlo({ attacker: base, defenderAc: 19, seed: SEED_STRATEGIC + 10 });
    const obsYes = strategicMonteCarlo({ attacker: base, defenderAc: 19, seed: SEED_STRATEGIC + 11, isFlanked: true });
    expect(Math.abs(obsNo - expectedNoFlank)).toBeLessThan(TOLERANCE);
    expect(Math.abs(obsYes - expectedFlank)).toBeLessThan(TOLERANCE);
    expect(Math.abs(obsYes - obsNo)).toBeGreaterThan(0.07);
  });

  test("moderate +8 vs AC 18 → 0.55 and low +2 vs 18 → 0.25 (coverage)", () => {
    expect(algebraicHitRate(8, 18)).toBeCloseTo(0.55, 10);
    expect(algebraicHitRate(2, 18)).toBeCloseTo(0.25, 10);
    const obsMid = strategicMonteCarlo({ attacker: { name: "A", bab: 8, ac: 10 }, defenderAc: 18, seed: SEED_STRATEGIC + 20 });
    const obsLow = strategicMonteCarlo({ attacker: { name: "A", bab: 2, ac: 10 }, defenderAc: 18, seed: SEED_STRATEGIC + 21 });
    expect(Math.abs(obsMid - 0.55)).toBeLessThan(TOLERANCE);
    expect(Math.abs(obsLow - 0.25)).toBeLessThan(TOLERANCE);
  });

  test("exact flank boundary via scripted die: 16+0+2=18 vs AC19 miss, 17→19 hit (strategic)", () => {
    // Mirrors pf1eResolve.test but through the sim engine's flank flag.
    const attacker: RawPF1eProfile = { name: "Attacker", bab: 14, ac: 10 };
    const defenderRaw: RawPF1eProfile = { name: "Def", ac: 19, hp: 10 };
    const registry = new PF1eProfileRegistry();
    const atk = registry.register({ ...attacker, weapon: { damageDiceCount: 0, critThreatMin: 21 } });
    const def = registry.register(defenderRaw);
    const pool = createModelPool(4, PF1E_MODEL_SCHEMA);
    const aIdx = allocModel(pool, { id: 1, unitIdx: 0, x: 0, y: 0, hp: 10, hpMax: 10, sys: { profileIdx: atk.id } });
    const dIdx = allocModel(pool, { id: 2, unitIdx: 1, x: 5, y: 0, hp: 10, hpMax: 10, sys: { profileIdx: def.id } });

    // die 2 +14+2=18 miss, die 3 +14+2=19 hit, die 3 +14+0=17 miss
    const missWithFlank = resolvePF1eAttacks({
      pool, attackers: [aIdx], defenders: [dIdx], registry,
      rng: scriptedRng([2]), isFlanked: true, highFidelity: true, maxIterativeAttacks: 1,
    });
    expect(missWithFlank.metrics.hits).toBe(0);

    // reset defender HP for next single-attack call (engine decrements hp on hit)
    pool.hp[dIdx] = 10; pool.status[dIdx]=0;
    const hitWithFlank = resolvePF1eAttacks({
      pool, attackers: [aIdx], defenders: [dIdx], registry,
      rng: scriptedRng([3]), isFlanked: true, highFidelity: true, maxIterativeAttacks: 1,
    });
    expect(hitWithFlank.metrics.hits).toBe(1);

    pool.hp[dIdx]=10; pool.status[dIdx]=0;
    const missNoFlank = resolvePF1eAttacks({
      pool, attackers: [aIdx], defenders: [dIdx], registry,
      rng: scriptedRng([3]), isFlanked: false, highFidelity: true, maxIterativeAttacks: 1,
    });
    expect(missNoFlank.metrics.hits).toBe(0);
  });
});

// ── Exact single-roll regressions (both scales) ──────────────────────────────
// @srd Combat > Attack Roll > Critical Hits
describe("V02 — Exact single-roll regressions (tactical & strategic)", () => {
  const trioDefender: PF1eResolveDefender = {
    name: "Trio Target",
    ac: { normal: 22, touch: 16, flatFooted: 17 },
    hp: 20,
    hpMax: 20,
    nonlethalDamage: 0,
  };
  const sword = { label: "Longsword", bonus: 16, critThreatMin: 20, critMultiplier: 2, damageType: "slashing" } as const;

  test("tactical: AC trio discriminates — total 19 misses normal (22) but hits touch (16) and flat-footed (17)", () => {
    // 16 + 3 = 19 (I §6.2 / Gap §7 fixture)
    const vsNormal = pf1eResolveAttack({ attack: sword, die: 3, defense: "normal", defender: trioDefender, damageTotal: 8 });
    const vsTouch = pf1eResolveAttack({ attack: sword, die: 3, defense: "touch", defender: trioDefender, damageTotal: 8 });
    const vsFlat = pf1eResolveAttack({ attack: sword, die: 3, defense: "flatFooted", defender: trioDefender, damageTotal: 8 });
    expect(vsNormal).toMatchObject({ ok: true, outcome: "miss", defenseAc: 22 });
    expect(vsTouch).toMatchObject({ ok: true, outcome: "hit", defenseAc: 16 });
    expect(vsFlat).toMatchObject({ ok: true, outcome: "hit", defenseAc: 17 });
  });

  test("tactical: flanked 18 vs AC19 miss, 19 hit — dropped flank misses, doubled flank would hit the miss", () => {
    const flanked = { base: 14, ac: 19 };
    const defender: PF1eResolveDefender = {
      ...trioDefender,
      ac: { normal: flanked.ac, touch: 12, flatFooted: 15 },
    };
    const miss = pf1eResolveAttack({ attack: { ...sword, bonus: flanked.base }, die: 2, defender, situational: { flanking: true }, damageTotal: 8 });
    const hit = pf1eResolveAttack({ attack: { ...sword, bonus: flanked.base }, die: 3, defender, situational: { flanking: true }, damageTotal: 8 });
    const noFlank = pf1eResolveAttack({ attack: { ...sword, bonus: flanked.base }, die: 3, defender, damageTotal: 8 });
    expect(miss).toMatchObject({ ok: true, outcome: "miss", attackTotal: 18 });
    expect(hit).toMatchObject({ ok: true, outcome: "hit", attackTotal: 19 });
    expect(noFlank).toMatchObject({ ok: true, outcome: "miss", attackTotal: 17 });
  });

  test("tactical: minimum nonlethal 1d6−10 ⇒ 1 nonlethal even when DR is bypassed (A.3 / Gap §2.3)", () => {
    // Mirrors pf1eResolve.test's Gap List fixture: 1d6−10 evaluated to −4.
    const defender: PF1eResolveDefender = {
      name: "Goblin",
      ac: { normal: 12, touch: 11, flatFooted: 11 },
      hp: 1, hpMax: 6, nonlethalDamage: 1,
      dr: [{ value: 5, bypass: ["slashing"] }],
    };
    const res = pf1eResolveAttack({ attack: { ...sword, bonus: 2 }, die: 14, defender, damageTotal: -4 });
    expect(res).toMatchObject({
      ok: true, outcome: "hit",
      damage: { rolled: -4, minimumApplied: true, dealt: 1, nonlethal: 1, lethal: 0, drBypassedVia: "slashing" },
    });
    // Via the lower layer: 1d6 with static −10, one multiplier step
    const dmg = resolveDamageRoll({
      weapon: { name: "Dagger", critMultiplier: 2, critThreatMin: 20, broken: false, nonlethal: false } as unknown as import("../../src/packages/pf1e/weapons").PF1eWeaponDescriptor,
      staticDamage: -10,
      weaponDamageRolls: [6], // max 1d6 still <1 after −10
    });
    expect(dmg).toMatchObject({ ok: true, lethal: 0, nonlethal: 1 });
    expect(dmg.ok && (dmg as Extract<typeof dmg, {ok: true}>).notes.join(" ")).toContain("nonlethal");
  });

  test("tactical: nat1 always misses, nat20 always hits and threatens regardless of math", () => {
    const farDefender: PF1eResolveDefender = { ...trioDefender, ac: { normal: 99, touch: 99, flatFooted: 99 } };
    const one = pf1eResolveAttack({ attack: sword, die: 1, defense: "normal", defender: farDefender, damageTotal: 10 });
    const weak: PF1eResolveDefender = { ...trioDefender, ac: { normal: 5, touch: 5, flatFooted: 5 } };
    const twenty = pf1eResolveAttack({ attack: { ...sword, bonus: -10 }, die: 20, confirmDie: 20, defense: "normal", defender: weak, damageTotal: 10 });
    expect(one).toMatchObject({ ok: true, outcome: "miss" });
    expect(twenty).toMatchObject({ ok: true, outcome: "crit", threat: true });
    // Pure layer direct
    const r1 = resolveAttackRoll({ die: 1, bonus: 99, ac: 5 });
    const r20 = resolveAttackRoll({ die: 20, bonus: -99, ac: 99 });
    expect(r1).toMatchObject({ ok: true, hits: false, natural: 1 });
    expect(r20).toMatchObject({ ok: true, hits: true, natural: 20, threat: true });
  });

  test("strategic: minimum-nonlethal path produces 1 nonlethal that the engine books as nonlethal (not lethal)", () => {
    // Weak attacker: 1d6 (≈3.5) + damageMod −11 ⇒ always <1 ⇒ engine's min rule fires.
    // We drive it via the tactical roll since the sim's damage loop has the same branch
    // (combatEngine.ts: nonlethalDamage = baseDamage <1 ?1:0) — verify that exact path here.
    // Use a raw profile with damageMod −11 and 1d6 so any roll <1.
    const weakAttacker: RawPF1eProfile = {
      name: "Weakling", bab: 5, ac: 10,
      weapon: { damageDiceCount: 1, damageDiceSides: 6, damageMod: -11, critThreatMin: 21 },
    };
    // For the exact assertion we reuse the tactical resolver (same rule, different caller)
    // and additionally probe the engine's bookkeeping with a single scripted hit.
    const dmg = resolveDamageRoll({
      weapon: { name: "Club", critMultiplier: 2, critThreatMin: 20, broken: false, nonlethal: false } as unknown as import("../../src/packages/pf1e/weapons").PF1eWeaponDescriptor,
      staticDamage: -11,
      weaponDamageRolls: [6],
    });
    expect(dmg).toMatchObject({ ok: true, nonlethal: 1, lethal: 0 });

    // Strategic engine: one hit must increment nonlethalDealt, not netDamage overcount
    const registry = new PF1eProfileRegistry();
    const atk = registry.register(weakAttacker);
    const def = registry.register({ name: "Tough", ac: 10, hp: 20 } as RawPF1eProfile);
    const pool = createModelPool(4, PF1E_MODEL_SCHEMA);
    const aIdx = allocModel(pool, { id: 1, unitIdx: 0, x: 0, y: 0, hp: 20, hpMax: 20, sys: { profileIdx: atk.id } });
    const dIdx = allocModel(pool, { id: 2, unitIdx: 1, x: 5, y: 0, hp: 20, hpMax: 20, sys: { profileIdx: def.id } });
    let rng: PF1eRng = { d: () => 20 }; // force a hit (die 20)
    // Patch: we need a PRNG that returns 20 for the attack die and then 1 for the damage die
    let calls = 0;
    rng = {
      d(sides: number): number {
        calls++;
        if (calls === 1) return 20; // d20
        // damage dice: 1d6 → 1 so total still −10, min fires
        return 1;
      },
    };
    const res = resolvePF1eAttacks({ pool, attackers: [aIdx], defenders: [dIdx], registry, rng, highFidelity: true });
    expect(res.metrics.hits).toBe(1);
    expect(res.metrics.nonlethalDealt).toBe(1);
    // netDamage includes the nonlethal as HP not lost? Engine books nonlethal separately; net is after DR.
    expect(res.metrics.netDamageDealt).toBe(0); // min nonlethal is not lethal
  });
});
