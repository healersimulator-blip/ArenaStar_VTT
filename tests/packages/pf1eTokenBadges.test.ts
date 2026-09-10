/**
 * P4/E06 — token condition badges and recompute-on-effect-change (D-147). Badges derive on
 * read from the two effect homes (the linked combatant's combat copy wins id collisions, the
 * token's actor supplies the rest), suppressed effects show nothing, conditions sort first —
 * and because nothing is persisted, the real turn flow proves expiry both clears the badge and
 * restores the base derivation, with initiative order untouched throughout (R02).
 */
import { describe, expect, test } from "vitest";
import { startCombat } from "../../src/core/combat";
import type {
  ActorDocument,
  CombatDocument,
  CombatantDocument,
  EffectDocument,
  Json,
  TokenDocument,
} from "../../src/core/documents";
import { deriveFromDocuments } from "../../src/packages/pf1e/actor";
import { readTacticalEffects } from "../../src/packages/pf1e/effects";
import { combatantEffectsRecord } from "../../src/packages/pf1e/effectOps";
import { pf1eConditionPayload } from "../../src/packages/pf1e/conditions";
import { pf1eNextTurn } from "../../src/packages/pf1e/combatState";
import {
  badgeTint,
  collectBadges,
  conditionCode,
  tokenBadgesFor,
  tokenBadgesMap,
} from "../../src/packages/pf1e/tokenBadges";

function token(id: string, over: Partial<TokenDocument> = {}): TokenDocument {
  return {
    _id: id,
    type: "token",
    name: id,
    ownership: { default: 0 },
    flags: {},
    system: {},
    x: 0,
    y: 0,
    rotation: 0,
    width: 100,
    height: 100,
    img: "",
    hidden: false,
    disposition: "friendly",
    vision: false,
    light: { radius: 0, color: "#fff", alpha: 0.5 },
    ...over,
  };
}

function actor(id: string, effects: EffectDocument[] = []): ActorDocument {
  return {
    _id: id,
    type: "actor",
    name: id,
    ownership: { default: 2 },
    flags: {},
    system: { pf1e: { abilities: { str: 10 } } },
    items: [],
    effects,
  };
}

function combatant(
  id: string,
  initiative: number,
  tokenId: string | null = null,
): CombatantDocument {
  return {
    _id: id,
    type: "combatant",
    name: id,
    ownership: { default: 1 },
    flags: {},
    system: {},
    tokenId,
    actorId: null,
    initiative,
    hidden: false,
    defeated: false,
  };
}

function combat(round: number, ...cs: CombatantDocument[]): CombatDocument {
  return {
    _id: "enc",
    type: "combat",
    name: "fight",
    ownership: { default: 1 },
    flags: {},
    system: {},
    round,
    turn: 0,
    combatants: cs,
  };
}

function effectDoc(
  id: string,
  payload: Json,
  over: Partial<EffectDocument> = {},
  duration?: number,
): EffectDocument {
  return {
    _id: id,
    type: "effect",
    name: id,
    ownership: { default: 0 },
    system: {},
    changes: [],
    disabled: false,
    flags: {
      ...(duration !== undefined ? { core: { duration } } : {}),
      pf1e: payload,
    } as EffectDocument["flags"],
    ...over,
  };
}

function withCombatantEffectsFixture(
  enc: CombatDocument,
  combatantId: string,
  effects: Record<string, EffectDocument>,
): CombatDocument {
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
        } as unknown as CombatantDocument)
      : c,
  );
  return { ...enc, combatants };
}

function deriveStr(
  actorDoc: ActorDocument,
  effects: ReturnType<typeof readTacticalEffects>["effects"],
) {
  return deriveFromDocuments({ actor: actorDoc, effects }).abilities.str;
}

describe("chip codes and tints", () => {
  test("conditionCode takes word initials, or the first two letters of one word", () => {
    expect(conditionCode("Flat-Footed")).toBe("FF");
    expect(conditionCode("Energy Drained")).toBe("ED");
    expect(conditionCode("Shaken")).toBe("SH");
    expect(conditionCode("Grappled")).toBe("GR");
    expect(conditionCode("")).toBe("??");
  });

  test("badgeTint is stable per label and deterministic across runs", () => {
    expect(badgeTint("Flat-Footed")).toBe(badgeTint("Flat-Footed"));
    expect(badgeTint("Shaken")).toBe(badgeTint("Shaken"));
    expect(Number.isFinite(badgeTint("Flat-Footed"))).toBe(true);
  });
});

describe("collectBadges — one record", () => {
  test("conditions render their SRD name, other effects their document name", () => {
    const flat = pf1eConditionPayload("Flat-Footed");
    expect(flat.ok).toBe(true);
    const record: Record<string, EffectDocument> = {
      ff: effectDoc("ff", (flat.ok ? flat.value : {}) as Json, {
        name: "Surprised",
      }),
      bless: effectDoc("bless", {
        mods: [{ key: "attack", type: "morale", value: 1 }],
      }),
    };
    const badges = collectBadges(record);
    expect(badges.map((b) => b.label)).toEqual(["Flat-Footed", "bless"]);
    expect(badges.map((b) => b.condition)).toEqual([true, false]);
    expect(badges[0]?.code).toBe("FF");
  });

  test("suppressed (disabled) and unparseable effects show nothing", () => {
    const record: Record<string, EffectDocument> = {
      off: effectDoc("off", { mods: [] }, { disabled: true }),
      junk: effectDoc("junk", { mods: "not-an-array" } as unknown as Json),
    };
    expect(collectBadges(record)).toEqual([]);
  });
});

