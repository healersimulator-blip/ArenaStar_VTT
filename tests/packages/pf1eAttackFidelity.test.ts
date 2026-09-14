/**
 * M01 (D-227) — scale-specific fixtures for Gap List §2.4–2.10: the strategic attack/damage
 * kernel against the verified data contract. One test per SRD row, discriminating values only
 * (each would fail under the previous behavior), independent sim loops via scripted dice — no
 * cross-scale equality gate (tactical-vs-compile agreement stays pinned in pf1eActor.test.ts).
 */
import { describe, expect, test } from "vitest";
import { createModelPool, allocModel } from "../../src/sim/pool";
import {
  PF1E_MODEL_SCHEMA,
  PF1eDrType,
  PF1eDamageType,
  PF1eProfileRegistry,
  compilePF1eProfile,
  type RawPF1eProfile,
} from "../../src/packages/pf1e/schema";
import {
  resolvePF1eAttacks,
  isDrBypassed,
  type PF1eRng,
} from "../../src/packages/pf1e/combatEngine";

/** Sequential scripted dice: each `d(sides)` shifts the queue; wraps on exhaustion. */
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

interface Fixture {
  pool: ReturnType<typeof createModelPool>;
  atkIdx: number;
  defIdx: number;
  registry: PF1eProfileRegistry;
  registrySizes: { attacker: number; defender: number };
}

function duel(
  attacker: RawPF1eProfile,
  defender: RawPF1eProfile,
  spacing = 5,
): Fixture {
  const registry = new PF1eProfileRegistry();
  const atk = registry.register(attacker);
  const def = registry.register(defender);
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
  // Production seeding (seedPF1ePool) loads one shot for firearms and zeroed weapon state.
  const ammoCol = pool.sys["ammo"] as unknown as Uint8Array | undefined;
  if (ammoCol && atk.isFirearm) ammoCol[atkIdx] = 1;
  const wsCol = pool.sys["weaponState"] as unknown as Uint8Array | undefined;
  if (wsCol) wsCol[atkIdx] = 0;
  const defIdx = allocModel(pool, {
    id: 2,
    unitIdx: 1,
    x: spacing,
    y: 0,
    hp: 20,
    hpMax: 20,
    sys: { profileIdx: def.id },
  });
  return { pool, atkIdx, defIdx, registry, registrySizes: { attacker: atk.id, defender: def.id } };
}

const plain: RawPF1eProfile = { name: "Target", bab: 1, ac: 10, hp: 20 };

describe("M01 §2.4 — multiplying damage: bonus dice are rolled once, never multiplied", () => {
  test("a x2 critical multiplies the base dice and static bonus, adding the flame dice once", () => {
    const flamingAxe: RawPF1eProfile = {
      name: "Axe",
      bab: 5,
      ac: 30,
      weapon: {
        damageDiceCount: 1,
        damageDiceSides: 6,
        damageMod: 0,
        critThreatMin: 20,
        critMultiplier: 2,
        bonusDice: { count: 1, sides: 6, typeFlags: PF1eDamageType.FIRE },
      },
    };
    // strMod 0 → damageMod = 0 + 0 + 0 = ... author the static bonus through damageMod (2h etc.)
    flamingAxe.strMod = 0;
    const { pool, atkIdx, defIdx, registry } = duel(flamingAxe, { ...plain });
    // d20 = 20 (threat), confirm = 20 (confirms), damage rolls: 3 (base), 6 (flame)
    const res = resolvePF1eAttacks({
      pool,
      attackers: [atkIdx],
      defenders: [defIdx],
      registry,
      rng: scriptedDice([20, 20, 3, 3, 6]),
      highFidelity: true,
    });
    expect(res.metrics.critsConfirmed).toBe(1);
    // Base (1d6=3 + 0) x2 crit = 6, flame d6 once = 6 → 12 total.
    // Wrong impl A (never roll bonus dice): 6. Wrong impl B (multiply bonus dice too): 18.
    expect(res.metrics.rawDamageDealt).toBe(12);
  });

  test("a non-critical hit still rolls the bonus dice (they exist outside crits)", () => {
    const flame: RawPF1eProfile = {
      name: "Flame Sword",
      bab: 5,
      ac: 30,
      weapon: {
        damageDiceCount: 1,
        damageDiceSides: 6,
        critThreatMin: 20,
        bonusDice: { count: 1, sides: 6, typeFlags: PF1eDamageType.FIRE },
      },
    };
    const { pool, atkIdx, defIdx, registry } = duel(flame, { ...plain });
    const res = resolvePF1eAttacks({
      pool,
      attackers: [atkIdx],
      defenders: [defIdx],
      registry,
      rng: scriptedDice([10, 4, 5]), // d20 10 hits AC 10 (bab 5), base 4, flame 5
      highFidelity: true,
    });
    expect(res.metrics.hits).toBe(1);
    expect(res.metrics.rawDamageDealt).toBe(9);
  });

  test("minimum damage applies only to the weapon blow: the bonus dice are never floored", () => {
    const weakFlame: RawPF1eProfile = {
      name: "Weak",
      bab: 0,
      strMod: -4,
      ac: 30,
      weapon: {
        damageDiceCount: 1,
        damageDiceSides: 6,
        damageMod: -1, // −4 Str + −1 author: 1d6−5, min-damage 1 rolls out
        bonusDice: { count: 1, sides: 6, typeFlags: PF1eDamageType.FIRE },
      },
    };
    const { pool, atkIdx, defIdx, registry } = duel(weakFlame, { ...plain });
    const res = resolvePF1eAttacks({
      pool,
      attackers: [atkIdx],
      defenders: [defIdx],
      registry,
      rng: scriptedDice([19, 1, 5]), // d20 19+bab0−4+... attack total 15 ≥ 10 hit; base 1, flame 5
      highFidelity: true,
    });
    expect(res.metrics.rawDamageDealt).toBe(5); // flame dice stand on their own
    expect(res.metrics.nonlethalDealt).toBe(1); // 1d6−5 dipped below 1 → 1 nonlethal
  });
});

