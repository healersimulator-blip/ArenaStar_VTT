/**
 * P07/D-193 — delay & ready as pure transitions (G §4.11, I P2/P6). Fixtures mirror
 * `pf1eCombatState.test.ts`: combatants sorted by initiative (desc), core's `turn` indexing the
 * sorted order, and every refusal asserted by its exact reason so the UI shows rule-language,
 * never a generic error. The last block proves the exploit the checklist names cannot happen: a
 * delayer or a readied combatant is never revisited in the round it left.
 */
import { describe, expect, test } from "vitest";
import {
  currentCombatant,
  nextTurn,
  sortCombatants,
} from "../../src/core/combat";
import type {
  CombatDocument,
  CombatantDocument,
  Json,
} from "../../src/core/documents";
import {
  delayTo,
  findReadied,
  readyCombatant,
  readyIsLost,
  resolveReady,
} from "../../src/packages/pf1e/readyDelay";
import {
  pf1eNextTurn,
  readCombatantState,
} from "../../src/packages/pf1e/combatState";
import {
  orderInterrupts,
  queueReadiedAction,
  queueAoOs,
  type PF1eInterruptQueue,
} from "../../src/packages/pf1e/interrupts";

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
  round = 1,
  turn = 0,
): CombatDocument => ({
  _id: "combat-1",
  type: "combat",
  name: "Combat 1",
  round,
  turn,
  combatants,
  ownership: { default: 3 },
  flags: {},
  system: {},
});

/** Four combatants in initiative order, `turn` on the first. */
const four = () =>
  combat([
    combatant("A", 20),
    combatant("R", 15),
    combatant("T", 7),
    combatant("D", 3),
  ]);

describe("delayTo — a current combatant moves to a lower count", () => {
  test("changes initiative permanently and hands the turn to the next actor", () => {
    const result = delayTo(four(), "A", 2);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const next = result.value.combat;
    // Permanent: initiative is the chosen count, and the order re-sorted around it.
    expect(next.combatants.find((c) => c._id === "A")?.initiative).toBe(2);
    expect(sortCombatants(next.combatants).map((c) => c._id)).toEqual([
      "R",
      "T",
      "D",
      "A",
    ]);
    // The round continues with the combatant who was next — not the delayer again.
    expect(currentCombatant(next)?._id).toBe("R");
    expect(result.value.hooks).toEqual([
      "combat:turn:end",
      "combat:combatant:delay",
    ]);
  });

  test("the delayer is visited exactly once — no extra turn", () => {
    const delayed = delayTo(four(), "A", 2);
    expect(delayed.ok).toBe(true);
    if (!delayed.ok) return;
    const visited: string[] = [];
    let c = delayed.value.combat;
    // Walk the rest of the round from the delay point.
    for (let i = 0; i < 3; i++) {
      visited.push(currentCombatant(c)?._id ?? "");
      c = nextTurn(c).combat;
    }
    // R, T, D, then A acts last — once — and the round wraps back to R, not A again.
    expect(visited).toEqual(["R", "T", "D"]);
    expect(currentCombatant(c)?._id).toBe("A");
    expect(c.round).toBe(1);
    const wrapped = nextTurn(c);
    expect(wrapped.combat.round).toBe(2);
    expect(currentCombatant(wrapped.combat)?._id).toBe("R");
  });

  test("refuses when the combatant is not current", () => {
    const result = delayTo(four(), "T", 1);
    expect(result).toEqual({
      ok: false,
      error: "only the current combatant can delay",
    });
  });

  test("refuses a count that is not lower", () => {
    const result = delayTo(four(), "A", 20);
    expect(result).toEqual({
      ok: false,
      error: "delay moves you to a lower initiative count",
    });
  });

  test("refuses a non-integer count", () => {
    const result = delayTo(four(), "A", 4.5);
    expect(result).toEqual({
      ok: false,
      error: "delay to a whole-number initiative count",
    });
  });

  test("a delay ticks the delayer's own effect durations and reports expiries", () => {
    const effect = (id: string, duration: number | null): Json => ({
      _id: id,
      type: "effect",
      name: id,
      ownership: { default: 1 },
      flags: { core: { duration } },
      system: {},
      changes: [],
      disabled: false,
    });
    const withEffects = (c: CombatantDocument) => ({
      ...c,
      flags: {
        ...(c.flags as object),
        core: {
          ...((c.flags as { core?: Record<string, unknown> })?.core ?? {}),
          effects: {
            ticked: effect("ticked", 2),
            untimed: effect("untimed", null),
          } as unknown as Record<string, Json>,
        },
      },
    });
    const c = combat([
      withEffects(combatant("A", 20)),
      combatant("R", 15),
      combatant("T", 7),
    ]);
    const result = delayTo(c, "A", 2);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const a = result.value.combat.combatants.find((x) => x._id === "A");
    expect(a).toBeDefined();
    if (!a) return;
    const effects = ((
      a.flags as { core?: { effects?: Record<string, unknown> } }
    ).core?.effects ?? {}) as Record<
      string,
      { flags?: { core?: { duration?: number } } }
    >;
    // The timed effect ticked down by one; the undated one persists.
    expect(effects["ticked"]?.flags?.core?.duration).toBe(1);
    expect(effects["untimed"]).toBeDefined();
    // R's effects are untouched by A's delay.
    expect(
      result.value.combat.combatants.find((x) => x._id === "R")?.flags,
    ).toEqual(combatant("R", 15).flags);
  });

  test("refuses when the count does not move the combatant later", () => {
    // A is between no-one: delaying to a count still above R changes nothing.
    const two = combat([combatant("A", 20), combatant("R", 15)]);
    const result = delayTo(two, "A", 16);
    expect(result).toEqual({
      ok: false,
      error:
        "that count does not move you later in the order — choose a lower initiative",
    });
  });

  test("refuses during a surprise round", () => {
    const surprise = {
      ...combat([combatant("A", 20), combatant("R", 15)], 0, 0),
      flags: {
        pf1e: { phase: "surprise", surpriseOrder: ["A"], surpriseTurn: 0 },
      },
    };
    expect(delayTo(surprise as CombatDocument, "A", 1)).toEqual({
      ok: false,
      error:
        "delay is not allowed during the surprise round — a single action only",
    });
  });

  // A defeated combatant is never "current" (core sorts defeated last), so the defeated
  // refusal is exercised where it is reachable — on `resolveReady` below.
});

