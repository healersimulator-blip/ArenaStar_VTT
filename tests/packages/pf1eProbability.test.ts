// Checklist: V02 — the seeded probability oracles this file pins.
/**
 * V02 — seeded probability oracles for the two independent attack kernels.
 *
 * The point of a probability oracle is that the *expected* number never comes from the code
 * under test. Everything analytic below is transcribed from the rule text:
 *
 *   CRB p.179 (Attack Roll): "A natural 1 is always a miss, and a natural 20 is always a
 *   hit." Otherwise the attack hits when `d20 + bonus ≥ AC`.
 *
 * So for a fixed bonus and AC the hit chance is a closed form over the 20 equally-likely
 * faces, and a seeded 100 000-roll Monte-Carlo run must land inside a few standard errors of
 * it. `expectedHitChance` below is that closed form, written from the rule; the resolvers are
 * then held to it. Both scales are tested **separately** — the tactical stack
 * (`attackModifierParts` → `resolveAttackRoll`) and the strategic kernel
 * (`resolvePF1eAttacks` over a `ModelPool`) — per D-113's "no cross-scale parity gate": each
 * must independently reproduce the same d20 law, and neither is compared to the other.
 *
 * Seeding is the sim's own §5A PRNG (`XoshiroPRNG` → `pf1eRngFromPrng`), so a failure here is
 * reproducible and bisectable rather than a flake: the same seed always produces the same
 * 100 000 faces.
 *
 * Tolerance: for n = 100 000 the standard error of a proportion is at most
 * √(0.25 / 100 000) ≈ 0.00158, so ±0.01 is ≈ 6.3σ — it cannot flake, and it still separates
 * the discriminating AC trio 22/16/17 (0.40 / 0.70 / 0.65 at +9), whose neighbours are 0.05
 * apart. A regression of one point of AC (0.05) is therefore a hard failure, not noise.
 *
 * @srd CRB p.179 Attack Roll: natural 1 always misses, natural 20 always hits, else d20 + bonus ≥ AC.
 * @srd CRB p.182 Critical Hits: a threat range below 20 threatens without automatically hitting.
 * @srd SRD Combat Modifiers > Flanking: +2 on the attack roll, never a penalty to the defender's AC.
 * @srd SRD Combat > Minimum Damage: penalties reducing damage below 1 deal 1 point of nonlethal instead.
 */
import { describe, expect, test } from "vitest";
import { XoshiroPRNG } from "../../src/sim/prng";
import {
  attackModifierParts,
  resolveAttackRoll,
  resolveDamageRoll,
} from "../../src/packages/pf1e/tactical";
import { resolvePF1eWeapon } from "../../src/packages/pf1e/weapons";
import {
  PF1E_MODEL_SCHEMA,
  PF1eProfileRegistry,
  type RawPF1eProfile,
} from "../../src/packages/pf1e/schema";
import {
  pf1eRngFromPrng,
  resolvePF1eAttacks,
} from "../../src/packages/pf1e/combatEngine";
import { allocModel, createModelPool } from "../../src/sim/pool";

/** Monte-Carlo sample size demanded by the box ("100k iterations"). */
const ITERATIONS = 100_000;
/** ≈ 6.3σ for n = 100 000 — see the header. */
const TOLERANCE = 0.01;

/**
 * The rule's own closed form for P(hit) on one d20.
 *
 * Face 1 always misses and face 20 always hits; faces 2–19 hit when
 * `face ≥ AC − bonus`. Counting faces rather than integrating keeps this
 * exact and obviously independent of any resolver.
 */
function expectedHitChance(bonus: number, ac: number): number {
  const needed = ac - bonus;
  if (needed <= 2) return 19 / 20; // only a natural 1 misses
  if (needed >= 21) return 1 / 20; // only a natural 20 hits
  return (21 - needed) / 20;
}

/** A reproducible d20 stream from the sim's PRNG — the same generator the turn uses. */
function seededD20(seed: number): () => number {
  const prng = new XoshiroPRNG(seed);
  return () => Math.floor(prng.nextFloat() * 20) + 1;
}

/**
 * The fixed build every tactical oracle uses: BAB +6, Str +3, Medium, mundane longsword
 * ⇒ +9. Chosen so AC 22/16/17 land on 0.40 / 0.70 / 0.65 — the Gap List's discriminating
 * trio, each a different number of faces.
 */
