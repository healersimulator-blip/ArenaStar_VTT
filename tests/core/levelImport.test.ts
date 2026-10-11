/** G-29 (D-441): import another scene as a floor. */
import { describe, expect, test } from "vitest";
import { draftLevel, sceneLevelsError } from "../../src/core/levels";
import { importFloorPlan, type ImportFloorInput } from "../../src/core/levelImport";
import { applyDiff } from "../../src/core/diff";
import type { LevelDocument, LightDocument, SceneDocument, TileDocument, WallDocument } from "../../src/core/documents";
import type { Op } from "../../src/core/ops";

const base = { ownership: { default: 0 as const }, flags: {}, system: {} };
const wall = (id: string, c: WallDocument["c"], levelScope?: WallDocument["levelScope"]): WallDocument => ({ ...base, _id: id, type: "wall", name: id, c, door: 0, oneWay: false,
  move: 0, sight: 0, sound: 0, light: 0, ...(levelScope ? { levelScope } : {}) });
const light = (id: string, levelScope?: LightDocument["levelScope"]): LightDocument => ({ ...base, _id: id, type: "light", name: id, x: 100, y: 50, dim: 200, bright: 100,
  color: "#fff", alpha: 0.5, ...(levelScope ? { levelScope } : {}) });
const tile = (id: string, over: Partial<TileDocument> = {}): TileDocument => ({ ...base, _id: id, type: "tile", name: id, x: 50, y: 50, width: 100, height: 50, img: "prop.png",
  above: false, occlusion: { mode: "fade", alpha: 0 }, ...over });
function scene(id: string, over: Partial<SceneDocument> = {}): SceneDocument {
  return { ...base, _id: id, type: "scene", name: id, active: false, img: null, width: 1000, height: 800,
    grid: { type: "square", size: 100, distance: 5, units: "ft" } as SceneDocument["grid"], darkness: 0,
    tokens: [], walls: [], lights: [], sounds: [], tiles: [], regions: [], drawings: [], templates: [], notes: [], ...over };
}
const tower = () => scene("tower", { levels: [draftLevel("ground", "Ground", 0, 10, 0), draftLevel("upper", "Upper", 10, 20, 1)], levelMode: "isolated",
  tiles: [tile("groundArt", { roofGroup: { id: "eaves", role: "source" } })] });
const cellar = () => scene("cellar", { img: "a".repeat(64), grid: { type: "square", size: 50, distance: 5, units: "ft" } as SceneDocument["grid"],
  background: { offset: { x: 10, y: 20 }, scale: 2 },
  walls: [wall("w1", [0, 0, 100, 0]), wall("door", [100, 0, 100, 100])], lights: [light("lamp")],
  tiles: [tile("crate", { roofGroup: { id: "eaves", role: "follower" }, triggerElevation: { min: 0, max: 5 } })],
  tokens: [{ ...base, _id: "rat", type: "token", name: "rat", x: 0, y: 0, width: 50, height: 50, rotation: 0, img: "", hidden: false, disposition: "hostile", vision: false,
    light: { radius: 0, color: "#fff", alpha: 0 } }] });
let n = 0;
const input = (over: Partial<ImportFloorInput> = {}): ImportFloorInput => ({ target: tower(), source: cellar(), into: { newLevel: { id: "attic", name: "Attic", height: 8 } },
  nextId: (kind) => `${kind}-${++n}`, ...over });
/** Apply a plan's ops to a copy of the target, as the store would. */
function apply(s: SceneDocument, ops: readonly Op[]): SceneDocument {
  const next = structuredClone(s) as unknown as Record<string, Array<{ _id: string }>>;
  for (const op of ops) {
    if (op.kind === "create") { (next[op.coll] ??= []).push(structuredClone(op.data)); continue; }
    if (op.kind !== "update") throw new Error("imports never delete");
    const rows = next[op.ref.coll] as Array<{ _id: string }>, i = rows.findIndex((r) => r._id === op.ref.id);
    const r = applyDiff(rows[i] as never, op.diff); if (!r.ok) throw new Error(r.error); rows[i] = r.value as { _id: string };
  }
  return next as unknown as SceneDocument;
}

