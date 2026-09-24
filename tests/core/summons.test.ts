import { describe, expect, test } from "vitest";
import type { ActorDocument, MacroDocument, SceneDocument, TokenDocument, WorldCollections } from "../../src/core/documents";
import { planSummon, summonDeletionOps, summonMarker, summonPlacementError, validateSummon, type SummonDefinition } from "../../src/core/summons";
import { projectEnvelope, projectWorld } from "../../src/core/projection";
import type { OpEnvelope } from "../../src/core/ops";
import { emptyWorld } from "../net/fixtures";

const definition: SummonDefinition = { version: 1, sceneId: "s1", source: { kind: "world", actorId: "source" },
  playerCallable: true, maxDistance: 30, durationMs: 60_000, size: 1.5 };
const source: ActorDocument = { _id: "source", type: "actor", name: "Wolf", ownership: { default: 0 },
  flags: { private: { value: "secret flag" } }, system: { hp: 22 }, items: [], effects: [] };
const caster: TokenDocument = { _id: "caster", type: "token", name: "Caster", ownership: { default: 0, rex: 3 },
  flags: {}, system: {}, x: 150, y: 150, width: 100, height: 100, rotation: 0, img: "", hidden: false,
  disposition: "friendly", vision: true, light: { radius: 0, alpha: 0, color: "#ffffff" } };
const scene: SceneDocument = { _id: "s1", type: "scene", name: "Field", ownership: { default: 2 }, flags: {}, system: {},
  active: true, img: null, width: 1000, height: 1000, darkness: 0, grid: { type: "square", size: 100,
    distance: 5, units: "ft", diagonals: "555", hexLayout: "oddQ" }, tokens: [caster], walls: [], lights: [],
  sounds: [], tiles: [], drawings: [], templates: [], notes: [] };
const preset: MacroDocument = { _id: "preset", type: "macro", kind: "summon", name: "Call a wolf",
  command: "PRIVATE COMMAND", ownership: { default: 1 }, flags: { core: { note: "GM secret" } },
  system: { origin: "hidden" }, summon: definition };
const rex = { id: "rex", role: "PLAYER" as const };
const ivy = { id: "ivy", role: "PLAYER" as const };

function planned() {
  return planSummon({ definition, presetId: "preset", source, scene, caller: rex, summoner: caster,
    at: { x: 350, y: 350 }, instanceId: "instance-1", actorId: "actor-1", tokenId: "token-1",
    now: 1000, manifest: {} });
}