const FIGHTER = {
  attacker: { bab: 6, strMod: 3, dexMod: 1, size: "Medium" as const },
  weapon: resolvePF1eWeapon({
    name: "Longsword",
    class: "melee",
    handedness: "one-handed",
    proficiency: "martial",
    damageDice: "1d8",
    damageType: "slashing",
  }).weapon,
};

const TACTICAL_BONUS = 9;

describe("V02 — the fixed build's modifier stack is exact before any probability is trusted", () => {
  test("BAB +6 / Str +3 / Medium / mundane longsword = +9, part by part", () => {
    const stack = attackModifierParts({
      attacker: FIGHTER.attacker,
      weapon: FIGHTER.weapon,
    });
    expect(stack.total).toBe(TACTICAL_BONUS);
    expect(stack.parts.map((part) => [part.label, part.value])).toEqual([
      ["BAB", 6],
      ["Str", 3],
      ["size", 0],
    ]);
    // No invented parts: an unenhanced weapon contributes nothing and no feat is implicit.
    expect(stack.notes).toEqual([]);
  });

  test("flanking is +2 on the attack roll and nothing else (SRD Combat Modifiers)", () => {
    const plain = attackModifierParts({
      attacker: FIGHTER.attacker,
      weapon: FIGHTER.weapon,
    }).total;
    const flanking = attackModifierParts({
      attacker: FIGHTER.attacker,
      weapon: FIGHTER.weapon,
      situational: { flanking: true },
    });
    expect(flanking.total - plain).toBe(2);
    expect(flanking.parts.filter((part) => part.label === "flanking")).toEqual([
      { label: "flanking", value: 2 },
    ]);
  });
});

describe("V02 — exact single-roll table: every face, no Monte-Carlo involved", () => {
  test("all 20 faces against AC 22 at +9 match the rule exactly", () => {
    // needed = 13 → faces 13–19 hit by total, face 20 hits and threatens, face 1 misses.
    const hits: number[] = [];
    for (let die = 1; die <= 20; die++) {
      const res = resolveAttackRoll({ die, bonus: TACTICAL_BONUS, ac: 22 });
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      const expectedHit = die === 20 || (die !== 1 && die + TACTICAL_BONUS >= 22);
      expect(res.hits, `d20 ${die} vs AC 22`).toBe(expectedHit);
      expect(res.margin).toBe(die + TACTICAL_BONUS - 22);
      if (res.hits) hits.push(die);
    }
    expect(hits).toEqual([13, 14, 15, 16, 17, 18, 19, 20]);
  });

  test("the AC boundary is discriminating: one point of AC moves exactly one face", () => {
    // At AC 21 the 12 hits too; at AC 23 the 13 stops hitting. Both are ±0.05 of chance.
    const hitsAt = (ac: number): number[] =>
      Array.from({ length: 20 }, (_, i) => i + 1).filter((die) => {
        const res = resolveAttackRoll({ die, bonus: TACTICAL_BONUS, ac });
        return res.ok && res.hits;
      });
    expect(hitsAt(21).length).toBe(9);
    expect(hitsAt(22).length).toBe(8);
    expect(hitsAt(23).length).toBe(7);
    expect(expectedHitChance(TACTICAL_BONUS, 21)).toBeCloseTo(0.45, 10);
    expect(expectedHitChance(TACTICAL_BONUS, 22)).toBeCloseTo(0.4, 10);
    expect(expectedHitChance(TACTICAL_BONUS, 23)).toBeCloseTo(0.35, 10);
  });

  test("a natural 20 hits and threatens at any AC; a natural 1 misses at any AC", () => {
    for (const ac of [5, 22, 40, 60]) {
      const twenty = resolveAttackRoll({ die: 20, bonus: 0, ac });
      const one = resolveAttackRoll({ die: 1, bonus: 99, ac });
      expect(twenty.ok && twenty.hits && twenty.threat).toBe(true);
      expect(one.ok && !one.hits && !one.threat).toBe(true);
    }
  });

  test("a widened threat range threatens without automatically hitting (CRB p.182)", () => {
    // 19–20 weapon at +9 vs AC 22: the 19 hits by total AND threatens; a 19 vs AC 30 does not
    // hit and therefore cannot threaten, even though it is inside the threat range.
    const nineteenHits = resolveAttackRoll({
      die: 19,
      bonus: TACTICAL_BONUS,
      ac: 22,
      critThreatMin: 19,
    });
    expect(nineteenHits).toMatchObject({ hits: true, threat: true });
    const nineteenMisses = resolveAttackRoll({
      die: 19,
      bonus: TACTICAL_BONUS,
      ac: 30,
      critThreatMin: 19,
    });
    expect(nineteenMisses).toMatchObject({ hits: false, threat: false });
  });
});

