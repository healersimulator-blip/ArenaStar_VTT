import { describe, expect, test } from "vitest";
import {
  castOrderFor,
  directAttackOrder,
  enemyTargetRows,
  heroOrderCapabilities,
  orderLabel,
  strategicHeroMark,
} from "../../src/ui/armies/heroOrders";
import { createMassBattlePf1e } from "../../src/packages/massBattlePf1e";
import { createMassBattleBasic } from "../../src/packages/massBattleBasic";
import type { RulesModule } from "../../src/core/rules";
import type {
  ArmyDocument,
  FactionDocument,
  UnitDocument,
} from "../../src/core/strategic";

/**
 * M10 — the pure layer behind the Army Window's hero controls. The window must be able to
 * offer a direct target and a caster for the module actually in play, and every state it
 * cannot resolve has to be refused by name here rather than becoming an Op the host rejects.
 */

function unit(
  id: string,
  type: string,
  over: Partial<UnitDocument> = {},
): UnitDocument {
  return {
    _id: id,
    type,
    name: id,
    ownership: { default: 0 },
    flags: {},
    system: {},
    profile: {},
    formation: "line",
    sceneId: null,
    modelRange: [0, 4],
    orders: { pending: [], issuedBy: "gm", issuedTurn: 0 },
    stats: { strength: 10, morale: 5, supply: 5, fatigue: 0 },
    ...over,
  };
}

function army(
  id: string,
  factionId: string,
  units: UnitDocument[],
  name = id,
): ArmyDocument {
  return {
    _id: id,
    type: "army",
    name,
    ownership: { default: 0 },
    flags: {},
    system: {},
    factionId,
    commander: [],
    supply: { level: 4 },
    units,
  };
}

function faction(id: string, name: string): FactionDocument {
  return {
    _id: id,
    type: "faction",
    name,
    color: "#888",
    allies: [],
    ownership: { default: 0 },
    flags: {},
    system: {},
  };
}

describe("heroOrderCapabilities (M10 capability gate)", () => {
  test("a PF1e campaign offers both direct targeting and the module's spells", () => {
    const caps = heroOrderCapabilities(createMassBattlePf1e());
    expect(caps.directAttack).toBe(true);
    expect(caps.casts.map((c) => c.id)).toContain("fireball");
    expect(caps.casts.find((c) => c.id === "fireball")?.targeting).toBe(
      "point",
    );
  });

  test("mass-battle-basic declares attack orders but no caster, so no caster control renders", () => {
    // The gate's whole point: the demo module has spell-free orders, and a greyed-out
    // "Cast" button the resolver can only refuse is worse than no button.
    const caps = heroOrderCapabilities(createMassBattleBasic());
    expect(caps.directAttack).toBe(true);
    expect(caps.casts).toEqual([]);
  });

  test("no module resolved yet means no capabilities, and no throw", () => {
    expect(heroOrderCapabilities(null)).toEqual({
      directAttack: false,
      casts: [],
    });
    expect(heroOrderCapabilities(undefined)).toEqual({
      directAttack: false,
      casts: [],
    });
  });

  test("a package whose capability call throws degrades to no caster control", () => {
    // §12 proves `orderVocabulary` is a function, nothing more. A third-party module that
    // throws inside it must not take the Orders tab down: move/hold/retreat still work.
    const broken = {
      schema: { orderTypes: ["move"], subPhases: [] },
      orderVocabulary: () => {
        throw new Error("package bug");
      },
    } as unknown as RulesModule;
    expect(heroOrderCapabilities(broken)).toEqual({
      directAttack: false,
      casts: [],
    });
  });

  test("a capability that answers with a non-list is treated as no spells", () => {
    const odd = {
      schema: { orderTypes: ["attack"], subPhases: [] },
      orderVocabulary: () => ({ casts: "fireball" }),
    } as unknown as RulesModule;
    expect(heroOrderCapabilities(odd)).toEqual({
      directAttack: true,
      casts: [],
    });
  });
});

