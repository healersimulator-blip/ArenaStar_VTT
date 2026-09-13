/**
 * PF1e round structure (plan P0.3): surprise, flat-footed-until-your-turn, the attacks-of-opportunity
 * ledger, held actions, and the clock — all as data under `combat.flags.pf1e`, with core still owning
 * `round`/`turn`/initiative and the effect tick. The last test is the one that matters most: wrapping
 * core must not quietly break core.
 */
import { describe, expect, test } from "vitest";
import { activeEffects, currentCombatant } from "../../src/core/combat";
import type {
  ActorDocument,
  CombatDocument,
  CombatantDocument,
  Json,
} from "../../src/core/documents";
import {
  HELD_FULL_ROUND_ALLIES,
  activePF1eCombatant,
  clockRounds,
  combatantStateDiff,
  holdAction,
  initiativeDisplay,
  isFlatFootedByRound,
  minutesElapsed,
  pf1eNextTurn,
  readCombatantState,
  readRoundState,
  resolveInitiative,
  roundStateDiff,
  checkSurprise,
  pf1eEndCombat,
  spendCombatantAction,
  startWithSurprise,
  useAttackOfOpportunity,
} from "../../src/packages/pf1e/combatState";
import { EMPTY_ACTION_LEDGER } from "../../src/packages/pf1e/actions";
import { DEFAULT_SECONDS_PER_ROUND } from "../../src/core/worldSettings";

const combatant = (
  id: string,
  initiative: number | null,
  flags: Record<string, unknown> = {},
): CombatantDocument => ({
  _id: id,
  type: "combatant",
  name: id,
  tokenId: null,
  actorId: null,
  initiative,
  hidden: false,
  defeated: false,
  ownership: { default: 3 },
  flags: flags as CombatantDocument["flags"],
  system: {},
});

const combat = (
  combatants: CombatantDocument[],
  round = 0,
  turn = 0,
  flags: unknown = {},
): CombatDocument => ({
  _id: "combat-1",
  type: "combat",
  name: "Combat 1",
  round,
  turn,
  combatants,
  ownership: { default: 3 },
  flags: flags as CombatDocument["flags"],
  system: {},
});

describe("round state reads", () => {
  test("a combat with no flags.pf1e is a legal setup state", () => {
    const s = readRoundState(combat([combatant("a", 5)]));
    expect(s.phase).toBe("setup");
    expect(s.clockSeconds).toBe(0);
    expect(s.secondsPerRound).toBe(DEFAULT_SECONDS_PER_ROUND);
    expect(s.roundRolled).toBe(false);
  });

  test("half-written state degrades per field rather than throwing", () => {
    const s = readRoundState(
      combat([], 3, 0, {
        pf1e: {
          phase: "nonsense",
          clockSeconds: "lots",
          surpriseOrder: [1, "ok"],
          ties: [{ ids: ["a"] }],
        },
      }),
    );
    expect(s.phase).toBe("rounds"); // round 3 implies rounds
    expect(s.clockSeconds).toBe(0);
    expect(s.surpriseOrder).toEqual(["ok"]);
    expect(s.ties).toEqual([]);
  });

  test("the state round-trips through the flags fragment the submit takes", () => {
    const state = readRoundState(combat([]));
    const diff = combatantStateDiff({
      aooUsed: 1,
      aooMax: 2,
      acted: true,
      surprised: false,
      actions: EMPTY_ACTION_LEDGER,
      held: null,
      ready: null,
    });
    expect(diff["flags.pf1e"]).toEqual({
      aooUsed: 1,
      aooMax: 2,
      acted: true,
      surprised: false,
      actions: EMPTY_ACTION_LEDGER,
      held: null,
      ready: null,
    });
    expect(Object.keys(roundStateDiff(readRoundState(combat([]))))).toEqual([
      "flags.pf1e",
    ]);
    expect(
      readRoundState(combat([], 1, 0, { pf1e: { ...state, clockSeconds: 42 } }))
        .clockSeconds,
    ).toBe(42);
  });
});

