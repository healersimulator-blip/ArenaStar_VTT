/** G-33 (D-451): a player's replica holds only what their floors can show. */
import { expect, test } from "vitest";
import { draftLevel } from "../../src/core/levels";
import { floorDisclosure, floorReadable } from "../../src/core/floorDisclosure";
import { projectWorld } from "../../src/core/projection";
import { TOP_LEVEL_COLLECTIONS } from "../../src/core/documents";
import type { ActorDocument, LightDocument, NoteDocument, SceneDocument, TileDocument, TokenDocument, WallDocument, WorldCollections } from "../../src/core/documents";
import type { PermissionUser } from "../../src/core/ownership";

const player: PermissionUser = { id: "p1", role: "PLAYER" };
const gm: PermissionUser = { id: "gm", role: "GM" };
const base = { ownership: { default: 0 }, flags: {}, system: {} } as const;
const token = (id: string, levelId: string | undefined, extra: Partial<TokenDocument> = {}): TokenDocument => ({ ...base, _id: id, type: "token", name: id, x: 50, y: 50, width: 100, height: 100,
  rotation: 0, img: "", hidden: false, disposition: "neutral", vision: true, light: { radius: 0, color: "#fff", alpha: 0 }, ...(levelId ? { levelId } : {}), ...extra });
const wall = (id: string, levelScope?: WallDocument["levelScope"]): WallDocument => ({ ...base, _id: id, type: "wall", name: id, c: [0, 0, 100, 0], door: 0, oneWay: false, move: 0, sight: 0, sound: 0, light: 0, ...(levelScope ? { levelScope } : {}) });
const light = (id: string, levelScope?: LightDocument["levelScope"]): LightDocument => ({ ...base, _id: id, type: "light", name: id, x: 0, y: 0, dim: 100, bright: 50, color: "#ffffff", alpha: 0.5, ...(levelScope ? { levelScope } : {}) });
const tile = (id: string): TileDocument => ({ ...base, _id: id, type: "tile", name: id, x: 0, y: 0, width: 100, height: 100, img: "", above: false, occlusion: { mode: "fade", alpha: 1 } });
const note = (id: string, levelScope?: NoteDocument["levelScope"]): NoteDocument => ({ ...base, ownership: { default: 1 }, _id: id, type: "note", name: id, x: 0, y: 0, text: id, icon: "pin", visible: true, ...(levelScope ? { levelScope } : {}) });
const on = (...ids: string[]) => ({ mode: "levels" as const, ids });

/** Ground ← Upper (sees Ground) ← Attic (sees Upper only when `atticSees`); the hero is on Upper. */
function scene(atticSees = false, isolated = true): SceneDocument {
  return {
    ...base, ownership: { default: 1 }, _id: "s", type: "scene", name: "Keep", active: true, img: null, width: 1000, height: 1000, darkness: 0,
    grid: { type: "square", size: 100, distance: 5, units: "ft", diagonals: "555", hexLayout: "oddR" }, ...(isolated ? { levelMode: "isolated" as const } : {}),
    levels: [
      { ...draftLevel("ground", "Ground", 0, 10, 0), tileIds: ["t-ground"] },
      { ...draftLevel("upper", "Upper", 10, 20, 1), visibleLevelIds: ["ground"], tileIds: ["t-upper"] },
      { ...draftLevel("attic", "Attic", 20, 30, 2), visibleLevelIds: atticSees ? ["upper"] : [], tileIds: ["t-attic"] },
    ],
    tokens: [token("hero", "upper", { ownership: { default: 0, p1: 3 } }), token("orc", "ground"), token("bat", "attic"), token("loose", undefined)],
    walls: [wall("w-ground", on("ground")), wall("w-upper", on("upper")), wall("w-attic", on("attic")), wall("w-all", { mode: "all" }), wall("w-loose")],
    lights: [light("l-ground", on("ground")), light("l-attic", on("attic"))],
    tiles: [tile("t-ground"), tile("t-upper"), tile("t-attic"), tile("t-loose")],
    notes: [note("n-ground", on("ground")), note("n-upper", on("upper")), note("n-all")],
    sounds: [], drawings: [], templates: [], regions: [],
  };
}
const noActors = () => undefined;

