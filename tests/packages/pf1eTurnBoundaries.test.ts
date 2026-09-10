/**
 * P4/E04 — effect duration boundaries in the real PF1e turn flow. Core ticks
 * every duration at the owner's turn end; this suite proves `pf1eNextTurn`
 * restores what core consumed from `endsOn: "round-start"` effects and ticks
 * them once per round wrap (no double-decrement), lets unmaintained
 * concentration/sustained effects lapse at their owner's turn end, and stays
 * bit-identical to core's own transition when no such effect exists.
 */
import { describe, expect, test } from "vitest";
import { nextTurn, startCombat } from "../../src/core/combat";
import type {
  ActorDocument,
  CombatDocument,
  CombatantDocument,
  Json,
} from "../../src/core/documents";
import { readTacticalEffects } from "../../src/packages/pf1e/effects";
import { combatantEffectsRecord } from "../../src/packages/pf1e/effectOps";
import {
  pf1eNextTurn,
  spendCombatantAction,
} from "../../src/packages/pf1e/combatState";

function combatant(id: string, initiative: number): CombatantDocument {
  return {
    _id: id,
    type: "combatant",
    name: id,
    ownership: { default: 1 },
    flags: {},
    system: {},
    tokenId: null,
    actorId: null,
    initiative,
    hidden: false,
    defeated: false,
  };
}

