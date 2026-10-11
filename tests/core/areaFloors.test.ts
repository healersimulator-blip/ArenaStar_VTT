/** G-27 (D-447): area effects on isolated floors — the caster's floor, plus what reaches through openings. */
import { describe, expect, test } from "vitest";
import { areaFloorOf, areaFloorReach, wallsOnFloor } from "../../src/core/areaFloors";
import { traceSurface } from "../../src/core/floorSurface";
import { draftLevel } from "../../src/core/levels";
import type { LevelDocument, LevelSurface, SceneDocument, TokenDocument, WallDocument } from "../../src/core/documents";

const base = { flags: {}, system: {} };
/** Upper floor: solid over the 1000 px building except a stairwell at 400–600. */
const stairwell = traceSurface((x, y) => x < 1000 && y < 1000 && !(x >= 400 && x < 600 && y >= 400 && y < 600), { x: 0, y: 0, width: 1000, height: 1000 }, { cell: 50 }).surface as LevelSurface;
const token = (id: string, levelId: string | undefined, x: number, y: number, z: number): TokenDocument => ({
  ...base, _id: id, type: "token", name: id, ownership: { default: 2 }, x, y, width: 100, height: 100, rotation: 0, elevation: z, img: "",
  vision: false, hidden: false, disposition: "hostile", light: { radius: 0, color: "#fff", alpha: 0 }, ...(levelId ? { levelId } : {}),
});
const wall = (id: string, c: WallDocument["c"], scope?: WallDocument["levelScope"]): WallDocument => ({
  ...base, _id: id, type: "wall", name: id, ownership: { default: 0 }, c, sight: 0, move: 0, sound: 0, light: 0, oneWay: false, door: 0, ...(scope ? { levelScope: scope } : {}),
});
function scene(over: { upper?: Partial<LevelDocument>; walls?: WallDocument[]; levelMode?: SceneDocument["levelMode"] } = {}): SceneDocument {
  return { ...base, _id: "s", type: "scene", name: "Keep", ownership: { default: 2 }, active: true, img: null, width: 1000, height: 1000, darkness: 0,
    levelMode: over.levelMode ?? "isolated",
    grid: { type: "square", size: 100, distance: 5, units: "ft", diagonals: "555", hexLayout: "oddQ" } as SceneDocument["grid"],
    levels: [draftLevel("ground", "Ground", 0, 10, 0), { ...draftLevel("upper", "Upper", 10, 20, 1), surface: stairwell, ...over.upper }],
    tokens: [], walls: over.walls ?? [], lights: [], sounds: [], tiles: [], regions: [], drawings: [], templates: [], notes: [] };
}
const caster = token("caster", "upper", 300, 500, 10);
/** A 20 ft burst centred over the stairwell. */
const burst = { origin: { x: 500, y: 500 }, radius: 20 };

describe("G-27 area effects across floors", () => {
  test("tokens on the caster's floor count; below, only through the opening and within the radius", () => {
    const reach = areaFloorReach(scene(), caster, burst);
    expect(reach(token("sameFloor", "upper", 800, 800, 10))).toBe(true); // the area's cells still decide
    expect(reach(token("inWell", "ground", 500, 700, 0))).toBe(true);
    expect(reach(token("farBelow", "ground", 500, 950, 0))).toBe(false); // beyond 20 ft
    expect(reach(token("floorless", undefined, 500, 500, 0))).toBe(false);
    // In reach of a 30 ft burst, but solid floor stands between.
    expect(areaFloorReach(scene(), caster, { ...burst, radius: 30 })(token("underFloor", "ground", 850, 500, 0))).toBe(false);
    // Untraced: the upper floor is solid everywhere.
    const solid = scene(); delete (solid.levels?.[1] as LevelDocument).surface;
    expect(areaFloorReach(solid, caster, burst)(token("inWell", "ground", 500, 700, 0))).toBe(false);
  });

  test("the lower floor's walls block the line of effect there; the upper floor's walls do not", () => {
    const target = token("inWell", "ground", 500, 700, 0);
    const across: WallDocument["c"] = [300, 650, 700, 650];
    expect(areaFloorReach(scene({ walls: [wall("w", across, { mode: "levels", ids: ["ground"] })] }), caster, burst)(target)).toBe(false);
    expect(areaFloorReach(scene({ walls: [wall("w", across, { mode: "levels", ids: ["upper"] })] }), caster, burst)(target)).toBe(true);
    expect(areaFloorReach(scene({ walls: [wall("w", across, { mode: "all" })] }), caster, burst)(target)).toBe(false);
    expect(areaFloorReach(scene({ walls: [wall("w", across)] }), caster, burst)(target)).toBe(true); // unscoped walls do nothing in floor play
  });

  test("lines and cones stay on the caster's floor; without floor play nothing changes", () => {
    expect(areaFloorReach(scene(), caster, { origin: { x: 500, y: 500 } })(token("inWell", "ground", 500, 700, 0))).toBe(false);
    expect(areaFloorReach(scene(), caster, { origin: { x: 500, y: 500 } })(token("sameFloor", "upper", 900, 500, 10))).toBe(true);
    const drafts = scene({ levelMode: undefined });
    delete drafts.levelMode;
    expect(areaFloorOf(drafts, caster)).toBeNull();
    expect(areaFloorReach(drafts, caster, burst)(token("underFloor", "ground", 850, 850, 0))).toBe(true);
    expect(areaFloorReach(scene(), token("loose", undefined, 300, 500, 0), burst)(token("underFloor", "ground", 850, 850, 0))).toBe(true);
    expect(areaFloorReach(scene(), undefined, burst)(token("underFloor", "ground", 850, 850, 0))).toBe(true);
    expect(areaFloorOf(scene(), caster)).toBe("upper");
    expect(areaFloorOf(scene(), token("ghost", "gone", 0, 0, 0))).toBeNull();
  });

  test("walls on a floor: scoped to it or to every floor", () => {
    const walls = [wall("g", [0, 0, 1, 1], { mode: "levels", ids: ["ground"] }), wall("u", [0, 0, 1, 1], { mode: "levels", ids: ["upper", "ground"] }),
      wall("a", [0, 0, 1, 1], { mode: "all" }), wall("none", [0, 0, 1, 1])];
    expect(wallsOnFloor(walls, "upper").map((w) => w._id)).toEqual(["u", "a"]);
    expect(wallsOnFloor(walls, "ground").map((w) => w._id)).toEqual(["g", "u", "a"]);
  });
});
