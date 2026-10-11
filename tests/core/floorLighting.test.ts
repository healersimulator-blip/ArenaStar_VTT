/** G-22 (D-446): light between floors through openings — the links players receive, and perception. */
import { describe, expect, test } from "vitest";
import { tokensSeenBelow } from "../../src/core/crossFloorSight";
import { traceSurface } from "../../src/core/floorSurface";
import { floorAbove, floorLighting, floorPresentation } from "../../src/core/levelPlay";
import { levelFocusView } from "../../src/core/levelNavigation";
import { draftLevel } from "../../src/core/levels";
import type { LevelDocument, LevelSurface, LightDocument, SceneDocument, TokenDocument, WallDocument } from "../../src/core/documents";

const player = { id: "p", role: "PLAYER" as const };
const base = { flags: {}, system: {} };
const stairwell = traceSurface((x, y) => x < 1000 && y < 1000 && !(x >= 400 && x < 600 && y >= 400 && y < 600), { x: 0, y: 0, width: 1000, height: 1000 }, { cell: 50 }).surface as LevelSurface;
const light = (id: string, scope: LightDocument["levelScope"], over: Partial<LightDocument> = {}): LightDocument => ({
  ...base, _id: id, type: "light", name: id, ownership: { default: 2 }, x: 500, y: 500, dim: 400, bright: 200, color: "#fff", alpha: 0.5, ...(scope ? { levelScope: scope } : {}), ...over,
});
const wall = (id: string, scope: WallDocument["levelScope"]): WallDocument => ({
  ...base, _id: id, type: "wall", name: id, ownership: { default: 0 }, c: [0, 0, 100, 0], sight: 1, move: 1, sound: 1, light: 1, oneWay: false, door: 0, ...(scope ? { levelScope: scope } : {}),
});
const token = (id: string, levelId: string, x: number, y: number, z: number, over: Partial<TokenDocument> = {}): TokenDocument => ({
  ...base, _id: id, type: "token", name: id, ownership: { default: 2 }, x, y, width: 100, height: 100, rotation: 0, elevation: z, levelId, img: "",
  vision: false, hidden: false, disposition: "hostile", light: { radius: 0, color: "#fff", alpha: 0 }, ...over,
});
function scene(over: { ground?: Partial<LevelDocument>; upper?: Partial<LevelDocument>; top?: Partial<LevelDocument>; lights?: LightDocument[]; walls?: WallDocument[]; tokens?: TokenDocument[] } = {}): SceneDocument {
  return { ...base, _id: "s", type: "scene", name: "Keep", ownership: { default: 2 }, active: true, img: null, width: 1000, height: 1000, darkness: 0.3, levelMode: "isolated",
    grid: { type: "square", size: 100, distance: 5, units: "ft", diagonals: "555", hexLayout: "oddQ" } as SceneDocument["grid"],
    levels: [{ ...draftLevel("ground", "Ground", 0, 10, 0), darkness: 0.9, ...over.ground },
      { ...draftLevel("upper", "Upper", 10, 20, 1), visibleLevelIds: ["ground"], surface: stairwell, ...over.upper },
      { ...draftLevel("top", "Top", 20, 30, 2), ...over.top }],
    tokens: over.tokens ?? [], walls: over.walls ?? [], lights: over.lights ?? [], sounds: [], tiles: [], regions: [], drawings: [], templates: [], notes: [] };
}
const level = (s: SceneDocument, id: string) => s.levels?.find((l) => l._id === id) as LevelDocument;

