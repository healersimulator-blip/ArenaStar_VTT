import { describe, expect, test } from "vitest";
import type { ActorDocument, CombatDocument } from "../../src/core/documents";
import { startCombat } from "../../src/core/combat";
import {
  combatantBudget,
  isPf1eEncounter,
  spendCombatantActionAuthorized,
} from "../../src/ui/combat/actionBudget";
import { readCombatantState } from "../../src/packages/pf1e/combatState";

const gm = { id: "gm", role: "GM" as const };
const player = { id: "p1", role: "PLAYER" as const };

function pf1eActor(id: string): ActorDocument {
  return {
    _id: id,
    type: "actor",
    name: id,
    ownership: { default: 0 },
    flags: {},
    system: { pf1e: { abilities: { dex: 14 } } },
    items: [],
    effects: [],
  };
}

function combat(): CombatDocument {
  const doc = {
    _id: "combat",
    type: "combat",
    name: "Fight",
    round: 0,
    turn: 0,
    ownership: { default: 3 },
    flags: {},
    system: {},
    combatants: [
      {
        _id: "hero",
        type: "combatant",
        name: "Hero",
        tokenId: null,
        actorId: "hero",
        initiative: null,
        hidden: false,
        defeated: false,
        ownership: { default: 3 },
        flags: {},
        system: {},
      },
      {
        _id: "mook",
        type: "combatant",
        name: "Mook",
        tokenId: null,
        actorId: null,
        initiative: null,
        hidden: false,
        defeated: false,
        ownership: { default: 3 },
        flags: {},
        system: {},
      },
    ],
  } as unknown as CombatDocument;
  return startCombat(doc).combat;
}

describe("PF1e encounter detection and budget views (T05)", () => {
  test("an encounter is PF1e when any combatant links a PF1e actor", () => {
    const c = combat();
    expect(isPf1eEncounter(c, [pf1eActor("hero")])).toBe(true);
    expect(isPf1eEncounter(c, [])).toBe(false);
    expect(
      isPf1eEncounter(
        { ...c, combatants: c.combatants.filter((x) => x._id === "mook") },
        [pf1eActor("hero")],
      ),
    ).toBe(false);
  });

  test("the budget view reports the active combatant's remaining actions and refusals", () => {
    const c = combat();
    const budget = combatantBudget(c, "hero");
    expect(budget).not.toBeNull();
    expect(budget?.refusals.standard).toBeNull();
    expect(budget?.refusals.fullRound).toBeNull();
    expect(budget?.refusals.completeFullRound).toContain(
      "no full-round action",
    );
    expect(budget?.refusals.immediate).toBeNull();
    expect(combatantBudget(c, "nope")).toBeNull();
  });
});

describe("authorized action spends (T05)", () => {
  test("a GM spend lands as an updated combat with the hook; refusals are errors", () => {
    const c = combat();
    const before = structuredClone(c);
    const ok = spendCombatantActionAuthorized(
      c,
      "hero",
      { kind: "standard" },
      gm,
    );
    expect(ok.error).toBeNull();
    expect(ok.hooks).toEqual(["combat:combatant:update"]);
    expect(c).toEqual(before); // pure — the caller submits the returned combat
    const hero = ok.combat?.combatants.find((x) => x._id === "hero");
    const fallback = c.combatants.find((x) => x._id === "hero");
    if (!hero || !fallback) throw new Error("missing fixture combatant");
    expect(readCombatantState(hero).actions.standardUsed).toBe(true);
    const refused = spendCombatantActionAuthorized(
      ok.combat ?? c,
      "hero",
      { kind: "standard" },
      gm,
    );
    expect(refused.combat).toBeNull();
    expect(refused.error).toContain("Action refused");
    expect(refused.error).toContain("standard action already spent");
    expect(
      spendCombatantActionAuthorized(c, "hero", { kind: "swift" }, null).error,
    ).toContain("You cannot update this encounter.");
  });

  test("players without update permission cannot spend from the budget", () => {
    // default ownership 0 = private: a player is refused, the GM is not
    const privateCombat = {
      ...combat(),
      ownership: { default: 0 },
    } as unknown as CombatDocument;
    const denied = spendCombatantActionAuthorized(
      privateCombat,
      "hero",
      { kind: "swift" },
      player,
    );
    expect(denied.combat).toBeNull();
    expect(denied.error).toContain("You cannot update this encounter.");
    expect(
      spendCombatantActionAuthorized(
        privateCombat,
        "hero",
        { kind: "swift" },
        gm,
      ).error,
    ).toBeNull();
  });
});
