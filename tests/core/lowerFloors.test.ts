/** G-19 (D-443): floors seen beneath the current one — presets, presentation, floor scene, GM view. */
import { describe, expect, test } from "vitest";
import { draftLevel, levelVisibilityPreset, sceneLevelsError } from "../../src/core/levels";
import { backgroundDepth, floorPresentation, floorScene, lowerFloorDepths, lowerFloorTint, visibleFloorsBelow } from "../../src/core/levelPlay";
import { gmFloorRender } from "../../src/core/gmFloorView";
import type { LevelDocument, SceneDocument, TileDocument } from "../../src/core/documents";

const base = { ownership: { default: 0 as const }, flags: {}, system: {} };
const tile = (id: string, above = false): TileDocument => ({ ...base, _id: id, type: "tile", name: id, x: 0, y: 0, width: 100, height: 100, img: `${id}.png`, above,
  occlusion: { mode: "fade", alpha: 0 } });
function tower(): SceneDocument {
  const levels: LevelDocument[] = [
    { ...draftLevel("cellar", "Cellar", -10, 0, 0), tileIds: ["cellarArt"] },
    { ...draftLevel("ground", "Ground", 0, 10, 1), tileIds: ["groundArt"], useSceneBackground: true },
    { ...draftLevel("upper", "Upper", 10, 20, 2), tileIds: ["upperArt", "shared"] },
    { ...draftLevel("roof", "Roof", 20, 30, 3), tileIds: ["roofArt", "shared"] },
  ];
  return { ...base, _id: "tower", type: "scene", name: "tower", active: true, img: "bg.png", width: 1000, height: 1000,
    grid: { type: "square", size: 100, distance: 5, units: "ft" } as SceneDocument["grid"], darkness: 0, levelMode: "isolated", levels,
    tokens: [], walls: [], lights: [], sounds: [], regions: [], drawings: [], templates: [], notes: [],
    tiles: ["cellarArt", "groundArt", "upperArt", "roofArt", "shared", "loose"].map((id) => tile(id, id === "roofArt")) };
}
const level = (s: SceneDocument, id: string) => s.levels?.find((l) => l._id === id) as LevelDocument;
const withPreset = (s: SceneDocument, kind: Parameters<typeof levelVisibilityPreset>[1]): SceneDocument => ({ ...s, levels: levelVisibilityPreset(s.levels ?? [], kind) });

describe("G-19 visibility presets", () => {
  test("down to ground: floors at or above the ground see down to it; basements stay sealed and unseen", () => {
    const s = withPreset(tower(), "aboveGround");
    expect(sceneLevelsError(s)).toBeNull();
    expect(Object.fromEntries((s.levels ?? []).map((l) => [l._id, l.visibleLevelIds]))).toEqual({ cellar: [], ground: [], upper: ["ground"], roof: ["ground", "upper"] });
  });
  test("all below, then sealed; entries for floors above survive a preset", () => {
    const open = withPreset(tower(), "open");
    expect(level(open, "roof").visibleLevelIds).toEqual(["cellar", "ground", "upper"]);
    expect(level(open, "ground").visibleLevelIds).toEqual(["cellar"]);
    const s = tower(); level(s, "ground").visibleLevelIds = ["upper"]; // a balcony seen from below
    expect(level(withPreset(s, "sealed"), "ground").visibleLevelIds).toEqual(["upper"]);
    expect(level(withPreset(s, "open"), "ground").visibleLevelIds).toEqual(["cellar", "upper"]);
  });
});

describe("G-19 presentation and floor scene", () => {
  test("a floor's presentation lists the floors it sees below, nearest first, with stack depth", () => {
    const s = withPreset(tower(), "aboveGround");
    expect(visibleFloorsBelow(s, level(s, "roof")).map((f) => [f.level._id, f.depth])).toEqual([["upper", 1], ["ground", 2]]);
    const p = floorPresentation(s, level(s, "roof"));
    expect(p.below).toEqual([{ levelId: "upper", depth: 1, tileIds: ["upperArt", "shared"], useSceneBackground: false },
      { levelId: "ground", depth: 2, tileIds: ["groundArt"], useSceneBackground: true }]);
    // The roof's own tiles are not "lower", even when a lower floor lists them too.
    expect([...lowerFloorDepths(p)]).toEqual([["upperArt", 1], ["groundArt", 2]]);
    expect(backgroundDepth(p)).toBe(2);
    // Floors that see nothing below carry no `below` at all (older presentations are unchanged).
    expect(floorPresentation(s, level(s, "ground")).below).toBeUndefined();
    expect(backgroundDepth(floorPresentation(s, level(s, "ground")))).toBe(0);
    expect(backgroundDepth(floorPresentation(s, level(s, "cellar")))).toBeNull();
  });
  test("the player's floor scene brings the lower floors' art and the background they use, never their tokens", () => {
    const s = withPreset(tower(), "aboveGround");
    s.tokens = [{ ...base, _id: "guard", type: "token", name: "guard", x: 50, y: 50, width: 100, height: 100, rotation: 0, img: "", hidden: false, disposition: "hostile",
      vision: false, light: { radius: 0, color: "#fff", alpha: 0 }, levelId: "ground" } as SceneDocument["tokens"][number]];
    const shown = floorScene(s, { isolated: true, levelId: "upper", tokenIds: [], presentation: floorPresentation(s, level(s, "upper")) });
    expect(shown.tiles.map((t) => t._id)).toEqual(["groundArt", "upperArt", "shared"]);
    expect(shown.img).toBe("bg.png");
    expect(shown.tokens).toEqual([]);
    const sealed = floorScene(s, { isolated: true, levelId: "cellar", tokenIds: [], presentation: floorPresentation(s, level(s, "cellar")) });
    expect(sealed.tiles.map((t) => t._id)).toEqual(["cellarArt"]);
    expect(sealed.img).toBeNull();
  });
  test("tints darken with depth and clamp", () => {
    expect([1, 2, 3, 9, 0].map(lowerFloorTint)).toEqual([0xa6a6a6, 0x808080, 0x606060, 0x606060, 0xa6a6a6]);
  });
});

describe("G-19 GM isolated floor view", () => {
  test("'only' shows the lower floors' art with depths, as players see it; other modes do not", () => {
    const s = withPreset(tower(), "aboveGround");
    const only = gmFloorRender(s, { levelId: "roof", mode: "only" });
    expect([...only.lower]).toEqual([["upperArt", 1], ["groundArt", 2]]);
    expect(only.backgroundDepth).toBe(2);
    expect(only.scene.img).toBe("bg.png");
    // Unassigned tiles stay visible to the GM in every mode (they still need assigning).
    expect(only.scene.tiles.map((t) => t._id).sort()).toEqual(["groundArt", "loose", "roofArt", "shared", "upperArt"]);
    const ghost = gmFloorRender(s, { levelId: "roof", mode: "ghost" });
    expect(ghost.lower.size).toBe(0);
    expect(ghost.backgroundDepth).toBeNull();
    const sealed = gmFloorRender(withPreset(tower(), "sealed"), { levelId: "roof", mode: "only" });
    expect(sealed.lower.size).toBe(0);
    expect(sealed.scene.img).toBeNull();
  });
});
