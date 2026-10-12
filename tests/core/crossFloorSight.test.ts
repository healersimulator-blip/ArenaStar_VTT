/** G-20 (D-445): tokens on lower floors, seen through openings in the floor above. */
import { describe, expect, test } from "vitest";
import { capToBand, floorBarriers, floorLights, perceptionBody, tokensSeenBelow } from "../../src/core/crossFloorSight";
import { traceSurface } from "../../src/core/floorSurface";
import { gmFloorRender } from "../../src/core/gmFloorView";
import { levelFocusView } from "../../src/core/levelNavigation";
import { draftLevel } from "../../src/core/levels";
import type { LevelDocument, LevelSurface, SceneDocument, TokenDocument, WallDocument } from "../../src/core/documents";

const player = { id: "p", role: "PLAYER" as const };
const base = { flags: {}, system: {} };
const token = (id: string, levelId: string, x: number, y: number, z: number, over: Partial<TokenDocument> = {}): TokenDocument => ({
  ...base, _id: id, type: "token", name: id, ownership: { default: 2 }, x, y, width: 100, height: 100, rotation: 0, elevation: z, levelId, img: "",
  vision: false, hidden: false, disposition: "hostile", light: { radius: 0, color: "#fff", alpha: 0 }, ...over,
});
const hero = (x = 350, y = 550, over: Partial<TokenDocument> = {}) => token("hero", "upper", x, y, 10, { ownership: { default: 2, p: 3 }, vision: true, disposition: "friendly", ...over });
/** Upper floor: solid over the 1000 px building except a 200 px stairwell at 400–600. */
const stairwell = traceSurface((x, y) => x < 1000 && y < 1000 && !(x >= 400 && x < 600 && y >= 400 && y < 600), { x: 0, y: 0, width: 1000, height: 1000 }, { cell: 50 }).surface as LevelSurface;
function scene(tokens: TokenDocument[], over: { upper?: Partial<LevelDocument>; ground?: Partial<LevelDocument>; walls?: WallDocument[]; untraced?: boolean } = {}): SceneDocument {
  const ground = { ...draftLevel("ground", "Ground", 0, 10, 0), ...over.ground };
  const upper: LevelDocument = { ...draftLevel("upper", "Upper", 10, 20, 1), visibleLevelIds: ["ground"], ...(over.untraced ? {} : { surface: stairwell }), ...over.upper };
  return { ...base, _id: "s", type: "scene", name: "Keep", ownership: { default: 2 }, active: true, img: null, width: 1000, height: 1000, darkness: 0, levelMode: "isolated",
    grid: { type: "square", size: 100, distance: 5, units: "ft", diagonals: "555", hexLayout: "oddQ" } as SceneDocument["grid"],
    levels: [ground, upper], tokens, walls: over.walls ?? [], lights: [], sounds: [], tiles: [], regions: [], drawings: [], templates: [], notes: [] };
}

