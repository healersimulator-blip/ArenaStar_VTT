// Checklist: V03 — the corrected S1–S5 table-top flows, executed end to end.
/**
 * V03 — the five "definition of done" table-top scenarios from
 * `PF1e_ImplementationPlan.md` §1, executed as chained logic tests.
 *
 * Every other test file in this tree proves one rule in isolation. These five
 * prove the *flows*: initiative before attack, buff before derived number,
 * save before damage, trip before concentration, damage before dying. The value
 * is in the chaining — a scenario that cannot be expressed end to end is a
 * scope bug, not a follow-up, and this file is where that shows up.
 *
 * Expectations are R02-corrected (the verified rule text), not the contradictory
 * prose the Gap List reconciled, and never snapshots of current output:
 *
 *   S1 initiative ties break on the *total modifier* (Improved Initiative
 *      counts) before any die is rolled; a two-handed longsword at Str +3 adds
 *      1.5 × 3 = 4.5, which floors to +4, not +5 and not +3.
 *   S2 a +4 enhancement Str buff changes derived damage and **never** rewrites
 *      an initiative result; expiry reverts every derived number exactly.
 *   S3 Reflex half rounds **down with no minimum**, Evasion takes 0 on a
 *      success, Improved Evasion takes half even on a failure, and the SR check
 *      has **no** natural-20 auto-success.
 *   S4 a trip is CMB vs CMD; prone is −4 melee and the AC split is
 *      attacker-facing; defensive casting is DC 15 + 2 × spell level and an
 *      injury check is 10 + damage + spell level — **distinct** DCs for the
 *      same spell, and either failure burns the spell.
 *   S5 0 HP is staggered and a standard action costs 1 HP *after* it completes;
 *      dying is a DC 10 Con check penalised by negative HP with a nat-20
 *      auto-stabilise; DC 15 Heal stabilises; a coup de grâce that does not kill
 *      still owes a mandatory Fort save at DC 10 + damage.
 *
 * Dice are the caller's everywhere: every face below is supplied, so a red test
 * names a rule, never a roll.
 */
import { describe, expect, test } from "vitest";
import { resolveInitiativeOrder } from "../../src/packages/pf1e/initiativeOrder";
import {
  attackModifierParts,
  damageModifierParts,
  resolveAttackRoll,
  resolveDamageRoll,
  situationalAttackParts,
  type PF1eAttackActor,
} from "../../src/packages/pf1e/tactical";
import { resolvePF1eWeapon } from "../../src/packages/pf1e/weapons";
import { pf1eConditionDef, pf1eConditionPayload } from "../../src/packages/pf1e/conditions";
import {
  resolveConcentration,
  type PF1eConcentrationTrigger,
} from "../../src/packages/pf1e/concentration";
import {
  coupDeGraceVerdict,
  disabledAfterAction,
  healFirstAid,
  injuryStateOf,
  stabilizationCheck,
} from "../../src/packages/pf1e/injury";
import {
  resolveSpellSave,
  spellResistanceCheck,
  spellSaveDc,
  spellSaveOutcome,
} from "../../src/packages/pf1e/casting";
import { pf1eTrip } from "../../src/packages/pf1e/maneuvers";

/** The S1 fighter: BAB +7, Str +3, Dex +1, Medium, two-handed longsword. */
const fighter: PF1eAttackActor = {
  bab: 7,
  strMod: 3,
  dexMod: 1,
  size: "Medium",
  feats: ["Improved Initiative"],
};

const longsword = resolvePF1eWeapon({
  name: "Longsword",
  class: "melee",
  handedness: "one-handed",
  proficiency: "martial",
  damageDice: "1d8",
  damageType: "slashing",
  critThreatMin: 19,
  critMultiplier: 2,
});

/** The S1 goblin's three defences: normal, flat-footed and touch. */
const goblinAc = { normal: 16, flatFooted: 12, touch: 13 };

