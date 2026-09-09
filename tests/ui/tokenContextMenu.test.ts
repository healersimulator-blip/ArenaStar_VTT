import { describe, expect, test } from "vitest";
import type {
  CombatDocument,
  CombatantDocument,
  SceneDocument,
  TokenDocument,
} from "../../src/core/documents";
import { startCombat } from "../../src/core/combat";
import {
  applyTokenMenuEntry,
  tokenCombatant,
  tokenContextMenuModel,
  toggleTokenHiddenOp,
} from "../../src/ui/combat/tokenContextMenu";

const gm = { id: "gm", role: "GM" as const };
const player = { id: "p1", role: "PLAYER" as const };

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
    disposition: "neutral",
    vision: true,
    light: { radius: 0, color: "#fff", alpha: 0.5 },
    ...over,
  };
}

function scene(tokens: TokenDocument[]): SceneDocument {
  return {
    _id: "scene",
    name: "Scene",
    type: "scene",
    flags: {},
    ownership: { default: 3 },
    tokens,
  } as unknown as SceneDocument;
}

function combatWith(tokens: TokenDocument[]): CombatDocument {
  const members: CombatantDocument[] = tokens.map((t) => ({
    _id: `c-${t._id}`,
    type: "combatant",
    name: t.name,
    tokenId: t._id,
    actorId: null,
    initiative: null,
    hidden: false,
    defeated: false,
    ownership: { default: 3 },
    flags: {},
    system: {},
  }));
  return startCombat({
    _id: "combat",
    type: "combat",
    name: "Fight",
    round: 0,
    turn: 0,
    ownership: { default: 3 },
    flags: {},
    system: {},
    combatants: members,
  } as unknown as CombatDocument).combat;
}

describe("token context menu model (T01)", () => {
  test("shows the initiative state, add/remove and hidden entries per token", () => {
    const hero = token("hero");
    const lurker = token("lurker", { hidden: true });
    const c = combatWith([hero]);
    const heroEntry = c.combatants.find((cb) => cb.tokenId === "hero");
    if (heroEntry) heroEntry.initiative = 17;

    const inEncounter = tokenContextMenuModel({
      combat: c,
      scene: scene([hero, lurker]),
      token: hero,
      user: gm,
    });
    expect(inEncounter.entries.map((e) => [e.id, e.label])).toEqual([
      ["initiative", "Initiative: 17"],
      ["remove-combatant", "Remove from encounter"],
      ["toggle-hidden", "Hide token"],
    ]);
    // display entry stays "disabled" (informational); the actionable ones are enabled
    expect(
      inEncounter.entries
        .filter((e) => e.id !== "initiative")
        .every((e) => !e.disabled),
    ).toBe(true);

    const outsider = tokenContextMenuModel({
      combat: c,
      scene: scene([hero, lurker]),
      token: lurker,
      user: gm,
    });
    expect(outsider.entries[0]?.label).toBe("Not in the encounter");
    expect(outsider.entries[1]?.label).toBe("Add to encounter");
    expect(outsider.entries[2]?.label).toBe("Show token"); // lurker is already hidden
  });

  test("no encounter degrades to an explained disabled add entry", () => {
    const hero = token("hero");
    const model = tokenContextMenuModel({
      combat: null,
      scene: scene([hero]),
      token: hero,
      user: gm,
    });
    expect(model.entries[0]?.label).toBe("No active encounter");
    expect(model.entries[1]?.disabled).toBe(true);
    expect(model.entries[1]?.reason).toContain("No active encounter");
  });

  test("players get state display but not the mutating entries", () => {
    const hero = token("hero");
    const c = combatWith([hero]);
    const model = tokenContextMenuModel({
      combat: c,
      scene: scene([hero]),
      token: hero,
      user: player, // combat default ownership 3 = owner… use a private combat:
    });
    const privateCombat = { ...c, ownership: { default: 0 } } as CombatDocument;
    const denied = tokenContextMenuModel({
      combat: privateCombat,
      scene: scene([hero]),
      token: hero,
      user: player,
    });
    expect(model.entries[0]?.label).toBe("Initiative: not rolled");
    expect(denied.entries[1]?.disabled).toBe(true);
    expect(denied.entries[1]?.reason).toContain(
      "You cannot update this encounter",
    );
    expect(denied.entries[2]?.disabled).toBe(false); // scene default 3: scene updates allowed
  });

  test("tokenCombatant resolves the linked member or null", () => {
    const hero = token("hero");
    const c = combatWith([hero]);
    expect(tokenCombatant(c, hero)?.id).toBe("c-hero");
    expect(tokenCombatant(null, hero)).toBeNull();
    expect(tokenCombatant(c, token("ghost"))).toBeNull();
  });
});

