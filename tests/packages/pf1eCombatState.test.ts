/**
 * PF1e round structure (plan P0.3): surprise, flat-footed-until-your-turn, the attacks-of-opportunity
 * ledger, held actions, and the clock — all as data under `combat.flags.pf1e`, with core still owning
 * `round`/`turn`/initiative and the effect tick. The last test is the one that matters most: wrapping
 * core must not quietly break core.
 */
import { describe, expect, test } from "vitest";
import { activeEffects, currentCombatant } from "../../src/core/combat";
import type {
  CombatDocument,
  CombatantDocument,
  Json,
} from "../../src/core/documents";
import {
  HELD_FULL_ROUND_ALLIES,
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
  startWithSurprise,
  useAttackOfOpportunity,
} from "../../src/packages/pf1e/combatState";
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
      held: null,
    });
    expect(diff["flags.pf1e"]).toEqual({
      aooUsed: 1,
      aooMax: 2,
      acted: true,
      surprised: false,
      held: null,
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
  test("every attacker must beat every defender, or there is no surprise round", () => {
    const all = checkSurprise(["d1", "d2"], {
      stealth: { a1: 17, a2: 16 },
      perception: { d1: 12, d2: 14 },
    });
    expect(all.surpriseRound).toBe(true);
    expect(all.flatFooted).toEqual(["d1", "d2"]);
    const seen = checkSurprise(["d1", "d2"], {
      stealth: { a1: 17, a2: 13 },
      perception: { d1: 12, d2: 14 },
    });
    expect(seen.surpriseRound).toBe(false);
    expect(seen.note).toContain("d2 noticed");
    expect(
      checkSurprise([], { stealth: { a1: 20 }, perception: {} }).surpriseRound,
    ).toBe(false);
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

    const one = pf1eNextTurn(started.combat);
    expect(one.state.phase).toBe("surprise");
    expect(one.state.surpriseTurn).toBe(1);
    expect(one.combat.round).toBe(0);

    const two = pf1eNextTurn(one.combat);
    expect(two.state.phase).toBe("rounds");
    expect(two.combat.round).toBe(1);
    expect(two.hooks).toContain("combat:round:start");
    expect(currentCombatant(two.combat)?._id).toBe("a1");
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