describe("initiative (A.1)", () => {
  test("ties break on the highest Dexterity bonus, and the marker keeps the die result visible", () => {
    const r = resolveInitiative([
      { combatantId: "a", value: 12, dexMod: 5 },
      { combatantId: "b", value: 12, dexMod: 2 },
      { combatantId: "c", value: 7, dexMod: 9 },
    ]);
    expect(r.values.a).toBe(12.5);
    expect(r.values.b).toBe(12);
    expect(r.values.c).toBe(7);
    expect(r.needsReroll).toBe(false);
    expect(r.ties[0]?.resolvedBy).toBe("dexterity");
    expect(initiativeDisplay(r.values.a ?? 0)).toBe("12");
    const c = combat(
      [combatant("a", r.values.a ?? 0), combatant("b", 12), combatant("c", 7)],
      1,
    );
    expect(currentCombatant(c)?._id).toBe("a");
  });

  test("equal rolls and equal Dexterity must be rerolled, not ordered arbitrarily", () => {
    const r = resolveInitiative([
      { combatantId: "a", value: 12, dexMod: 3 },
      { combatantId: "b", value: 12, dexMod: 3 },
    ]);
    expect(r.needsReroll).toBe(true);
    expect(r.ties[0]?.resolvedBy).toBe("reroll-needed");
    expect(r.values.a).toBe(12);
    expect(r.values.b).toBe(12);
  });
});

describe("surprise round (A.1)", () => {
  test("mixed awareness is a surprise round: only the unaware stay flat-footed, the aware defender acts (CRB p.178)", () => {
    // d2's Perception 14 matches a2's Stealth 13 — d2 noticed SOMEONE, so d2 is aware
    // and acts in the surprise round; d1 (12) noticed nothing and is flat-footed.
    const mixed = checkSurprise(["d1", "d2"], {
      stealth: { a1: 17, a2: 13 },
      perception: { d1: 12, d2: 14 },
    });
    expect(mixed.surpriseRound).toBe(true);
    expect(mixed.flatFooted).toEqual(["d1"]);
    expect(mixed.aware).toEqual(["a1", "a2", "d2"]);
    expect(mixed.note).toBeNull();
    // every defender noticed someone — no surprise round at all
    const alert = checkSurprise(["d1", "d2"], {
      stealth: { a1: 17, a2: 13 },
      perception: { d1: 18, d2: 14 },
    });
    expect(alert.surpriseRound).toBe(false);
    expect(alert.flatFooted).toEqual([]);
    expect(alert.note).toContain("no surprise round");
    expect(
      checkSurprise([], { stealth: { a1: 20 }, perception: {} }).surpriseRound,
    ).toBe(false);
    // a defender with no Perception authored cannot notice anyone: unaware
    const blind = checkSurprise(["d1"], {
      stealth: { a1: 10 },
      perception: {},
    });
    expect(blind.surpriseRound).toBe(true);
    expect(blind.flatFooted).toEqual(["d1"]);
  });

  test("the surprise round runs before round 1 and only the aware act in it", () => {
    const c = combat([
      combatant("a1", 15),
      combatant("a2", 11),
      combatant("d1", 4),
    ]);
    const started = startWithSurprise(c, {
      initiative: [
        { combatantId: "a1", value: 15, dexMod: 5 },
        { combatantId: "a2", value: 11, dexMod: 3 },
        { combatantId: "d1", value: 4, dexMod: -1 },
      ],
      targets: ["d1"],
      stealth: { a1: 17, a2: 16 },
      perception: { d1: 12 },
    });
    expect(started.surprise?.surpriseRound).toBe(true);
    expect(started.state.phase).toBe("surprise");
    expect(started.state.surpriseOrder).toEqual(["a1", "a2"]);
    expect(started.combat.round).toBe(0); // core has not started the first round yet
    expect(
      isFlatFootedByRound(
        started.combat,
        started.combat.combatants[2] ?? combatant("d1", 4),
      ).why,
    ).toBe("surprise");
    // the first surprise actor's turn has started: acted, restricted budget (A.1/A.6)
    const firstActor = readCombatantState(
      started.combat.combatants[0] ?? combatant("a1", 15),
    );
    expect(firstActor.acted).toBe(true);
    expect(firstActor.actions.restriction).toBe("single-standard-or-move");
    expect(activePF1eCombatant(started.combat)?._id).toBe("a1"); // core's turn pointer is meaningless in the surprise round

    const one = pf1eNextTurn(started.combat);
    expect(one.state.phase).toBe("surprise");
    expect(one.state.surpriseTurn).toBe(1);
    expect(one.combat.round).toBe(0);
    const secondActor = readCombatantState(
      one.combat.combatants.find((x) => x._id === "a2") ?? combatant("a2", 11),
    );
    expect(secondActor.acted).toBe(true);
    expect(secondActor.actions.restriction).toBe("single-standard-or-move");

    const two = pf1eNextTurn(one.combat);
    expect(two.state.phase).toBe("rounds");
    expect(two.combat.round).toBe(1);
    expect(two.hooks).toContain("combat:round:start");
    expect(currentCombatant(two.combat)?._id).toBe("a1");
    expect(activePF1eCombatant(two.combat)?._id).toBe("a1");
    // regular rounds lift the surprise restriction for everyone whose turn starts
    const a1 = readCombatantState(
      two.combat.combatants.find((x) => x._id === "a1") ?? combatant("a1", 15),
    );
    expect(a1.actions.restriction).toBe("none");
    expect(a1.acted).toBe(true);
  });

  test("without stealth data combat starts normally and the first actor is no longer flat-footed", () => {
    const c = combat([combatant("a", 8), combatant("b", 5)]);
    const started = startWithSurprise(c, {
      initiative: [
        { combatantId: "a", value: 8, dexMod: 1 },
        { combatantId: "b", value: 5, dexMod: 0 },
      ],
    });
    expect(started.state.phase).toBe("rounds");
    expect(started.combat.round).toBe(1);
    expect(
      isFlatFootedByRound(
        started.combat,
        started.combat.combatants[0] ?? c.combatants[0] ?? combatant("x", 0),
      ).flatFooted,
    ).toBe(false);
    expect(
      readCombatantState(started.combat.combatants[0] ?? combatant("a", 8))
        .acted,
    ).toBe(true);
    expect(
      readCombatantState(started.combat.combatants[1] ?? combatant("b", 5))
        .acted,
    ).toBe(false);
  });
});

