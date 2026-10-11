/** D-453: raised areas inside a floor (crate stacks, scaffolds): ground, validation and sight. */
import { describe, expect, test } from "vitest";
import {
  clipToConvex, followedElevation, groundAt, raisedAreaError, raisedBarriers, raisedBlocks, raisedEyeSegments, raisedGroundOps,
  raisedSight, raisedSightKey, raisedTokenSeen, raisedVolumes,
} from "../../src/core/raisedAreas";
import { regionGeometryError } from "../../src/core/regionGeometry";
import { sceneRegionsError } from "../../src/core/regionValidation";
import { draftLevel } from "../../src/core/levels";
import { fogRevealKey, fogViewers, fogVisibleTokenIds } from "../../src/core/fogExploration";
import { tokensSeenBelow } from "../../src/core/crossFloorSight";
import { traceSurface } from "../../src/core/floorSurface";
import { unsupportedWalks } from "../../src/core/floorSupport";
import type { LevelDocument, LevelSurface, RegionDocument, SceneDocument, TokenDocument } from "../../src/core/documents";
import type { Op } from "../../src/core/ops";

const base = { flags: {}, system: {} };
const player = { id: "p", role: "PLAYER" as const };
const token = (id: string, x: number, y: number, z = 0, over: Partial<TokenDocument> = {}): TokenDocument => ({
  ...base, _id: id, type: "token", name: id, ownership: { default: 2 }, x, y, width: 100, height: 100, rotation: 0, elevation: z, img: "",
  vision: false, hidden: false, disposition: "hostile", light: { radius: 0, color: "#fff", alpha: 0 }, ...over,
});
const hero = (x = 1150, y = 1750, z = 0, over: Partial<TokenDocument> = {}) =>
  token("hero", x, y, z, { ownership: { default: 2, p: 3 }, vision: true, disposition: "friendly", ...over });
const raised = (id: string, x: number, y: number, w: number, h: number, height: number, solid: boolean, over: Partial<RegionDocument> = {}): RegionDocument => ({
  ...base, _id: id, type: "region", name: id, ownership: { default: 2 }, x, y, width: w, height: h,
  shape: { kind: "polygon", points: [[0, 0], [1, 0], [1, 1], [0, 1]] }, raised: { height, solid }, ...over,
});
/** The Ice Beacon hall: 5/10/15-ft solid crate stacks and an open 10-ft scaffold. */
const hallAreas = () => [
  raised("crates5", 600, 1400, 200, 200, 5, true), raised("crates10", 600, 1200, 200, 200, 10, true),
  raised("crates15", 800, 1200, 200, 200, 15, true), raised("scaffold", 1300, 1100, 300, 200, 10, false),
];
function flat(tokens: TokenDocument[], regions: RegionDocument[] = hallAreas()): SceneDocument {
  return { ...base, _id: "s", type: "scene", name: "Hall", ownership: { default: 2 }, active: true, img: null, width: 2200, height: 2200, darkness: 0,
    grid: { type: "square", size: 100, distance: 5, units: "ft", diagonals: "555", hexLayout: "oddQ" } as SceneDocument["grid"],
    tokens, walls: [], lights: [], sounds: [], tiles: [], regions, drawings: [], templates: [], notes: [], flags: { core: { fog: true } } };
}
/** Ground 0–20 and a gallery 20–35 that sees the ground through an opening over x 500–1700. */
const gallerySurface = traceSurface((x, y) => !(x >= 500 && x < 1700 && y >= 500 && y < 1700), { x: 0, y: 0, width: 2200, height: 2200 }, { cell: 50 }).surface as LevelSurface;
function tower(tokens: TokenDocument[], regions: RegionDocument[] = hallAreas().map((r) => ({ ...r, levelScope: { mode: "levels" as const, ids: ["hall"] } })),
  over: { gallery?: Partial<LevelDocument> } = {}): SceneDocument {
  const hall = draftLevel("hall", "Hall", 0, 20, 0);
  const gallery: LevelDocument = { ...draftLevel("gallery", "Gallery", 20, 35, 1), visibleLevelIds: ["hall"], surface: gallerySurface, ...over.gallery };
  return { ...flat(tokens, regions), levelMode: "isolated", levels: [hall, gallery] };
}
const wholeScene = new Float32Array([0, 0, 2200, 0, 2200, 2200, 0, 2200]);
const move = (id: string, diff: Record<string, unknown>): Op => ({ kind: "update", ref: { coll: "tokens", id, parent: { coll: "scenes", id: "s" } }, diff } as Op);

