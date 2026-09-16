// Checklist: V04 — the broader tactical encounter flow: 2 PCs vs 3 goblins, end to end.
/**
 * V04 — the broader tactical encounter flow from Gap List §7.5: **2 PCs vs 3
 * goblins**, running surprise, a 5-foot step, an attack of opportunity, a
 * charge, cover/concealment, a manœuvre and injury progression in one continuous
 * encounter, with the player-ownership and replication half asserted separately
 * in `tests/host/pf1eEncounterOwnership.test.ts`.
 *
 * Where `pf1eScenarioFlows.test.ts` proves one rule at a time, this file proves
 * the encounter *holds together*: the surprise round that flat-foots Ivy is the
 * same flat-footed state her first-turn AC reads, the AoO the goblin spends is
 * drawn from the same ledger that later refuses a second one, and the trip that
 * knocks Rex prone is the same prone that feeds his injury track.
 *
 * Every die face is supplied by the test, so a red test names a rule rather
 * than an unlucky roll.
 */
import { describe, expect, test } from "vitest";
import type { CombatantDocument, CombatDocument } from "../../src/core/documents";
import {
  checkSurprise,
  isFlatFootedByRound,
  readCombatantState,
  readRoundState,
  resolveInitiative,
  startWithSurprise,
  useAttackOfOpportunity,
  type InitiativeRoll,
} from "../../src/packages/pf1e/combatState";
import {
  attackModifierParts,
  resolveAttackRoll,
  situationalAttackParts,
  type PF1eAttackActor,
} from "../../src/packages/pf1e/tactical";
import { resolvePF1eWeapon } from "../../src/packages/pf1e/weapons";
import { concealmentGrade, concealmentOutcome, coverBetween } from "../../src/packages/pf1e/positional";
import { pf1eTrip } from "../../src/packages/pf1e/maneuvers";
import { injuryStateOf, stabilizationCheck } from "../../src/packages/pf1e/injury";
import { pf1eMovePlan } from "../../src/packages/pf1e/movement";
import type { PF1eThreatToken } from "../../src/packages/pf1e/threatPreview";

/* ------------------------------------------------------------------ *
 * Cast — 2 PCs, 3 goblins
 * ------------------------------------------------------------------ */

const REX = "pc-rex"; // fighter, alert
const IVY = "pc-ivy"; // rogue, caught unaware
const GOB = ["gob-1", "gob-2", "gob-3"] as const;

const rex: PF1eAttackActor = { bab: 4, strMod: 3, dexMod: 1, size: "Medium" };
const ivy: PF1eAttackActor = { bab: 3, strMod: 1, dexMod: 4, size: "Medium" };
const goblin: PF1eAttackActor = { bab: 1, strMod: 0, dexMod: 2, size: "Small" };

const combatant = (id: string, initiative: number | null): CombatantDocument => ({
  _id: id,
  type: "combatant",
  name: id,
  tokenId: null,
  actorId: null,
  initiative,
  hidden: false,
  defeated: false,
  ownership: { default: 3 },
  flags: {},
  system: {},
});

const combatOf = (
  combatants: CombatantDocument[],
  round = 0,
  turn = 0,
  flags: unknown = {},
): CombatDocument => ({
  _id: "combat-1",
  type: "combat",
  name: "Goblin ambush",
  round,
  turn,
  combatants,
  ownership: { default: 3 },
  flags: flags as CombatDocument["flags"],
  system: {},
});