describe("attacks of opportunity ledger (A.10)", () => {
  test("spending is tracked and refused at the budget", () => {
    const c = combatant("a", 10);
    const one = useAttackOfOpportunity(c, 2);
    expect(one.ok).toBe(true);
    if (!one.ok) return;
    expect(one.value.used).toBe(1);
    expect(one.value.left).toBe(1);
    const two = useAttackOfOpportunity(one.value.combatant, 2, {
      reason: "total defense",
    });
    expect(two.ok && two.value.left).toBe(0);
    const three = useAttackOfOpportunity(
      two.ok ? two.value.combatant : one.value.combatant,
      2,
    );
    expect(!three.ok && three.error).toContain(
      "no attacks of opportunity left",
    );
    expect(readCombatantState(one.value.combatant).aooUsed).toBe(1);
  });

  test("the budget comes back at the start of the combatant's own turn, and not before", () => {
    const first = useAttackOfOpportunity(combatant("a", 10), 2);
    if (!first.ok) throw new Error("setup");
    const second = useAttackOfOpportunity(first.value.combatant, 2);
    if (!second.ok) throw new Error("setup");
    expect(second.value.left).toBe(0);
    const c = combat([second.value.combatant, combatant("b", 5)], 1, 0);
    const toB = pf1eNextTurn(c);
    // It is b's turn now: a's exhausted ledger must survive untouched.
    expect(currentCombatant(toB.combat)?._id).toBe("b");
    expect(
      readCombatantState(toB.combat.combatants[0] ?? combatant("a", 10))
        .aooUsed,
    ).toBe(2);
    const backToA = pf1eNextTurn(toB.combat);
    expect(currentCombatant(backToA.combat)?._id).toBe("a");
    expect(
      readCombatantState(backToA.combat.combatants[0] ?? combatant("a", 10))
        .aooUsed,
    ).toBe(0);
    expect(backToA.aooRefreshed).toEqual(["a"]);
  });
});