describe("G-29 import a scene as a floor", () => {
  test("a new floor on top gets the map as a tile plus scaled, stamped copies of tiles, walls and lights", () => {
    n = 0;
    const plan = importFloorPlan(input({ backgroundSize: { width: 300, height: 200 } }));
    expect(plan.error).toBeNull();
    expect(plan.levelId).toBe("attic");
    const after = apply(tower(), plan.ops);
    expect(sceneLevelsError(after)).toBeNull();
    const attic = after.levels?.find((l) => l._id === "attic") as LevelDocument;
    expect(attic).toMatchObject({ name: "Attic", bottom: 20, top: 28, floorZ: 20, sort: 2 });
    // Grid 50 → 100: everything doubles. The map: offset (10,20) and scale 2 of a 300×200 image.
    const map = after.tiles.find((t) => t.name === "cellar map") as TileDocument;
    expect(map).toMatchObject({ x: 20, y: 40, width: 1200, height: 800, img: "a".repeat(64), above: false });
    const crate = after.tiles.find((t) => t.name === "crate") as TileDocument;
    expect(crate).toMatchObject({ x: 100, y: 100, width: 200, height: 100 });
    // A roof group name the tower already uses is made distinct; trigger data is dropped.
    expect(crate.roofGroup).toEqual({ id: "eaves-attic", role: "follower" });
    expect(crate.triggerElevation).toBeUndefined();
    expect(attic.tileIds).toEqual([map._id, crate._id]);
    const walls = after.walls.map((w) => [w.c, w.levelScope]);
    expect(walls).toEqual([[[0, 0, 200, 0], { mode: "levels", ids: ["attic"] }], [[200, 0, 200, 200], { mode: "levels", ids: ["attic"] }]]);
    expect(after.lights[0]).toMatchObject({ x: 200, y: 100, dim: 400, bright: 200, levelScope: { mode: "levels", ids: ["attic"] } });
    expect(after.tokens).toEqual([]); // tokens never travel
    expect(new Set([...after.tiles, ...after.walls, ...after.lights].map((d) => d._id)).size).toBe(after.tiles.length + after.walls.length + after.lights.length);
    expect(plan.summary).toEqual(["New floor Attic: Z 20–28, above Upper", "2 map tiles, 2 walls, 1 light from cellar", "Scaled ×2 so 50 px cells match this scene's 100 px"]);
    expect(plan.notes.join(" ")).toContain("Trigger zones on 1 tile were not copied");
  });

  test("into an existing floor, without grid matching, at an offset", () => {
    const plan = importFloorPlan(input({ into: { levelId: "upper" }, matchGrid: false, offset: { x: 500, y: 0 }, include: { lights: false } }));
    expect(plan.error).toBeNull();
    const after = apply(tower(), plan.ops);
    const upper = after.levels?.find((l) => l._id === "upper") as LevelDocument;
    expect(upper.tileIds).toHaveLength(2);
    expect(after.walls[0]?.c).toEqual([500, 0, 600, 0]);
    expect(after.lights).toEqual([]);
    expect(after.levels).toHaveLength(2);
    // Unknown map size: the tile fills the source scene rectangle, and says so.
    expect(after.tiles.find((t) => t.name === "cellar map")).toMatchObject({ x: 500, y: 0, width: 1000, height: 800 });
    expect(plan.notes[0]).toContain("pixel size is unknown");
  });

  test("a multilevel source imports one of its floors", () => {
    const source = cellar();
    source.levels = [{ ...draftLevel("low", "Low", 0, 10, 0), tileIds: ["crate"] }, { ...draftLevel("high", "High", 10, 20, 1), useSceneBackground: true }];
    source.walls = [wall("lowWall", [0, 0, 1, 1], { mode: "levels", ids: ["low"] }), wall("highWall", [0, 0, 2, 2], { mode: "levels", ids: ["high"] }), wall("everywhere", [0, 0, 3, 3], { mode: "all" })];
    source.tiles.push(tile("stray"));
    expect(importFloorPlan(input({ source })).error).toBe("Choose which floor of cellar to import");
    const low = importFloorPlan(input({ source, sourceLevelId: "low", matchGrid: false }));
    const after = apply(tower(), low.ops);
    expect(after.walls.map((w) => w.c[2])).toEqual([1, 3]);
    // Low does not use the scene background; it brings its own assigned tile only.
    expect(after.tiles.map((t) => t.name)).toEqual(["groundArt", "crate"]);
    expect(low.notes[0]).toBe("1 tile not assigned to any floor of cellar was skipped.");
    const high = apply(tower(), importFloorPlan(input({ source, sourceLevelId: "high", matchGrid: false })).ops);
    expect(high.tiles.map((t) => t.name)).toEqual(["groundArt", "cellar map"]);
    expect(high.walls.map((w) => w.c[2])).toEqual([2, 3]);
  });

  test("refusals", () => {
    expect(importFloorPlan(input({ target: scene("flat") })).error).toBe("Save floors for this scene first, then import into one of them");
    expect(importFloorPlan(input({ source: tower() })).error).toBe("Choose another scene to import");
    expect(importFloorPlan(input({ into: { levelId: "gone" } })).error).toBe("That floor no longer exists");
    expect(importFloorPlan(input({ into: { newLevel: { id: "x", name: " ", height: 8 } } })).error).toBe("Name the new floor (up to 64 characters)");
    expect(importFloorPlan(input({ into: { newLevel: { id: "x", name: "X", height: 0 } } })).error).toBe("Give the new floor a height above 0");
    const open = tower(); (open.levels as LevelDocument[])[1] = draftLevel("upper", "Upper", 10, null, 1);
    expect(importFloorPlan(input({ target: open })).error).toBe("Upper has an open top, so nothing can stack above it; import into an existing floor");
    expect(importFloorPlan(input({ source: scene("empty") })).error).toBe("empty has nothing to import (no map, tiles, walls or lights)");
    // The staged check catches a stale target, e.g. a new floor id that already exists.
    expect(importFloorPlan(input({ into: { newLevel: { id: "ground", name: "Again", height: 8 } } })).error).not.toBeNull();
  });
});