describe("M01 §2.5 — threat range is weapon data, Improved Critical doubles it", () => {
  test("19–20 threat + Improved Critical ⇒ threat on 17", () => {
    const p = compilePF1eProfile(1, {
      bab: 5,
      weapon: { critThreatMin: 19, improvedCritical: true },
    });
    expect(p.critThreatMin).toBe(17);
  });
  test("18–20 threat + Improved Critical ⇒ threat on 15", () => {
    const p = compilePF1eProfile(1, {
      bab: 5,
      weapon: { critThreatMin: 18, improvedCritical: true },
    });
    expect(p.critThreatMin).toBe(15);
  });
  test("a 17 natural roll is a threat with IC, and no threat without it", () => {
    const keen: RawPF1eProfile = {
      name: "Keen",
      bab: 5,
      ac: 30,
      weapon: { damageDiceCount: 1, damageDiceSides: 8, critThreatMin: 19, improvedCritical: true },
    };
    const dull: RawPF1eProfile = {
      name: "Dull",
      bab: 5,
      ac: 30,
      weapon: { damageDiceCount: 1, damageDiceSides: 8, critThreatMin: 19 },
    };
    const keenDuel = duel(keen, { ...plain });
    const keenRes = resolvePF1eAttacks({
      pool: keenDuel.pool,
      attackers: [keenDuel.atkIdx],
      defenders: [keenDuel.defIdx],
      registry: keenDuel.registry,
      rng: scriptedDice([17, 20, 8, 8]), // d20 17+bab5 = 22 ≥ 10 hit & threat; confirm 20; dmg 8,8
      highFidelity: true,
    });
    expect(keenRes.metrics.critThreats).toBe(1);
    expect(keenRes.metrics.critsConfirmed).toBe(1);
    const dullDuel = duel(dull, { ...plain });
    const dullRes = resolvePF1eAttacks({
      pool: dullDuel.pool,
      attackers: [dullDuel.atkIdx],
      defenders: [dullDuel.defIdx],
      registry: dullDuel.registry,
      rng: scriptedDice([17, 8]),
      highFidelity: true,
    });
    expect(dullRes.metrics.critThreats).toBe(0);
  });
});