describe("held actions (A.10 hold the charge)", () => {
  test("a hold is delivered at the round boundary, costing a full round past six allies", () => {
    const holder = holdAction(combatant("a", 10), "charge", 1);
    const others = Array.from({ length: HELD_FULL_ROUND_ALLIES }, (_, i) =>
      combatant(`n${i}`, 5 - i),
    );
    let c = combat([holder, ...others], 1, 0);
    let delivered: Array<{ kind: string; fullRound: boolean }> = [];
    for (let i = 0; i < HELD_FULL_ROUND_ALLIES; i += 1) {
      const step = pf1eNextTurn(c);
      c = step.combat;
      delivered = step.heldDelivered;
    }
    // Six other combatants have acted, so the next boundary reports the full-round cost.
    const closing = pf1eNextTurn(c);
    expect(closing.combat.round).toBe(2);
    expect(closing.heldDelivered[0]?.combatantId).toBe("a");
    expect(closing.heldDelivered[0]?.kind).toBe("charge");
    expect(closing.heldDelivered[0]?.fullRound).toBe(true);
    expect(delivered).toEqual([]);
    expect(
      readCombatantState(closing.combat.combatants[0] ?? holder).held,
    ).toBeNull();
  });

  test("with a short queue the hold is simply delivered", () => {
    const holder = holdAction(combatant("a", 10), "spell", 1);
    const c = combat([holder, combatant("b", 5)], 1, 0);
    const toB = pf1eNextTurn(c);
    expect(toB.heldDelivered).toEqual([]);
    const backToA = pf1eNextTurn(toB.combat);
    expect(backToA.heldDelivered[0]).toMatchObject({
      combatantId: "a",
      kind: "spell",
      fullRound: false,
    });
  });
});

describe("world clock", () => {
  test("a wrapped round advances the clock by the world's seconds per round", () => {
    const c = combat([combatant("a", 10), combatant("b", 5)], 1, 1, {
      pf1e: { clockSeconds: 100, secondsPerRound: 10, phase: "rounds" },
    });
    const step = pf1eNextTurn(c);
    expect(step.clockDeltaSeconds).toBe(10);
    expect(step.state.clockSeconds).toBe(110);
    expect(
      clockRounds({ ...step.state, clockSeconds: 110, secondsPerRound: 10 }),
    ).toBe(11);
    expect(
      minutesElapsed({ ...step.state, clockSeconds: 120, secondsPerRound: 10 }),
    ).toBe(2);
  });

  test("mid-round turns spend no clock time, and the option can opt out entirely", () => {
    const mid = combat([combatant("a", 10), combatant("b", 5)], 1, 0, {
      pf1e: { clockSeconds: 42 },
    });
    expect(pf1eNextTurn(mid).clockDeltaSeconds).toBe(0);
    const wrapped = combat([combatant("a", 10), combatant("b", 5)], 1, 1, {
      pf1e: { clockSeconds: 42 },
    });
    expect(
      pf1eNextTurn(wrapped, { advanceClock: false }).clockDeltaSeconds,
    ).toBe(0);
  });
});