describe("GM-reviewed summon definition, instance planning and lifecycle", () => {
  test("rejects unsafe source paths, extra fields, invalid range, duration and unknown source kind", () => {
    expect(validateSummon(definition).ok).toBe(true);
    for (const edit of [
      { ...definition, source: { kind: "compendium", packageId: "rules", packFile: "../secret.json", entryId: "e" } },
      { ...definition, source: { kind: "arbitrary", actorId: "source" } },
      { ...definition, maxDistance: NaN },
      { ...definition, durationMs: 1 },
      { ...definition, playerCallable: false, grantCode: "eval" },
    ]) expect(validateSummon(edit).ok).toBe(false);
  });

  test("creates independent linked actor/token, preserves source, bounds/range and shareable image rights", () => {
    const first = planned();
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.ops).toHaveLength(2);
    expect(first.actor).toMatchObject({ _id: "actor-1", system: { hp: 22 }, flags: { summon: {
      ownerId: "rex", actorId: "actor-1", tokenId: "token-1", expiresAt: 61_000 } } });
    expect(first.token).toMatchObject({ actorId: "actor-1", x: 350, y: 350, width: 150, height: 150 });
    expect(source.flags.private).toBeDefined();
    expect(first.actor.flags.private).toBeUndefined();
    (first.actor.system as { hp: number }).hp = 1;
    expect(source.system.hp).toBe(22);
    expect(summonMarker(first.token)?.instanceId).toBe("instance-1");
    expect(planSummon({ definition, presetId: "preset", source, scene, caller: rex, summoner: caster,
      at: { x: 990, y: 350 }, instanceId: "i2", actorId: "a2", tokenId: "t2",
      now: 1000, manifest: {} }).ok).toBe(false);
    expect(planSummon({ definition: { ...definition, maxDistance: 1 }, presetId: "preset", source, scene,
      caller: rex, summoner: caster, at: { x: 350, y: 350 }, instanceId: "i2", actorId: "a2", tokenId: "t2",
      now: 1000, manifest: {} }).ok).toBe(false);
    const art = "d".repeat(64);
    const withImg = { ...source, img: art } as ActorDocument;
    const args = { definition, presetId: "preset", source: withImg, scene, caller: rex, summoner: caster,
      at: { x: 350, y: 350 }, instanceId: "i2", actorId: "a2", tokenId: "t2", now: 1000 };
    const blocked = planSummon({ ...args, manifest: { [art]: { name: "secret.png", mime: "image/png",
      chunks: 1, size: 10, visibility: "gm" } } });
    const allowed = planSummon({ ...args, manifest: { [art]: { name: "shared.png", mime: "image/png",
      chunks: 1, size: 10, visibility: "referenced" } } });
    expect(blocked.ok && blocked.token.img).toBe("");
    expect(allowed.ok && allowed.token.img).toBe(art);
  });

  test("shared crosshair/host placement rejects blocked sight but permits an open door", () => {
    const wall = { _id: "barrier", type: "wall" as const, name: "Gate", flags: {}, system: {},
      ownership: { default: 0 as const }, c: [250, 100, 250, 500] as [number, number, number, number],
      door: 0 as const, oneWay: false, move: 1 as const, sight: 1 as const,
      sound: 1 as const, light: 1 as const };
    const blockedScene = { ...scene, walls: [wall] };
    const checked = { ...definition, requireLoS: true };
    expect(summonPlacementError(blockedScene, checked, { x: 350, y: 350 }, caster))
      .toContain("sight-blocking wall");
    expect(planSummon({ definition: checked, scene: blockedScene, source, caller: rex, summoner: caster,
      presetId: "preset", at: { x: 350, y: 350 }, instanceId: "id", actorId: "aid", tokenId: "tid",
      now: 1000, manifest: {} }).ok).toBe(false);
    const open = { ...blockedScene, walls: [{ ...wall, door: 1 as const }] };
    expect(summonPlacementError(open, checked, { x: 350, y: 350 }, caster)).toBeNull();
  });

  test("deleting token, instance actor or scene removes only linked counterpart; source survives", () => {
    const first = planned();
    if (!first.ok) throw new Error(first.error);
    const world: WorldCollections = { ...emptyWorld(), scenes: [{ ...scene, tokens: [...scene.tokens, first.token] }],
      actors: [source, first.actor] };
    const tokenRef = { coll: "tokens" as const, id: first.token._id,
      parent: { coll: "scenes" as const, id: scene._id } };
    const tokenDel = summonDeletionOps(world, [{ kind: "delete", ref: tokenRef }]);
    expect(tokenDel).toEqual([{ kind: "delete", ref: tokenRef },
      { kind: "delete", ref: { coll: "actors", id: first.actor._id } }]);
    const actorDel = summonDeletionOps(world, [{ kind: "delete", ref: { coll: "actors", id: first.actor._id } }]);
    expect(actorDel).toEqual([{ kind: "delete", ref: { coll: "actors", id: first.actor._id } },
      { kind: "delete", ref: tokenRef }]);
    expect(summonDeletionOps(world, [{ kind: "delete", ref: { coll: "scenes", id: "s1" } }]))
      .toEqual([{ kind: "delete", ref: { coll: "scenes", id: "s1" } },
        { kind: "delete", ref: { coll: "actors", id: "actor-1" } }]);
    expect(summonDeletionOps(world, [{ kind: "delete", ref: { coll: "actors", id: "source" } }]))
      .toHaveLength(1);
  });

  test("snapshots, create/update envelopes hide source/instance markers, retain safe dismissal status", () => {
    const first = planned();
    if (!first.ok) throw new Error(first.error);
    const world: WorldCollections = { ...emptyWorld(), scenes: [{ ...scene, tokens: [...scene.tokens, first.token] }],
      actors: [source, first.actor], macros: [preset] };
    for (const viewer of [rex, ivy]) {
      const view = projectWorld(world, 1, viewer);
      const pub = view.collections.macros?.[0];
      expect(pub?.summon).toMatchObject({ version: 1, sceneId: "s1", playerCallable: true, maxDistance: 30 });
      expect(JSON.stringify(pub)).not.toContain("source");
      expect(JSON.stringify(pub)).not.toContain("PRIVATE COMMAND");
      const token = view.collections.scenes?.[0]?.tokens.find((t) => t._id === "token-1");
      expect(token?.flags.summon).toBeUndefined();
      expect(token?.flags.summonStatus).toEqual({ ownerId: "rex", expiresAt: 61_000 });
      expect(view.collections.actors?.find((a) => a._id === "actor-1")?.flags.summon).toBeUndefined();
      if (viewer === ivy) expect(view.collections.actors?.some((a) => a._id === "actor-1")).toBe(false);
      const env: OpEnvelope = { seq: 2, ts: 1000, txId: "tx", by: "gm", ops: [
        { kind: "create", coll: "macros", data: preset }, ...first.ops ] };
      const projected = projectEnvelope(env, viewer, { resolve: () => world.scenes[0] });
      expect(JSON.stringify(projected)).not.toContain("source");
      expect(JSON.stringify(projected)).not.toContain("instance-1");
      expect(JSON.stringify(projected)).not.toContain("GM secret");
      expect(JSON.stringify(projected)).not.toContain("secret flag");
    }
    const unpublished = { ...preset, summon: { ...definition, playerCallable: false } };
    expect(projectWorld({ ...world, macros: [unpublished] }, 2, rex).collections.macros).toEqual([]);
  });
});