describe("readyCombatant — a standard action prepares a readied action", () => {
  test("spends the standard action and stores the ready", () => {
    const result = readyCombatant(four(), "A", {
      action: { kind: "standard", action: "attack" },
      trigger: { kind: "cast", note: "when T casts a spell" },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const a = result.value.combat.combatants.find((c) => c._id === "A");
    expect(a).toBeDefined();
    if (!a) return;
    const cs = readCombatantState(a);
    expect(cs.actions.standardUsed).toBe(true);
    expect(cs.ready?.trigger.kind).toBe("cast");
    expect(cs.ready?.sinceRound).toBe(1);
    expect(result.value.hooks).toEqual(["combat:combatant:ready"]);
  });

  test("refuses a full-round prepared action by name", () => {
    const result = readyCombatant(four(), "A", {
      action: { kind: "full-round", action: "full-attack" },
      trigger: { kind: "attack" },
    });
    expect(result).toEqual({
      ok: false,
      error:
        'a readied action must be a standard, move, swift or free action — "full-round" is not legal to ready',
    });
  });

  test("refuses when the standard action is already spent", () => {
    const spent = combat([
      combatant("A", 20, {
        pf1e: { actions: { standardUsed: true } },
      }),
      combatant("R", 15),
    ]);
    const result = readyCombatant(spent, "A", {
      action: { kind: "standard", action: "attack" },
      trigger: { kind: "attack" },
    });
    expect(result).toEqual({
      ok: false,
      error: "cannot ready — standard action already spent this turn",
    });
  });

  test("refuses a second ready on the same combatant", () => {
    const already = combat([
      combatant("A", 20, {
        pf1e: {
          ready: {
            action: { kind: "standard", action: "attack" },
            trigger: { kind: "attack" },
            sinceRound: 1,
          },
        },
      }),
      combatant("R", 15),
    ]);
    const result = readyCombatant(already, "A", {
      action: { kind: "standard", action: "attack" },
      trigger: { kind: "attack" },
    });
    expect(result).toEqual({
      ok: false,
      error: "this combatant already has a readied action",
    });
  });

  test("refuses when the combatant is not current", () => {
    const result = readyCombatant(four(), "R", {
      action: { kind: "standard", action: "attack" },
      trigger: { kind: "attack" },
    });
    expect(result).toEqual({
      ok: false,
      error: "only the current combatant can ready an action",
    });
  });
});

describe("resolveReady — a readied action fires just before the trigger", () => {
  const readied = () =>
    combat([
      combatant("A", 20),
      combatant("R", 15, {
        pf1e: {
          ready: {
            action: { kind: "standard", action: "attack" },
            trigger: { kind: "cast" },
            sinceRound: 1,
          },
        },
      }),
      combatant("T", 7),
      combatant("D", 3),
    ]);

  test("moves the readied combatant immediately ahead of the triggerer", () => {
    const result = resolveReady(readied(), "R", "T");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.action).toEqual({ kind: "standard", action: "attack" });
    const r = result.value.combat.combatants.find((c) => c._id === "R");
    expect(r).toBeDefined();
    if (!r) return;
    expect(r.initiative).toBe(8); // T's 7 + 1
    // The ready is spent; the turn points at R so the action resolves now.
    expect(readCombatantState(r).ready).toBeNull();
    expect(currentCombatant(result.value.combat)?._id).toBe("R");
    expect(
      sortCombatants(result.value.combat.combatants).map((c) => c._id),
    ).toEqual(["A", "R", "T", "D"]);
  });

  test("an already-adjacent readied combatant fires without an initiative change", () => {
    const adjacent = combat([
      combatant("A", 20),
      combatant("R", 8, {
        pf1e: {
          ready: {
            action: { kind: "standard", action: "attack" },
            trigger: { kind: "cast" },
            sinceRound: 1,
          },
        },
      }),
      combatant("T", 7),
    ]);
    const result = resolveReady(adjacent, "R", "T");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(
      result.value.combat.combatants.find((c) => c._id === "R")?.initiative,
    ).toBe(8);
  });

  test("refuses an initiative collision that would misplace the combatant", () => {
    const colliding = combat([
      combatant("A", 20),
      combatant("R", 15, {
        pf1e: {
          ready: {
            action: { kind: "standard", action: "attack" },
            trigger: { kind: "cast" },
            sinceRound: 1,
          },
        },
      }),
      combatant("X", 8),
      combatant("T", 7),
    ]);
    const result = resolveReady(colliding, "R", "T");
    expect(result).toEqual({
      ok: false,
      error:
        "initiative collision — the readied combatant would not land immediately ahead of the triggerer; adjust the order manually",
    });
  });

  test("refuses with no readied action to fire", () => {
    expect(resolveReady(four(), "R", "T")).toEqual({
      ok: false,
      error: "this combatant has no readied action to fire",
    });
  });

  test("refuses a defeated readied combatant", () => {
    const defeated = combat([
      combatant("A", 20),
      {
        ...combatant("R", 15, {
          pf1e: {
            ready: {
              action: { kind: "standard", action: "attack" },
              trigger: { kind: "cast" },
              sinceRound: 1,
            },
          },
        }),
        defeated: true,
      },
      combatant("T", 7),
    ]);
    expect(resolveReady(defeated, "R", "T")).toEqual({
      ok: false,
      error: "a defeated combatant's readied action cannot fire",
    });
  });

  test("refuses self-interruption", () => {
    const self = combat([
      combatant("R", 15, {
        pf1e: {
          ready: {
            action: { kind: "standard", action: "attack" },
            trigger: { kind: "attack" },
            sinceRound: 1,
          },
        },
      }),
      combatant("T", 7),
    ]);
    expect(resolveReady(self, "R", "R")).toEqual({
      ok: false,
      error: "a combatant cannot be interrupted by its own readied action",
    });
  });
});

describe("findReadied — matching a described event", () => {
  const withReady = () =>
    combat([
      combatant("A", 20, {
        pf1e: {
          ready: {
            action: { kind: "standard", action: "attack" },
            trigger: { kind: "cast", targetId: "T" },
            sinceRound: 1,
          },
        },
      }),
      combatant("B", 15, {
        pf1e: {
          ready: {
            action: { kind: "move" },
            trigger: { kind: "move" },
            sinceRound: 1,
          },
        },
      }),
      combatant("T", 7),
    ]);

  test("matches by kind and honours a targetId scope", () => {
    const scoped = findReadied(withReady(), { kind: "cast", triggererId: "T" });
    expect(scoped).toEqual([
      { combatantId: "A", trigger: { kind: "cast", targetId: "T" } },
    ]);
    const wrongTarget = findReadied(withReady(), {
      kind: "cast",
      triggererId: "X",
    });
    expect(wrongTarget).toEqual([]);
    const move = findReadied(withReady(), { kind: "move", triggererId: "T" });
    expect(move).toEqual([{ combatantId: "B", trigger: { kind: "move" } }]);
  });
});

describe("an unspent ready is lost at the combatant's next turn", () => {
  test("pf1eNextTurn clears a ready carried over from a previous round", () => {
    // round 2, turn on A; B readied in round 1 and never fired.
    const c = combat(
      [
        combatant("A", 20),
        combatant("B", 10, {
          pf1e: {
            ready: {
              action: { kind: "standard", action: "attack" },
              trigger: { kind: "cast" },
              sinceRound: 1,
            },
          },
        }),
      ],
      2,
      0,
    );
    const result = pf1eNextTurn(c);
    const b = result.combat.combatants.find((x) => x._id === "B");
    expect(b).toBeDefined();
    if (!b) return;
    expect(readCombatantState(b).ready).toBeNull();
  });

  test("a ready made this round survives the turn boundary", () => {
    const c = combat(
      [
        combatant("A", 20),
        combatant("B", 10, {
          pf1e: {
            ready: {
              action: { kind: "standard", action: "attack" },
              trigger: { kind: "cast" },
              sinceRound: 2,
            },
          },
        }),
      ],
      2,
      0,
    );
    const result = pf1eNextTurn(c);
    const b = result.combat.combatants.find((x) => x._id === "B");
    expect(b).toBeDefined();
    if (!b) return;
    expect(readCombatantState(b).ready?.trigger.kind).toBe("cast");
  });

  test("readyIsLost reflects the boundary rule", () => {
    const ready = {
      action: { kind: "standard" as const },
      trigger: { kind: "cast" as const },
      sinceRound: 1,
    };
    expect(readyIsLost(ready, 2)).toBe(true);
    expect(readyIsLost(ready, 1)).toBe(false);
  });
});

describe("interrupt ordering — a readied action resolves before every AoO", () => {
  const ready = {
    action: { kind: "standard" as const },
    trigger: { kind: "cast" as const },
    sinceRound: 1,
  };
  const emptyQueue = (): PF1eInterruptQueue => ({
    turn: 1,
    substep: "cast",
    interrupts: [],
  });

  test("orderInterrupts ranks the ready first, even when it was queued last", () => {
    let q = emptyQueue();
    const aoos = queueAoOs(q, {
      turn: 1,
      substep: "cast",
      provokerId: "T",
      actionId: "cast-spell",
      trigger: { kind: "provoking-action", actionId: "cast-spell" },
      reactors: [{ id: "X" }],
    });
    q = aoos.queue;
    const fired = queueReadiedAction(q, {
      turn: 1,
      substep: "cast",
      reactorId: "R",
      provokerId: "T",
      actionId: "attack",
      ready,
    });
    const ordered = orderInterrupts(fired.queue.interrupts, {
      initiativeOf: (id) => (id === "X" ? 99 : 1),
    });
    expect(ordered.map((i) => `${i.kind}:${i.reactorId}`)).toEqual([
      "readied-action:R",
      "attack-of-opportunity:X",
    ]);
  });

  test("queueReadiedAction dedupes one ready per combatant", () => {
    const q = emptyQueue();
    const first = queueReadiedAction(q, {
      turn: 1,
      substep: "cast",
      reactorId: "R",
      provokerId: "T",
      actionId: "attack",
      ready,
    });
    const second = queueReadiedAction(first.queue, {
      turn: 1,
      substep: "cast",
      reactorId: "R",
      provokerId: "T",
      actionId: "attack",
      ready,
    });
    expect(second.queued).toBeNull();
    expect(second.reason).toBe(
      "this combatant's readied action is already queued",
    );
  });
});
