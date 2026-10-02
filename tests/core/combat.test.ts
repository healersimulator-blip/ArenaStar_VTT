import { describe, expect, test } from "vitest";
import {
  activeEffects,
  applyInitiative,
  currentCombatant,
  delayCombatant,
  nextTurn,
  previousTurn,
  setDefeated,
  sortCombatants,
  startCombat,
  endCombat,
  combatTriggerEvents,
  COMBAT_TRIGGER_METHODS,
  type CombatTransition,
} from "../../src/core/combat";
import type {
  CombatDocument,
  CombatantDocument,
  EffectDocument,
} from "../../src/core/documents";
import type { Json } from "../../src/core/documents";

function combatant(
  id: string,
  initiative: number | null,
  extra: Record<string, Json> = {},
): CombatantDocument {
  return {
    _id: id,
    type: "combatant",
    name: id,
    ownership: { default: 1 },
    flags: Object.keys(extra).length > 0 ? { core: extra } : {},
    system: {},
    tokenId: null,
    actorId: null,
    initiative,
    hidden: false,
    defeated: false,
  };
}

function effect(id: string, duration: number | null): EffectDocument {
  const core: Record<string, Json> = duration === null ? {} : { duration };
  return {
    _id: id,
    type: "effect",
    name: id,
    ownership: { default: 1 },
    flags: core.duration === undefined ? {} : { core },
    system: {},
    changes: [],
    disabled: false,
  };
}

function combat(...cs: CombatantDocument[]): CombatDocument {
  return {
    _id: "c1",
    type: "combat",
    name: "fight",
    ownership: { default: 1 },
    flags: {},
    system: {},
    round: 0,
    turn: 0,
    combatants: cs,
  };
}

function withEffects(c: CombatantDocument, effects: Record<string, Json>): CombatantDocument {
  return { ...c, flags: { core: { ...(c.flags.core ?? {}), effects } } };
}