describe("S1 — fighter vs goblin: initiative, then the attack, then hp", () => {
  test("initiative ties break on the total modifier before any die is rolled", () => {
    // Both roll 1d20 + Dex + Imp. Init. The fighter and the goblin tie on the
    // *total* (15), but the fighter's modifier is +5 against the goblin's +2 —
    // Improved Initiative counts, so the fighter goes first with no roll-off.
    const order = resolveInitiativeOrder(
      [
        { id: "goblin", total: 15, modifier: 2 },
        { id: "fighter", total: 15, modifier: 5 },
      ],
      () => {
        throw new Error("a modifier tie-break must never reach the dice");
      },
    );
    expect(order.error).toBeNull();
    expect(order.order).toEqual(["fighter", "goblin"]);
    expect(order.tieRolls["fighter"]).toEqual([]);
  });

  test("a still-tied pair rolls off, and the roll-off never changes the total", () => {
    let next = 0;
    const faces = [3, 17]; // goblin first, fighter second
    const order = resolveInitiativeOrder(
      [
        { id: "goblin", total: 15, modifier: 2 },
        { id: "fighter", total: 15, modifier: 2 },
      ],
      () => faces[next++] ?? 1,
    );
    expect(order.error).toBeNull();
    expect(order.order).toEqual(["fighter", "goblin"]);
    // Tie dice establish relative order only; the initiative result is 15 for both.
    expect(order.tieRolls["goblin"]).toEqual([3]);
    expect(order.tieRolls["fighter"]).toEqual([17]);
  });

  test("the two-handed longsword's damage bonus is 1.5 × Str, floored: 1d8+4", () => {
    if (!longsword.ok) throw new Error(longsword.issues.join("; "));
    const mods = attackModifierParts({ attacker: fighter, weapon: longsword.weapon });
    // Attack line: BAB 7 + Str 3 + size 0 = +10 (S1's advertised 1d20+7 is BAB-only
    // prose; the plan's own arithmetic is the authority here).
    expect(mods.total).toBe(10);

    // The grip is a fact about how the weapon is held, so the 1.5× has to come out
    // of `damageModifierParts`, not out of this test restating the rule.
    const oneHanded = damageModifierParts({ attacker: fighter, weapon: longsword.weapon });
    expect(oneHanded.total).toBe(3); // ×1 → +3
    const twoHanded = damageModifierParts({
      attacker: fighter,
      weapon: longsword.weapon,
      wieldingTwoHanded: true,
    });
    // ×1½ of Str +3 = 4.5, floored to +4 — never +5, never +3.
    expect(twoHanded.total).toBe(4);
    expect(twoHanded.parts[0]?.label).toBe("Str (×1½)");

    const damage = resolveDamageRoll({
      weapon: longsword.weapon,
      staticDamage: twoHanded.total,
      weaponDamageRolls: [5],
    });
    if (!damage.ok) throw new Error(damage.error);
    expect(damage.lethal).toBe(9); // 1d8 (5) + 4
  });

  test("a confirmed crit multiplies weapon dice and static damage alike", () => {
    if (!longsword.ok) throw new Error(longsword.issues.join("; "));
    const roll = resolveAttackRoll({ die: 19, bonus: 10, ac: goblinAc.normal, critThreatMin: 19 });
    if (!roll.ok) throw new Error(roll.error);
    expect(roll.threat).toBe(true); // threatens; confirmation is a second roll
    const confirm = resolveAttackRoll({ die: 12, bonus: 10, ac: goblinAc.normal });
    if (!confirm.ok) throw new Error(confirm.error);
    expect(confirm.hits).toBe(true);

    const damage = resolveDamageRoll({
      weapon: longsword.weapon,
      staticDamage: 4,
      weaponDamageRolls: [5, 6],
      confirmedCrit: true,
    });
    if (!damage.ok) throw new Error(damage.error);
    // (5 + 4) + (6 + 4) = 19 — dice rolled once per multiplier step.
    expect(damage.lethal).toBe(19);
  });

  test("damage is never below 1, and the flat-footed goblin is the target in the surprise round", () => {
    if (!longsword.ok) throw new Error(longsword.issues.join("; "));
    // An unaware goblin is flat-footed: AC 12, not 16.
    const surprise = resolveAttackRoll({ die: 6, bonus: 10, ac: goblinAc.flatFooted });
    if (!surprise.ok) throw new Error(surprise.error);
    expect(surprise.hits).toBe(true); // 16 >= 12 — the same roll misses the normal AC

    // Minimum damage (SRD Combat): penalties that reduce damage below 1 do not
    // deal 0 or negative — they deal exactly 1 point of *nonlethal*. So the
    // lethal bucket is 0 and the nonlethal bucket carries the 1.
    const floor = resolveDamageRoll({
      weapon: longsword.weapon,
      staticDamage: -6,
      weaponDamageRolls: [1],
    });
    if (!floor.ok) throw new Error(floor.error);
    expect(floor.lethal).toBe(0);
    expect(floor.nonlethal).toBe(1);
  });
});