describe("tokenBadgesFor — both homes", () => {
  const flat = pf1eConditionPayload("Flat-Footed");
  const flatPayload = (flat.ok ? flat.value : {}) as Json;

  test("the linked combatant's combat home shows through the token", () => {
    let enc = combat(1, combatant("a", 20, "tok-1"));
    enc = withCombatantEffectsFixture(enc, "a", {
      ff: effectDoc("ff", flatPayload),
    });
    const badges = tokenBadgesFor(token("tok-1"), {
      actors: [],
      combats: [enc],
    });
    expect(badges.map((b) => b.label)).toEqual(["Flat-Footed"]);
  });

  test("an under-way encounter (round ≥ 1) wins the token claim", () => {
    const prep = withCombatantEffectsFixture(
      combat(0, combatant("a", 20, "tok-1")),
      "a",
      { bless: effectDoc("bless", { mods: [] }, { name: "bless" }) },
    );
    const live = withCombatantEffectsFixture(
      combat(2, combatant("a", 20, "tok-1")),
      "a",
      { ff: effectDoc("ff", flatPayload) },
    );
    const badges = tokenBadgesFor(token("tok-1"), {
      actors: [],
      combats: [prep, live],
    });
    expect(badges.map((b) => b.effectId)).toEqual(["ff"]);
  });

  test("the actor home supplies badges via actorId; combat copy wins id collisions", () => {
    const enc = withCombatantEffectsFixture(
      combat(1, combatant("a", 20, "tok-1")),
      "a",
      { ff: effectDoc("ff", flatPayload, { name: "combat copy" }) },
    );
    const hero = actor("hero", [
      effectDoc("ff", { mods: [] } as Json, { name: "actor copy" }),
      effectDoc("bless", { mods: [] } as Json, { name: "bless" }),
    ]);
    const badges = tokenBadgesFor(token("tok-1", { actorId: "hero" }), {
      actors: [hero],
      combats: [enc],
    });
    expect(badges.map((b) => b.effectId)).toEqual(["ff", "bless"]);
    expect(badges.find((b) => b.effectId === "ff")?.label).toBe(
      "Flat-Footed", // the combat copy's payload, not the actor copy's name
    );
  });

  test("a token linked to nothing shows no badges", () => {
    const hero = actor("hero", [effectDoc("bless", { mods: [] } as Json)]);
    expect(
      tokenBadgesFor(token("lonely"), { actors: [hero], combats: [] }),
    ).toEqual([]);
  });
});

describe("expiry clears badges and restores the base — the real flow", () => {
  test("apply → derived +4 Str and a badge; one wrap → base and no badge; initiative untouched", () => {
    const hero = actor("hero");
    let enc = combat(0, combatant("a", 20, "tok-1"));
    enc = withCombatantEffectsFixture(enc, "a", {
      inspired: effectDoc(
        "inspired",
        { mods: [{ key: "ability.str", type: "morale", value: 4 }] } as Json,
        { name: "Inspired" },
        1, // own-turn ticks: core drops it at the owner's first turn end
      ),
    });

    const badgesDuring = tokenBadgesFor(token("tok-1"), {
      actors: [hero],
      combats: [enc],
    });
    expect(badgesDuring.map((b) => b.label)).toEqual(["Inspired"]);

    const carrier = enc.combatants[0];
    if (!carrier) throw new Error("fixture combatant missing");
    const live = readTacticalEffects(combatantEffectsRecord(carrier)).effects;
    expect(deriveStr(hero, live)).toBe(14);

    // The real expiry: start the encounter, then core ticks duration 1 at the owner's turn end.
    const started = startCombat(enc);
    expect(
      tokenBadgesFor(token("tok-1"), {
        actors: [hero],
        combats: [started.combat],
      }).map((b) => b.label),
    ).toEqual(["Inspired"]);
    const t1 = pf1eNextTurn(started.combat);
    const afterCarrier = t1.combat.combatants[0];
    if (!afterCarrier) throw new Error("transition lost the combatant");
    const after = readTacticalEffects(
      combatantEffectsRecord(afterCarrier),
    ).effects;
    expect(deriveStr(hero, after)).toBe(10);
    expect(
      tokenBadgesFor(token("tok-1"), { actors: [hero], combats: [t1.combat] }),
    ).toEqual([]);

    // R02: no re-sort, no initiative rewrite — effect changes never touch the order.
    expect(
      t1.combat.combatants.map((c) => ({ id: c._id, init: c.initiative })),
    ).toEqual([{ id: "a", init: 20 }]);
  });
});

describe("tokenBadgesMap", () => {
  test("only tokens with badges appear in the map", () => {
    const flat = pf1eConditionPayload("Flat-Footed");
    const enc = withCombatantEffectsFixture(
      combat(1, combatant("a", 20, "tok-1"), combatant("b", 15, "tok-2")),
      "a",
      { ff: effectDoc("ff", (flat.ok ? flat.value : {}) as Json) },
    );
    const map = tokenBadgesMap([token("tok-1"), token("tok-2")], {
      actors: [],
      combats: [enc],
    });
    expect([...map.keys()]).toEqual(["tok-1"]);
    expect(map.get("tok-1")?.[0]?.code).toBe("FF");
  });
});
