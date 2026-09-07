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
  type CombatTransition,
} from "../../src/core/combat";
import type { CombatDocument, CombatantDocument, EffectDocument } from "../../src/core/documents";
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