describe("G-20 cross-floor sight", () => {
  test("a token below is seen through the stairwell, not through solid floor, and only by the viewer's own tokens", () => {
    // From the stairwell's edge the hero looks down into it: the goblin in the well is seen, the
    // one under the solid floor is not.
    const tokens = [hero(), token("inWell", "ground", 550, 550, 0), token("underFloor", "ground", 850, 850, 0)];
    expect(tokensSeenBelow(scene(tokens), [], player, "upper")).toEqual([{ id: "inWell", depth: 1 }]);
    // Far from the opening the angle is too shallow: nothing below is seen. (From the opposite
    // corner, the diagonal line to the far goblin would pass straight through the well.)
    expect(tokensSeenBelow(scene([hero(150, 850), ...tokens.slice(1)]), [], player, "upper")).toEqual([]);
    expect(tokensSeenBelow(scene([hero(150, 150), ...tokens.slice(1)]), [], player, "upper")).toEqual([{ id: "underFloor", depth: 1 }]);
    // Untraced: the floor is solid everywhere.
    expect(tokensSeenBelow(scene(tokens, { untraced: true }), [], player, "upper")).toEqual([]);
    // A floor that does not see the ground shows nothing of it.
    expect(tokensSeenBelow(scene(tokens, { upper: { visibleLevelIds: [] } }), [], player, "upper")).toEqual([]);
    // Someone else's token is not this player's eyes; a blind token sees nothing either.
    expect(tokensSeenBelow(scene([hero(350, 550, { ownership: { default: 2 } }), ...tokens.slice(1)]), [], player, "upper")).toEqual([]);
    expect(tokensSeenBelow(scene([hero(350, 550, { vision: false }), ...tokens.slice(1)]), [], player, "upper")).toEqual([]);
    // GM-hidden tokens are never disclosed.
    expect(tokensSeenBelow(scene([hero(), token("inWell", "ground", 550, 550, 0, { hidden: true })]), [], player, "upper")).toEqual([]);
  });

  test("range, darkness, darkvision, the target floor's lights and its walls all apply", () => {
    const well = token("inWell", "ground", 550, 550, 0);
    // A 5 ft sight range does not reach the goblin 2 cells away (horizontally ~1.6 cells, plus the drop).
    expect(tokensSeenBelow(scene([hero(350, 550, { sight: 5 }), well]), [], player, "upper")).toEqual([]);
    // A pitch-dark ground floor hides it, unless a light on that floor or darkvision helps.
    const dark = { ground: { darkness: 1 } };
    expect(tokensSeenBelow(scene([hero(), well], dark), [], player, "upper")).toEqual([]);
    expect(tokensSeenBelow(scene([hero(350, 550, { darkvision: 60 }), well], dark), [], player, "upper")).toEqual([{ id: "inWell", depth: 1 }]);
    const lit = scene([hero(), well], dark);
    lit.lights = [{ ...base, _id: "torch", type: "light", name: "torch", ownership: { default: 2 }, x: 500, y: 700, dim: 400, bright: 200, color: "#fff", alpha: 0.5, levelScope: { mode: "levels", ids: ["ground"] } }];
    expect(tokensSeenBelow(lit, [], player, "upper")).toEqual([{ id: "inWell", depth: 1 }]);
    expect(floorLights(lit, new Set(["ground"]))).toEqual([{ id: "torch@ground", at: { x: 500, y: 700, z: 5 }, bright: 10, dim: 20 }]);
    // A wall on the upper floor between the hero and the stairwell blocks the view down.
    const wall: WallDocument = { ...base, _id: "rail", type: "wall", name: "rail", ownership: { default: 2 }, c: [390, 300, 390, 800], door: 0, oneWay: false,
      move: 0, sight: 0, sound: 0, light: 0, levelScope: { mode: "levels", ids: ["upper"] } };
    expect(tokensSeenBelow(scene([hero(), well], { walls: [wall] }), [], player, "upper")).toEqual([]);
    // The same wall on the ground floor stands beside the goblin, not in the line of sight.
    expect(tokensSeenBelow(scene([hero(), well], { walls: [{ ...wall, levelScope: { mode: "levels", ids: ["ground"] } }] }), [], player, "upper")).toEqual([{ id: "inWell", depth: 1 }]);
    const { levelScope: scoped, ...loose } = wall; void scoped;
    expect(floorBarriers(scene([], { walls: [wall, { ...loose, _id: "loose" }] })).map((b) => [b.id, b.zSpan])).toEqual([["rail@upper", { bottom: 10, top: 20 }]]);
  });

  test("bodies: size in cells times the grid distance, eyes at 90 %, never through their own ceiling", () => {
    const g = { size: 100, distance: 5 };
    expect(perceptionBody(token("m", "ground", 0, 0, 0), g)).toMatchObject({ height: 5, eyeHeight: 4.5, sight: 1_000_000, darkvision: 0 });
    const huge = perceptionBody(token("h", "ground", 0, 0, 0, { width: 300, height: 300 }), g);
    expect(huge).toMatchObject({ height: 15, eyeHeight: 13.5 });
    expect(capToBand(huge, { top: 10 })).toMatchObject({ height: 9.99 });
    expect(capToBand(huge, { top: null })).toBe(huge);
  });

  test("players get the tokens they see in their floor presentation; the GM's isolated view shows every token below", () => {
    const tokens = [hero(), token("inWell", "ground", 550, 550, 0), token("underFloor", "ground", 850, 850, 0)];
    const s = scene(tokens);
    const view = levelFocusView(s, [], player, null);
    expect(view.levelId).toBe("upper");
    expect(view.presentation?.belowTokens).toEqual([{ id: "inWell", depth: 1 }]);
    // They are drawn beneath this floor's art, not in the token layer.
    expect(view.tokenIds).toEqual(["hero"]);
    // Nothing seen: no field at all.
    expect(levelFocusView(scene([hero(150, 850), ...tokens.slice(1)]), [], player, null).presentation?.belowTokens).toBeUndefined();
    const gm = gmFloorRender(s, { levelId: "upper", mode: "only" });
    expect([...gm.lowerTokens]).toEqual([["inWell", 1], ["underFloor", 1]]);
    expect(gmFloorRender(s, { levelId: "upper", mode: "ghost" }).lowerTokens.size).toBe(0);
  });
});