describe("core's effect ticking still runs through the wrapper", () => {
  test("flags.core.duration decreases on the owner's turn end, and the PF1e payload is untouched", () => {
    const withEffect = combatant("a", 10, {
      core: {
        effects: {
          bull: {
            type: "effect",
            name: "Bull's Strength",
            disabled: false,
            ownership: { default: 3 },
            system: {},
            flags: {
              core: { duration: 3 },
              pf1e: {
                mods: [{ key: "ability.str", type: "enhancement", value: 2 }],
              },
            },
          } as unknown as Json,
        },
      },
    });
    const c = combat([withEffect, combatant("b", 5)], 1, 0);
    const step = pf1eNextTurn(c);
    const effects = (
      step.combat.combatants[0]?.flags as {
        core: {
          effects: Record<string, { flags: { core: { duration: number } } }>;
        };
      }
    ).core.effects;
    const embedded = effects["bull"];
    if (!embedded) throw new Error("setup: the effect vanished");
    expect(embedded.flags.core.duration).toBe(2);
    // The PF1e side is data, not a second timer: it must survive core's rewrite untouched.
    const pf1eFlags = embedded.flags as unknown as {
      pf1e?: { mods?: unknown[] };
    };
    expect(pf1eFlags.pf1e?.mods).toHaveLength(1);
    expect(activeEffects(step.combat).map((e) => e.duration)).toEqual([2]);

    // Only a's own turn ends spend a tick, and with two combatants that is every other transition:
    // 2 → 1 at a's next turn end, then expiry on the one after. The caller is told, not left to poll.
    let cur = step.combat;
    let expiredHere: Array<{ combatantId: string; effectId: string }> = [];
    for (let i = 0; i < 5; i += 1) {
      const t = pf1eNextTurn(cur);
      cur = t.combat;
      expiredHere = t.expired;
      if (expiredHere.length > 0) break;
    }
    expect(expiredHere).toEqual([{ combatantId: "a", effectId: "bull" }]);
    const after = cur.combatants[0];
    if (!after) throw new Error("setup");
    expect(activeEffects(cur)).toEqual([]);
  });
});

/** Narrow an applied combat mutation; refused spends fail the test with their reason. */
function applied(
  result: { ok: true; value: CombatDocument } | { ok: false; error: string },
): CombatDocument {
  if (!result.ok) throw new Error(result.error);
  return result.value;
}

