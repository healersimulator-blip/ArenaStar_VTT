/** Cross-floor LOS policy for traced floor apertures and scoped wall openings. */
import { describe, expect, test } from "vitest";
import type { Json, LevelDocument, LevelSurface, SceneDocument, TokenDocument, WallDocument } from "../../src/core/documents";
import { surfaceApertures } from "../../src/core/floorSurface";
import { draftLevel } from "../../src/core/levels";
import { tokensSeenBelow } from "../../src/core/crossFloorSight";
import { wallFieldsFor } from "../../src/canvas/vision/wallKinds";
import type { SceneOpeningSightPolicy } from "../../src/core/openingSightPolicy";

const player = { id: "player", role: "PLAYER" as const };
const base = { flags: {}, system: {} };
const policy: SceneOpeningSightPolicy = {
  enabled: true,
  applyTo: { windows: true, doors: true, apertures: true },
  partialAt: 20,
  partial: { depth: 0, widthDeg: 180 },
  fullAt: 5,
  full: { depth: 40, widthDeg: 180 },
};
const squareSurface: LevelSurface = {
  x: 0, y: 0, width: 1000, height: 1000, source: "drawn",
  footprint: {
    version: 2,
    components: [{
      outer: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }],
      holes: [[{ x: 0.4, y: 0.4 }, { x: 0.6, y: 0.4 }, { x: 0.6, y: 0.6 }, { x: 0.4, y: 0.6 }]],
    }],
  },
};

const token = (id: string, levelId: string, x: number, y: number, z: number, over: Partial<TokenDocument> = {}): TokenDocument => ({
  ...base, _id: id, type: "token", name: id, ownership: { default: 2 }, x, y, width: 100, height: 100, rotation: 0,
  elevation: z, levelId, img: "", vision: false, hidden: false, disposition: "hostile",
  light: { radius: 0, color: "#fff", alpha: 0 }, ...over,
});
const hero = (x: number, over: Partial<TokenDocument> = {}) => token("hero", "upper", x, 550, 10,
  { ownership: { default: 2, player: 3 }, vision: true, disposition: "friendly", ...over });
function scene(tokens: TokenDocument[], options: {
  policy?: SceneOpeningSightPolicy;
  upper?: Partial<LevelDocument>;
  walls?: WallDocument[];
} = {}): SceneDocument {
  const ground = draftLevel("ground", "Ground", 0, 10, 0);
  const upper: LevelDocument = {
    ...draftLevel("upper", "Upper", 10, 20, 1), visibleLevelIds: ["ground"], surface: squareSurface,
    ...options.upper,
  };
  return {
    ...base, _id: "scene", type: "scene", name: "Room", ownership: { default: 2 }, active: true, img: null,
    width: 1000, height: 1000, darkness: 0, levelMode: "isolated",
    grid: { type: "square", size: 100, distance: 5, units: "ft", diagonals: "555", hexLayout: "oddQ" },
    flags: options.policy ? { core: { openingSight: options.policy as unknown as Json } } : {},
    levels: [ground, upper], tokens, walls: options.walls ?? [], lights: [], sounds: [], tiles: [], regions: [], drawings: [], templates: [], notes: [],
  };
}
function scopedWall(kind: "window" | "door", state = 0 as 0 | 1 | 2, override?: WallDocument["openingSightOverride"]): WallDocument {
  return {
    ...base, _id: `${kind}-${state}`, type: "wall", name: kind, ownership: { default: 2 },
    levelScope: { mode: "levels", ids: ["upper"] },
    ...wallFieldsFor(kind, [390, 300, 390, 800], state),
    ...(override ? { openingSightOverride: override } : {}),
  };
}

describe("cross-floor proximity sight", () => {
  const apertureId = surfaceApertures({ surface: squareSurface })[0]?.id;
  if (!apertureId) throw new Error("test surface must contain its traced hole");

  test("attenuates only a real traced aperture; legacy, disabled and local Full LOS preserve open passage", () => {
    // The far observer's high target sample crosses the hole interior, but is more than the
    // interpolated partial depth away from the lower target. Other samples cross solid floor.
    const tokens = [hero(100), token("below", "ground", 827, 550, 0)];
    expect(tokensSeenBelow(scene(tokens), [], player, "upper")).toEqual([{ id: "below", depth: 1 }]);
    expect(tokensSeenBelow(scene(tokens, { policy: { ...policy, enabled: false } }), [], player, "upper")).toEqual([
      { id: "below", depth: 1 },
    ]);
    expect(tokensSeenBelow(scene(tokens, { policy }), [], player, "upper")).toEqual([]);

    const full = scene(tokens, { policy, upper: { apertureSightOverrides: { [apertureId]: { mode: "full" } } } });
    expect(tokensSeenBelow(full, [], player, "upper")).toEqual([{ id: "below", depth: 1 }]);
    const custom = scene(tokens, { policy: { ...policy, enabled: false }, upper: {
      apertureSightOverrides: { [apertureId]: { mode: "custom", curve: {
        partialAt: 100, partial: { depth: 30, widthDeg: 180 }, fullAt: 5, full: { depth: 40, widthDeg: 180 },
      } } },
    } });
    expect(tokensSeenBelow(custom, [], player, "upper")).toEqual([{ id: "below", depth: 1 }]);

  });

  test("a scoped window or open door attenuates rays, while closed and locked doors stay blocked", () => {
    const nearTokens = [hero(350), token("near", "ground", 550, 550, 0)];
    const farTokens = [hero(100), token("far", "ground", 827, 550, 0)];
    const wallOnlyPolicy = { ...policy, applyTo: { ...policy.applyTo, apertures: false } };
    const window = scopedWall("window");
    expect(tokensSeenBelow(scene(nearTokens, { policy: wallOnlyPolicy, walls: [window] }), [], player, "upper"))
      .toEqual([{ id: "near", depth: 1 }]);
    expect(tokensSeenBelow(scene(farTokens, { policy: wallOnlyPolicy, walls: [window] }), [], player, "upper"))
      .toEqual([]);

    const openDoor = scopedWall("door", 1);
    expect(tokensSeenBelow(scene(nearTokens, { policy: wallOnlyPolicy, walls: [openDoor] }), [], player, "upper"))
      .toEqual([{ id: "near", depth: 1 }]);
    expect(tokensSeenBelow(scene(farTokens, { policy: wallOnlyPolicy, walls: [openDoor] }), [], player, "upper"))
      .toEqual([]);

    const forcedFullDoor = scopedWall("door", 1, { mode: "full" });
    expect(tokensSeenBelow(scene(farTokens, { policy: wallOnlyPolicy, walls: [forcedFullDoor] }), [], player, "upper"))
      .toEqual([{ id: "far", depth: 1 }]);
    for (const state of [0, 2] as const) {
      const physicallyClosed = scopedWall("door", state, { mode: "full" });
      expect(tokensSeenBelow(scene(nearTokens, { policy: wallOnlyPolicy, walls: [physicallyClosed] }), [], player, "upper"))
        .toEqual([]);
    }
  });
});