describe("combat tracker (§10)", () => {
  test("sortCombatants: initiative desc, nulls last, defeated last, stable", () => {
    const a = combatant("a", 20);
    const b = combatant("b", 15);
    const c = combatant("c", 15);
    const d = combatant("d", null);
    const e = combatant("e", 99); // high initiative but defeated
    const defeated = { ...e, defeated: true };
    expect(sortCombatants([d, defeated, b, a, c]).map((x) => x._id)).toEqual([
      "a",
      "b",
      "c",
      "d",
      "e",
    ]);
  });

  test("startCombat: round 1, turn 0, hook order", () => {
    const t = startCombat(combat(combatant("a", 10), combatant("b", 20)));
    expect(t.combat.round).toBe(1);
    expect(t.combat.turn).toBe(0);
    expect(currentCombatant(t.combat)?._id).toBe("b"); // highest first
    expect(t.hooks).toEqual(["combat:start", "combat:round:start", "combat:turn:start"]);
  });

  test("nextTurn walks combatants then wraps the round", () => {
    const c = startCombat(
      combat(combatant("a", 10), combatant("b", 20), combatant("c", 15)),
    ).combat;
    expect(currentCombatant(c)?._id).toBe("b");
    let t: CombatTransition = nextTurn(c);
    expect(currentCombatant(t.combat)?._id).toBe("c");
    expect(t.combat.round).toBe(1);
    expect(t.hooks).toContain("combat:turn:end");
    expect(t.hooks).toContain("combat:turn:start");
    t = nextTurn(t.combat);
    expect(currentCombatant(t.combat)?._id).toBe("a");
    t = nextTurn(t.combat);
    expect(t.combat.round).toBe(2);
    expect(t.combat.turn).toBe(0);
    expect(currentCombatant(t.combat)?._id).toBe("b");
    expect(t.hooks).toContain("combat:round:start");
  });

  test("previousTurn steps back and wraps rounds backwards", () => {
    let c = startCombat(combat(combatant("a", 10), combatant("b", 20))).combat;
    c = nextTurn(c).combat; // → a
    c = nextTurn(c).combat; // → round 2, b
    let t = previousTurn(c);
    expect(t.combat.round).toBe(1);
    expect(currentCombatant(t.combat)?._id).toBe("a");
    t = previousTurn(t.combat);
    expect(currentCombatant(t.combat)?._id).toBe("b");
    t = previousTurn(t.combat); // at combat start → no-op
    expect(t.hooks).toEqual([]);
    expect(t.combat.round).toBe(1);
  });

  test("delay flags the combatant and clears on their next turn start", () => {
    const c = startCombat(combat(combatant("a", 10), combatant("b", 20))).combat;
    // a delays while b acts
    const delayed = delayCombatant(c, "a");
    expect(delayed.hooks).toContain("combat:combatant:delay");
    const delayedA = delayed.combat.combatants.find((x) => x._id === "a");
    expect((delayedA?.flags.core as Record<string, Json>)?.delayed).toBe(true);
    // advance to a → flag clears (empty core scope dropped)
    const t = nextTurn(delayed.combat);
    const a = t.combat.combatants.find((x) => x._id === "a");
    expect(a?.flags.core).toBeUndefined();
  });

  test("round wrap clears scoped markers on every combatant, not only the starting one", () => {
    let c = startCombat(
      combat(combatant("a", 30), combatant("b", 20), combatant("c", 10)),
    ).combat;
    c = nextTurn(nextTurn(c).combat).combat;
    c = delayCombatant(delayCombatant(c, "b").combat, "c").combat;
    const before = structuredClone(c);
    const result = nextTurn(c);
    expect(result.combat.round).toBe(2);
    expect(currentCombatant(result.combat)?._id).toBe("a");
    expect(result.combat.combatants.every((x) => x.flags.core?.delayed === undefined)).toBe(
      true,
    );
    expect(result.combat.combatants.map((x) => x.initiative)).toEqual([30, 20, 10]);
    expect(result.hooks).toEqual([
      "combat:turn:end",
      "combat:round:start",
      "combat:turn:start",
    ]);
    expect(c).toEqual(before);
  });

  test("round cleanup preserves other scopes and effects and ticks only the ending owner", () => {
    const b = withEffects(combatant("b", 20, { delayed: true, custom: "keep" }), {
      buff: effect("buff", 2) as unknown as Json,
    });
    b.flags.other = { delayed: true, note: "keep" };
    const c = withEffects(combatant("c", 10, { delayed: true }), {
      ending: effect("ending", 1) as unknown as Json,
    });
    const input = { ...combat(combatant("a", 30), b, c), round: 1, turn: 2 };
    const before = structuredClone(input);
    const result = nextTurn(input);
    expect(result.combat.combatants[1]?.flags).toMatchObject({
      core: { custom: "keep" },
      other: { delayed: true, note: "keep" },
    });
    expect(result.combat.combatants[1]?.flags.core).not.toHaveProperty("delayed");
    expect(activeEffects(result.combat).map((x) => [x.id, x.duration])).toEqual([["buff", 2]]);
    expect(result.expired).toEqual([{ combatantId: "c", effectId: "ending" }]);
    expect(result.hooks).toEqual([
      "combat:turn:end",
      "combat:effect:expire",
      "combat:round:start",
      "combat:turn:start",
    ]);
    expect(input).toEqual(before);
  });

  test("marking delay is metadata only and missing IDs are a no-op", () => {
    const c = startCombat(combat(combatant("a", 20), combatant("b", 10))).combat;
    const result = delayCombatant(c, "a");
    expect(result.combat.turn).toBe(c.turn);
    expect(result.combat.round).toBe(c.round);
    expect(sortCombatants(result.combat.combatants).map((x) => x._id)).toEqual(["a", "b"]);
    expect(currentCombatant(result.combat)?._id).toBe("a");
    expect(delayCombatant(c, "missing")).toEqual({ combat: c, hooks: [], expired: [] });
  });

  test("defeated sorts last and keeps initiative", () => {
    const c = combat(combatant("a", 10), combatant("b", 20));
    const t = setDefeated(c, "b", true);
    expect(t.combat.combatants[0]?._id).toBe("a");
    expect(t.combat.combatants[1]?.defeated).toBe(true);
  });

  test("effect durations tick on the owner's turn end and expire", () => {
    const a = withEffects(combatant("a", 20), {
      e1: effect("e1", 2) as unknown as Json,
      e2: effect("e2", null) as unknown as Json,
    });
    const c = startCombat(combat(a, combatant("b", 10))).combat;
    // a's turn ends → durations tick
    let t = nextTurn(c);
    const effects = activeEffects(t.combat).find((e) => e.id === "e1");
    expect(effects?.duration).toBe(1);
    // undated effect persists
    expect(activeEffects(t.combat).find((e) => e.id === "e2")).toBeTruthy();
    expect(t.hooks).not.toContain("combat:effect:expire"); // ticked, none expired yet
    // b's turn ends (no effects), round 2, a's turn ends again → e1 expires
    t = nextTurn(t.combat); // a turn start (round 2)
    t = nextTurn(t.combat); // a's turn end → tick 1 → 0 → expire
    expect(activeEffects(t.combat).find((e) => e.id === "e1")).toBeUndefined();
    expect(t.expired).toContainEqual({ combatantId: "a", effectId: "e1" });
  });

  test("applyInitiative re-sorts the order", () => {
    const c = combat(combatant("a", 20), combatant("b", 10));
    const t = applyInitiative(c, { a: 5, b: 25 });
    expect(t.combat.combatants.map((x) => x._id)).toEqual(["b", "a"]);
    expect(t.hooks).toContain("combat:combatant:update");
  });

  test("endCombat resets round/turn", () => {
    const c = startCombat(combat(combatant("a", 1))).combat;
    const t = endCombat(c);
    expect(t.combat.round).toBe(0);
    expect(t.hooks).toEqual(["combat:end"]);
  });

  test("nextTurn on an unstarted combat starts it", () => {
    const t = nextTurn(combat(combatant("a", 5)));
    expect(t.combat.round).toBe(1);
    expect(t.hooks).toContain("combat:start");
  });
});