describe("action budget wiring (T05, CRB p.181)", () => {
  test("the active combatant's budget resets at the start of their turn, reservation included", () => {
    const c = combat([combatant("a", 15), combatant("b", 10)], 1, 0, {
      pf1e: { v: 1, phase: "rounds" },
    });
    // b spends its standard now (out of turn, e.g. bookkeeping ahead of time)…
    const spentStd = spendCombatantAction(c, "b", { kind: "standard" });
    expect(spentStd.ok).toBe(true);
    // …and used an immediate action off-turn, reserving next turn's swift.
    const withImmediate = applied(
      spendCombatantAction(applied(spentStd), "b", {
        kind: "immediate",
        onTurn: false,
      }),
    );
    // a's turn ends: b's turn STARTS, so the budget resets — the off-turn standard is
    // gone and the reservation converted into "swift already used".
    const one = pf1eNextTurn(withImmediate);
    expect(currentCombatant(one.combat)?._id).toBe("b");
    const b = one.combat.combatants.find((x) => x._id === "b");
    const after = readCombatantState(b ?? combatant("b", 10)).actions;
    expect(after.standardUsed).toBe(false);
    expect(after.swiftReserved).toBe(false);
    expect(after.swiftUsed).toBe(true);
    // And a later advance does not disturb b's ledger again.
    const two = pf1eNextTurn(one.combat);
    const bLater = two.combat.combatants.find((x) => x._id === "b");
    expect(readCombatantState(bLater ?? combatant("b", 10)).actions).toEqual(
      after,
    );
  });

  test("a pending full-round action survives the turn boundary to be completed", () => {
    const c = combat([combatant("a", 15), combatant("b", 10)], 1, 0, {
      pf1e: { v: 1, phase: "rounds" },
    });
    const started = applied(
      spendCombatantAction(c, "a", {
        kind: "start-full-round",
        action: "cast-spell",
      }),
    );
    const back = spendCombatantAction(started, "a", {
      kind: "complete-full-round",
    });
    expect(back.ok).toBe(false); // the starting standard is spent this turn
    // two advances: b's turn, then the round wraps back to a's fresh turn
    const next = pf1eNextTurn(pf1eNextTurn(started).combat);
    expect(currentCombatant(next.combat)?._id).toBe("a");
    const aNext = next.combat.combatants.find((x) => x._id === "a");
    const ledger = readCombatantState(aNext ?? combatant("a", 15)).actions;
    expect(ledger.fullRoundPending).toBe("cast-spell");
    expect(ledger.standardUsed).toBe(false); // fresh standard for the completion
    const done = spendCombatantAction(next.combat, "a", {
      kind: "complete-full-round",
    });
    expect(done.ok).toBe(true);
  });

  test("spendCombatantAction refuses unknown combatants and refused spends, mutating nothing", () => {
    const c = combat([combatant("a", 15)], 1, 0, {
      pf1e: { v: 1, phase: "rounds" },
    });
    const before = structuredClone(c);
    expect(spendCombatantAction(c, "nope", { kind: "swift" }).ok).toBe(false);
    const twice = spendCombatantAction(
      applied(spendCombatantAction(c, "a", { kind: "swift" })),
      "a",
      { kind: "swift" },
    );
    expect(twice.ok).toBe(false);
    if (!twice.ok) expect(twice.error).toContain("swift action already used");
    expect(c).toEqual(before); // refusals and misses never write
  });

  test("combat started through startWithSurprise gives the first actor a fresh ledger", () => {
    const dirty = combatant("a", 0, {
      pf1e: {
        aooUsed: 1,
        aooMax: 1,
        acted: false,
        surprised: false,
        actions: {
          standardUsed: true,
          moveUsed: true,
          swiftUsed: true,
          swiftReserved: true,
          fiveFootStepUsed: true,
          movementFt: 30,
          fullRoundPending: "cast-spell",
          restriction: "single-standard-or-move",
        },
      },
    });
    const started = startWithSurprise(combat([dirty, combatant("b", 5)]), {
      initiative: [
        { combatantId: "a", value: 15, dexMod: 2 },
        { combatantId: "b", value: 5, dexMod: 0 },
      ],
    });
    const a = started.combat.combatants.find((x) => x._id === "a");
    expect(readCombatantState(a ?? dirty).acted).toBe(true);
    // Everything resets — except the pending full-round action, which by rule survives
    // to be completed with this turn's standard action (CRB p.185).
    expect(readCombatantState(a ?? dirty).actions).toEqual({
      ...EMPTY_ACTION_LEDGER,
      fullRoundPending: "cast-spell",
      swiftUsed: true, // the dirty swiftReserved converted per CRB p.183
    });
  });

  test("after the surprise round, the first regular actor is no longer flat-footed", () => {
    const c = combat([
      combatant("a1", 15),
      combatant("a2", 11),
      combatant("d1", 4),
    ]);
    const started = startWithSurprise(c, {
      initiative: [
        { combatantId: "a1", value: 15, dexMod: 5 },
        { combatantId: "a2", value: 11, dexMod: 3 },
        { combatantId: "d1", value: 4, dexMod: -1 },
      ],
      targets: ["d1"],
      stealth: { a1: 17, a2: 16 },
      perception: { d1: 12 },
    });
    expect(started.state.phase).toBe("surprise");
    const two = pf1eNextTurn(pf1eNextTurn(started.combat).combat);
    expect(two.state.phase).toBe("rounds");
    const a1 = two.combat.combatants.find((x) => x._id === "a1");
    // a1's own first regular turn is starting — that IS the flat-footed transition.
    expect(readCombatantState(a1 ?? combatant("a1", 15)).acted).toBe(true);
    expect(
      isFlatFootedByRound(two.combat, a1 ?? combatant("a1", 15)).flatFooted,
    ).toBe(false);
    expect(readCombatantState(a1 ?? combatant("a1", 15)).actions).toEqual(
      EMPTY_ACTION_LEDGER,
    );
  });
});

