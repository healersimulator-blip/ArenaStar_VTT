import { describe, expect, test } from "vitest";
import type { ActorDocument, SceneDocument, TokenDocument } from "../../src/core/documents";
import { newEncounter } from "../../src/ui/combat/encounters";
import {
  manualInitiative,
  rollEncounterInitiative,
  rollSelectedInitiative,
} from "../../src/ui/combat/initiative";
import { currentCombatant, startCombat, nextTurn, sortCombatants } from "../../src/core/combat";
function required<T>(value: T | undefined | null): T {
  if (value == null) throw new Error("Missing fixture/result");
  return value;
}
const gm = { id: "gm", role: "GM" as const };
function fixture() {
  const actor: ActorDocument = {
    _id: "hero",
    type: "actor",
    name: "Hero",
    ownership: { default: 0 },
    flags: {},
    system: { pf1e: { abilities: { dex: 16 }, initiative: 4 } },
    items: [],
    effects: [],
  };
  const scene = {
    _id: "scene",
    name: "Scene",
    type: "scene",
    flags: {},
    ownership: { default: 2 },
    tokens: [
      { _id: "hero-token", name: "Hero", actorId: "hero", hidden: false },
      { _id: "generic-token", name: "Generic", hidden: false },
    ] as TokenDocument[],
  } as unknown as SceneDocument;
  let id = 0;
  const combat = startCombat(newEncounter(scene, "combat", "Fight", () => `c${id++}`)).combat;
  return { actor, scene, combat };
}
describe("actor-aware public initiative", () => {
  /** @srd CRB p.178 Initiative: d20 + Dexterity modifier + other initiative modifiers. */
  test("records actor-aware totals and generic fallback, without changing authored data", () => {
    const { actor, scene, combat } = fixture();
    const before = structuredClone([actor, scene, combat]);
    const result = rollEncounterInitiative(combat, scene, [actor], gm, () => 10);
    expect(result.error).toBeNull();
    expect(result.transition?.combat.combatants.map((c) => c.initiative)).toEqual([17, 10]);
    expect(result.transition?.combat.combatants[0]?.flags.core?.initiativeRoll).toMatchObject({
      die: 10,
      modifier: 7,
      total: 17,
      actorId: "hero",
    });
    expect([actor, scene, combat]).toEqual(before);
  });
  test("active effects affect only a new roll; flat-footed never removes initiative Dex", () => {
    const { actor, scene, combat } = fixture();
    actor.effects = [
      {
        _id: "buff",
        type: "effect",
        name: "Buff",
        ownership: { default: 0 },
        flags: {
          pf1e: {
            mods: [{ key: "initiative", type: "morale", value: 2 }],
            flags: { flatFooted: true },
          },
        },
        system: {},
        changes: [],
        disabled: false,
      },
    ];
    const first = rollEncounterInitiative(combat, scene, [actor], gm, () => 10);
    expect(first.transition?.combat.combatants[0]?.initiative).toBe(19);
    actor.effects = [];
    expect(first.transition?.combat.combatants[0]?.initiative).toBe(19);
    expect(
      rollEncounterInitiative(combat, scene, [actor], gm, () => 10).transition?.combat
        .combatants[0]?.initiative,
    ).toBe(17);
  });
  test("rerolls retain the active combatant even when it moves to a different sorted index", () => {
    const { actor, scene, combat } = fixture();
    required(combat.combatants[0]).initiative = 20;
    required(combat.combatants[1]).initiative = 10;
    const dice = [1, 20];
    const result = rollEncounterInitiative(combat, scene, [actor], gm, () =>
      required(dice.shift()),
    );
    expect(result.transition?.combat.turn).toBe(1);
    expect(currentCombatant(required(result.transition).combat)?._id).toBe("c0");
    expect(result.transition?.combat.round).toBe(1);
    expect(result.transition?.hooks).not.toContain("combat:turn:start");
  });
  test("the first roll at encounter start activates the highest result", () => {
    const { actor, scene, combat } = fixture();
    const dice = [1, 20];
    const result = rollEncounterInitiative(combat, scene, [actor], gm, () =>
      required(dice.shift()),
    );
    expect(currentCombatant(required(result.transition).combat)?._id).toBe("c1");
    expect(result.transition?.combat.turn).toBe(0);
  });
  test("equal-total modifier ordering survives the generic core sort", () => {
    const { actor, scene, combat } = fixture();
    combat.combatants.reverse();
    const dice = [10, 3]; // generic 10 vs PF1e 3 + 7
    const result = rollEncounterInitiative(combat, scene, [actor], gm, () =>
      required(dice.shift()),
    );
    const next = required(result.transition).combat;
    expect(sortCombatants(next.combatants).map((c) => c._id)).toEqual(["c0", "c1"]);
    expect(next.combatants.map((c) => c.initiative)).toEqual([10, 10]);
    expect(dice).toHaveLength(0);
  });
  test("tie-roll order persists across a round wrap and explicit rerolls retain the active identity", () => {
    const { actor, scene, combat } = fixture();
    required(combat.combatants[1]).actorId = actor._id;
    const dice = [10, 10, 1, 20];
    const first = required(
      rollEncounterInitiative(combat, scene, [actor], gm, () => required(dice.shift()))
        .transition,
    ).combat;
    expect(first.combatants.map((c) => c._id)).toEqual(["c1", "c0"]);
    expect(required(first.combatants[0]).flags.core?.initiativeRoll).toMatchObject({
      total: 17,
      tiePolicy: "pf1e",
      tieRolls: [20],
    });
    const secondTurn = nextTurn(first).combat;
    expect(currentCombatant(secondTurn)?._id).toBe("c0");
    expect(currentCombatant(nextTurn(secondTurn).combat)?._id).toBe("c1");
    const reroll = [10, 10, 20, 1];
    const updated = required(
      rollEncounterInitiative(secondTurn, scene, [actor], gm, () => required(reroll.shift()))
        .transition,
    );
    expect(currentCombatant(updated.combat)?._id).toBe("c0");
    expect(updated.hooks).not.toContain("combat:turn:start");
  });
  test("generic-only ties remain stable and use no extra dice", () => {
    const { actor, scene, combat } = fixture();
    actor.system = {};
    let calls = 0;
    const result = rollEncounterInitiative(combat, scene, [actor], gm, () => {
      calls++;
      return 10;
    });
    expect(result.error).toBeNull();
    expect(calls).toBe(2);
    expect(result.transition?.combat.combatants.map((c) => c._id)).toEqual(["c0", "c1"]);
  });
  test("unresolved tie leaves the original encounter and prior receipts untouched", () => {
    const { actor, scene, combat } = fixture();
    required(combat.combatants[1]).actorId = actor._id;
    const before = structuredClone(combat);
    const result = rollEncounterInitiative(combat, scene, [actor], gm, () => 10);
    expect(result.transition).toBeNull();
    expect(result.error).toContain("20 roll-offs");
    expect(combat).toEqual(before);
  });
  test("selected rolls leave all unselected results and receipts unchanged", () => {
    const { actor, scene, combat } = fixture();
    const rolled = required(
      rollEncounterInitiative(combat, scene, [actor], gm, () => 10).transition,
    ).combat;
    const other = required(rolled.combatants.find((c) => c._id === "c1"));
    const before = structuredClone(rolled);
    let calls = 0;
    const result = rollSelectedInitiative(
      rolled,
      scene,
      [actor],
      gm,
      () => {
        calls++;
        return 1;
      },
      { sceneId: scene._id, ids: ["hero-token"] },
    );
    const next = required(result.transition).combat;
    expect(next.combatants.find((c) => c._id === "c1")).toEqual(other);
    expect(next.combatants.find((c) => c._id === "c0")?.initiative).toBe(8);
    expect(currentCombatant(next)?._id).toBe("c0");
    expect(calls).toBe(1);
    expect(rolled).toEqual(before);
  });
  test("selected roll ties are accepted without rerolling unselected combatants", () => {
    const { actor, scene, combat } = fixture();
    required(combat.combatants[1]).initiative = 10;
    const before = structuredClone(combat);
    let calls = 0;
    const result = rollSelectedInitiative(
      combat,
      scene,
      [actor],
      gm,
      () => {
        calls++;
        return 3;
      },
      { sceneId: scene._id, ids: ["hero-token"] },
    );
    expect(result.error).toBeNull();
    const updated = required(result.transition).combat;
    expect(updated.combatants.map((c) => c._id)).toEqual(["c0", "c1"]);
    expect(updated.combatants.map((c) => c.initiative)).toEqual([10, 10]);
    expect(updated.combatants[1]).toEqual(combat.combatants[1]);
    expect(updated.combatants[0]?.flags.core?.initiativeRoll).toMatchObject({
      crossSelectionTie: "stable-order",
    });
    expect(calls).toBe(1);
    expect(combat).toEqual(before);
  });
  test("deleted, wrong-scene, or non-roster selected tokens reject before dice; empty selects the whole roster", () => {
    const { actor, scene, combat } = fixture();
    for (const selection of [
      { sceneId: "wrong", ids: ["hero-token"] },
      { sceneId: scene._id, ids: ["missing"] },
    ]) {
      let calls = 0;
      const result = rollSelectedInitiative(
        combat,
        scene,
        [actor],
        gm,
        () => {
          calls++;
          return 10;
        },
        selection,
      );
      expect(result.transition).toBeNull();
      expect(calls).toBe(0);
    }
    scene.tokens.push({ ...required(scene.tokens[0]), _id: "not-in-roster" });
    expect(
      rollSelectedInitiative(
        combat,
        scene,
        [actor],
        gm,
        () => {
          throw new Error("must not roll");
        },
        { sceneId: scene._id, ids: ["not-in-roster"] },
      ).error,
    ).toContain("not in this encounter");
    expect(
      rollSelectedInitiative(combat, scene, [actor], gm, () => 10, {
        sceneId: scene._id,
        ids: [],
      }).transition?.combat.combatants,
    ).toHaveLength(2);
  });
  test("manual override removes stale receipt and preserves active identity and metadata", () => {
    const { actor, scene, combat } = fixture();
    required(combat.combatants[0]).flags.other = { note: "keep" };
    const rolled = required(
      rollEncounterInitiative(combat, scene, [actor], gm, () => 10).transition,
    ).combat;
    const result = manualInitiative(rolled, "c0", -5);
    const hero = required(result.combat.combatants.find((c) => c._id === "c0"));
    expect(hero.flags.core?.initiativeRoll).toBeUndefined();
    expect(hero.flags.other).toEqual({ note: "keep" });
    expect(currentCombatant(result.combat)?._id).toBe("c0");
  });
  test("hidden roster, missing actors/tokens, wrong scene and non-owner reject before RNG", () => {
    for (const reason of ["hidden", "actor", "token", "scene", "permission"]) {
      const { actor, scene, combat } = fixture();
      if (reason === "hidden") required(scene.tokens[1]).hidden = true;
      if (reason === "token") scene.tokens = [];
      if (reason === "scene") scene._id = "other";
      let rolls = 0;
      const result = rollEncounterInitiative(
        combat,
        scene,
        reason === "actor" ? [] : [actor],
        reason === "permission" ? { id: "p", role: "PLAYER" } : gm,
        () => {
          rolls++;
          return 10;
        },
      );
      expect(result.transition).toBeNull();
      expect(result.error).toBeTruthy();
      expect(rolls).toBe(0);
    }
  });
  test("bad die values and malformed actor data never produce a transition", () => {
    const { actor, scene, combat } = fixture();
    for (const die of [0, 21, 2.5, NaN])
      expect(
        rollEncounterInitiative(combat, scene, [actor], gm, () => die).transition,
      ).toBeNull();
    actor.system.pf1e = { initiative: "fast" };
    expect(rollEncounterInitiative(combat, scene, [actor], gm, () => 10).transition).toBeNull();
  });
});
