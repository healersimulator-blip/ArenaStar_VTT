/**
 * D-311 (SQ-12 / A09) — the use path: which cue a committed item use asks the host for.
 *
 * This is the half a table actually feels. The rules are pinned in `tests/core/fxBinding`;
 * what matters here is the join — recognition of the committed outcome, the reader's own view
 * of which timelines exist (the projection already gated it), the scene and tokens the run
 * should name, and what happens when there is nothing to play.
 */
import { describe, expect, test } from "vitest";
import { boundCueFor, boundCuesFor, fireBoundItemCue, fxCastOutcome } from "../../src/ui/sheets/fxItemCue";
import type { ActorDocument, ItemDocument, MacroDocument, SceneDocument } from "../../src/core/documents";

const spell = (): ItemDocument => ({ _id: "wand", type: "item", name: "Wand of Sparks",
  ownership: { default: 0 }, flags: {}, system: {}, effects: [] } as ItemDocument);
const hero = (): ActorDocument => ({ _id: "a-hero", type: "actor", name: "Hero",
  ownership: { default: 0 }, flags: {}, system: {}, items: [spell()], effects: [] });
const ogre = (): ActorDocument => ({ _id: "a-ogre", type: "actor", name: "Ogre",
  ownership: { default: 0 }, flags: {}, system: {}, items: [], effects: [] });

const timeline = (id: string, fxItem?: MacroDocument["fxItem"]): MacroDocument => ({
  _id: id, type: "macro", name: id, command: "", kind: "sequence", ownership: { default: 1 },
  flags: {}, system: {}, sequence: { version: 1, audience: "scene", persistent: false,
    sections: [{ id: "s", kind: "text", text: "boom", at: { kind: "point", x: 5, y: 5 },
      startMs: 0, durationMs: 400, color: "#ffffff", scale: 1 }] },
  ...(fxItem ? { fxItem } : {}) } as MacroDocument);

function scene(tokens: Array<{ id: string; actorId: string }>, active = true): SceneDocument {
  return { _id: "s1", type: "scene", name: "Scene", ownership: { default: 2 }, flags: {},
    system: {}, active, img: null, width: 1000, height: 1000, darkness: 0,
    grid: { type: "square", size: 100, distance: 5, units: "ft", diagonals: "555", hexLayout: "oddQ" },
    tokens: tokens.map((t) => ({ _id: t.id, type: "token" as const, name: t.id,
      ownership: { default: 0 }, flags: {}, system: {}, actorId: t.actorId, x: 100, y: 100,
      width: 100, height: 100, rotation: 0, hidden: false, disposition: "neutral" as const,
      vision: false, light: { radius: 0, alpha: 0, color: "#fff" } })),
    walls: [], lights: [], sounds: [], tiles: [], drawings: [], templates: [], notes: []
  } as unknown as SceneDocument;
}

/** A client whose store is exactly what the reader can see, and which records the requests. */
function client(world: { macros?: MacroDocument[]; scenes?: SceneDocument[]; actors?: ActorDocument[] }) {
  const requested: Array<{ macroId: string; sceneId: string; source?: string; target?: string }> = [];
  return {
    requested,
    store: {
      getAll: (coll: "macros" | "scenes" | "actors") =>
        coll === "macros" ? world.macros ?? [] : coll === "scenes" ? world.scenes ?? []
          : world.actors ?? [],
      get: (coll: "macros" | "scenes" | "actors", id: string) =>
        (coll === "macros" ? world.macros ?? [] : coll === "scenes" ? world.scenes ?? []
          : world.actors ?? []).find((entry) => entry._id === id),
    },
    requestSequence: (macroId: string, sceneId: string, source?: string, target?: string) => {
      requested.push({ macroId, sceneId, ...(source ? { source } : {}), ...(target ? { target } : {}) });
      return "req";
    },
  } as unknown as Parameters<typeof fireBoundItemCue>[0]["client"] & {
    requested: typeof requested;
  };
}