test("a player's floors reach their own documents, the floors they see below, and the lights of a floor above that sees down", () => {
  const d = floorDisclosure(scene(), player, noActors);
  expect(d && [[...d.floors], [...d.seen].sort(), [...d.lit].sort()]).toEqual([["upper"], ["ground", "upper"], ["ground", "upper"]]);
  const lit = floorDisclosure(scene(true), player, noActors);
  expect(lit && [...lit.lit].sort()).toEqual(["attic", "ground", "upper"]);
  expect(lit && floorReadable(lit, "lights", light("l-attic", on("attic")))).toBe(true); // the attic's light falls through onto Upper
  expect(lit && floorReadable(lit, "tokens", token("bat", "attic"))).toBe(false); // but its tokens stay up there
});

test("what is readable, kind by kind", () => {
  const s = scene(), d = floorDisclosure(s, player, noActors);
  const readable = (coll: string, ids: string[], rows: Array<{ _id: string }>) => ids.filter((id) => floorReadable(d, coll, rows.find((r) => r._id === id) as never));
  expect(readable("tokens", ["hero", "orc", "bat", "loose"], s.tokens)).toEqual(["hero", "orc", "loose"]);
  expect(readable("walls", ["w-ground", "w-upper", "w-attic", "w-all", "w-loose"], s.walls)).toEqual(["w-ground", "w-upper", "w-all", "w-loose"]);
  expect(readable("lights", ["l-ground", "l-attic"], s.lights)).toEqual(["l-ground"]);
  expect(readable("tiles", ["t-ground", "t-upper", "t-attic", "t-loose"], s.tiles)).toEqual(["t-ground", "t-upper", "t-loose"]);
  expect(readable("notes", ["n-ground", "n-upper", "n-all"], s.notes)).toEqual(["n-upper", "n-all"]); // pins of a floor below stay down there
});

test("tokens controlled through their actor count; GMs, scenes outside floor play and players without tokens", () => {
  const s = scene();
  s.tokens = [token("hero", "upper", { actorId: "a-hero" }), ...s.tokens.slice(1)];
  const actor = { _id: "a-hero", type: "actor", ownership: { default: 0, p1: 3 } } as unknown as ActorDocument;
  expect(floorDisclosure(s, player, () => undefined)?.floors.size).toBe(0);
  expect([...(floorDisclosure(s, player, (id) => (id === "a-hero" ? actor : undefined))?.floors ?? [])]).toEqual(["upper"]);
  expect(floorDisclosure(s, gm, noActors)).toBeNull();
  expect(floorDisclosure(scene(false, false), player, noActors)).toBeNull();
});

test("the player's snapshot leaves other floors on the host; the GM's keeps everything", () => {
  const world = { ...Object.fromEntries(TOP_LEVEL_COLLECTIONS.map((c) => [c, []])), assetManifest: {}, scenes: [scene()] } as unknown as WorldCollections;
  const ids = (s: SceneDocument | undefined) => s && { tokens: s.tokens.map((t) => t._id), walls: s.walls.map((w) => w._id), lights: s.lights.map((l) => l._id), tiles: s.tiles.map((t) => t._id), notes: s.notes.map((n) => n._id) };
  expect(ids(projectWorld(world, 1, player).collections.scenes?.[0])).toEqual({ tokens: ["hero", "orc", "loose"], walls: ["w-ground", "w-upper", "w-all", "w-loose"], lights: ["l-ground"],
    tiles: ["t-ground", "t-upper", "t-loose"], notes: ["n-upper", "n-all"] });
  expect(ids(projectWorld(world, 1, gm).collections.scenes?.[0])?.tokens).toEqual(["hero", "orc", "bat", "loose"]);
  const flat = { ...world, scenes: [scene(false, false)] } as WorldCollections;
  expect(ids(projectWorld(flat, 1, player).collections.scenes?.[0])?.walls).toHaveLength(5);
});
