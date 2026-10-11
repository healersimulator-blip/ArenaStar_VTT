/** G-23 (D-448): standing on floors, falling through openings and flying between floors. */
import { describe, expect, test } from "vitest";
import { floorFooting, flightPassage, tokenFooting, unsupportedWalks } from "../../src/core/floorSupport";
import { traceSurface } from "../../src/core/floorSurface";
import { draftLevel } from "../../src/core/levels";
import type { LevelDocument, LevelSurface, RegionDocument, SceneDocument, TokenDocument } from "../../src/core/documents";
import type { FlatDiff, Op } from "../../src/core/ops";

const base = { flags: {}, system: {} };
/** Upper floor: solid over the 1000 px building except a stairwell at 400–600. */
const stairwell = traceSurface((x, y) => x < 1000 && y < 1000 && !(x >= 400 && x < 600 && y >= 400 && y < 600), { x: 0, y: 0, width: 1000, height: 1000 }, { cell: 50 }).surface as LevelSurface;
const token = (id: string, levelId: string, x: number, y: number, z: number, over: Partial<TokenDocument> = {}): TokenDocument => ({
  ...base, _id: id, type: "token", name: id, ownership: { default: 2 }, x, y, width: 100, height: 100, rotation: 0, elevation: z, levelId, img: "",
  vision: false, hidden: false, disposition: "hostile", light: { radius: 0, color: "#fff", alpha: 0 }, ...over,
});
/** Stairs in the well's west half (400–500 × 400–600), serving both floors. */
const stairs: RegionDocument = { ...base, _id: "stairs", type: "region", name: "Stairs", ownership: { default: 0 }, hidden: true, x: 400, y: 400, width: 100, height: 200,
  shape: { kind: "polygon", points: [[0, 0], [1, 0], [1, 1], [0, 1]] }, stairs: { version: 2, levels: ["ground", "upper"], mode: "prompt" } };
function scene(over: { upper?: Partial<LevelDocument>; ground?: Partial<LevelDocument>; regions?: RegionDocument[]; tokens?: TokenDocument[]; levelMode?: SceneDocument["levelMode"] | null } = {}): SceneDocument {
  const s: SceneDocument = { ...base, _id: "s", type: "scene", name: "Keep", ownership: { default: 2 }, active: true, img: null, width: 1000, height: 1000, darkness: 0,
    levelMode: "isolated", grid: { type: "square", size: 100, distance: 5, units: "ft", diagonals: "555", hexLayout: "oddQ" } as SceneDocument["grid"],
    levels: [{ ...draftLevel("ground", "Ground", 0, 10, 0), ...over.ground }, { ...draftLevel("upper", "Upper", 10, 20, 1), surface: stairwell, ...over.upper }],
    tokens: over.tokens ?? [], walls: [], lights: [], sounds: [], tiles: [], regions: over.regions ?? [], drawings: [], templates: [], notes: [] };
  if (over.levelMode === null) delete s.levelMode;
  return s;
}

describe("G-23 footing", () => {
  test("a walking token over an opening has nothing under it, and lands on the floor below", () => {
    expect(floorFooting(scene(), token("t", "upper", 800, 800, 10))).toEqual({ supported: true, landing: null });
    expect(floorFooting(scene(), token("t", "upper", 550, 500, 10))).toEqual({ supported: false, landing: { levelId: "ground", name: "Ground", z: 0 } });
    // Airborne (feet above the floor), inside a stairwell, on an untraced floor or a floorless token: supported.
    expect(floorFooting(scene(), token("t", "upper", 550, 500, 12)).supported).toBe(true);
    expect(floorFooting(scene({ regions: [stairs] }), token("t", "upper", 450, 500, 10)).supported).toBe(true);
    expect(floorFooting(scene({ regions: [stairs] }), token("t", "upper", 550, 500, 10)).supported).toBe(false); // the east half has no stairs
    const solid = scene(); delete (solid.levels?.[1] as LevelDocument).surface;
    expect(floorFooting(solid, token("t", "upper", 550, 500, 10)).supported).toBe(true);
    // A hole in the lowest floor: nothing to land on.
    expect(floorFooting(scene({ ground: { surface: stairwell } }), token("t", "ground", 500, 500, 0))).toEqual({ supported: false, landing: null });
    // Play enforces it only in floor play; the floor-play check reads the structure regardless.
    expect(tokenFooting(scene({ levelMode: null }), token("t", "upper", 550, 500, 10)).supported).toBe(true);
    expect(floorFooting(scene({ levelMode: null }), token("t", "upper", 550, 500, 10)).supported).toBe(false);
  });

  test("flying between floors: the whole body must pass through the openings", () => {
    // From the ground, straight up through the well (a 100 px token fits the 200 px opening).
    expect(flightPassage(scene(), token("t", "ground", 500, 500, 0), 10)).toEqual({ clear: true, blockedBy: null });
    // Under solid floor, or too big for the opening: the upper floor is in the way.
    expect(flightPassage(scene(), token("t", "ground", 800, 800, 0), 10)).toEqual({ clear: false, blockedBy: { levelId: "upper", name: "Upper" } });
    expect(flightPassage(scene(), token("t", "ground", 500, 500, 0, { width: 300, height: 300 }), 15).blockedBy?.levelId).toBe("upper");
    // Down from the upper floor: through the well, yes; through its own solid floor, no.
    expect(flightPassage(scene(), token("t", "upper", 500, 500, 10), 0).clear).toBe(true);
    expect(flightPassage(scene(), token("t", "upper", 800, 800, 10), 0).blockedBy?.levelId).toBe("upper");
    // Rising within a floor never crosses one.
    expect(flightPassage(scene(), token("t", "ground", 800, 800, 0), 4).clear).toBe(true);
  });

  test("the host's walk check: players cannot step out over an opening", () => {
    const hero = token("hero", "upper", 300, 500, 10);
    const s = scene({ tokens: [hero], regions: [stairs] });
    const move = (diff: FlatDiff, id = "hero"): Op[] => [{ kind: "update", ref: { coll: "tokens", id, parent: { coll: "scenes", id: "s" } }, diff }];
    const byId = () => s;
    expect(unsupportedWalks(move({ x: 650, y: 500 }), byId)).toEqual([]); // past the well, on solid floor
    expect(unsupportedWalks(move({ x: 550, y: 500 }), byId)).toEqual([{ tokenId: "hero", name: "hero", floor: "Upper" }]);
    expect(unsupportedWalks(move({ x: 450, y: 500 }), byId)).toEqual([]); // onto the stairs
    expect(unsupportedWalks(move({ x: 550, y: 500, levelId: "ground", elevation: 0 }), byId)).toEqual([]); // an explicit floor change
    expect(unsupportedWalks(move({ elevation: 12 }), byId)).toEqual([]);
    // Two steps in one transaction: only where it ends counts.
    expect(unsupportedWalks([...move({ x: 550 }), ...move({ x: 700 })], byId)).toEqual([]);
    // A prefab part rides its parent.
    const rider = token("rider", "upper", 300, 500, 10, { flags: { prefab: { parentId: "hero" } } });
    expect(unsupportedWalks(move({ x: 550, y: 500 }, "rider"), () => scene({ tokens: [hero, rider] }))).toEqual([]);
    // Outside floor play, nothing is refused.
    expect(unsupportedWalks(move({ x: 550, y: 500 }), () => scene({ tokens: [hero], levelMode: null }))).toEqual([]);
  });
});