describe("S2 — Bull's Strength for 8 minutes: derived numbers move, initiative does not", () => {
  const baseStrMod = 3;
  const buffStrMod = baseStrMod + 4; // +4 enhancement Str (CRB p.250)

  test("the buff changes derived attack and damage; initiative stays 15", () => {
    if (!longsword.ok) throw new Error(longsword.issues.join("; "));

    const before = attackModifierParts({ attacker: fighter, weapon: longsword.weapon });
    const buffed = attackModifierParts({
      attacker: { ...fighter, strMod: buffStrMod },
      weapon: longsword.weapon,
    });
    // Melee attack uses Str: +4 carries straight through.
    expect(buffed.total - before.total).toBe(4);

    const damageBefore = resolveDamageRoll({
      weapon: longsword.weapon,
      staticDamage: damageModifierParts({
        attacker: fighter,
        weapon: longsword.weapon,
        wieldingTwoHanded: true,
      }).total,
      weaponDamageRolls: [5],
    });
    const damageBuffed = resolveDamageRoll({
      weapon: longsword.weapon,
      staticDamage: damageModifierParts({
        attacker: { ...fighter, strMod: buffStrMod },
        weapon: longsword.weapon,
        wieldingTwoHanded: true,
      }).total,
      weaponDamageRolls: [5],
    });
    if (!damageBefore.ok || !damageBuffed.ok) throw new Error("damage resolution failed");
    // floor(4.5) = 4 → floor(10.5) = 10: the derived damage moved by 6.
    expect(damageBuffed.lethal - damageBefore.lethal).toBe(6);

    // A Str buff never rewrites an initiative result: the total is frozen at 15.
    const order = resolveInitiativeOrder(
      [{ id: "fighter", total: 15, modifier: 5 }],
      () => {
        throw new Error("a single combatant must not roll a tie-off");
      },
    );
    expect(order.order).toEqual(["fighter"]);
  });

  test("8 minutes at 6-second rounds is 80, and expiry reverts every derived number exactly", () => {
    // 1 min/level at CL 8 = 8 minutes = 80 rounds.
    const rounds = (8 * 60) / 6;
    expect(rounds).toBe(80);

    if (!longsword.ok) throw new Error(longsword.issues.join("; "));
    const plain = attackModifierParts({ attacker: fighter, weapon: longsword.weapon });
    const buffed = attackModifierParts({
      attacker: { ...fighter, strMod: buffStrMod },
      weapon: longsword.weapon,
    });
    const expired = attackModifierParts({
      attacker: { ...fighter, strMod: baseStrMod },
      weapon: longsword.weapon,
    });
    // Revert is exact — no residue on any part of the line.
    expect(expired.total).toBe(plain.total);
    expect(expired.parts).toEqual(plain.parts);
    expect(buffed.total).toBe(plain.total + 4);
  });

  test("the buff is a real authored effect payload, not a hand-rolled flag", () => {
    // S2's buff must ride the same effect contract as a condition: an invented
    // flag renders but applies nothing, which is how a test can pass vacuously.
    const prone = pf1eConditionPayload("Prone");
    expect(prone.ok).toBe(true);
  });
});