describe("V02 — tactical seeded oracle, 100 000 rolls per fixed build/defense", () => {
  /**
   * Drive the real resolver with a seeded stream and compare the measured hit rate with the
   * rule's closed form. Returns the measured rate so tests can also compare two builds.
   */
  function measureHitRate(seed: number, ac: number, bonus = TACTICAL_BONUS): number {
    const nextD20 = seededD20(seed);
    let hits = 0;
    for (let i = 0; i < ITERATIONS; i++) {
      const res = resolveAttackRoll({ die: nextD20(), bonus, ac });
      if (!res.ok) throw new Error(`resolver refused a legal roll: ${res.error}`);
      if (res.hits) hits++;
    }
    return hits / ITERATIONS;
  }

  test("the discriminating AC trio 22 / 16 / 17 matches 0.40 / 0.70 / 0.65", () => {
    const cases: Array<[number, number]> = [
      [22, 0.4],
      [16, 0.7],
      [17, 0.65],
    ];
    for (const [index, [ac, expected]] of cases.entries()) {
      // A distinct seed per case so a bad stream cannot accidentally satisfy all three.
      const measured = measureHitRate(0x5eed_0001 + index, ac);
      expect(measured, `AC ${ac}`).toBeCloseTo(expected, 2);
      expect(Math.abs(measured - expected)).toBeLessThanOrEqual(TOLERANCE);
      // And the closed form agrees with the hand-transcribed number — the oracle is checked too.
      expect(expectedHitChance(TACTICAL_BONUS, ac)).toBeCloseTo(expected, 10);
    }
  });

  test("the three ACs are mutually distinguishable at this sample size", () => {
    const ac22 = measureHitRate(0x5eed_1001, 22);
    const ac16 = measureHitRate(0x5eed_1002, 16);
    const ac17 = measureHitRate(0x5eed_1003, 17);
    // Guard against a resolver that flattens AC into one answer: the spread must be ~0.30.
    expect(Math.abs(ac16 - ac22)).toBeGreaterThan(0.25);
    expect(Math.abs(ac17 - ac16)).toBeGreaterThan(0.02);
    expect(ac16).toBeGreaterThan(ac17);
    expect(ac17).toBeGreaterThan(ac22);
  });

  test("the flanking boundary is exactly +0.10 of hit chance (two faces)", () => {
    // AC 18 at +9: needed 9 → 12/20. Flanking makes it +11 → needed 7 → 14/20. Δ = 2/20.
    const plain = measureHitRate(0xf1a4_0001, 18);
    const flanked = measureHitRate(0xf1a4_0002, 18, TACTICAL_BONUS + 2);
    expect(Math.abs(plain - 0.6)).toBeLessThanOrEqual(TOLERANCE);
    expect(Math.abs(flanked - 0.7)).toBeLessThanOrEqual(TOLERANCE);
    expect(Math.abs(flanked - plain - 0.1)).toBeLessThanOrEqual(2 * TOLERANCE);
    // The exact boundary face: a 7 hits only while flanking.
    expect(
      resolveAttackRoll({ die: 7, bonus: TACTICAL_BONUS, ac: 18 }),
    ).toMatchObject({ hits: false });
    expect(
      resolveAttackRoll({ die: 7, bonus: TACTICAL_BONUS + 2, ac: 18 }),
    ).toMatchObject({ hits: true });
    expect(
      resolveAttackRoll({ die: 6, bonus: TACTICAL_BONUS + 2, ac: 18 }),
    ).toMatchObject({ hits: false });
  });

  test("a 19–20 threat range threatens on exactly 10% of rolls, independent of AC", () => {
    const nextD20 = seededD20(0x7ea7_0001);
    let threats = 0;
    for (let i = 0; i < ITERATIONS; i++) {
      const res = resolveAttackRoll({
        die: nextD20(),
        bonus: TACTICAL_BONUS,
        ac: 12, // low enough that every threat face also hits
        critThreatMin: 19,
      });
      if (res.ok && res.threat) threats++;
    }
    expect(Math.abs(threats / ITERATIONS - 0.1)).toBeLessThanOrEqual(TOLERANCE);
  });

  test("the same seed reproduces the same rate; a different seed still lands in tolerance", () => {
    const a = measureHitRate(0xdead_beef, 22);
    const b = measureHitRate(0xdead_beef, 22);
    expect(a).toBe(b); // determinism: the oracle is bisectable
    const c = measureHitRate(0x1234_5678, 22);
    expect(c).not.toBe(a); // …and it is a real stream, not a constant
    expect(Math.abs(c - 0.4)).toBeLessThanOrEqual(TOLERANCE);
  });
});