describe("enemyTargetRows (M10 direct-target roster)", () => {
  const factions = [faction("f-red", "Red"), faction("f-blue", "Blue")];

  test("own army and same-faction armies are never offered as targets", () => {
    const armies = [
      army("army-r", "f-red", [unit("u-r-0", "infantry")], "Red Host"),
      army("army-r2", "f-red", [unit("u-r2-0", "cavalry")], "Red Reserve"),
      army("army-b", "f-blue", [unit("u-b-0", "infantry")], "Blue Host"),
    ];
    const list = enemyTargetRows({ armies, factions, ownArmyId: "army-r" });
    expect(list.targets.map((t) => t.unitId)).toEqual(["u-b-0"]);
    expect(list.targets[0]?.armyName).toBe("Blue Host");
    expect(list.targets[0]?.factionName).toBe("Blue");
  });

  test("an enemy unit holding no models is counted as untargetable, not dropped quietly", () => {
    // The engine measures a unit's anchor on its first living model (M07/D-173); with no
    // modelRange there is nothing to hit, so the control must say so instead of offering a
    // target that resolves to zero defenders.
    const armies = [
      army("army-r", "f-red", [unit("u-r-0", "infantry")]),
      army(
        "army-b",
        "f-blue",
        [
          unit("u-b-0", "infantry"),
          unit("u-b-1", "artillery", { modelRange: null }),
        ],
        "Blue Host",
      ),
    ];
    const list = enemyTargetRows({ armies, factions, ownArmyId: "army-r" });
    expect(list.targets.map((t) => t.unitId)).toEqual(["u-b-0"]);
    expect(list.undeployed).toBe(1);
  });

  test("heroes sort first, then by name; strength reads the authored figure", () => {
    const armies = [
      army("army-r", "f-red", [unit("u-r-0", "infantry")]),
      army(
        "army-b",
        "f-blue",
        [
          unit("zeta", "infantry"),
          unit("alpha", "infantry"),
          unit("hero-of-blue", "hero", {
            stats: { strength: 4, morale: 5, supply: 5, fatigue: 0 },
          }),
        ],
        "Blue Host",
      ),
    ];
    const list = enemyTargetRows({ armies, factions, ownArmyId: "army-r" });
    expect(list.targets.map((t) => t.unitId)).toEqual([
      "hero-of-blue",
      "alpha",
      "zeta",
    ]);
    expect(list.targets[0]).toMatchObject({
      hero: true,
      strength: 4,
      unitType: "hero",
    });
    expect(list.targets[1]?.strength).toBe(10);
  });

  test("a missing own army yields an empty list rather than the whole battlefield", () => {
    const armies = [army("army-b", "f-blue", [unit("u-b-0", "infantry")])];
    expect(
      enemyTargetRows({ armies, factions, ownArmyId: "army-gone" }),
    ).toEqual({ targets: [], undeployed: 0 });
  });

  test("an unknown faction id is surfaced verbatim, not blanked", () => {
    const armies = [
      army("army-r", "f-red", [unit("u-r-0", "infantry")]),
      army("army-x", "f-green", [unit("u-x-0", "infantry")]),
    ];
    const list = enemyTargetRows({ armies, factions, ownArmyId: "army-r" });
    expect(list.targets[0]?.factionName).toBe("f-green");
  });
});

describe("strategicHeroMark (M10 label, not a rule)", () => {
  test("the three authored facts the module's gate reads all mark a hero", () => {
    expect(strategicHeroMark(unit("a", "hero"))).toBe(true);
    expect(
      strategicHeroMark(
        unit("b", "infantry", {
          stats: { strength: 0, morale: 0, supply: 0, fatigue: 0, hero: 1 },
        }),
      ),
    ).toBe(true);
    expect(
      strategicHeroMark(unit("c", "infantry", { leaderTokenId: "tok-1" })),
    ).toBe(true);
    expect(strategicHeroMark(unit("d", "infantry"))).toBe(false);
    // An empty binding is not a binding.
    expect(
      strategicHeroMark(unit("e", "infantry", { leaderTokenId: "" })),
    ).toBe(false);
  });
});