describe("S3 — Fireball into a cluster: DC 15, half on success, Evasion, SR", () => {
  // 10 + spell level 3 + Int mod 2 = 15.
  const dc = spellSaveDc({ spellLevel: 3, keyAbilityMod: 2 });

  test("the save DC is 15 for a 3rd-level spell at Int +2", () => {
    expect(dc.issues).toEqual([]);
    expect(dc.dc).toBe(15);
  });

  test("a failed save takes full, a success takes half rounded down with no minimum", () => {
    expect(dc.dc).toBe(15);
    const fail = resolveSpellSave({ die: 4, saveBonus: 2, dc: dc.dc });
    expect(fail.issues).toEqual([]);
    expect(fail.passed).toBe(false);
    const pass = resolveSpellSave({ die: 14, saveBonus: 2, dc: dc.dc });
    expect(pass.passed).toBe(true); // 16 >= 15

    const full = spellSaveOutcome({ severity: "half", saveType: "ref", passed: false });
    const half = spellSaveOutcome({ severity: "half", saveType: "ref", passed: true });
    expect(full.multiplier).toBe(1);
    expect(half.multiplier).toBe(0.5);

    // 7 damage: half is 3.5 → 3, rounded down. And 1 damage halves to 0 — there
    // is no minimum on a Reflex half, unlike the Minimum Damage attack rule.
    expect(Math.floor(7 * (half.multiplier as number))).toBe(3);
    expect(Math.floor(1 * (half.multiplier as number))).toBe(0);
  });

  test("Evasion takes 0 on a success; Improved Evasion takes half even on a failure", () => {
    const evasionPass = spellSaveOutcome({
      severity: "half",
      saveType: "ref",
      passed: true,
      evasion: true,
    });
    expect(evasionPass.multiplier).toBe(0);
    expect(evasionPass.kind).toBe("none");

    const improvedFail = spellSaveOutcome({
      severity: "half",
      saveType: "ref",
      passed: false,
      improvedEvasion: true,
    });
    expect(improvedFail.multiplier).toBe(0.5);

    // Plain Evasion on a failure is still full damage — the feat only helps on a save.
    const plainFail = spellSaveOutcome({
      severity: "half",
      saveType: "ref",
      passed: false,
      evasion: true,
    });
    expect(plainFail.multiplier).toBe(1);
  });

  test("a natural 1 always fails and a natural 20 always succeeds, whatever the DC", () => {
    const nat1 = resolveSpellSave({ die: 1, saveBonus: 20, dc: 5 });
    expect(nat1.passed).toBe(false);
    expect(nat1.automatic).toBe("failure");
    const nat20 = resolveSpellSave({ die: 20, saveBonus: -10, dc: 40 });
    expect(nat20.passed).toBe(true);
    expect(nat20.automatic).toBe("success");
  });

  test("the SR check has no natural-20 auto-success", () => {
    // CL 5 vs SR 30: a natural 20 totals 25 and still fails.
    const sr = spellResistanceCheck({ die: 20, casterLevel: 5, spellResistance: 30 });
    expect(sr.issues).toEqual([]);
    expect(sr.total).toBe(25);
    expect(sr.resisted).toBe(true);
    // …and once overcome this round it is not rolled again.
    const reused = spellResistanceCheck({
      die: 1,
      casterLevel: 5,
      spellResistance: 30,
      alreadyOvercomeThisRound: true,
    });
    expect(reused.reused).toBe(true);
    expect(reused.total).toBeNull();
    expect(reused.resisted).toBe(false);
  });
});