describe("G-22 floor light links", () => {
  test("a floor with openings links the floors it sees below: their own lights, their walls, their darkness", () => {
    const s = scene({
      lights: [light("groundLamp", { mode: "levels", ids: ["ground"] }), light("both", { mode: "levels", ids: ["ground", "upper"] }), light("everywhere", { mode: "all" }), light("upperLamp", { mode: "levels", ids: ["upper"] }), light("flat", undefined)],
      walls: [wall("groundWall", { mode: "levels", ids: ["ground"] }), wall("allWall", { mode: "all" }), wall("upperWall", { mode: "levels", ids: ["upper"] }), wall("flatWall", undefined)],
    });
    expect(floorLighting(s, level(s, "upper"))).toEqual({ surface: stairwell, links: [
      // Lights also on this floor (or on every floor) already light it: they are not repeated.
      { levelId: "ground", side: "below", depth: 1, lightIds: ["groundLamp"], wallIds: ["groundWall", "allWall"], darkness: 0.9 },
    ] });
    // The presentation carries it; untraced (solid) floors and floors that see nothing below do not.
    expect(floorPresentation(s, level(s, "upper")).lighting?.links.map((l) => l.levelId)).toEqual(["ground"]);
    const solid = scene();
    delete level(solid, "upper").surface;
    expect(floorLighting(solid, level(solid, "upper"))).toBeNull();
    expect("lighting" in floorPresentation(solid, level(solid, "upper"))).toBe(false);
    expect(floorLighting(scene({ upper: { visibleLevelIds: [] } }), level(scene({ upper: { visibleLevelIds: [] } }), "upper"))).toBeNull();
    // The host sends it to a player standing on that floor; players hold no levels or surfaces themselves.
    const hero = token("hero", "upper", 350, 550, 10, { ownership: { default: 2, p: 3 }, vision: true });
    const view = levelFocusView({ ...s, tokens: [hero] }, [], player, null);
    expect(view.levelId).toBe("upper");
    expect(view.presentation?.lighting).toEqual(floorLighting(s, level(s, "upper")));
  });

  test("the floor above lights this one through its openings when it sees this floor and has lights of its own", () => {
    const lamp = light("upperLamp", { mode: "levels", ids: ["upper"] });
    const s = scene({ lights: [lamp], walls: [wall("upperWall", { mode: "levels", ids: ["upper"] })] });
    expect(floorAbove(s, "ground")?._id).toBe("upper");
    expect(floorAbove(s, "top")).toBeUndefined();
    expect(floorAbove(s, "missing")).toBeUndefined();
    // Ground has no surface of its own: only the light from above crosses into it.
    expect(floorLighting(s, level(s, "ground"))).toEqual({ links: [
      { levelId: "upper", side: "above", depth: 1, lightIds: ["upperLamp"], wallIds: ["upperWall"], darkness: 0.3, surface: stairwell },
    ] });
    expect(floorLighting(scene(), level(scene(), "ground"))).toBeNull(); // no lamps up there
    const blind = scene({ lights: [lamp], upper: { visibleLevelIds: [] } });
    expect(floorLighting(blind, level(blind, "ground"))).toBeNull(); // it does not see the ground
    const solid = scene({ lights: [lamp] }); delete level(solid, "upper").surface;
    expect(floorLighting(solid, level(solid, "ground"))).toBeNull(); // a solid floor lets nothing down
  });

  test("perception: a lamp hanging over the stairwell lights a goblin in the dark below; one over solid floor does not", () => {
    const hero = token("hero", "upper", 350, 550, 10, { ownership: { default: 2, p: 3 }, vision: true, disposition: "friendly" });
    const goblin = token("goblin", "ground", 550, 550, 0);
    const dark = { ground: { darkness: 1 } };
    expect(tokensSeenBelow(scene({ ...dark, tokens: [hero, goblin] }), [], player, "upper")).toEqual([]);
    const over = light("lamp", { mode: "levels", ids: ["upper"] }, { x: 500, y: 500 });
    expect(tokensSeenBelow(scene({ ...dark, tokens: [hero, goblin], lights: [over] }), [], player, "upper")).toEqual([{ id: "goblin", depth: 1 }]);
    const far = light("lamp", { mode: "levels", ids: ["upper"] }, { x: 850, y: 850 });
    expect(tokensSeenBelow(scene({ ...dark, tokens: [hero, goblin], lights: [far] }), [], player, "upper")).toEqual([]);
    // The floor above (Top) lights it too, but only through Top's own openings.
    const topLamp = light("topLamp", { mode: "levels", ids: ["top"] }, { x: 500, y: 500, dim: 600 });
    expect(tokensSeenBelow(scene({ ...dark, tokens: [hero, goblin], lights: [topLamp] }), [], player, "upper")).toEqual([]);
    expect(tokensSeenBelow(scene({ ...dark, tokens: [hero, goblin], lights: [topLamp], top: { surface: stairwell } }), [], player, "upper")).toEqual([{ id: "goblin", depth: 1 }]);
  });
});