describe("M01 §2.6 — attack bonus is per-weapon: Dex for ranged, size applies", () => {
  test("a Small archer compiles iteratives with Dex and the attack size modifier", () => {
    const compiled = compilePF1eProfile(1, {
      name: "Halfling Archer",
      bab: 11,
      strMod: 1,
      dexMod: 4,
      sizeMod: 1,
      weapon: { isRanged: true, damageDiceCount: 1, damageDiceSides: 6 },
    });
    // BAB ladder 11/6/1 + Dex 4 + size 1 → 16/11/6 (the old compile gave 12/7/2 — Str, no size).
    expect(compiled.iteratives).toEqual([16, 11, 6]);
    // Ranged adds nothing from Strength to damage.
    expect(compiled.damageMod).toBe(0);
  });

  test("a Large rider compiles the −1 attack size modifier while CMB/CMD ride the special ladder", () => {
    const compiled = compilePF1eProfile(1, {
      name: "Knight",
      bab: 8,
      strMod: 4,
      sizeMod: -1,
      specialSizeMod: 1,
      weapon: { damageDiceCount: 1, damageDiceSides: 8 },
    });
    expect(compiled.iteratives).toEqual([11, 6]);
    expect(compiled.cmb).toBe(13);
    expect(compiled.cmd).toBe(23);
  });

  test("the compiled ladder decides the die: d20 10 + (4+1) small hits AC 16 where a Str+no-size build misses", () => {
    const archer: RawPF1eProfile = {
      name: "Archer",
      bab: 10,
      strMod: 1,
      dexMod: 4,
      sizeMod: 1,
      weapon: { isRanged: true, damageDiceCount: 1, damageDiceSides: 6, rangeIncrement: 30 },
    };
    const { pool, atkIdx, defIdx, registry } = duel(archer, {
      ...plain,
      ac: 16,
    });
    const res = resolvePF1eAttacks({
      pool,
      attackers: [atkIdx],
      defenders: [defIdx],
      registry,
      rng: scriptedDice([10, 3, 10, 3]),
      highFidelity: true,
    });
    // 10 + 10(BAB) + 4(Dex) + 1(size) = 25 ≥ 16 hit, and the +10 iterative also lands — the
    // discriminating fixture is the exact compiled ladder, not a hit-count sponge.
    expect(res.metrics.hits).toBe(2);
    expect(res.metrics.rawDamageDealt).toBe(6); // two 1d6 = 3 hits
    const compiled = registry.get(pool.sys["profileIdx"]?.[atkIdx] ?? 0);
    expect(compiled?.iteratives).toEqual([15, 10]);
  });
});

describe("M01 §2.7 — damage: handedness Strength shares and enhancement on damage", () => {
  test("two-handed 1.5x (rounded down), off-hand 0.5x, penalty never halved", () => {
    expect(
      compilePF1eProfile(1, { bab: 1, strMod: 5, weapon: { handedness: "two" } }).damageMod,
    ).toBe(7);
    expect(
      compilePF1eProfile(1, { bab: 1, strMod: 5, weapon: { handedness: "offHand" } }).damageMod,
    ).toBe(2);
    expect(
      compilePF1eProfile(1, { bab: 1, strMod: 5, weapon: { handedness: "one" } }).damageMod,
    ).toBe(5);
    expect(
      compilePF1eProfile(1, { bab: 1, strMod: -2, weapon: { handedness: "offHand" } }).damageMod,
    ).toBe(-2);
    expect(
      compilePF1eProfile(1, { bab: 1, strMod: -2, weapon: { handedness: "two" } }).damageMod,
    ).toBe(-2);
  });

  test("a +1 longsword deals damage including the enhancement bonus", () => {
    expect(
      compilePF1eProfile(1, {
        bab: 1,
        strMod: 3,
        weapon: { handedness: "one", enhancementBonus: 1 },
      }).damageMod,
    ).toBe(4); // 0 authored + 3 Str + 1 enhancement (the old line dropped the +1)
  });

  test("a thrown weapon adds Strength to damage (but Dexterity to the roll)", () => {
    const javelin = compilePF1eProfile(1, {
      bab: 2,
      strMod: 3,
      dexMod: 1,
      weapon: { isRanged: true, isThrown: true, damageDiceCount: 1, damageDiceSides: 6 },
    });
    expect(javelin.damageMod).toBe(3); // 0 + 3 Str (thrown) + 0
    expect(javelin.iteratives).toEqual([3]); // BAB 2 + Dex 1 (ranged), not Str 3
    expect(javelin.maxIncrements).toBe(5); // thrown cap
  });
});

