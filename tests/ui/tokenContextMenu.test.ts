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
  moduleActionEntryId,
  parseModuleActionEntryId,
  playerTokenContextMenuModel,
  tokenCombatant,
  tokenContextMenuModel,
  toggleTokenHiddenOp,
} from "../../src/ui/combat/tokenContextMenu";
import type { ActorDocument } from "../../src/core/documents";

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
      actors: [],
      combat: c,
      scene: scene([hero, lurker]),
      token: hero,
      user: gm,
    });
    expect(inEncounter.entries.map((e) => [e.id, e.label])).toEqual([
      ["initiative", "Initiative: 17"],
      ["remove-combatant", "Remove from encounter"],
      ["toggle-hidden", "Hide token"],
      // E02: no PF1e actor on this fixture token — the entry exists but explains why.
      ["apply-effect", "Apply effect…"],
    ]);
    // display entry stays "disabled" (informational); the actionable ones are enabled
    // (apply-effect stays disabled here — the fixture token links no PF1e actor)
    expect(
      inEncounter.entries
        .filter((e) => e.id !== "initiative" && e.id !== "apply-effect")
        .every((e) => !e.disabled),
    ).toBe(true);

    const outsider = tokenContextMenuModel({
      actors: [],
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
      actors: [],
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
      actors: [],
      combat: c,
      scene: scene([hero]),
      token: hero,
      user: player, // combat default ownership 3 = owner… use a private combat:
    });
    const privateCombat = { ...c, ownership: { default: 0 } } as CombatDocument;
    const denied = tokenContextMenuModel({
      actors: [],
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
      actors: [],
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
      actors: [],
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
      actors: [],
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
      actors: [],
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
      actors: [],
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
        actors: [],
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
        actors: [],
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

// D-468: the player shell's reduced menu — sheet + shared light actions, never roster controls.
describe("playerTokenContextMenuModel", () => {
  const playerScene = (tokens: TokenDocument[]): SceneDocument =>
    ({ ...scene(tokens), ownership: { default: 2 } }) as SceneDocument;
  const actor = (id: string, ownership: Record<string, number>): ActorDocument =>
    ({ _id: id, type: "actor", name: id, ownership, flags: {}, system: {}, items: [], effects: [] }) as unknown as ActorDocument;
  const light = { enabled: true, reason: null, active: false, sourceName: null };

  test("the player gets the sheet of a readable character and live light actions on a token they control", () => {
    const own = token("own", { ownership: { default: 0, p1: 3 }, actorId: "a1" });
    const model = playerTokenContextMenuModel({
      scene: playerScene([own]), token: own, user: player, actors: [actor("a1", { default: 0, p1: 3 })], lightActions: light,
    });
    expect(model.title).toBe("own");
    expect(model.entries.map((e) => e.id)).toEqual([
      "open-sheet", "token-light-toggle", "token-light-next", "token-light-select", "token-light-off", "token-light-settings",
    ]);
    expect(model.entries.every((e) => !e.disabled)).toBe(true);
    expect(model.entries[1]?.label).toBe("Turn carried light on");
    // No roster, visibility or effect entries — those are the GM's.
    expect(model.entries.some((e) => ["initiative", "add-combatant", "toggle-hidden", "apply-effect"].includes(e.id))).toBe(false);
  });

  test("another player's token: everything stays visible but disabled, with the reason", () => {
    const foreign = token("foreign", { ownership: { default: 0, p2: 3 }, actorId: "a2" });
    const model = playerTokenContextMenuModel({
      scene: playerScene([foreign]), token: foreign, user: player, actors: [actor("a2", { default: 0, p2: 3 })], lightActions: light,
    });
    expect(model.entries[0]).toMatchObject({ id: "open-sheet", disabled: true, reason: "You cannot view this character." });
    for (const entry of model.entries.slice(1)) expect(entry).toMatchObject({ disabled: true, reason: "You do not control this token." });
  });

  test("the provider's own state wins when the token is controlled; no provider means no light entries", () => {
    const own = token("own", { ownership: { default: 0, p1: 3 } });
    const waiting = playerTokenContextMenuModel({
      scene: playerScene([own]), token: own, user: player, actors: [],
      lightActions: { enabled: false, reason: "Allow the token-light module when prompted.", active: false },
    });
    expect(waiting.entries[0]).toMatchObject({ id: "open-sheet", disabled: true, reason: "This token has no character." });
    expect(waiting.entries[1]).toMatchObject({ id: "token-light-toggle", disabled: true, reason: "Allow the token-light module when prompted." });
    const bare = playerTokenContextMenuModel({ scene: playerScene([own]), token: own, user: player, actors: [] });
    expect(bare.entries.map((e) => e.id)).toEqual(["open-sheet"]);
  });

  test("an active carried light flips the toggle label and names the source", () => {
    const own = token("own", { ownership: { default: 0, p1: 3 } });
    const model = playerTokenContextMenuModel({
      scene: playerScene([own]), token: own, user: player, actors: [],
      lightActions: { enabled: true, reason: null, active: true, sourceName: "Torch" },
    });
    expect(model.entries[1]?.label).toBe("Turn carried light off · Torch");
  });
});

describe("D-469 — manifest token actions in both menus", () => {
  const actions = [
    { packageId: "mounts", id: "mount", label: "Mount up", enabled: true, reason: null },
    { packageId: "mounts", id: "dismount", label: "Dismount", enabled: false, reason: "The module is starting." },
  ];
  const playerScene = (tokens: TokenDocument[]): SceneDocument =>
    ({ ...scene(tokens), ownership: { default: 2 } }) as SceneDocument;

  test("entry ids round-trip and never collide with the built-in entries", () => {
    expect(moduleActionEntryId("mounts", "mount")).toBe("module-action:mounts:mount");
    expect(parseModuleActionEntryId("module-action:mounts:mount")).toEqual({ packageId: "mounts", actionId: "mount" });
    expect(parseModuleActionEntryId("module-action:mounts:")).toBeNull();
    expect(parseModuleActionEntryId("token-light-toggle")).toBeNull();
  });

  test("the player menu adds them after the sheet entry, disabled with the module's reason or the ownership reason", () => {
    const own = token("own", { ownership: { default: 0, p1: 3 } });
    const other = token("other", { ownership: { default: 0 } });
    const mine = playerTokenContextMenuModel({ scene: playerScene([own, other]), token: own, user: player, actors: [], moduleActions: actions });
    expect(mine.entries.map((e) => e.id)).toEqual(["open-sheet", "module-action:mounts:mount", "module-action:mounts:dismount"]);
    expect(mine.entries[1]).toMatchObject({ label: "Mount up", disabled: false, reason: null });
    expect(mine.entries[2]).toMatchObject({ label: "Dismount", disabled: true, reason: "The module is starting." });
    const theirs = playerTokenContextMenuModel({ scene: playerScene([own, other]), token: other, user: player, actors: [], moduleActions: actions });
    expect(theirs.entries[1]).toMatchObject({ disabled: true, reason: "You do not control this token." });
  });

  test("the GM menu appends them after the light entries with the module's own state", () => {
    const hero = token("hero", {});
    const model = tokenContextMenuModel({ combat: null, scene: scene([hero]), token: hero, user: gm, actors: [], moduleActions: actions });
    const ids = model.entries.map((e) => e.id);
    expect(ids.slice(-2)).toEqual(["module-action:mounts:mount", "module-action:mounts:dismount"]);
    expect(model.entries.at(-1)).toMatchObject({ disabled: true, reason: "The module is starting." });
  });
});