describe("D-453 raised areas: validation", () => {
  test("height and solid are required, bounded and alone; never on a stairwell", () => {
    expect(raisedAreaError({ height: 10, solid: true })).toBeNull();
    expect(raisedAreaError({ height: 0, solid: true })).toMatch(/height/);
    expect(raisedAreaError({ height: -5, solid: false })).toMatch(/height/);
    expect(raisedAreaError({ height: 1001, solid: false })).toMatch(/height/);
    expect(raisedAreaError({ height: Number.NaN, solid: false })).toMatch(/height/);
    expect(raisedAreaError({ height: 5, solid: "yes" })).toMatch(/solid/);
    expect(raisedAreaError({ height: 5, solid: true, climb: 2 })).toMatch(/only height and solid/);
    expect(raisedAreaError([5, true])).toMatch(/object/);
    expect(regionGeometryError(raised("r", 0, 0, 100, 100, 5, true))).toBeNull();
    expect(regionGeometryError({ ...raised("r", 0, 0, 100, 100, 5, true), raised: { height: 5 } })).toMatch(/solid/);
    expect(regionGeometryError({ ...raised("r", 0, 0, 100, 100, 5, true), stairs: { version: 2 } })).toBe("A stairwell cannot also be a raised area");
    const many = Array.from({ length: 129 }, (_, i) => raised(`r${i}`, i, 0, 10, 10, 5, true));
    expect(sceneRegionsError({ regions: many.slice(0, 128) })).toBeNull();
    expect(sceneRegionsError({ regions: many })).toBe("scene raised-area budget is 128 regions");
  });
});