describe("token context menu actions (T01)", () => {
  test("add goes through the roster editor: idempotent, no duplicate members", () => {
    const hero = token("hero");
    const lurker = token("lurker");
    const c = combatWith([hero]);
    let n = 0;
    const added = applyTokenMenuEntry({
      combat: c,
      scene: scene([hero, lurker]),
      token: lurker,
      user: gm,
      entryId: "add-combatant",
      nextId: () => `id${n++}`,
    });
    expect(added.error).toBeNull();
    expect(added.transition?.combat.combatants).toHaveLength(2);
    // adding a token that is already in is a no-op transition
    const again = applyTokenMenuEntry({
      combat: added.transition?.combat ?? c,
      scene: scene([hero, lurker]),
      token: lurker,
      user: gm,
      entryId: "add-combatant",
      nextId: () => `id${n++}`,
    });
    expect(again.transition).toBeNull();
    expect(again.error).toBeNull();
  });

  test("remove preserves the active member policy and returns a transition", () => {
    const hero = token("hero");
    const lurker = token("lurker");
    const c = combatWith([hero, lurker]);
    const removed = applyTokenMenuEntry({
      combat: c,
      scene: scene([hero, lurker]),
      token: lurker,
      user: gm,
      entryId: "remove-combatant",
      nextId: () => "id",
    });
    expect(removed.error).toBeNull();
    expect(
      removed.transition?.combat.combatants.some((m) => m.tokenId === "lurker"),
    ).toBe(false);
  });

  test("hidden toggling is one authoritative token update op", () => {
    const hero = token("hero");
    const s = scene([hero]);
    const hidden = applyTokenMenuEntry({
      combat: null,
      scene: s,
      token: hero,
      user: gm,
      entryId: "toggle-hidden",
      nextId: () => "id",
    });
    expect(hidden.error).toBeNull();
    expect(hidden.transition).toBeNull();
    expect(hidden.ops).toEqual([toggleTokenHiddenOp(s, hero)]);
    expect(hidden.ops[0]).toMatchObject({
      kind: "update",
      ref: {
        coll: "tokens",
        id: "hero",
        parent: { coll: "scenes", id: "scene" },
      },
      diff: { hidden: true },
    });
    const shown = applyTokenMenuEntry({
      combat: null,
      scene: s,
      token: { ...hero, hidden: true },
      user: gm,
      entryId: "toggle-hidden",
      nextId: () => "id",
    });
    expect(shown.ops[0]).toMatchObject({
      kind: "update",
      diff: { hidden: false },
    });
  });

  test("informational and permission-refused entries explain themselves", () => {
    const hero = token("hero");
    const c = combatWith([hero]);
    expect(
      applyTokenMenuEntry({
        combat: c,
        scene: scene([hero]),
        token: hero,
        user: gm,
        entryId: "initiative",
        nextId: () => "id",
      }).error,
    ).toContain("informational");
    expect(
      applyTokenMenuEntry({
        combat: c,
        scene: scene([hero]),
        token: hero,
        user: null,
        entryId: "toggle-hidden",
        nextId: () => "id",
      }).error,
    ).toContain("You cannot update this scene");
  });
});