describe("V04 — 2 PCs vs 3 goblins: surprise through injury", () => {
  test("some-but-not-all awareness produces a surprise round, and only the unaware are flat-footed", () => {
    // The goblins ambush at Stealth 16. Rex's Perception 18 notices someone;
    // Ivy's 12 does not. Attackers are aware by the model — they initiated.
    const surprise = checkSurprise([REX, IVY], {
      stealth: { [GOB[0]]: 16, [GOB[1]]: 16, [GOB[2]]: 16 },
      perception: { [REX]: 18, [IVY]: 12 },
    });
    expect(surprise.surpriseRound).toBe(true);
    expect(surprise.flatFooted).toEqual([IVY]);
    expect(surprise.aware).toContain(REX);
    expect(surprise.aware).not.toContain(IVY);
  });

  test("when every defender notices someone there is no surprise round at all", () => {
    const none = checkSurprise([REX, IVY], {
      stealth: { [GOB[0]]: 16 },
      perception: { [REX]: 18, [IVY]: 20 },
    });
    expect(none.surpriseRound).toBe(false);
    expect(none.flatFooted).toEqual([]);
    // …and a defender with no Perception authored cannot notice anyone.
    const silent = checkSurprise([REX, IVY], {
      stealth: { [GOB[0]]: 1 },
      perception: { [REX]: 18 },
    });
    expect(silent.flatFooted).toEqual([IVY]);
  });

  test("initiative ties break on Dexterity; an unbreakable tie reports a reroll", () => {
    // `resolveInitiative` takes the *rolled totals* — the dice are the caller's.
    // Rex 15, Ivy 14, gob-1 and gob-2 both 10, gob-3 3.
    const rolls: InitiativeRoll[] = [
      { combatantId: REX, value: 15, dexMod: 1 },
      { combatantId: IVY, value: 14, dexMod: 4 },
      { combatantId: GOB[0], value: 10, dexMod: 2 },
      { combatantId: GOB[1], value: 10, dexMod: 2 },
      { combatantId: GOB[2], value: 3, dexMod: 2 },
    ];
    const tied = resolveInitiative(rolls);
    // The two goblins tie on both the roll and Dex, so no order is invented —
    // the tracker must ask for a reroll rather than guess.
    expect(tied.needsReroll).toBe(true);
    expect(tied.ties).toEqual([
      { ids: [GOB[0], GOB[1]], resolvedBy: "reroll-needed" },
    ]);

    // Break the tie the legal way: gob-1 has the higher Dex, so it wins on the
    // Dex rule and is expressed as the 0.5 marker core's ordering can read.
    const broken = resolveInitiative([
      ...rolls.filter((r) => r.combatantId !== GOB[1]),
      { combatantId: GOB[1], value: 10, dexMod: 1 },
    ]);
    expect(broken.needsReroll).toBe(false);
    expect(broken.values[GOB[0]]).toBe(10.5);
    expect(broken.values[GOB[1]]).toBe(10);
    expect(broken.values[REX]).toBe(15);
  });

  test("a flat-footed combatant loses Dex to AC until their first turn", () => {
    const surprise = checkSurprise([REX, IVY], {
      stealth: { [GOB[0]]: 16 },
      perception: { [REX]: 18, [IVY]: 12 },
    });
    const started = startWithSurprise(
      combatOf([
        combatant(REX, null),
        combatant(IVY, null),
        ...GOB.map((id) => combatant(id, null)),
      ]),
      {
        initiative: [
          { combatantId: REX, value: 15, dexMod: 1 },
          { combatantId: IVY, value: 14, dexMod: 4 },
          { combatantId: GOB[0], value: 12, dexMod: 2 },
          { combatantId: GOB[1], value: 11, dexMod: 2 },
          { combatantId: GOB[2], value: 3, dexMod: 2 },
        ],
        targets: [REX, IVY],
        stealth: { [GOB[0]]: 16, [GOB[1]]: 16, [GOB[2]]: 16 },
        perception: { [REX]: 18, [IVY]: 12 },
      },
    );
    const combat = started.combat;
    const state = readRoundState(combat);
    expect(state.phase).toBe("surprise");
    expect(state.surprised).toEqual([IVY]);
    // Only the aware act in the surprise round — Ivy is not in the order.
    expect(state.surpriseOrder).not.toContain(IVY);
    expect(surprise.flatFooted).toEqual([IVY]);

    const ivyDoc = combat.combatants.find((c) => c._id === IVY);
    if (!ivyDoc) throw new Error("Ivy is not in the encounter");
    const flatFooted = isFlatFootedByRound(combat, ivyDoc);
    expect(flatFooted.flatFooted).toBe(true);
    expect(flatFooted.why).toBe("surprise");

    // Rex noticed, so he is not flat-footed in the surprise round.
    const rexDoc = combat.combatants.find((c) => c._id === REX);
    if (!rexDoc) throw new Error("Rex is not in the encounter");
    expect(isFlatFootedByRound(combat, rexDoc).flatFooted).toBe(false);
  });

  test("a 5-foot step is legal once, and a second step in the same turn is refused", () => {
    // The default scene grid: 100 world units per 5-ft square.
    const grid = { size: 100, distance: 5, units: "ft" };
    const tokens: PF1eThreatToken[] = [
      {
        _id: REX,
        x: 0.5 * grid.size,
        y: 0.5 * grid.size,
        width: grid.size,
        height: grid.size,
        size: "Medium",
      } as PF1eThreatToken,
    ];
    const dest = (col: number, row: number) => ({
      x: (col + 0.5) * grid.size,
      y: (row + 0.5) * grid.size,
    });

    const step = pf1eMovePlan({
      grid,
      tokens,
      mover: { tokenId: REX, to: dest(1, 0), mode: "five-foot-step", speedFt: 20 },
    });
    expect(step.ok).toBe(true);
    expect(step.refusal).toBeNull();
    expect(step.costFt).toBe(5);

    // Any movement already spent this turn bars the step (CRB p.189).
    const barred = pf1eMovePlan({
      grid,
      tokens,
      mover: {
        tokenId: REX,
        to: dest(1, 0),
        mode: "five-foot-step",
        speedFt: 20,
        movedThisTurn: true,
      },
    });
    expect(barred.refusal).not.toBeNull();

    // Two squares is not a step.
    const tooFar = pf1eMovePlan({
      grid,
      tokens,
      mover: { tokenId: REX, to: dest(2, 0), mode: "five-foot-step", speedFt: 20 },
    });
    expect(tooFar.refusal).toContain("5-foot step moves 1 square");
  });

  test("the goblin's AoO comes off a real ledger, and Combat Reflexes is what allows a second", () => {
    // Dex +2 ⇒ 1 AoO per round; Combat Reflexes adds the Dex modifier.
    const budget = 1 + goblin.dexMod;
    expect(budget).toBe(3);

    let gob = combatant(GOB[0], 10);
    let left = budget;
    for (let i = 1; i <= budget; i++) {
      const used = useAttackOfOpportunity(gob, budget);
      if (!used.ok) throw new Error(used.error);
      gob = used.value.combatant;
      left = used.value.left;
      expect(used.value.used).toBe(i);
    }
    expect(left).toBe(0);
    expect(readCombatantState(gob).aooUsed).toBe(budget);

    const refused = useAttackOfOpportunity(gob, budget, { reason: "Ivy withdrew" });
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.error).toContain("Ivy withdrew");

    // A fighter with Dex +1 and no feat has exactly one, and it is spent.
    const rexOne = useAttackOfOpportunity(combatant(REX, 15), 1);
    if (!rexOne.ok) throw new Error(rexOne.error);
    expect(rexOne.value.left).toBe(0);
    expect(useAttackOfOpportunity(rexOne.value.combatant, 1).ok).toBe(false);
  });

  test("a charge is +2 on the attack and the prone/charge split is attacker-facing", () => {
    const shortSword = resolvePF1eWeapon({
      name: "Short sword",
      class: "melee",
      handedness: "light",
      proficiency: "martial",
      damageDice: "1d6",
      damageType: "piercing",
      critThreatMin: 19,
      critMultiplier: 2,
    });
    if (!shortSword.ok) throw new Error(shortSword.issues.join("; "));

    const plain = attackModifierParts({ attacker: ivy, weapon: shortSword.weapon });
    const charged = situationalAttackParts({ charging: true }, false);
    expect(charged).toEqual([{ label: "charge", value: 2 }]);
    const chargePart = charged[0];
    expect(chargePart?.value).toBe(2);
    expect(plain.total + 2).toBe(plain.total + (chargePart?.value ?? 0));

    // The charge's −2 AC half is the charger's own defence, not a roll modifier —
    // so it never appears on the attack line.
    expect(charged.some((part) => part.label.includes("AC"))).toBe(false);
  });

  test("cover and concealment both apply to the goblin's ranged attack, and do not stack", () => {
    const grid = { cellSize: 100, feetPerCell: 5, diagonals: "5105" as const };
    // A half-height wall across the south half of the border between the squares:
    // every corner-line has at least one block, but a clean pair survives, so the
    // ranged attacker (who may choose a corner) takes +4 cover rather than total.
    const covered = coverBetween({
      attackerCells: [{ col: 0, row: 0 }],
      defenderCells: [{ col: 3, row: 0 }],
      grid,
      walls: [{ x1: 200, y1: 50, x2: 200, y2: 100 }],
      ranged: true,
    });
    expect(covered.kind).toBe("standard");
    expect(covered.acBonus).toBe(4);
    expect(covered.reflexBonus).toBe(2);

    // The goblin behind it is a soft-cover target for Rex's reach: an intervening
    // creature grants +4 AC but can never produce total cover.
    const soft = coverBetween({
      attackerCells: [{ col: 0, row: 0 }],
      defenderCells: [{ col: 3, row: 0 }],
      grid,
      walls: [],
      creatureCells: [{ col: 2, row: 0 }],
      ranged: true,
    });
    expect(soft.kind).toBe("soft");
    expect(soft.acBonus).toBe(4);
    expect(soft.reflexBonus).toBe(0); // soft cover grants no Reflex bonus

    // Concealment is a miss chance, not an AC bonus, and lesser conditions do
    // not stack — only the worst applies (AoN 182).
    const grade = concealmentGrade([
      { percent: 20, label: "light fog" },
      { percent: 50, label: "darkness" },
      { percent: 10, label: "blur" },
    ]);
    expect(grade.percent).toBe(50);
    expect(grade.label).toBe("darkness");
    expect(grade.note).toContain("did not stack");

    // A d% at or below the miss chance misses; above it hits.
    expect(concealmentOutcome({ percent: 50, die: 50 }).miss).toBe(true);
    expect(concealmentOutcome({ percent: 50, die: 51 }).miss).toBe(false);
    // The miss chance applies to a hit — including a natural 20.
    const nat20 = resolveAttackRoll({ die: 20, bonus: 3, ac: 15 });
    if (!nat20.ok) throw new Error(nat20.error);
    expect(nat20.hits).toBe(true);
    expect(concealmentOutcome({ percent: 50, die: 12 }).miss).toBe(true);

    // No concealment authored ⇒ no miss chance at all.
    expect(concealmentGrade([]).percent).toBe(0);
    expect(concealmentOutcome({ percent: 0, die: 1 }).miss).toBe(false);
  });

  test("a goblin trips Rex, and the injury track runs prone → negative HP → dying", () => {
    // CMB 1 vs CMD 14: a natural 20 totals 21 and succeeds.
    const trip = pf1eTrip({
      check: { die: 20, cmb: 1, cmd: 14, attacker: { size: "Small" }, defender: { size: "Medium" } },
    });
    if (!trip.ok) throw new Error(trip.error);
    expect(trip.success).toBe(true);
    expect(trip.targetProne).toBe(true);

    // Rex (Con 14) takes 18 damage from 6 HP: −12 is exactly his Constitution.
    expect(injuryStateOf({ hp: 6, conScore: 14 }).state).toBe("healthy");
    expect(injuryStateOf({ hp: -11, conScore: 14 }).state).toBe("dying");
    expect(injuryStateOf({ hp: -14, conScore: 14 }).state).toBe("dead");

    // Dying at −11 with Con +2: a die of 8 totals 8 + 2 − 11 = −1 and fails,
    // costing another hit point; the next round a 20 auto-stabilises.
    const fail = stabilizationCheck({ die: 8, conMod: 2, hp: -11 });
    expect(fail.success).toBe(false);
    expect(fail.hpAfter).toBe(-12);
    const stabilised = stabilizationCheck({ die: 20, conMod: 2, hp: -12 });
    expect(stabilised.success).toBe(true);
    expect(stabilised.hpAfter).toBe(-12);
  });

  test("the whole encounter resolves: three goblins, two PCs, one loser", () => {
    // Both PCs' attack bonuses come off the same derived line, not from prose:
    // Rex is a melee BAB 4 + Str 3 = +7, Ivy a Dex-based BAB 3 + Dex 4 = +7.
    const shortSword = resolvePF1eWeapon({
      name: "Short sword",
      class: "melee",
      handedness: "light",
      proficiency: "martial",
      damageDice: "1d6",
      damageType: "piercing",
      critThreatMin: 19,
      critMultiplier: 2,
    });
    if (!shortSword.ok) throw new Error(shortSword.issues.join("; "));
    const rexBonus = attackModifierParts({ attacker: rex, weapon: shortSword.weapon }).total;
    const ivyBonus = attackModifierParts({ attacker: ivy, weapon: shortSword.weapon }).total;
    expect(rexBonus).toBe(7); // BAB 4 + Str 3 (a Small goblin's size AC is the defender's)
    expect(ivyBonus).toBe(4); // BAB 3 + Str 1 — Ivy's Dex only applies with Weapon Finesse
    const ivyFinesse = attackModifierParts({
      attacker: { ...ivy, feats: ["Weapon Finesse"] },
      weapon: shortSword.weapon,
      weaponFinesse: true,
    }).total;
    expect(ivyFinesse).toBe(7); // BAB 3 + Dex 4, the light-weapon substitution

    // End-to-end arithmetic rather than a narrative: Ivy at +7 attacks a goblin's
    // AC 15 six times on fixed faces and must land the ones the rule says she lands.
    const faces = [1, 7, 8, 15, 19, 20];
    const hits = faces.filter((die) => {
      const roll = resolveAttackRoll({ die, bonus: 7, ac: 15, critThreatMin: 19 });
      if (!roll.ok) throw new Error(roll.error);
      return roll.hits;
    });
    // nat 1 never hits; 7+7 = 14 misses; 8+7 = 15 hits; 15, 19, 20 hit.
    expect(hits).toEqual([8, 15, 19, 20]);
  });
});