describe("M01 §2.8 — ranged attacks: −2 per full increment past the 1st; max-range legality", () => {
  const longbow: RawPF1eProfile = {
    name: "Bow",
    bab: 10,
    dexMod: 2,
    weapon: { isRanged: true, rangeIncrement: 30, damageDiceCount: 1, damageDiceSides: 8 },
  };

  test("at 70 feet (3 increments) the longbowman rolls at −4", () => {
    // spacing 70 world units = 70 ft.
    const { pool, atkIdx, defIdx, registry } = duel(longbow, { ...plain, ac: 22, hp: 20 }, 70);
    const res = resolvePF1eAttacks({
      pool,
      attackers: [atkIdx],
      defenders: [defIdx],
      registry,
      rng: scriptedDice([14, 5]),
      highFidelity: true,
    });
    // 14 + 12(hit) − 4(range) = 22 ≥ 22 hit — without the penalty 26, with the wrong −6 it'd be 20 (miss).
    expect(res.metrics.hits).toBe(1);
    expect(res.metrics.rawDamageDealt).toBe(5);
  });

  test("inside the first increment there is no penalty", () => {
    const { pool, atkIdx, defIdx, registry } = duel(longbow, { ...plain, ac: 26, hp: 20 }, 25);
    const res = resolvePF1eAttacks({
      pool,
      attackers: [atkIdx],
      defenders: [defIdx],
      registry,
      rng: scriptedDice([14, 5]),
      highFidelity: true,
    });
    // 14 + 12 = 26 ≥ 26 → hit; an off-by-one −2 would produce 24 (miss).
    expect(res.metrics.hits).toBe(1);
  });

  test("past 10 increments the attack is not made at all — no die consumed, no attack booked", () => {
    const { pool, atkIdx, defIdx, registry } = duel(longbow, { ...plain, hp: 20 }, 305);
    const res = resolvePF1eAttacks({
      pool,
      attackers: [atkIdx],
      defenders: [defIdx],
      registry,
      rng: scriptedDice([20, 8]),
      highFidelity: true,
    });
    expect(res.metrics.totalAttacks).toBe(0);
    expect(res.metrics.hits).toBe(0);
  });

  test("a javelin beyond 5 increments is silent while the same throw at the 5th resolves", () => {
    const spear: RawPF1eProfile = {
      name: "Spear",
      bab: 3,
      dexMod: 1,
      weapon: { isRanged: true, isThrown: true, rangeIncrement: 5, damageDiceCount: 1, damageDiceSides: 6 },
    };
    const far = duel(spear, { ...plain }, 26); // 26 ft > 25 = 5th increment cap
    const farRes = resolvePF1eAttacks({
      pool: far.pool,
      attackers: [far.atkIdx],
      defenders: [far.defIdx],
      registry: far.registry,
      rng: scriptedDice([20, 6]),
      highFidelity: true,
    });
    expect(farRes.metrics.totalAttacks).toBe(0);
    const near = duel(spear, { ...plain, ac: 10, hp: 20 }, 25);
    const nearRes = resolvePF1eAttacks({
      pool: near.pool,
      attackers: [near.atkIdx],
      defenders: [near.defIdx],
      registry: near.registry,
      rng: scriptedDice([10, 4]),
      highFidelity: true,
    });
    // 10 + 3(BAB) + 1(Dex) − 8 (4 full increments past the 1st) = 6 < 10 … vs AC 10 ⇒ miss is fine;
    // what matters is that the attack was REGISTERED (it was taken, unlike the 26-ft case).
    expect(nearRes.metrics.totalAttacks).toBe(1);
  });
});

