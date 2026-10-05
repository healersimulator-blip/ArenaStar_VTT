/**
 * D-311 (SQ-12 / A09) — the use path: which cue a committed item use asks the host for.
 *
 * This is the half a table actually feels. The rules are pinned in `tests/core/fxBinding`;
 * what matters here is the join — recognition of the committed outcome, the reader's own view
 * of which timelines exist (the projection already gated it), the scene and tokens the run
 * should name, and what happens when there is nothing to play.
 */
import { describe, expect, test } from "vitest";
import { boundCueFor, boundCuesFor, boundSpellCueFor, castSpellCueNote, fireBoundItemCue,
  fireBoundSpellCue, fxCastOutcome } from "../../src/ui/sheets/fxItemCue";
import type { ActorDocument, ItemDocument, MacroDocument, SceneDocument } from "../../src/core/documents";

const spell = (): ItemDocument => ({ _id: "wand", type: "item", name: "Wand of Sparks",
  ownership: { default: 0 }, flags: {}, system: {}, effects: [] } as ItemDocument);
const hero = (): ActorDocument => ({ _id: "a-hero", type: "actor", name: "Hero",
  ownership: { default: 0 }, flags: {}, system: {}, items: [spell()], effects: [] });
const ogre = (): ActorDocument => ({ _id: "a-ogre", type: "actor", name: "Ogre",
  ownership: { default: 0 }, flags: {}, system: {}, items: [], effects: [] });

const vines = (id: string, fxSpell?: MacroDocument["fxSpell"]): MacroDocument => ({
  _id: id, type: "macro", name: id, command: "", kind: "sequence", ownership: { default: 1 },
  flags: {}, system: {}, sequence: { version: 1, audience: "scene", persistent: false,
    sections: [{ id: "s", kind: "image", assetId: "vine", at: { kind: "target" },
      startMs: 0, durationMs: 4_000 }] },
  ...(fxSpell ? { fxSpell } : {}) } as unknown as MacroDocument);

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

  test("the lookup and the fire path are per event: a swing cue is not a use cue (D-312)", () => {
    const burn = timeline("burn", { actorId: "a-hero", itemId: "axe" });
    const swing = timeline("swing", { actorId: "a-hero", itemId: "axe", events: ["attack"],
      onFailureId: "whiff" });
    const whiff = timeline("whiff");
    const c = client({ macros: [burn, swing, whiff],
      scenes: [scene([{ id: "t-hero", actorId: "a-hero" }, { id: "t-ogre", actorId: "a-ogre" }])] });

    // The item window reads two independent lines; each event finds its own cue.
    expect(boundCueFor(c, "a-hero", "axe")?._id).toBe("burn");
    expect(boundCueFor(c, "a-hero", "axe", "attack")?._id).toBe("swing");
    expect(boundCuesFor(c, "a-hero", "axe", "attack").map((m) => m._id)).toEqual(["swing"]);

    // A charge burn neither borrows the swing cue nor its failure cue.
    const burnOutcome = fireBoundItemCue({ client: c, actor: hero(), item: { _id: "axe" },
      outcome: "failure", targetActor: ogre() });
    expect(burnOutcome).toEqual({ fired: false, reason: "no-branch" }); // burn has no failure cue

    // The swing follows its own roll, and a miss plays the swing's failure cue.
    const hit = fireBoundItemCue({ client: c, actor: hero(), item: { _id: "axe" },
      outcome: "success", event: "attack", targetActor: ogre() });
    expect(hit).toMatchObject({ fired: true, macroId: "swing" });
    expect(c.requested.at(-1)).toEqual({ macroId: "swing", sceneId: "s1", source: "t-hero", target: "t-ogre" });
    const miss = fireBoundItemCue({ client: c, actor: hero(), item: { _id: "axe" },
      outcome: "failure", event: "attack", targetActor: ogre() });
    expect(miss).toMatchObject({ fired: true, macroId: "whiff" });
    if (miss.fired) expect(miss.note).toContain('bound failure cue "whiff" requested');

    // An item bound only to a swing reads as unbound to a use — and vice versa.
    const swingOnly = client({ macros: [swing, whiff],
      scenes: [scene([{ id: "t", actorId: "a-hero" }])] });
    expect(fireBoundItemCue({ client: swingOnly, actor: hero(), item: { _id: "axe" },
      outcome: "success" })).toEqual({ fired: false, reason: "unbound" });
    expect(swingOnly.requested).toHaveLength(0);
    const burnOnly = client({ macros: [burn], scenes: [scene([{ id: "t", actorId: "a-hero" }])] });
    expect(fireBoundItemCue({ client: burnOnly, actor: hero(), item: { _id: "axe" },
      outcome: "success", event: "attack" })).toEqual({ fired: false, reason: "unbound" });
  });
});