describe("firing an item's bound cue (D-311)", () => {
  test("recognition reads the committed outcome, and a pending cast commits nothing", () => {
    expect(fxCastOutcome({})).toBe("success");
    expect(fxCastOutcome({ lost: true })).toBe("failure"); // ruined after committing
    expect(fxCastOutcome({ held: true })).toBe("failure"); // melee touch missed, charge spent
    expect(fxCastOutcome({ touch: { hit: false } })).toBe("failure");
    expect(fxCastOutcome({ touch: { hit: true } })).toBe("success");
    expect(fxCastOutcome({ result: { resisted: true } })).toBe("failure"); // spell resistance
    expect(fxCastOutcome({ result: { passed: true } })).toBe("failure"); // the target saved
    expect(fxCastOutcome({ result: { passed: false } })).toBe("success");
    // A longer casting time has landed nothing yet — there is no result to recognise.
    expect(fxCastOutcome({ pending: { round: 3 } })).toBe("unknown");
  });

  test("a committed use asks for the branch its outcome names, with scene and both tokens", () => {
    const both = timeline("hit", { actorId: "a-hero", itemId: "wand", onFailureId: "miss" });
    const c = client({ macros: [both], scenes: [scene([{ id: "t-hero", actorId: "a-hero" },
      { id: "t-ogre", actorId: "a-ogre" }])] });
    const hit = fireBoundItemCue({ client: c, actor: hero(), item: spell(), outcome: "success",
      targetActor: ogre() });
    expect(hit.fired).toBe(true);
    expect(c.requested).toEqual([{ macroId: "hit", sceneId: "s1", source: "t-hero", target: "t-ogre" }]);

    const miss = fireBoundItemCue({ client: c, actor: hero(), item: spell(), outcome: "failure",
      targetActor: ogre() });
    expect(miss.fired).toBe(true);
    if (miss.fired) expect(miss.macroId).toBe("miss");
    expect(c.requested[1]?.macroId).toBe("miss");
    // An unlocated actor still names the scene: the host's own anchor rules decide.
    const noTokens = client({ macros: [both], scenes: [scene([])] });
    expect(fireBoundItemCue({ client: noTokens, actor: hero(), item: spell(), outcome: "success" }))
      .toMatchObject({ fired: true, macroId: "hit" });
    expect(noTokens.requested[0]).toEqual({ macroId: "hit", sceneId: "s1" });
  });

  test("nothing to play is an answer, not a crash", () => {
    const c = client({ macros: [timeline("plain")], scenes: [scene([{ id: "t", actorId: "a-hero" }])] });
    expect(fireBoundItemCue({ client: c, actor: hero(), item: spell(), outcome: "success" }))
      .toEqual({ fired: false, reason: "unbound" });
    expect(c.requested).toHaveLength(0);

    const missOnly = client({ macros: [timeline("hit", { actorId: "a-hero", itemId: "wand",
      onFailureId: "miss" })], scenes: [scene([{ id: "t", actorId: "a-hero" }])] });
    expect(fireBoundItemCue({ client: missOnly, actor: hero(), item: spell(), outcome: "failure" }))
      .toMatchObject({ fired: true, macroId: "miss" });
    // …and with no failure cue bound, a miss plays nothing rather than the hit cue.
    const hitOnly = client({ macros: [timeline("hit", { actorId: "a-hero", itemId: "wand" })],
      scenes: [scene([{ id: "t", actorId: "a-hero" }])] });
    expect(fireBoundItemCue({ client: hitOnly, actor: hero(), item: spell(), outcome: "failure" }))
      .toEqual({ fired: false, reason: "no-branch" });

    const off = client({ macros: [timeline("hit", { actorId: "a-hero", itemId: "wand",
      enabled: false })], scenes: [scene([{ id: "t", actorId: "a-hero" }])] });
    expect(fireBoundItemCue({ client: off, actor: hero(), item: spell(), outcome: "success" }))
      .toEqual({ fired: false, reason: "disabled" });

    const noScene = client({ macros: [timeline("hit", { actorId: "a-hero", itemId: "wand" })] });
    expect(fireBoundItemCue({ client: noScene, actor: hero(), item: spell(), outcome: "success" }))
      .toEqual({ fired: false, reason: "no-scene" });
  });

  test("the reader only ever sees bindings it could already read", () => {
    // The store *is* the projection: a GM-only timeline is simply not in a player's replica,
    // so the item looks unbound to them and nothing is requested.
    const gmOnly = timeline("secret", { actorId: "a-hero", itemId: "wand" });
    const player = client({ macros: [], scenes: [scene([{ id: "t", actorId: "a-hero" }])] });
    expect(boundCueFor(player, "a-hero", "wand")).toBeNull();
    const gm = client({ macros: [gmOnly], scenes: [scene([{ id: "t", actorId: "a-hero" }])] });
    expect(boundCueFor(gm, "a-hero", "wand")?._id).toBe("secret");
    expect(boundCuesFor(gm, "a-hero", "sword")).toEqual([]);
    // Two timelines on one item is refused by the host, and if a hand-edited world has them
    // the tie is broken by id rather than by iteration order.
    const second = timeline("aaa", { actorId: "a-hero", itemId: "wand" });
    const both = client({ macros: [gmOnly, second], scenes: [scene([{ id: "t", actorId: "a-hero" }])] });
    expect(boundCuesFor(both, "a-hero", "wand").map((m) => m._id)).toEqual(["aaa", "secret"]);
  });
});