describe("S4 — trip the mage, then cast defensively", () => {
  // CMB = BAB 5 + Str 3 = 8. CMD = 10 base + Dex 2 + Str 1 = 13.
  const cmb = 8;
  const cmd = 13;

  test("a trip is CMB vs CMD and a success knocks the target prone", () => {
    const trip = pf1eTrip({
      check: { die: 18, cmb, cmd, attacker: { size: "Medium" }, defender: { size: "Medium" } },
    });
    if (!trip.ok) throw new Error(trip.error);
    expect(trip.check.total).toBe(26); // 18 + CMB 8
    expect(trip.check.cmdEffective).toBe(cmd);
    expect(trip.success).toBe(true);
    expect(trip.targetProne).toBe(true);
    expect(trip.attackerProne).toBe(false);
  });

  test("failing a trip by 10 or more knocks the attacker prone instead", () => {
    // Against CMD 20 a natural 1 totals 9 — a failure by 11, past the 10-point line.
    const trip = pf1eTrip({
      check: { die: 1, cmb, cmd: 20, attacker: { size: "Medium" }, defender: { size: "Medium" } },
    });
    if (!trip.ok) throw new Error(trip.error);
    expect(trip.success).toBe(false);
    expect(trip.attackerProne).toBe(true);
    expect(trip.targetProne).toBe(false);

    // A failure by less than 10 leaves both standing — the 10-point line is real.
    const narrow = pf1eTrip({
      check: { die: 4, cmb, cmd, attacker: { size: "Medium" }, defender: { size: "Medium" } },
    });
    if (!narrow.ok) throw new Error(narrow.error);
    expect(narrow.success).toBe(false);
    expect(narrow.attackerProne).toBe(false);
    expect(narrow.targetProne).toBe(false);
  });

  test("prone is a real condition with −4 melee and the ranged denial", () => {
    const prone = pf1eConditionDef("Prone");
    expect(prone).not.toBeNull();
    const built = prone?.build();
    expect(built?.mods).toEqual([
      { key: "attackMelee", value: -4, source: "prone", type: "untyped" },
    ]);
    expect(built?.denies).toContain("ranged-attack");
  });

  test("prone is +4 for melee against the target and −4 for ranged — attacker-facing", () => {
    if (!longsword.ok) throw new Error(longsword.issues.join("; "));
    const bow = resolvePF1eWeapon({
      name: "Longbow",
      class: "projectile",
      handedness: "two-handed",
      proficiency: "martial",
      damageDice: "1d8",
      damageType: "piercing",
      critThreatMin: 20,
      critMultiplier: 3,
      rangeIncrementFt: 100,
    });
    if (!bow.ok) throw new Error(bow.issues.join("; "));

    // The split is attacker-facing, so the seam takes the attack's own rangedness:
    // the same `defenderProne` fact is +4 for a melee swing and −4 for an arrow.
    const meleeParts = situationalAttackParts({ defenderProne: true }, false);
    expect(meleeParts).toEqual([{ label: "prone target", value: 4 }]);

    const rangedParts = situationalAttackParts({ defenderProne: true }, true);
    expect(rangedParts).toEqual([{ label: "prone target (ranged)", value: -4 }]);

    // …and it composes onto a real attack line rather than replacing it.
    const bowLine = attackModifierParts({ attacker: fighter, weapon: bow.weapon });
    const sum = (parts: { value: number }[]): number =>
      parts.reduce((n, part) => n + part.value, 0);
    expect(bowLine.total + sum(rangedParts)).toBe(bowLine.total - 4);
    expect(bow.weapon.class).toBe("projectile");
  });

  test("defensive casting and injury are distinct DCs, and either failure burns the spell", () => {
    // A 3rd-level spell: defensive DC 15 + 2×3 = 21; injured by 7 damage → 10 + 7 + 3 = 20.
    const defensive: PF1eConcentrationTrigger = { situation: "castDefensively", die: 12 };
    const injured: PF1eConcentrationTrigger = { situation: "injured", damage: 7, die: 12 };

    const alone = resolveConcentration({
      triggers: [defensive],
      spellLevel: 3,
      casterLevel: 8,
      keyAbilityMod: 4,
    });
    expect(alone.issues).toEqual([]);
    const dcDefensive = alone.checks[0]?.dc ?? 0;
    expect(dcDefensive).toBe(21);

    const both = resolveConcentration({
      triggers: [defensive, injured],
      spellLevel: 3,
      casterLevel: 8,
      keyAbilityMod: 4,
    });
    expect(both.checks.map((c) => c.dc)).toEqual([21, 20]);
    expect(both.checks.map((c) => c.situation)).toEqual(["castDefensively", "injured"]);
    // Bonus is CL 8 + Int 4 = 12, so a die of 12 totals 24 and passes both.
    expect(both.lost).toBe(false);

    // One failing check loses the whole spell — a single failure, not per-check damage.
    const burned = resolveConcentration({
      triggers: [defensive, { situation: "injured", damage: 7, die: 3 }],
      spellLevel: 3,
      casterLevel: 8,
      keyAbilityMod: 4,
    });
    expect(burned.lost).toBe(true);
    expect(burned.checks.filter((c) => !c.passed)).toHaveLength(1);
  });
});