describe("D-453 raised areas: ground", () => {
  test("volumes stand on the ground, on their scoped floors, or on every floor; tops stop at the next floor", () => {
    expect(raisedVolumes(flat([])).map((v) => [v.id, v.levelId, v.bottom, v.top, v.solid])).toEqual([
      ["crates5", null, 0, 5, true], ["crates10", null, 0, 10, true], ["crates15", null, 0, 15, true], ["scaffold", null, 0, 10, false]]);
    // A player's floor scene: no levels, the floor's Z is given.
    expect(raisedVolumes(flat([], [raised("r", 0, 0, 100, 100, 5, true)]), 20).map((v) => [v.bottom, v.top])).toEqual([[20, 25]]);
    const pillar = raised("pillar", 0, 0, 100, 100, 25, true);
    const unscoped = tower([], [pillar]);
    expect(raisedVolumes(unscoped).map((v) => [v.id, v.bottom, v.top, v.standable])).toEqual([
      ["pillar@hall", 0, 20, false], ["pillar@gallery", 20, 35, false]]);
    // The top floor has no ceiling.
    expect(raisedVolumes(tower([], [pillar], { gallery: { top: null } })).map((v) => [v.id, v.top, v.standable])).toEqual([
      ["pillar@hall", 20, false], ["pillar@gallery", 45, true]]);
    expect(raisedVolumes(tower([], [{ ...pillar, levelScope: { mode: "levels", ids: ["gallery"] } }])).map((v) => v.id)).toEqual(["pillar@gallery"]);
  });

  test("the ground under a centre is the highest standable top there", () => {
    const s = flat([]);
    expect(groundAt(s, token("t", 1150, 1750))).toBe(0);
    expect(groundAt(s, token("t", 650, 1450))).toBe(5);
    expect(groundAt(s, token("t", 950, 1350))).toBe(15);
    expect(groundAt(s, token("t", 800, 1300))).toBe(15); // the shared edge of the 10 and the 15: the higher
    expect(groundAt(s, token("t", 1450, 1250))).toBe(10); // open areas are stood on too
    // On a floor: its own areas, from its own Z.
    const t = tower([]);
    expect(groundAt(t, token("t", 950, 1350, 0, { levelId: "hall" }))).toBe(15);
    expect(groundAt(t, token("t", 950, 1350, 20, { levelId: "gallery" }))).toBe(20);
    // An area reaching the next floor is never stood on.
    expect(groundAt(tower([], [raised("pillar", 900, 1300, 100, 100, 20, true, { levelScope: { mode: "levels", ids: ["hall"] } })]), token("t", 950, 1350, 0, { levelId: "hall" }))).toBe(0);
  });

  test("walkers follow the ground up and down; flyers keep their height unless they land in a taller area", () => {
    const s = flat([]);
    expect(followedElevation(s, token("t", 1150, 1750, 0), { x: 750, y: 1550 })).toBe(5);
    expect(followedElevation(s, token("t", 750, 1550, 5), { x: 750, y: 1250 })).toBe(10);
    expect(followedElevation(s, token("t", 750, 1250, 10), { x: 1150, y: 1750 })).toBe(0);
    expect(followedElevation(s, token("t", 1150, 1750, 30), { x: 950, y: 1350 })).toBe(30);
    expect(followedElevation(s, token("t", 1150, 1750, 8), { x: 950, y: 1350 })).toBe(15);
    expect(followedElevation(s, token("t", 1150, 1750, 8), { x: 1150, y: 1650 })).toBe(8);
    expect(followedElevation(flat([], []), token("t", 0, 0, 3), { x: 950, y: 1350 })).toBe(3);
  });

  test("the host appends one elevation update per walking token; explicit heights, floors and prefab parts are left alone", () => {
    const s = flat([token("t", 1150, 1750), token("flyer", 1150, 1650, 30), token("rider", 1050, 1750, 0, { flags: { prefab: { parentId: "t" } } })]);
    const scenes = (id: string) => (id === "s" ? s : undefined);
    expect(raisedGroundOps([move("t", { x: 950, y: 1350 })], scenes)).toEqual([move("t", { elevation: 15 })]);
    // A path in two steps: judged from where it started to where it ended.
    expect(raisedGroundOps([move("t", { x: 750, y: 1550 }), move("t", { x: 1150, y: 1650 })], scenes)).toEqual([]);
    expect(raisedGroundOps([move("t", { x: 950, y: 1350, elevation: 2 })], scenes)).toEqual([]);
    expect(raisedGroundOps([move("t", { x: 950, y: 1350 }), move("t", { levelId: "x" })], scenes)).toEqual([]);
    expect(raisedGroundOps([move("flyer", { x: 950, y: 1350 })], scenes)).toEqual([]);
    expect(raisedGroundOps([move("rider", { x: 950, y: 1350 })], scenes)).toEqual([]);
    expect(raisedGroundOps([move("t", { rotation: 90 })], scenes)).toEqual([]);
    expect(raisedGroundOps([move("t", { x: 950, y: 1350 }), { kind: "delete", ref: { coll: "tokens", id: "t", parent: { coll: "scenes", id: "s" } } }], scenes)).toEqual([]);
    // Dropped onto the crates at floor height: it stands on top.
    const create: Op = { kind: "create", coll: "tokens", parent: { coll: "scenes", id: "s" }, data: token("new", 650, 1450) };
    expect(raisedGroundOps([create], scenes)).toEqual([move("new", { elevation: 5 })]);
    expect(raisedGroundOps([{ ...create, data: token("new", 650, 1450, 12) }], scenes)).toEqual([]);
    // No raised areas: nothing to do.
    expect(raisedGroundOps([move("t", { x: 950, y: 1350 })], () => flat([token("t", 1150, 1750)], []))).toEqual([]);
  });

  test("G-23: a player walking off a crate stack into an opening is refused like any walk into it", () => {
    const crate = raised("crate", 1700, 900, 200, 200, 5, true, { levelScope: { mode: "levels", ids: ["gallery"] } });
    const s = tower([token("t", 1750, 950, 25, { levelId: "gallery" })], [crate]);
    const scenes = (id: string) => (id === "s" ? s : undefined);
    expect(unsupportedWalks([move("t", { x: 1650, y: 950 })], scenes).map((w) => w.tokenId)).toEqual(["t"]);
    expect(unsupportedWalks([move("t", { x: 1950, y: 950 })], scenes)).toEqual([]);
    // Flying over the crate's edge is not a walk off it.
    const flying = tower([token("t", 1750, 950, 31, { levelId: "gallery" })], [crate]);
    expect(unsupportedWalks([move("t", { x: 1650, y: 950 })], () => flying)).toEqual([]);
  });
});

