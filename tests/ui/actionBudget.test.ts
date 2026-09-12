import { describe, expect, test } from "vitest";
import type {
  ActorDocument,
  CombatDocument,
  Json,
} from "../../src/core/documents";
import { startCombat } from "../../src/core/combat";
import {
  attackOfOpportunityBudget,
  combatantBudget,
  isPf1eEncounter,
  spendAttackOfOpportunityAuthorized,
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

describe("attacks of opportunity through the encounter ledger (P06/D-185)", () => {
  /** The fixture hero, optionally feated, with `acted` set so it is not round-flat-footed. */
  function actorWith(id: string, pf1e: Record<string, Json>): ActorDocument {
    return {
      _id: id,
      type: "actor",
      name: id,
      ownership: { default: 0 },
      flags: {},
      system: { pf1e },
      items: [],
      effects: [],
    };
  }

  function actedCombat(): CombatDocument {
    const c = combat();
    return {
      ...c,
      combatants: c.combatants.map((x) =>
        x._id === "hero"
          ? { ...x, flags: { ...x.flags, pf1e: { acted: true } } }
          : x,
      ),
    } as unknown as CombatDocument;
  }

  test("the budget is the derivation's number, not a second formula (D-183)", () => {
    const c = actedCombat();
    const plain = attackOfOpportunityBudget(c, "hero", [
      actorWith("hero", { abilities: { dex: 14 } }),
    ]);
    expect(plain?.max).toBe(1); // one per round without the feat, whatever the Dex is
    expect(plain?.used).toBe(0);
    expect(plain?.left).toBe(1);
    expect(plain?.canTake).toBe(true);
    expect(plain?.reason).toBeNull();

    const feated = attackOfOpportunityBudget(c, "hero", [
      actorWith("hero", { abilities: { dex: 14 }, feats: ["Combat Reflexes"] }),
    ]);
    expect(feated?.max).toBe(3); // 1 + Dex mod 2
  });

  test("flat-footed before its first turn is refused in the queue's own words", () => {
    // Rounds are running and the hero has not acted yet: round-structural flat-footedness,
    // which is not an effect — so it reaches the refusal through `isFlatFootedByRound`
    // plus the derivation's `combatReflexes`, exactly as AoN 102's exception reads.
    const inRounds = {
      ...combat(),
      flags: { pf1e: { v: 1, phase: "rounds" } },
    } as unknown as CombatDocument;
    const budget = attackOfOpportunityBudget(inRounds, "hero", [
      actorWith("hero", { abilities: { dex: 14 } }),
    ]);
    expect(budget?.flatFootedWhy).toBe("no-turn-yet");
    expect(budget?.canTake).toBe(false);
    expect(budget?.reason).toBe("flat-footed (no Combat Reflexes)");

    // The same combatant with Combat Reflexes may react while flat-footed.
    const feated = attackOfOpportunityBudget(inRounds, "hero", [
      actorWith("hero", { abilities: { dex: 14 }, feats: ["Combat Reflexes"] }),
    ]);
    expect(feated?.canTake).toBe(true);
    expect(feated?.reason).toBeNull();
    expect(feated?.max).toBe(3);
  });

  test("a spend writes the ledger through the authorized path, and the next spend is refused", () => {
    const c = actedCombat();
    const actors = [actorWith("hero", { abilities: { dex: 14 } })];
    const before = structuredClone(c);
    const spent = spendAttackOfOpportunityAuthorized(c, "hero", gm, actors, {
      reason: "movement",
    });
    expect(spent.error).toBeNull();
    expect(c).toEqual(before); // pure — the caller submits `ops`
    expect(spent.hooks).toEqual(["combat:combatant:update"]);
    expect(spent.ops[0]).toMatchObject({
      kind: "update",
      ref: { coll: "combats", id: "combat" },
    });
    const hero = spent.combat?.combatants.find((x) => x._id === "hero");
    if (!hero) throw new Error("missing fixture combatant");
    expect(readCombatantState(hero).aooUsed).toBe(1);
    expect(readCombatantState(hero).aooMax).toBe(1);
    expect(spent.budget?.left).toBe(0);
    expect(spent.budget?.canTake).toBe(false);

    // The ledger is spent: the second opportunity of the round is refused by name.
    const again = spendAttackOfOpportunityAuthorized(
      spent.combat ?? c,
      "hero",
      gm,
      actors,
    );
    expect(again.combat).toBeNull();
    expect(again.error).toContain("Attack of opportunity refused");
    expect(again.error).toContain("no opportunities left (1/1)");
  });

  test("permission and combatant lookup refuse before any ledger write", () => {
    const c = actedCombat();
    const actors = [actorWith("hero", { abilities: { dex: 14 } })];
    const denied = spendAttackOfOpportunityAuthorized(
      { ...c, ownership: { default: 0 } } as unknown as CombatDocument,
      "hero",
      player,
      actors,
    );
    expect(denied.combat).toBeNull();
    expect(denied.error).toContain("You cannot update this encounter.");
    expect(
      spendAttackOfOpportunityAuthorized(c, "nobody", gm, actors).error,
    ).toContain("not in this encounter");
  });

  test("an effect that denies AoOs refuses with the same wording the queue uses", () => {
    // The paralyzing/stunning conditions carry `flags.cannotAoO` (conditions.ts) and
    // `payload.denies` is the other spelling of the same fact (effectOps' long-reserved
    // `"aoo"` token — this budget is its first consumer).
    const c = actedCombat();
    // The payload is `flags.pf1e` itself: structural flags at `payload.flags`, deny tokens
    // at `payload.denies` (`validateEffectPayload`).
    const effect = (payload: Record<string, Json>) =>
      ({
        _id: "paralysis",
        name: "Paralyzed",
        flags: { pf1e: payload },
      }) as unknown as ActorDocument["effects"][number];
    const base = actorWith("hero", { abilities: { dex: 14 } });

    const byFlag: ActorDocument = {
      ...base,
      effects: [effect({ flags: { cannotAoO: true } })],
    };
    const budget = attackOfOpportunityBudget(c, "hero", [byFlag]);
    expect(budget?.deniedByEffect).toBe(false); // no deny token, only the structural flag
    expect(budget?.derivationRefused).toBe(true);
    expect(budget?.canTake).toBe(false);
    expect(budget?.reason).toBe("cannot take attacks of opportunity");
    const spent = spendAttackOfOpportunityAuthorized(c, "hero", gm, [byFlag]);
    expect(spent.combat).toBeNull();
    expect(spent.error).toContain("cannot take attacks of opportunity");

    // The deny token refuses through the effect gate instead.
    const byToken: ActorDocument = {
      ...base,
      effects: [effect({ denies: ["aoo"] })],
    };
    const tokenBudget = attackOfOpportunityBudget(c, "hero", [byToken]);
    expect(tokenBudget?.deniedByEffect).toBe(true);
    expect(tokenBudget?.canTake).toBe(false);
    expect(tokenBudget?.reason).toBe("cannot take attacks of opportunity");
  });
});