describe("the spell cue (D-407)", () => {
  const world = { scenes: [scene([{ id: "t-hero", actorId: "a-hero" },
    { id: "t-ogre", actorId: "a-ogre" }])] };

  test("a landed cast plays the spell's own timeline, anchored on the caster and the target", () => {
    const c = client({ ...world, macros: [vines("fx-vines", { spellId: "entangle" })] });
    expect(boundSpellCueFor(c, "entangle")?.name).toBe("fx-vines");
    const cue = fireBoundSpellCue({ client: c, spellId: "entangle", outcome: "success",
      casterActor: hero(), targetActor: ogre() });
    expect(cue).toMatchObject({ fired: true, macroId: "fx-vines", branch: "success" });
    expect(c.requested).toEqual([{ macroId: "fx-vines", sceneId: "s1", source: "t-hero",
      target: "t-ogre" }]);
    expect(cue.fired && cue.note).toContain("bound spell cue");
  });

  test("a made save is a failure for recognition: nothing is bound, so nothing plays", () => {
    const c = client({ ...world, macros: [vines("fx-vines", { spellId: "entangle" })] });
    expect(fireBoundSpellCue({ client: c, spellId: "entangle", outcome: "failure",
      casterActor: hero(), targetActor: ogre() })).toMatchObject({ fired: false, reason: "no-branch" });
    expect(c.requested).toEqual([]);
    // …unless the author bound a failure cue, which then plays instead.
    const paired = client({ ...world, macros: [vines("fx-vines", { spellId: "entangle",
      onFailureId: "fx-fizzle" })] });
    expect(fireBoundSpellCue({ client: paired, spellId: "entangle", outcome: "failure",
      casterActor: hero() })).toMatchObject({ fired: true, macroId: "fx-fizzle" });
    expect(paired.requested).toEqual([{ macroId: "fx-fizzle", sceneId: "s1", source: "t-hero" }]);
  });

  test("an unbound or disabled spell plays nothing, and a name the catalogue lacks says nothing", () => {
    const unbound = client({ ...world, macros: [vines("fx-other", { spellId: "sleep" })] });
    expect(fireBoundSpellCue({ client: unbound, spellId: "entangle", outcome: "success",
      casterActor: hero() })).toMatchObject({ fired: false, reason: "unbound" });
    const off = client({ ...world, macros: [vines("fx-vines", { spellId: "entangle",
      enabled: false })] });
    expect(fireBoundSpellCue({ client: off, spellId: "entangle", outcome: "success",
      casterActor: hero() })).toMatchObject({ fired: false, reason: "disabled" });
    expect(off.requested).toEqual([]);
    // The note helper is the call sites' entry point: by *name*, silent when unknown.
    expect(castSpellCueNote({ client: unbound, spellName: "Magic Missile", outcome: "success",
      caster: hero() })).toBe("");
    expect(castSpellCueNote({ client: client({ ...world,
      macros: [vines("fx-vines", { spellId: "entangle" })] }), spellName: "  eNtAnGlE ",
      outcome: "success", caster: hero(), target: ogre() }))
      .toContain("bound spell cue");
    // A bound spell whose branch this outcome does not play names the *spell*, not an item.
    expect(castSpellCueNote({ client: client({ ...world,
      macros: [vines("fx-vines", { spellId: "entangle" })] }), spellName: "Entangle",
      outcome: "failure", caster: hero(), target: ogre() }))
      .toBe(" · the spell has no cue for that outcome");
  });

  test("the cast helper resolves the same spell by name, case-insensitively", () => {
    const c = client({ ...world, macros: [vines("fx-vines", { spellId: "entangle" })] });
    const note = castSpellCueNote({ client: c, spellName: "Entangle", outcome: "success",
      caster: hero(), target: ogre() });
    expect(note).toContain("bound spell cue \"fx-vines\" requested");
    expect(c.requested).toHaveLength(1);
  });
});