describe("D-453 raised areas: sight", () => {
  test("clipping a segment to a convex box, and 3D blocking against the box's height", () => {
    const square = [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }, { x: 0, y: 100 }];
    expect(clipToConvex(square, { x: -100, y: 50 }, { x: 200, y: 50 })).toEqual([1 / 3, 2 / 3]);
    expect(clipToConvex([...square].reverse(), { x: -100, y: 50 }, { x: 200, y: 50 })).toEqual([1 / 3, 2 / 3]);
    expect(clipToConvex(square, { x: -100, y: 150 }, { x: 200, y: 150 })).toBeNull();
    expect(clipToConvex(square, { x: 50, y: 50 }, { x: 60, y: 60 })).toEqual([0, 1]);
    const box = raisedVolumes(flat([], [raised("b", 0, 0, 100, 100, 10, true)]));
    expect(raisedBlocks(box, { x: -100, y: 50, z: 5 }, { x: 200, y: 50, z: 5 })).toBe(true);
    expect(raisedBlocks(box, { x: -100, y: 50, z: 12 }, { x: 200, y: 50, z: 12 })).toBe(false);
    expect(raisedBlocks(box, { x: -100, y: 50, z: 3 }, { x: 200, y: 50, z: 22 })).toBe(true); // 9.3 ft at the near side
    expect(raisedBlocks(box, { x: -100, y: 50, z: 4 }, { x: 200, y: 50, z: 22 })).toBe(false); // grazes the top edge
    expect(raisedBlocks(box, { x: -100, y: 50, z: 14 }, { x: 200, y: 50, z: 22 })).toBe(false);
  });

  test("a solid stack hides what is behind it from eyes below its top; an open scaffold hides nothing", () => {
    const tokens = [hero(), token("ambusher", 800, 1050), token("lookout", 950, 1350, 15), token("orc", 1550, 1050), token("archer", 1450, 1250, 10)];
    const s = flat(tokens);
    const viewers = fogViewers(s, player);
    const sight = raisedSight(s, viewers);
    if (!sight) throw new Error("expected a raised sight context");
    expect(sight.eyes).toEqual([{ x: 1150, y: 1750, z: 4.5, levelId: null }]);
    expect(sight.volumes.map((v) => v.id)).toEqual(["crates5", "crates10", "crates15"]); // the scaffold is open
    const seen = (id: string) => raisedTokenSeen(sight, 0, wholeScene, tokens.find((t) => t._id === id) as TokenDocument, s.grid);
    expect(seen("ambusher")).toBe(false);
    expect(seen("lookout")).toBe(true);
    expect(seen("orc")).toBe(true);
    expect(seen("archer")).toBe(true);
    // The fog polygon gets every stack taller than the hero's eyes (4.5 ft): all three, 4 edges each.
    expect(raisedEyeSegments(sight, 0)).toHaveLength(12);
    // Through the token gate: the ambusher is withheld from the player.
    const visible = fogVisibleTokenIds(s, player, [wholeScene], { viewers, raised: { sight, wallPolys: [wholeScene] } });
    expect([...visible].sort()).toEqual(["archer", "hero", "lookout", "orc"]);
    // Without the raised context, the polygon alone decides (every token in it).
    expect(fogVisibleTokenIds(s, player, [wholeScene], { viewers }).has("ambusher")).toBe(true);
    // Walls still bound sight: outside the walls-only polygon nothing shows.
    const westOnly = new Float32Array([0, 0, 1000, 0, 1000, 2200, 0, 2200]);
    expect(raisedTokenSeen(sight, 0, westOnly, tokens[3] as TokenDocument, s.grid)).toBe(false);
  });

  test("climbing changes what is seen; the box a viewer stands in never blinds it", () => {
    const ambusher = token("ambusher", 800, 1050);
    const view = (h: TokenDocument) => {
      const s = flat([h, ambusher]);
      const sight = raisedSight(s, fogViewers(s, player));
      if (!sight) throw new Error("expected a raised sight context");
      return { seen: raisedTokenSeen(sight, 0, wholeScene, ambusher, s.grid), segments: raisedEyeSegments(sight, 0).length };
    };
    expect(view(hero(650, 1450, 5))).toEqual({ seen: false, segments: 8 }); // on the 5 ft: the 10 ft is in the way
    expect(view(hero(750, 1250, 10))).toEqual({ seen: true, segments: 4 }); // on the 10 ft: past the 15 ft's corner
    expect(view(hero(850, 1250, 15))).toEqual({ seen: true, segments: 0 }); // on the 15 ft, north edge: looks down behind it
    expect(view(hero(950, 1350, 15)).seen).toBe(false); // the stack's own top hides its foot from its far corner
    // A token inside a stack at floor height (placed there by the GM) still sees out.
    expect(view(hero(900, 1300, 0)).segments).toBe(8);
  });

  test("the reveal key follows the boxes and the eyes' heights", () => {
    const s = flat([hero()]);
    const key = fogRevealKey(s, fogViewers(s, player), 3000);
    expect(fogRevealKey(flat([hero(1150, 1750, 5)]), fogViewers(s, player), 3000)).not.toBe(key);
    expect(fogRevealKey(flat([hero()], hallAreas().map((r) => (r._id === "crates15" ? { ...r, raised: { height: 20, solid: true } } : r))), fogViewers(s, player), 3000)).not.toBe(key);
    expect(fogRevealKey(flat([hero()], []), fogViewers(s, player), 3000)).not.toContain("crates");
    expect(raisedSightKey(null)).toBe("");
  });

  test("across floors: the stacks' sides are kernel barriers up to their tops", () => {
    const t = tower([]);
    const barriers = raisedBarriers(t);
    expect(barriers).toHaveLength(12);
    expect(barriers[0]).toMatchObject({ id: "raised:crates5@hall:0", zSpan: { bottom: 0, top: 5 }, restrictions: { move: 2, sight: 0, light: 2, sound: 2 } });
    expect(raisedBarriers(flat([]))).toEqual([]); // flat scenes have no cross-floor sight
    // From the gallery's edge, a goblin tucked behind the 15-ft stack (seen from the south) is hidden;
    // one in the open is seen.
    const lookout = token("hero", 1150, 1750, 20, { levelId: "gallery", ownership: { default: 2, p: 3 }, vision: true });
    const goblins = [token("tucked", 900, 1150, 0, { levelId: "hall" }), token("open", 1150, 1450, 0, { levelId: "hall" })];
    expect(tokensSeenBelow(tower([lookout, ...goblins]), [], player, "gallery").map((x) => x.id)).toEqual(["open"]);
    expect(tokensSeenBelow(tower([lookout, ...goblins], []), [], player, "gallery").map((x) => x.id)).toEqual(["open", "tucked"]);
  });
});