describe("combat trigger classification (MATT's five kinds)", () => {
  const member = (id: string, initiative: number, tokenId: string) =>
    ({ ...combatant(id, initiative), tokenId });
  const started = (round = 1, turn = 0) =>
    ({ ...combat(member("a", 20, "t-a"), member("b", 10, "t-b")), round, turn });

  test("a started encounter appearing begins with start, round and turn", () => {
    expect(combatTriggerEvents(undefined, started()).map((e) => e.method))
      .toEqual(["combatStart", "combatRound", "combatTurnStart"]);
    // The triggering token is the current combatant at that moment.
    expect(combatTriggerEvents(undefined, started()).map((e) => e.tokenId))
      .toEqual(["t-a", "t-a", "t-a"]);
  });

  test("creating an unstarted encounter (round 0) is not an event", () => {
    expect(combatTriggerEvents(undefined, combat(combatant("a", 20)))).toEqual([]);
  });

  test("starting from round 0 fires the same three kinds", () => {
    expect(combatTriggerEvents(combat(combatant("a", 20), combatant("b", 10)), started())
      .map((e) => e.method)).toEqual(["combatStart", "combatRound", "combatTurnStart"]);
  });

  test("a turn advance ends the old turn before starting the new one", () => {
    const events = combatTriggerEvents(started(1, 0), started(1, 1));
    expect(events.map((e) => e.method)).toEqual(["combatTurnEnd", "combatTurnStart"]);
    // Turn end reports the combatant that left; turn start the one that arrived.
    expect(events.map((e) => e.tokenId)).toEqual(["t-a", "t-b"]);
    expect(events[0]).toMatchObject({ round: 1, turn: 1 - 1 });
  });

  test("a round wrap ends the turn, then announces the round and the new turn", () => {
    const events = combatTriggerEvents(started(1, 1), started(2, 0));
    expect(events.map((e) => e.method))
      .toEqual(["combatTurnEnd", "combatRound", "combatTurnStart"]);
    expect(events.map((e) => e.tokenId)).toEqual(["t-b", "t-a", "t-a"]);
    expect(events[1]).toMatchObject({ round: 2, turn: 0 });
  });

  test("stepping back fires only the turn that starts again, matching previousTurn", () => {
    expect(combatTriggerEvents(started(1, 1), started(1, 0)).map((e) => e.method))
      .toEqual(["combatTurnStart"]);
    expect(combatTriggerEvents(started(2, 0), started(1, 1)).map((e) => e.method))
      .toEqual(["combatTurnStart"]);
  });

  test("a jump back to round 1 turn 0 is a restart, not a rewind", () => {
    expect(combatTriggerEvents(started(3, 2), started(1, 0)).map((e) => e.method))
      .toEqual(["combatStart", "combatRound", "combatTurnStart"]);
  });

  test("ending or deleting a running encounter fires combatEnd with the last current", () => {
    const ended = combatTriggerEvents(started(2, 1), { ...started(2, 1), round: 0, turn: 0 });
    expect(ended.map((e) => e.method)).toEqual(["combatEnd"]);
    expect(ended[0]?.tokenId).toBe("t-b");
    expect(combatTriggerEvents(started(2, 1), undefined).map((e) => e.method)).toEqual(["combatEnd"]);
    // Deleting or ending an encounter that never started is not an event.
    expect(combatTriggerEvents(combat(combatant("a", 20)), undefined)).toEqual([]);
    expect(combatTriggerEvents(combat(combatant("a", 20)), combat(combatant("a", 20)))).toEqual([]);
  });

  test("combatant-only edits, same-value updates and an empty roster are quiet", () => {
    const before = started(1, 0);
    const roster = { ...before, combatants: [...before.combatants, combatant("c", 5)] };
    expect(combatTriggerEvents(before, roster)).toEqual([]);
    expect(combatTriggerEvents(before, started(1, 0))).toEqual([]);
    // A round advance with no combatants still announces the round, but there is no
    // current combatant for the turn kinds.
    const empty = combat();
    expect(combatTriggerEvents({ ...empty, round: 1 }, { ...empty, round: 2 }).map((e) => e.method))
      .toEqual(["combatTurnEnd", "combatRound"]);
    expect(combatTriggerEvents(undefined, { ...empty, round: 1 }).map((e) => e.method))
      .toEqual(["combatStart", "combatRound"]);
  });

  test("the method names are the shared combat trigger contract", () => {
    expect([...COMBAT_TRIGGER_METHODS])
      .toEqual(["combatStart", "combatRound", "combatTurnStart", "combatTurnEnd", "combatEnd"]);
  });
});
