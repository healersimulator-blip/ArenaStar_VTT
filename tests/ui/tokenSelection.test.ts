import { describe, expect, test } from "vitest";
import type { SceneDocument, TokenDocument } from "../../src/core/documents";
import { selectedTokens, editSelectedRoster } from "../../src/ui/combat/tokenSelection";
import { newEncounter } from "../../src/ui/combat/encounters";
import { currentCombatant, startCombat } from "../../src/core/combat";
const gm = { id: "gm", role: "GM" as const };
function fixture() {
  const scene = {
    _id: "s",
    type: "scene",
    name: "Scene",
    flags: {},
    ownership: { default: 2 },
    tokens: [
      { _id: "a", name: "A", actorId: "hero" },
      { _id: "b", name: "B" },
      { _id: "c", name: "C" },
    ] as TokenDocument[],
  } as unknown as SceneDocument;
  let id = 0;
  const combat = newEncounter(
    { ...scene, tokens: scene.tokens.slice(0, 2) },
    "combat",
    "Fight",
    () => `c${id++}`,
  );
  return { scene, combat };
}
describe("scene-tagged token selection", () => {
  test("empty selection explicitly falls back to all tokens only for encounter creation", () => {
    const { scene } = fixture();
    const empty = { sceneId: "s", ids: [] };
    expect(selectedTokens(scene, empty).tokens).toEqual([]);
    expect(selectedTokens(scene, empty, true).tokens).toEqual(scene.tokens);
    const chosen = selectedTokens(scene, { sceneId: "s", ids: ["c", "a", "a"] }, true);
    expect(chosen.tokens.map((t) => t._id)).toEqual(["a", "c"]);
    let id = 0;
    const c = newEncounter(
      { ...scene, tokens: chosen.tokens },
      "selected",
      "Selected",
      () => `id-${id++}`,
    );
    expect(c.combatants.map((member) => member.actorId)).toEqual(["hero", null]);
  });
  test("wrong-scene or partly deleted selections never silently broaden to all tokens", () => {
    const { scene } = fixture();
    for (const selection of [
      { sceneId: "wrong", ids: ["a"] },
      { sceneId: "s", ids: ["a", "deleted"] },
    ]) {
      expect(selectedTokens(scene, selection, true)).toMatchObject({
        tokens: [],
        error: expect.any(String),
      });
    }
  });
  test("add is idempotent and preserves old initiative/effect metadata", () => {
    const { scene, combat } = fixture();
    combat.combatants = combat.combatants.map((c) => ({
      ...c,
      initiative: 12,
      flags: { other: { keep: true } },
    }));
    const before = structuredClone(combat);
    const selection = { sceneId: "s", ids: ["a", "c"] };
    const result = editSelectedRoster(combat, scene, selection, gm, "add", () => "new");
    if (!result.transition) throw new Error(result.error ?? "No transition");
    expect(result.transition.combat.combatants.slice(0, 2)).toEqual(combat.combatants);
    expect(result.transition.combat.combatants[2]?.tokenId).toBe("c");
    expect(
      editSelectedRoster(
        result.transition.combat,
        scene,
        selection,
        gm,
        "add",
        () => "duplicate",
      ).transition,
    ).toBeNull();
    expect(combat).toEqual(before);
  });
  test("removing active or inactive members is allowed without advancing the round", () => {
    const { scene, combat } = fixture();
    const running = { ...startCombat(combat).combat, turn: 1 };
    const result = editSelectedRoster(
      running,
      scene,
      { sceneId: "s", ids: ["a"] },
      gm,
      "remove",
      () => "unused",
    );
    if (!result.transition) throw new Error(result.error ?? "No transition");
    expect(currentCombatant(result.transition.combat)?._id).toBe("c1");
    expect(result.transition.combat.turn).toBe(0);
    expect(result.transition.expired).toEqual([]);
    const activeRemoved = editSelectedRoster(
      running,
      scene,
      { sceneId: "s", ids: ["b"] },
      gm,
      "remove",
      () => "unused",
    );
    if (!activeRemoved.transition) throw new Error(activeRemoved.error ?? "No transition");
    expect(currentCombatant(activeRemoved.transition.combat)?._id).toBe("c0");
    expect(activeRemoved.transition.combat.round).toBe(1);
    expect(activeRemoved.transition.hooks).toEqual(["combat:combatant:update"]);
    expect(activeRemoved.transition.expired).toEqual([]);
    const empty = editSelectedRoster(
      running,
      scene,
      { sceneId: "s", ids: ["a", "b"] },
      gm,
      "remove",
      () => "unused",
    );
    expect(empty.transition?.combat).toMatchObject({ round: 1, turn: 0, combatants: [] });
    const ended = editSelectedRoster(
      combat,
      scene,
      { sceneId: "s", ids: ["a", "b"] },
      gm,
      "remove",
      () => "unused",
    );
    expect(ended.transition?.combat.combatants).toEqual([]);
  });
  test("removing the active member and its next neighbor selects the next surviving successor", () => {
    const { scene } = fixture();
    let id = 0;
    const combat = startCombat(newEncounter(scene, "all", "All", () => `c${id++}`)).combat;
    const before = structuredClone(combat);
    const result = editSelectedRoster(
      combat,
      scene,
      { sceneId: "s", ids: ["a", "b"] },
      gm,
      "remove",
      () => "unused",
    );
    if (!result.transition) throw new Error(result.error ?? "Missing transition");
    expect(currentCombatant(result.transition.combat)?._id).toBe("c2");
    expect(result.transition.combat.round).toBe(1);
    expect(combat).toEqual(before);
  });
  test("permissions, stale selection, and mismatched encounter prevent edits", () => {
    const { scene, combat } = fixture();
    const sel = { sceneId: "s", ids: ["c"] };
    for (const user of [null, { id: "p", role: "PLAYER" as const }])
      expect(
        editSelectedRoster(combat, scene, sel, user, "add", () => "new").transition,
      ).toBeNull();
    expect(
      editSelectedRoster(combat, { ...scene, _id: "other" }, sel, gm, "add", () => "new")
        .transition,
    ).toBeNull();
    expect(
      editSelectedRoster(
        combat,
        scene,
        { sceneId: "s", ids: ["missing"] },
        gm,
        "remove",
        () => "new",
      ).transition,
    ).toBeNull();
  });
});