describe("explicit awareness and encounter end (T03, A.1)", () => {
  const twoVTwo = () =>
    combat([
      combatant("a1", 15),
      combatant("a2", 11),
      combatant("d1", 12),
      combatant("d2", 6),
    ]);

  test("GM awareness marks drive the surprise round; the aware defender acts too", () => {
    const started = startWithSurprise(twoVTwo(), {
      initiative: [
        { combatantId: "a1", value: 15, dexMod: 2 },
        { combatantId: "a2", value: 11, dexMod: 1 },
        { combatantId: "d1", value: 12, dexMod: 0 },
        { combatantId: "d2", value: 6, dexMod: 0 },
      ],
      unaware: ["d2"],
    });
    expect(started.surprise?.surpriseRound).toBe(true);
    // d1 is aware (not marked) — defenders who noticed act in the surprise round
    expect(started.state.surpriseOrder).toEqual(["a1", "d1", "a2"]);
    expect(started.state.surprised).toEqual(["d2"]);
    expect(
      readCombatantState(
        started.combat.combatants.find((x) => x._id === "d2") ??
          combatant("d2", 6),
      ).surprised,
    ).toBe(true);
    // unknown ids in the marks are ignored, not invented combatants
    expect(started.surprise?.aware).not.toContain("ghost");
  });

  test("no surprise round when the marks make everyone aware or everyone unaware", () => {
    const all = startWithSurprise(twoVTwo(), {
      initiative: [],
      unaware: ["d1", "d2", "a1", "a2"],
    });
    expect(all.surprise?.surpriseRound).toBe(false);
    expect(all.surprise?.note).toContain("no combatant is aware");
    expect(all.state.phase).toBe("rounds"); // starts normally through core
    const none = startWithSurprise(twoVTwo(), {
      initiative: [],
      unaware: ["ghost"], // resolves to "no one is unaware"
    });
    expect(none.surprise?.surpriseRound).toBe(false);
    expect(none.surprise?.note).toContain("no combatant is unaware");
  });

  test("pf1eEndCombat resets the round structure for a clean restart", () => {
    const started = startWithSurprise(twoVTwo(), {
      initiative: [],
      unaware: ["d2"],
    });
    const inProgress = pf1eNextTurn(started.combat); // surprise advances
    expect(inProgress.state.phase).toBe("surprise");
    const ended = pf1eEndCombat(inProgress.combat);
    expect(ended.combat.round).toBe(0);
    expect(ended.combat.turn).toBe(0);
    expect(ended.state.phase).toBe("setup");
    expect(ended.state.surpriseOrder).toEqual([]);
    expect(ended.state.surprised).toEqual([]);
    expect(ended.state.clockSeconds).toBe(0);
    expect(readRoundState(ended.combat).phase).toBe("setup");
  });
});

describe("P7/H01/D-204 — the dying round's stabilization obligation", () => {
  const dyingActor = (
    hp: number,
    conditions: string[] = [],
  ): ActorDocument => ({
    _id: "hero",
    type: "actor",
    name: "Hero",
    ownership: { default: 3 },
    flags: {},
    items: [],
    effects: [],
    system: {
      pf1e: {
        abilities: { str: 14, dex: 14, con: 14 },
        hp,
        hpMax: 20,
        ...(conditions.length > 0 ? { conditions } : {}),
      },
    },
  });
  const heroCombatant = (): CombatantDocument => ({
    ...combatant("hero-c", 5),
    actorId: "hero",
  });
  const roundsCombat = (): CombatDocument =>
    combat([combatant("foe", 10), heroCombatant()], 1, 0);

  test("a dying creature whose turn starts owes the Constitution check", () => {
    const next = pf1eNextTurn(roundsCombat(), {
      actors: [dyingActor(-3)],
    });
    expect(next.dyingChecks).toEqual([
      {
        combatantId: "hero-c",
        actorId: "hero",
        actorName: "Hero",
        hp: -3,
        conMod: 2,
      },
    ]);
  });

  test("stable, dead, disabled and unlinked creatures owe nothing", () => {
    expect(
      pf1eNextTurn(roundsCombat(), {
        actors: [dyingActor(-3, ["Stable"])],
      }).dyingChecks,
    ).toEqual([]);
    expect(
      pf1eNextTurn(roundsCombat(), { actors: [dyingActor(-14)] })
        .dyingChecks,
    ).toEqual([]);
    expect(
      pf1eNextTurn(roundsCombat(), { actors: [dyingActor(0)] }).dyingChecks,
    ).toEqual([]);
    // No actor documents passed ⇒ no checks reported, exactly as documented.
    expect(pf1eNextTurn(roundsCombat()).dyingChecks).toEqual([]);
    // A combatant with no actor link cannot owe a check.
    const unlinked = combat([combatant("foe", 10), combatant("hero-c", 5)], 1, 0);
    expect(
      pf1eNextTurn(unlinked, { actors: [dyingActor(-3)] }).dyingChecks,
    ).toEqual([]);
  });
});