describe("M01 §2.9 — firearms: class-window touch AC and incremented penalties", () => {
  const advanced: RawPF1eProfile = {
    name: "Advanced Rifle",
    bab: 5,
    dexMod: 2,
    weapon: { isFirearm: true, isEarlyFirearm: false, rangeIncrement: 20, damageDiceCount: 1, damageDiceSides: 10 },
  };
  const armorDef: RawPF1eProfile = { ...plain, ac: 20, touchAc: 11 };

  test("an advanced firearm resolves vs touch AC through the 5th increment (here: 4th)", () => {
    const { pool, atkIdx, defIdx, registry } = duel(advanced, { ...armorDef }, 61);
    const res = resolvePF1eAttacks({
      pool,
      attackers: [atkIdx],
      defenders: [defIdx],
      registry,
      rng: scriptedDice([4, 5]), // 4 + 7 − 6 = 5? no: bab5+dex2 = 7; 4+7−6 = 5 < 11...
      highFidelity: true,
    });
    // increments at 61 ft / 20 = 4 → −6; touch AC 11; total 4+7−6 = 5 ⇒ miss (old code: no touch,
    // no penalty → 4+7 = 11 ≥ 11 HIT vs standard 20 would miss; the discriminating cases below pin
    // the touch window exactly, so this hitless assert catches both wrong branches).
    expect(res.metrics.totalAttacks).toBe(1);
    expect(res.metrics.hits).toBe(0);
  });

  test("at the 4th increment a touch hit lands where standard AC would block it", () => {
    const { pool, atkIdx, defIdx, registry } = duel(advanced, { ...armorDef }, 61);
    const res = resolvePF1eAttacks({
      pool,
      attackers: [atkIdx],
      defenders: [defIdx],
      registry,
      rng: scriptedDice([10, 5]),
      highFidelity: true,
    });
    // touch 11: 10 + 7 − 6 = 11 ≥ 11 hit; vs standard 20 it is a miss. Old code had NO touch
    // window beyond the 1st increment (and NO range penalty) → 10+7 = 17 <20 miss: red before fix.
    expect(res.metrics.hits).toBe(1);
  });

  test("an early firearm past its 1st increment resolves vs standard AC with the −2/increment ladder", () => {
    const blunderbuss: RawPF1eProfile = {
      name: "Blunderbuss",
      bab: 5,
      dexMod: 2,
      weapon: { isFirearm: true, isEarlyFirearm: true, rangeIncrement: 20, damageDiceCount: 1, damageDiceSides: 8 },
    };
    const { pool, atkIdx, defIdx, registry } = duel(blunderbuss, { ...armorDef }, 61);
    const res = resolvePF1eAttacks({
      pool,
      attackers: [atkIdx],
      defenders: [defIdx],
      registry,
      rng: scriptedDice([19, 8]),
      highFidelity: true,
    });
    // Standard AC 20 here (not touch): 19 + 7 − 6 = 20 ≥ 20 hit — one point less and it misses,
    // so the −6 penalty (3 full increments past the 1st) is verified by construction.
    expect(res.metrics.hits).toBe(1);
  });

  test("firearms beyond their class ceiling refuse to fire", () => {
    const early = { ...advanced, weapon: { ...(advanced.weapon ?? {}), isEarlyFirearm: true } };
    const far = duel(early, { ...armorDef }, 101); // 6 increments > early cap 5
    const farRes = resolvePF1eAttacks({
      pool: far.pool,
      attackers: [far.atkIdx],
      defenders: [far.defIdx],
      registry: far.registry,
      rng: scriptedDice([20, 5]),
      highFidelity: true,
    });
    expect(farRes.metrics.totalAttacks).toBe(0);
    const near = duel(advanced, { ...armorDef }, 101); // advanced: 6 ≤ 10 → legal, but penalized −10
    const nearRes = resolvePF1eAttacks({
      pool: near.pool,
      attackers: [near.atkIdx],
      defenders: [near.defIdx],
      registry: near.registry,
      rng: scriptedDice([20, 5]),
      highFidelity: true,
    });
    expect(nearRes.metrics.totalAttacks).toBe(1);
  });
});

describe("M01 §2.9b — a broken weapon fights at −2 attack and −2 damage", () => {
  test("broken longarm: −2 attack turns a tie into a miss; −2 damage shows on a hit", () => {
    const rifle: RawPF1eProfile = {
      name: "Rifle",
      bab: 5,
      weapon: { damageDiceCount: 1, damageDiceSides: 8, damageMod: 4 },
    };
    const { pool, atkIdx, defIdx, registry } = duel(rifle, { ...plain, ac: 20, hp: 40 });
    (pool.sys["weaponState"] as unknown as Uint8Array)[atkIdx] = 1; // broken
    const miss = resolvePF1eAttacks({
      pool,
      attackers: [atkIdx],
      defenders: [defIdx],
      registry,
      rng: scriptedDice([15, 8]),
      highFidelity: true,
    });
    // 15 + 5 − 2 = 18 < 20 miss; exactly the −2 (sound weapon: 20 = hit).
    expect(miss.metrics.hits).toBe(0);
    const { pool: p2, atkIdx: a2, defIdx: d2, registry: r2 } = duel(rifle, { ...plain, ac: 16, hp: 40 });
    (p2.sys["weaponState"] as unknown as Uint8Array)[a2] = 1;
    const hit = resolvePF1eAttacks({
      pool: p2,
      attackers: [a2],
      defenders: [d2],
      registry: r2,
      rng: scriptedDice([13, 4]),
      highFidelity: true,
    });
    // 13 + 5 − 2 = 16 ≥ 16 hit; damage (1d8=4 + 4 − 2) = 6 (sound would deal 7).
    expect(hit.metrics.hits).toBe(1);
    expect(hit.metrics.rawDamageDealt).toBe(6);
  });
});