function combat(...cs: CombatantDocument[]): CombatDocument {
  return {
    _id: "enc",
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

/** Apply an effect directly to a combatant's core map (input fixture helper). */
function withEffect(
  enc: CombatDocument,
  combatantId: string,
  id: string,
  payload: Json,
  duration: number,
): CombatDocument {
  const member = enc.combatants.find((c) => c._id === combatantId);
  if (!member) throw new Error(`fixture: no combatant ${combatantId}`);
  const doc = {
    _id: id,
    type: "effect",
    name: id,
    ownership: { default: 0 },
    system: {},
    changes: [],
    disabled: false,
    flags: {
      ...(duration > 0 ? { core: { duration } } : {}),
      pf1e: payload,
    },
  };
  const effects = { ...combatantEffectsRecord(member), [id]: doc };
  const combatants = enc.combatants.map((c) =>
    c._id === combatantId
      ? ({
          ...c,
          flags: {
            ...(c.flags as object),
            core: {
              ...((
                c.flags as Record<string, Record<string, unknown>> | undefined
              )?.core ?? {}),
              effects,
            },
          },
        } as CombatantDocument)
      : c,
  );
  return { ...enc, combatants };
}

const durationLeft = (enc: CombatDocument, id: string): number | null => {
  for (const member of enc.combatants) {
    const doc = combatantEffectsRecord(member)[id];
    if (doc === undefined) continue;
    const read = readTacticalEffects([[id, doc]]).effects[0];
    return read?.durationLeft ?? null;
  }
  return null;
};

function requireCombatant(combat: CombatDocument): CombatantDocument {
  const c = combat.combatants[0];
  if (!c) throw new Error("combatant missing");
  return c;
}

const hasEffect = (enc: CombatDocument, id: string): boolean =>
  enc.combatants.some((c) => combatantEffectsRecord(c)[id] !== undefined);

describe("pf1eNextTurn — round-start expiry without double-decrement (E04)", () => {
  test("an own-turn and a round-start effect on one combatant tick at their own boundaries", () => {
    let enc = combat(combatant("a", 20), combatant("b", 15));
    enc = withEffect(
      enc,
      "a",
      "ownTurn",
      {
        mods: [{ key: "ac", type: "dodge", value: 2 }],
        ttl: { unit: "round", value: 3 },
      },
      3,
    );
    enc = withEffect(
      enc,
      "a",
      "wholeRounds",
      {
        mods: [{ key: "attack", type: "morale", value: 2 }],
        ttl: { unit: "round", value: 2, endsOn: "round-start" },
      },
      2,
    );
    const started = startCombat(enc);

    // End a's turn: the own-turn effect ticks (3→2); the round-start effect is
    // restored untouched — core's premature tick is undone.
    const t1 = pf1eNextTurn(started.combat);
    expect(durationLeft(t1.combat, "ownTurn")).toBe(2);
    expect(durationLeft(t1.combat, "wholeRounds")).toBe(2);
    expect(t1.expired.filter((e) => e.effectId === "wholeRounds")).toHaveLength(
      0,
    );

    // End b's turn: the round wraps into round 2 — the round-start effect
    // ticks once (2→1); the own-turn effect does not (it is not a's turn).
    const t2 = pf1eNextTurn(t1.combat);
    expect(t2.combat.round).toBe(2);
    expect(durationLeft(t2.combat, "wholeRounds")).toBe(1);
    expect(durationLeft(t2.combat, "ownTurn")).toBe(2);

    // Round 2: a's turn end ticks the own-turn effect again (2→1); the
    // round-start effect stays at 1 until the wrap.
    const t3 = pf1eNextTurn(t2.combat);
    expect(durationLeft(t3.combat, "ownTurn")).toBe(1);
    expect(durationLeft(t3.combat, "wholeRounds")).toBe(1);

    // The second wrap drops the round-start effect and reports it.
    const t4 = pf1eNextTurn(t3.combat);
    expect(t4.combat.round).toBe(3);
    expect(hasEffect(t4.combat, "wholeRounds")).toBe(false);
    expect(t4.expired).toContainEqual({
      combatantId: "a",
      effectId: "wholeRounds",
    });
    expect(hasEffect(t4.combat, "ownTurn")).toBe(true);
  });

  test("a round-start effect ticks on every combatant carrying it at the wrap", () => {
    let enc = combat(combatant("a", 20), combatant("b", 15));
    enc = withEffect(
      enc,
      "a",
      "field",
      { ttl: { unit: "round", value: 1, endsOn: "round-start" } },
      1,
    );
    enc = withEffect(
      enc,
      "b",
      "fieldB",
      { ttl: { unit: "round", value: 1, endsOn: "round-start" } },
      1,
    );
    const started = startCombat(enc);
    const t1 = pf1eNextTurn(started.combat);
    expect(durationLeft(t1.combat, "field")).toBe(1);
    expect(durationLeft(t1.combat, "fieldB")).toBe(1);
    const t2 = pf1eNextTurn(t1.combat);
    expect(hasEffect(t2.combat, "field")).toBe(false);
    expect(hasEffect(t2.combat, "fieldB")).toBe(false);
    expect(t2.expired).toEqual(
      expect.arrayContaining([
        { combatantId: "a", effectId: "field" },
        { combatantId: "b", effectId: "fieldB" },
      ]),
    );
  });

  test("with no round-start or concentration effects, core's tick stands unmodified", () => {
    let enc = combat(combatant("a", 20), combatant("b", 15));
    enc = withEffect(
      enc,
      "b",
      "plain",
      {
        mods: [{ key: "ac", type: "dodge", value: 1 }],
        ttl: { unit: "round", value: 5 },
      },
      5,
    );
    const started = startCombat(enc);
    const pf1e = pf1eNextTurn(started.combat);
    const core = nextTurn(started.combat);
    // The effect maps are bit-identical (the T05 combatant-state additions are
    // pf1eNextTurn's own job, not an effect change).
    expect(durationLeft(pf1e.combat, "plain")).toBe(
      durationLeft(core.combat, "plain"),
    );
    expect(pf1e.expired).toEqual(core.expired);
    expect(pf1e.lapsed).toEqual([]);
    expect(pf1e.combat.round).toBe(core.combat.round);
    expect(pf1e.combat.turn).toBe(core.combat.turn);
  });

  test("round-start payloads without a duration are inert (no crash, no drop)", () => {
    let enc = combat(combatant("a", 20));
    enc = withEffect(
      enc,
      "a",
      "marked",
      { ttl: { unit: "day", value: 1, endsOn: "round-start" } },
      // No flags.core.duration: it persists until removed.
      0,
    );
    // Remove the duration key to simulate a persistent marker.
    const member = enc.combatants[0];
    if (!member) throw new Error("fixture combatant missing");
    const effects = combatantEffectsRecord(member);
    const marked = effects["marked"];
    if (!marked) throw new Error("marked effect missing");
    const doc = { ...marked };
    delete (doc.flags as { core?: unknown }).core;
    effects["marked"] = doc as (typeof effects)["marked"];
    const started = startCombat(enc);
    const t1 = pf1eNextTurn(started.combat);
    const t2 = pf1eNextTurn(t1.combat);
    expect(hasEffect(t2.combat, "marked")).toBe(true);
    expect(durationLeft(t2.combat, "marked")).toBeNull();
  });
});

describe("pf1eNextTurn — concentration/sustained maintenance (E04)", () => {
  const concentrationPayload = {
    mods: [{ key: "attack", type: "morale", value: 2 }],
    concentration: true,
  };

  test("a turn that spent the standard action sustains the effect", () => {
    let enc = combat(combatant("a", 20), combatant("b", 15));
    // No core duration: concentration durations last until removed or lapsed.
    enc = withEffect(enc, "a", "sustained", concentrationPayload, 0);
    const started = startCombat(enc);
    // The owner spends their standard action mid-turn (A.16: maintaining a
    // spell is a standard action) — through the ledger's own spend path.
    const spent = spendCombatantAction(started.combat, "a", {
      kind: "standard",
    });
    if (!spent.ok) throw new Error(`fixture: spend refused: ${spent.error}`);
    const t1 = pf1eNextTurn(spent.value);
    expect(hasEffect(t1.combat, "sustained")).toBe(true);
    expect(t1.lapsed).toEqual([]);
  });

  test("a turn that never spent the standard lets it lapse at turn end", () => {
    let enc = combat(combatant("a", 20), combatant("b", 15));
    enc = withEffect(enc, "a", "sustained", concentrationPayload, 0);
    const started = startCombat(enc);
    const t1 = pf1eNextTurn(started.combat);
    expect(hasEffect(t1.combat, "sustained")).toBe(false);
    expect(t1.lapsed).toEqual([{ combatantId: "a", effectId: "sustained" }]);
    // It is a lapse, not an expiry — `expired` stays core's own.
    expect(t1.expired).toHaveLength(0);
  });

  test("a maintained concentration effect that also ticks at round-start is restored first, then sustained", () => {
    let enc = combat(combatant("a", 20), combatant("b", 15));
    enc = withEffect(
      enc,
      "a",
      "sustainedRounds",
      {
        concentration: true,
        ttl: { unit: "round", value: 3, endsOn: "round-start" },
      },
      3,
    );
    const started = startCombat(enc);
    const spent = spendCombatantAction(started.combat, "a", {
      kind: "standard",
    });
    if (!spent.ok) throw new Error(`fixture: spend refused: ${spent.error}`);
    // a's turn ends: the round-start tick core took is undone, the maintenance
    // check sees the spent standard and the effect survives.
    const t1 = pf1eNextTurn(spent.value);
    expect(durationLeft(t1.combat, "sustainedRounds")).toBe(3);
    expect(t1.lapsed).toEqual([]);
    // The wrap ticks it once per round like any round-start effect.
    const t2 = pf1eNextTurn(t1.combat);
    expect(durationLeft(t2.combat, "sustainedRounds")).toBe(2);
  });

  test("an unmaintained round-start concentration effect lapses instead of ticking", () => {
    let enc = combat(combatant("a", 20), combatant("b", 15));
    enc = withEffect(
      enc,
      "a",
      "sustainedRounds",
      {
        concentration: true,
        ttl: { unit: "round", value: 3, endsOn: "round-start" },
      },
      3,
    );
    const started = startCombat(enc);
    const t1 = pf1eNextTurn(started.combat);
    expect(hasEffect(t1.combat, "sustainedRounds")).toBe(false);
    expect(t1.lapsed).toEqual([
      { combatantId: "a", effectId: "sustainedRounds" },
    ]);
  });

  test("surprise-round steps never tick or lapse effects", () => {
    let enc = combat(combatant("a", 20), combatant("b", 15));
    enc = withEffect(enc, "a", "sustained", concentrationPayload, 2);
    const started = startCombat(enc);
    // Force the surprise phase via the same flags the surprise path reads.
    const surprise: CombatDocument = {
      ...enc,
      flags: {
        pf1e: {
          phase: "surprise",
          surpriseOrder: ["a"],
          surpriseTurn: 0,
          surprised: [],
          flatFooted: [],
        },
      },
    };
    const step = pf1eNextTurn(surprise);
    expect(hasEffect(step.combat, "sustained")).toBe(true);
    expect(step.lapsed).toEqual([]);
    void started;
  });

  test("the lapsed effect stops contributing to the actor's derivation", () => {
    const actor: ActorDocument = {
      _id: "hero",
      type: "actor",
      name: "Hero",
      ownership: { default: 2 },
      flags: {},
      system: { pf1e: { abilities: { str: 10 } } },
      items: [],
      effects: [],
    };
    let enc = combat(combatant("a", 20));
    enc = withEffect(
      enc,
      "a",
      "inspired",
      {
        mods: [{ key: "ability.str", type: "morale", value: 4 }],
        concentration: true,
      },
      0,
    );
    const started = startCombat(enc);
    const live = readTacticalEffects(
      combatantEffectsRecord(requireCombatant(started.combat)),
    ).effects;
    expect(deriveStr(actor, live)).toBe(14);
    const t1 = pf1eNextTurn(started.combat);
    const after = readTacticalEffects(
      combatantEffectsRecord(requireCombatant(t1.combat)),
    ).effects;
    expect(deriveStr(actor, after)).toBe(10);
  });
});

import { deriveFromDocuments } from "../../src/packages/pf1e/actor";
function deriveStr(
  actor: ActorDocument,
  effects: ReturnType<typeof readTacticalEffects>["effects"],
) {
  return deriveFromDocuments({ actor, effects }).abilities.str;
}
