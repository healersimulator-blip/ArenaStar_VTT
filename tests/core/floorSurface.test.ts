/** G-21 (D-444): solid floors with openings, traced from the floor's art. */
import { describe, expect, test } from "vitest";
import { artSampler, floorSolidAt, floorSurfaces, levelSurfaceError, traceSurface, SURFACE_MAX_VERTICES } from "../../src/core/floorSurface";
import { draftLevel, levelDraftOps, sceneLevelsError } from "../../src/core/levels";
import { regionShapeV2Error } from "../../src/core/multilevelGeometry";
import { SpatialKernel } from "../../src/core/spatial/kernel";
import type { LevelDocument, LevelSurface, SceneDocument, TileDocument } from "../../src/core/documents";

type Rect = [number, number, number, number];
const inRect = (x: number, y: number, [rx, ry, w, h]: Rect) => x >= rx && x < rx + w && y >= ry && y < ry + h;
/** Solid inside any of `solid`, except inside any of `open`. */
const art = (solid: Rect[], open: Rect[] = []) => (x: number, y: number) => solid.some((r) => inRect(x, y, r)) && !open.some((r) => inRect(x, y, r));
const vertices = (s: LevelSurface) => s.footprint.components.reduce((n, c) => n + c.outer.length + c.holes.reduce((m, h) => m + h.length, 0), 0);
const box = { x: 0, y: 0, width: 1000, height: 1000 };