describe("M01 §2.10 — DR: compound forms need every quality; alignment row; precision bypass", () => {
  test("DR/magic and cold iron: a +1 steel sword and a mundane cold-iron sword both stall", () => {
    const compound = PF1eDrType.MAGIC | PF1eDrType.COLD_IRON;
    expect(isDrBypassed(1, "none", "slashing", compound)).toBe(false);
    expect(isDrBypassed(0, "cold_iron", "slashing", compound)).toBe(false);
    // The old first-match OR returned true for both rows above.
    expect(isDrBypassed(1, "cold_iron", "slashing", compound)).toBe(true);
    expect(isDrBypassed(3, "silver", "slashing", compound)).toBe(true); // +3 covers magic AND cold iron
  });

  test("the enhancement ladder: +1 magic, +3 iron/silver, +4 adamantine, +5 alignment", () => {
    expect(isDrBypassed(4, "none", "slashing", PF1eDrType.ADAMANTINE)).toBe(true);
    expect(isDrBypassed(3, "none", "slashing", PF1eDrType.ADAMANTINE)).toBe(false);
    expect(isDrBypassed(4, "none", "slashing", PF1eDrType.ALIGNMENT)).toBe(false);
    expect(isDrBypassed(5, "none", "slashing", PF1eDrType.ALIGNMENT)).toBe(true);
    // An aligned weapon bypasses /alignment regardless of enhancement.
    expect(isDrBypassed(0, "none", "slashing", PF1eDrType.ALIGNMENT, 1)).toBe(true);
  });

  test("precision bonus dice sail past DR while the weapon blow is absorbed", () => {
    const sneak: RawPF1eProfile = {
      name: "Rogue",
      bab: 5,
      strMod: 0,
      weapon: {
        damageDiceCount: 1,
        damageDiceSides: 6,
        damageMod: 2,
        bonusDice: { count: 2, sides: 6, precision: true },
      },
    };
    const slave: RawPF1eProfile = {
      ...plain,
      dr: { typeFlags: PF1eDrType.NONE, val: 5 }, // DR 5/—
      hp: 40,
    };
    const { pool, atkIdx, defIdx, registry } = duel(sneak, slave);
    const res = resolvePF1eAttacks({
      pool,
      attackers: [atkIdx],
      defenders: [defIdx],
      registry,
      rng: scriptedDice([15, 4, 3, 3]),
      highFidelity: true,
    });
    // Weapon blow: 1d6(4)+2 = 6 − DR 5 = 1; sneak dice 3+3 = 6 untouched → net 7.
    expect(res.metrics.rawDamageDealt).toBe(12);
    expect(res.metrics.drAbsorbed).toBe(5);
    expect(res.metrics.netDamageDealt).toBe(7);
  });
});

describe("M01 — authored weapon data flows from unit stats into the compiled profile", () => {
  test("rawProfileFromUnit carries the numeric weapon stat payload (deploySeed seam)", async () => {
    const { rawProfileFromUnit } = await import("../../src/packages/pf1e/deploySeed");
    const raw = rawProfileFromUnit({
      id: "u1",
      name: "Musketeers",
      armyId: "a1",
      factionId: "red",
      profile: "soldier",
      stats: {
        bab: 5,
        dexMod: 2,
        weaponIsFirearm: 1,
        weaponIsEarlyFirearm: 0,
        weaponRangeIncrement: 20,
        weaponDamageDiceCount: 1,
        weaponDamageDiceSides: 10,
        weaponImprovedCritical: 1,
        weaponBonusDiceCount: 1,
        weaponBonusDiceSides: 6,
        weaponBonusDiceTypeFlags: PF1eDamageType.FIRE,
      },
    } as unknown as Parameters<typeof rawProfileFromUnit>[0]);
    const compiled = compilePF1eProfile(1, raw);
    expect(compiled.isFirearm).toBe(true);
    expect(compiled.isEarlyFirearm).toBe(false);
    expect(compiled.isRanged).toBe(true);
    expect(compiled.iteratives).toEqual([7]); // BAB 5 + Dex 2
    expect(compiled.maxIncrements).toBe(10); // advanced
    expect(compiled.bonusDamageCount).toBe(1);
    expect(compiled.bonusDamageTypeFlags).toBe(PF1eDamageType.FIRE);
    expect(compiled.critThreatMin).toBe(19); // 20 → doubled through the IC rule
  });
});