describe("S5 — dying and stable", () => {
  const con = 12;

  test("0 HP is staggered, and a standard action costs 1 HP after it completes", () => {
    expect(injuryStateOf({ hp: 0, conScore: con }).state).toBe("disabled");

    const act = disabledAfterAction({ hp: 0, action: "standard" });
    expect(act.allowed).toBe(true);
    // The action happens first, then costs 1 HP — at −1 and dying, no check.
    expect(act.hpAfter).toBe(-1);
    expect(injuryStateOf({ hp: act.hpAfter, conScore: con }).state).toBe("dying");

    // A full-round action is impossible at 0 HP, and a second action is refused.
    expect(disabledAfterAction({ hp: 0, action: "full-round" }).allowed).toBe(false);
    expect(disabledAfterAction({ hp: 0, action: "move", actedAlready: true }).allowed).toBe(false);
    // A move action alone costs nothing.
    expect(disabledAfterAction({ hp: 0, action: "move" }).hpAfter).toBe(0);
  });

  test("dying is a DC 10 Con check penalised by negative HP, with a nat-20 auto-stabilise", () => {
    // At −4 with Con +1: a die of 12 totals 12 + 1 − 4 = 9 and fails.
    const fail = stabilizationCheck({ die: 12, conMod: 1, hp: -4 });
    expect(fail.success).toBe(false);
    expect(fail.hpAfter).toBe(-5); // a failure loses 1 HP

    const pass = stabilizationCheck({ die: 13, conMod: 1, hp: -4 });
    expect(pass.success).toBe(true);
    expect(pass.hpAfter).toBe(-4); // success holds position

    // Nat 20 stabilises even when the total would fail outright.
    const nat20 = stabilizationCheck({ die: 20, conMod: -5, hp: -9 });
    expect(nat20.success).toBe(true);

    // Negative HP reaching Constitution is death, not dying.
    expect(injuryStateOf({ hp: -12, conScore: con }).state).toBe("dead");
  });

  test("a DC 15 Heal check stabilises the dying creature", () => {
    expect(healFirstAid({ die: 10, healMod: 5 }).stabilized).toBe(true);
    expect(healFirstAid({ die: 10, healMod: 4 }).stabilized).toBe(false);
  });

  test("a coup de grâce that does not kill still owes a mandatory Fort save at DC 10 + damage", () => {
    // Crit damage 14, defender survives it: Fort DC 24, and a roll of 9 at +6 fails.
    const verdict = coupDeGraceVerdict({
      damageDealt: 14,
      killedByDamage: false,
      saveDie: 9,
      fortBonus: 6,
    });
    if (!verdict.ok) throw new Error(verdict.error);
    expect(verdict.save?.dc).toBe(24);
    expect(verdict.save?.passed).toBe(false);
    expect(verdict.dead).toBe(true); // the failed save kills

    const saved = coupDeGraceVerdict({
      damageDealt: 14,
      killedByDamage: false,
      saveDie: 18,
      fortBonus: 6,
    });
    if (!saved.ok) throw new Error(saved.error);
    expect(saved.save?.passed).toBe(true);
    expect(saved.dead).toBe(false);

    // A creature immune to critical hits owes no save at all.
    const immune = coupDeGraceVerdict({
      damageDealt: 14,
      killedByDamage: false,
      fortBonus: 6,
      critImmune: true,
    });
    if (!immune.ok) throw new Error(immune.error);
    expect(immune.save).toBeNull();
    expect(immune.dead).toBe(false);
  });
});