describe("V02 — minimum nonlethal: exact floors and their seeded frequency", () => {
  /** Mundane sap: 1d6 nonlethal, so the whole blow can be reduced to nothing. */
  const sap = resolvePF1eWeapon({
    name: "Sap",
    class: "melee",
    handedness: "light",
    proficiency: "martial",
    damageDice: "1d6",
    damageType: "bludgeoning",
    nonlethal: true,
  }).weapon;

  test("penalties that reduce the blow below 1 deal exactly 1 nonlethal (SRD Minimum Damage)", () => {
    // staticDamage −5 against a rolled 3 ⇒ −2 raw; the rule floors the *result* at 1 nonlethal
    // and it is nonlethal even though the intent was lethal.
    const res = resolveDamageRoll({
      weapon: sap,
      staticDamage: -5,
      weaponDamageRolls: [3],
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.nonlethal).toBe(1);
    expect(res.weaponContribution).toEqual({ lethal: 0, nonlethal: 1 });
  });

  test("the floor is a floor, not a bump: 1 or more damage is untouched", () => {
    for (const [roll, staticDamage, expected] of [
      [4, -3, 1], // exactly 1 → stays 1, not floored up to something else
      [4, -2, 2],
      [6, 0, 6],
      [1, 0, 1],
    ] as const) {
      const res = resolveDamageRoll({
        weapon: sap,
        staticDamage,
        weaponDamageRolls: [roll],
      });
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      expect(res.nonlethal, `1d6=${roll} ${staticDamage >= 0 ? "+" : ""}${staticDamage}`).toBe(
        expected,
      );
    }
  });

  test("every face of 1d6 at −5 static floors to 1 nonlethal (100% of the time)", () => {
    // The whole die range 1–6 is below 1 after −5, so the minimum rule must fire on every roll.
    for (let face = 1; face <= 6; face++) {
      const res = resolveDamageRoll({
        weapon: sap,
        staticDamage: -5,
        weaponDamageRolls: [face],
      });
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      expect(res.nonlethal).toBe(1);
    }
  });

  test("seeded: at −3 static the floor fires on exactly the faces that would fall below 1", () => {
    // 1d6 − 3 < 1 ⇔ face ≤ 3 ⇔ 3/6 = 50%. A seeded d6 stream must reproduce that.
    const prng = new XoshiroPRNG(0x1d6_0001);
    let floored = 0;
    for (let i = 0; i < ITERATIONS; i++) {
      const face = Math.floor(prng.nextFloat() * 6) + 1;
      const res = resolveDamageRoll({
        weapon: sap,
        staticDamage: -3,
        weaponDamageRolls: [face],
      });
      if (!res.ok) throw new Error(res.error);
      if (res.nonlethal === 1 && face <= 3) floored++;
      // Faces 4–6 must NOT be floored: they keep their real value.
      if (face > 3) expect(res.nonlethal).toBe(face - 3);
    }
    expect(Math.abs(floored / ITERATIONS - 0.5)).toBeLessThanOrEqual(TOLERANCE);
  });
});

describe("V02 — strategic seeded oracle: the same d20 law, measured independently", () => {
  /**
   * A strategic duel: `attackersPerBatch` identical attackers against one effectively-immortal
   * defender, one attack each (`maxIterativeAttacks: 1`), driven by the sim's seeded PRNG
   * through the production adapter `pf1eRngFromPrng`. The pool's `ac` column stays 0, so
   * `resolveTargetAc` reads the defender's authored profile AC — the number the oracle uses.
   */
  function measureStrategicHitRate(
    seed: number,
    ac: number,
    opts: { isFlanked?: boolean; circumstanceMod?: number } = {},
  ): { rate: number; attacks: number } {
    const attackersPerBatch = 1_000;
    const batches = ITERATIONS / attackersPerBatch;
    const registry = new PF1eProfileRegistry();
    // BAB +9 / Str +0 / Medium ⇒ a single iterative at +9, matching the tactical build's bonus.
    const attacker: RawPF1eProfile = { name: "Attacker", bab: 9, strMod: 0, ac: 30, hp: 10 };
    const defender: RawPF1eProfile = { name: "Target", bab: 0, ac, hp: 1e9 };
    const atkProfile = registry.register(attacker);
    const defProfile = registry.register(defender);

    const pool = createModelPool(attackersPerBatch + 1, PF1E_MODEL_SCHEMA);
    const attackers: number[] = [];
    for (let i = 0; i < attackersPerBatch; i++) {
      attackers.push(
        allocModel(pool, {
          id: i + 1,
          unitIdx: 0,
          x: 0,
          y: 0,
          hp: 10,
          hpMax: 10,
          sys: { profileIdx: atkProfile.id },
        }),
      );
    }
    const defIdx = allocModel(pool, {
      id: attackersPerBatch + 1,
      unitIdx: 1,
      x: 5,
      y: 0,
      hp: 1e9,
      hpMax: 1e9,
      sys: { profileIdx: defProfile.id },
    });

    const prng = new XoshiroPRNG(seed);
    const rng = pf1eRngFromPrng(prng);
    let hits = 0;
    let attacks = 0;
    for (let b = 0; b < batches; b++) {
      const res = resolvePF1eAttacks({
        pool,
        attackers,
        defenders: [defIdx],
        registry,
        rng,
        maxIterativeAttacks: 1,
        isFlanked: opts.isFlanked ?? false,
        // exactOptionalPropertyTypes: only pass the key when the caller supplied one.
        ...(opts.circumstanceMod === undefined
          ? {}
          : { circumstanceMod: opts.circumstanceMod }),
      });
      hits += res.metrics.hits;
      attacks += res.attacksExecuted;
    }
    if (attacks !== ITERATIONS) {
      throw new Error(`strategic oracle made ${attacks} attacks, expected ${ITERATIONS}`);
    }
    return { rate: hits / attacks, attacks };
  }

  test("BAB +9 vs AC 22 / 16 / 17 reproduces 0.40 / 0.70 / 0.65 at the mass scale", () => {
    const cases = [
      { ac: 22, expected: 0.4 },
      { ac: 16, expected: 0.7 },
      { ac: 17, expected: 0.65 },
    ];
    for (const [index, { ac, expected }] of cases.entries()) {
      const { rate } = measureStrategicHitRate(0x57a7_0001 + index, ac);
      expect(rate, `strategic AC ${ac}`).toBeCloseTo(expected, 2);
      expect(Math.abs(rate - expected)).toBeLessThanOrEqual(TOLERANCE);
    }
  });

  test("strategic flanking is worth exactly +0.10, applied to the roll and not to AC", () => {
    const plain = measureStrategicHitRate(0xf1a6_0001, 18).rate;
    const flanked = measureStrategicHitRate(0xf1a6_0002, 18, { isFlanked: true }).rate;
    expect(Math.abs(plain - 0.6)).toBeLessThanOrEqual(TOLERANCE);
    expect(Math.abs(flanked - 0.7)).toBeLessThanOrEqual(TOLERANCE);
    expect(Math.abs(flanked - plain - 0.1)).toBeLessThanOrEqual(2 * TOLERANCE);
  });

  test("a −2 circumstance (fighting defensively) costs exactly 0.10 of hit chance", () => {
    const plain = measureStrategicHitRate(0xc1c7_0001, 18).rate;
    const penalized = measureStrategicHitRate(0xc1c7_0002, 18, {
      circumstanceMod: -2,
    }).rate;
    expect(Math.abs(penalized - 0.5)).toBeLessThanOrEqual(TOLERANCE);
    expect(Math.abs(plain - penalized - 0.1)).toBeLessThanOrEqual(2 * TOLERANCE);
  });

  test("the tactical and strategic oracles are separate measurements, not a shared code path", () => {
    // Both must reach the same *rule* answer by different routes. Asserting the two measured
    // rates agree within tolerance documents the independence D-113 requires, without making
    // either one the oracle for the other.
    const tactical = (() => {
      const nextD20 = seededD20(0x9c01_0001);
      let hits = 0;
      for (let i = 0; i < ITERATIONS; i++) {
        const res = resolveAttackRoll({ die: nextD20(), bonus: TACTICAL_BONUS, ac: 22 });
        if (res.ok && res.hits) hits++;
      }
      return hits / ITERATIONS;
    })();
    const strategic = measureStrategicHitRate(0x9c01_0002, 22).rate;
    expect(Math.abs(tactical - 0.4)).toBeLessThanOrEqual(TOLERANCE);
    expect(Math.abs(strategic - 0.4)).toBeLessThanOrEqual(TOLERANCE);
    expect(Math.abs(tactical - strategic)).toBeLessThanOrEqual(2 * TOLERANCE);
  });
});