describe("G-21 floor surfaces", () => {
  test("a floor with a stairwell traces to one solid area with one opening", () => {
    const traced = traceSurface(art([[100, 100, 800, 600]], [[400, 300, 200, 200]]), box, { cell: 25 });
    expect(traced.surface).not.toBeNull();
    const surface = traced.surface as LevelSurface;
    expect(regionShapeV2Error(surface.footprint)).toBeNull();
    expect(levelSurfaceError(surface)).toBeNull();
    expect([traced.components, traced.openings]).toEqual([1, 1]);
    expect(vertices(surface)).toBe(8); // two rectangles
    const level = { surface };
    expect(floorSolidAt(level, { x: 150, y: 150 })).toBe(true);
    expect(floorSolidAt(level, { x: 500, y: 400 })).toBe(false); // the stairwell
    expect(floorSolidAt(level, { x: 950, y: 950 })).toBe(false); // beyond the building
    expect(floorSolidAt({}, { x: 950, y: 950 })).toBe(true); // untraced floors stay solid everywhere
  });

  test("separate buildings, a courtyard with a statue, and diagonal contacts all trace to valid shapes", () => {
    const two = traceSurface(art([[0, 0, 300, 300], [600, 600, 300, 300]]), box, { cell: 25 });
    expect([two.components, two.openings]).toEqual([2, 0]);
    // A courtyard building with an island (a statue plinth) inside the courtyard.
    const building = art([[100, 100, 800, 800]], [[300, 300, 400, 400]]), statue = art([[450, 450, 100, 100]]);
    const yard = traceSurface((x, y) => building(x, y) || statue(x, y), box, { cell: 25 });
    expect(yard.surface && regionShapeV2Error(yard.surface.footprint)).toBeNull();
    expect([yard.components, yard.openings]).toEqual([2, 1]);
    const plinth = yard.surface as LevelSurface;
    expect(floorSolidAt({ surface: plinth }, { x: 500, y: 500 })).toBe(true);
    expect(floorSolidAt({ surface: plinth }, { x: 350, y: 350 })).toBe(false);
    // Squares meeting only at corners would make rings touch themselves; tracing closes the contact.
    const checker = traceSurface(art([[0, 0, 100, 100], [100, 100, 100, 100], [200, 0, 100, 100]]), { x: 0, y: 0, width: 300, height: 200 }, { cell: 50 });
    expect(checker.surface && regionShapeV2Error(checker.surface.footprint)).toBeNull();
  });

  test("intricate art coarsens until it fits the budget, and empty art traces to nothing", () => {
    // A disc with a ring of round holes: lots of staircase edges at a fine grid.
    const disc = (x: number, y: number) => {
      const r = Math.hypot(x - 500, y - 500);
      const holes = Array.from({ length: 8 }, (_, i) => [500 + 300 * Math.cos(i * Math.PI / 4), 500 + 300 * Math.sin(i * Math.PI / 4)]);
      return r < 450 && !holes.some(([hx, hy]) => Math.hypot(x - (hx as number), y - (hy as number)) < 60);
    };
    const traced = traceSurface(disc, box, { cell: 5 });
    expect(traced.surface).not.toBeNull();
    expect(vertices(traced.surface as LevelSurface)).toBeLessThanOrEqual(SURFACE_MAX_VERTICES);
    expect(traced.cell).toBeGreaterThan(5);
    expect(levelSurfaceError(traced.surface)).toBeNull();
    expect(traceSurface(() => false, box, { cell: 25 })).toMatchObject({ surface: null, notes: ["No opaque art to trace"] });
  });

  test("tile art is sampled through position, rotation and alpha; unreadable art counts as solid", () => {
    const tile = (id: string, over: Partial<TileDocument>): TileDocument => ({
      _id: id, type: "tile", name: id, ownership: { default: 0 }, flags: {}, system: {}, img: id, x: 0, y: 0, width: 400, height: 200, rotation: 0,
      hidden: false, overhead: false, ...over,
    } as TileDocument);
    // A 4×2 alpha mask with the right half transparent.
    const mask = { width: 4, height: 2, opaque: Uint8Array.from([1, 1, 0, 0, 1, 1, 0, 0]) };
    const sample = artSampler([tile("a", {}), tile("b", { x: 600, y: 600, width: 100, height: 300, rotation: 90 })], (t) => (t._id === "a" ? mask : null));
    expect(sample(100, 100)).toBe(true);
    expect(sample(300, 100)).toBe(false); // transparent half
    expect(sample(650, 750)).toBe(true); // rotated tile b covers x 500–800, y 700–800
    expect(sample(520, 750)).toBe(true);
    expect(sample(650, 620)).toBe(false);
  });

  test("validation, draft ops and the spatial kernel", () => {
    const surface = traceSurface(art([[0, 0, 1000, 1000]], [[400, 400, 200, 200]]), box, { cell: 50 }).surface as LevelSurface;
    expect(levelSurfaceError({ ...surface, extra: 1 })).toBe("Floor surface accepts only x, y, width, height, footprint and source");
    expect(levelSurfaceError({ ...surface, width: 0 })).toBe("Floor surface size must be between 1 and 1,000,000");
    expect(levelSurfaceError({ ...surface, footprint: { version: 2, components: [] } })).toMatch(/^Floor surface: /);
    const big = { version: 2 as const, components: [{ outer: Array.from({ length: 200 }, (_, i) => ({ x: 0.5 + 0.4 * Math.cos(i / 100 * Math.PI), y: 0.5 + 0.4 * Math.sin(i / 100 * Math.PI) })), holes: [] }] };
    expect(levelSurfaceError({ ...surface, footprint: big })).toBe(`Floor surface exceeds ${SURFACE_MAX_VERTICES} vertices`);

    const ground = draftLevel("ground", "Ground", 0, 10, 0), upper: LevelDocument = { ...draftLevel("upper", "Upper", 10, 20, 1), surface };
    expect(sceneLevelsError({ levels: [ground, upper] })).toBeNull();
    expect(sceneLevelsError({ levels: [ground, { ...upper, surface: { ...surface, height: -1 } }] })).toBe("Floor surface size must be between 1 and 1,000,000");
    const plain = draftLevel("upper", "Upper", 10, 20, 1);
    expect(levelDraftOps("s", [ground, plain], [ground, upper])).toEqual([{ kind: "update", ref: { coll: "levels", id: "upper", parent: { coll: "scenes", id: "s" } }, diff: { surface } }]);
    expect(levelDraftOps("s", [ground, upper], [ground, plain])[0]).toMatchObject({ diff: { "-=surface": null } });

    // Sight between floors crosses the stairwell and stops at solid floor.
    const scene = { width: 1000, height: 1000, levels: [ground, upper] } as Pick<SceneDocument, "levels" | "width" | "height">;
    const kernel = new SpatialKernel([], floorSurfaces(scene));
    expect(kernel.ray({ x: 500, y: 500, z: 15 }, { x: 500, y: 500, z: 5 }, "sight").filter((h) => h.id === "floor:upper")).toEqual([]);
    expect(kernel.ray({ x: 100, y: 100, z: 15 }, { x: 100, y: 100, z: 5 }, "sight").map((h) => h.id)).toEqual(["floor:upper"]);
    expect(kernel.supportBelow({ x: 500, y: 500, z: 12 })).toMatchObject({ id: "floor:ground", z: 0 }); // falls through the hole
    expect(kernel.supportBelow({ x: 100, y: 100, z: 12 })).toMatchObject({ id: "floor:upper", z: 10 });
    // Untraced floors are solid everywhere, well past the scene's edges.
    expect(kernel.supportBelow({ x: -400, y: 1300, z: 3 })).toMatchObject({ id: "floor:ground" });
  });

  test("the floor-play check flags an opening with no floor beneath it", async () => {
    const { levelPlayAudit } = await import("../../src/core/levelAudit");
    const { surfaceOpenings } = await import("../../src/core/floorSurface");
    const holed = traceSurface(art([[0, 0, 1000, 1000]], [[400, 400, 200, 200]]), box, { cell: 50 }).surface as LevelSurface;
    const [opening] = surfaceOpenings(holed);
    expect(opening && opening.x > 400 && opening.x < 600 && opening.y > 400 && opening.y < 600).toBe(true);
    const scene = (levels: LevelDocument[]) => ({ _id: "s", type: "scene", name: "Keep", ownership: { default: 0 }, flags: {}, system: {}, active: true, img: null,
      width: 1000, height: 1000, grid: { type: "square", size: 100, distance: 5, units: "ft" }, darkness: 0, levels,
      tokens: [], walls: [], lights: [], sounds: [], tiles: [], regions: [], drawings: [], templates: [], notes: [] }) as unknown as SceneDocument;
    const codes = (levels: LevelDocument[]) => levelPlayAudit(scene(levels)).filter((f) => f.code === "opening-over-void").map((f) => f.message);
    const ground = draftLevel("ground", "Ground", 0, 10, 0), upper = draftLevel("upper", "Upper", 10, 20, 1);
    // An untraced ground is solid everywhere: the stairwell looks down onto it.
    expect(codes([ground, { ...upper, surface: holed }])).toEqual([]);
    // The lowest floor's own hole has nothing under it; so does a shaft through every traced floor.
    expect(codes([{ ...ground, surface: holed }])).toEqual(["Ground has 1 opening with no floor beneath it."]);
    expect(codes([{ ...ground, surface: holed }, { ...upper, surface: holed }])).toEqual(["Ground has 1 opening with no floor beneath it.", "Upper has 1 opening with no floor beneath it."]);
  });
});