describe("directAttackOrder / castOrderFor (M10 order payloads)", () => {
  test("a direct target is an attack order naming the enemy unit", () => {
    expect(directAttackOrder("u-b-0")).toEqual({
      kind: "attack",
      targetUnitId: "u-b-0",
    });
  });

  test("a burst carries the designated point of origin in feet (CRB p.214)", () => {
    const built = castOrderFor({
      spellId: "fireball",
      targeting: "point",
      from: { x: 0, y: 0 },
      aim: { x: 12.0004, y: 30 },
    });
    expect(built).toEqual({
      ok: true,
      order: {
        kind: "custom",
        type: "spell_aoe",
        data: { spell: "fireball", x: 12, y: 30 },
      },
    });
  });

  test("a cone carries the caster-to-aim vector, because it starts at the caster", () => {
    const built = castOrderFor({
      spellId: "burning-hands",
      targeting: "direction",
      from: { x: 10, y: 10 },
      aim: { x: 25, y: 5 },
    });
    expect(built).toEqual({
      ok: true,
      order: {
        kind: "custom",
        type: "spell_aoe",
        data: { spell: "burning-hands", dirX: 15, dirY: -5 },
      },
    });
  });

  test("the engine accepts both payloads — the builder and the validator agree", () => {
    // Not a tautology: this pins that a control-built order passes the module's own
    // `validateOrder`, which is what the window runs before submitting.
    const rules = createMassBattlePf1e();
    const unitView = {
      id: "u0",
      armyId: "a0",
      factionId: "f0",
      type: "artillery",
      name: "Wizards",
      profile: {},
      stats: {},
      orders: null,
      formation: "line",
      sceneId: "scene-1",
      modelRange: [0, 1] as [number, number],
      leaderTokenId: null,
    } as unknown as Parameters<typeof rules.validateOrder>[1];
    const ctx = {
      sceneId: "scene-1",
      grid: {
        type: "square",
        size: 100,
        distance: 5,
        units: "ft",
        diagonals: "555",
      },
      walls: {
        x1: new Float32Array(),
        y1: new Float32Array(),
        x2: new Float32Array(),
        y2: new Float32Array(),
        restriction: new Uint8Array(),
      },
      factions: [],
      armies: [],
      leaderActors: {},
      worldSettings: {},
    } as unknown as Parameters<typeof rules.validateOrder>[0];
    const point = castOrderFor({
      spellId: "fireball",
      targeting: "point",
      from: { x: 0, y: 0 },
      aim: { x: 10, y: 10 },
    });
    const dir = castOrderFor({
      spellId: "burning-hands",
      targeting: "direction",
      from: { x: 10, y: 10 },
      aim: { x: 12, y: 9 },
    });
    expect(point.ok && rules.validateOrder(ctx, unitView, point.order).ok).toBe(
      true,
    );
    expect(dir.ok && rules.validateOrder(ctx, unitView, dir.order).ok).toBe(
      true,
    );
    // And the mismatched pair — a direction spelled as a point — is refused by name.
    const wrong = castOrderFor({
      spellId: "burning-hands",
      targeting: "direction",
      from: { x: 10, y: 10 },
      aim: { x: 10, y: 10 },
    });
    expect(wrong.ok).toBe(false);
  });

  test("every unusable input is refused with a name, never defaulted", () => {
    expect(
      castOrderFor({
        spellId: "",
        targeting: "point",
        from: { x: 0, y: 0 },
        aim: { x: 1, y: 1 },
      }),
    ).toEqual({ ok: false, reason: "no spell selected" });
    expect(
      castOrderFor({
        spellId: "fireball",
        targeting: "point",
        from: { x: 0, y: 0 },
        aim: { x: Number.NaN, y: 4 },
      }).ok,
    ).toBe(false);
    expect(
      castOrderFor({
        spellId: "fireball",
        targeting: "point",
        from: { x: 0, y: 0 },
        aim: { x: Number.POSITIVE_INFINITY, y: 4 },
      }),
    ).toEqual({
      ok: false,
      reason: "the point of origin needs finite numeric coordinates (feet)",
    });
    // Standing on the aim point is a GM question, not a fallback to "east".
    expect(
      castOrderFor({
        spellId: "burning-hands",
        targeting: "direction",
        from: { x: 7, y: 7 },
        aim: { x: 7.0001, y: 7.0001 },
      }),
    ).toEqual({
      ok: false,
      reason:
        "the caster and the aim point share an anchor — pick an aim point away from the caster",
    });
    expect(
      castOrderFor({
        spellId: "burning-hands",
        targeting: "direction",
        from: { x: Number.NaN, y: 0 },
        aim: { x: 3, y: 0 },
      }),
    ).toEqual({
      ok: false,
      reason:
        "the caster's position is unreadable, so no direction can be derived",
    });
  });
});

describe("orderLabel (M10 queue readout)", () => {
  const nameOf = (id: string) => (id === "u-b-0" ? "Blue Infantry" : id);

  test("an attack names its target, and a missing document falls back to the id", () => {
    expect(orderLabel({ kind: "attack", targetUnitId: "u-b-0" }, nameOf)).toBe(
      "attack → Blue Infantry",
    );
    expect(orderLabel({ kind: "attack", targetUnitId: "u-gone" }, nameOf)).toBe(
      "attack → u-gone",
    );
  });

  test("a cast says which spell and which payload it carries", () => {
    expect(
      orderLabel(
        {
          kind: "custom",
          type: "spell_aoe",
          data: { spell: "fireball", x: 12, y: 30 },
        },
        nameOf,
      ),
    ).toBe("cast fireball → (12, 30)");
    expect(
      orderLabel(
        {
          kind: "custom",
          type: "spell_aoe",
          data: { spell: "burning-hands", dirX: 15, dirY: -5 },
        },
        nameOf,
      ),
    ).toBe("cast burning-hands → dir (15, -5)");
    // An unnamed spell reads as the default, exactly as the resolver treats it.
    expect(
      orderLabel(
        { kind: "custom", type: "spell_aoe", data: { x: 1, y: 2 } },
        nameOf,
      ),
    ).toBe("cast default spell → (1, 2)");
    expect(
      orderLabel({ kind: "custom", type: "volley", data: {} }, nameOf),
    ).toBe("custom (volley)");
  });

  test("the pre-existing kinds keep reading the way they did", () => {
    expect(
      orderLabel(
        { kind: "move", path: [{ x: 1, y: 2 }], pace: "march" },
        nameOf,
      ),
    ).toBe("move → 1 wp (march)");
    expect(
      orderLabel({ kind: "retreat", toward: { x: 4.0004, y: -2 } }, nameOf),
    ).toBe("retreat → (4, -2)");
    expect(orderLabel({ kind: "hold", stance: "screen" }, nameOf)).toBe(
      "hold (screen)",
    );
    expect(orderLabel({ kind: "formation", formation: "square" }, nameOf)).toBe(
      "formation (square)",
    );
    expect(orderLabel({ kind: "supply", action: "redistribute" }, nameOf)).toBe(
      "supply (redistribute)",
    );
  });
});
