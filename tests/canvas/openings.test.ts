/** Proximity openings stay physically bounded and observer-specific in the 2D visibility sweep. */
import { describe, expect, test } from "vitest";
import type { Json, SceneDocument, WallDocument } from "../../src/core/documents";
import { sceneSightGeometry } from "../../src/canvas/vision/openings";
import { pointInPolygon, visibilityPolygon } from "../../src/canvas/vision/polygon";
import type { SceneOpeningSightPolicy } from "../../src/core/openingSightPolicy";

const policy: SceneOpeningSightPolicy = {
  enabled: true,
  applyTo: { windows: true, doors: true, apertures: true },
  partialAt: 20,
  partial: { depth: 3, widthDeg: 20 },
  fullAt: 5,
  full: { depth: 20, widthDeg: 120 },
};
const windowWall: WallDocument = {
  _id: "window", type: "wall", name: "Window", ownership: { default: 2 }, flags: {}, system: {},
  c: [10, -100, 10, 100], door: 0, oneWay: false, sight: 2, move: 0, sound: 0, light: 2,
};
function scene(walls: WallDocument[] = [windowWall], setting: SceneOpeningSightPolicy | null = policy): SceneDocument {
  return {
    _id: "scene", type: "scene", name: "Room", ownership: { default: 2 }, flags: setting ? { core: { openingSight: setting as unknown as Json } } : {}, system: {},
    active: true, img: null, width: 200, height: 200, grid: { type: "square", size: 1, distance: 1, units: "ft", diagonals: "555", hexLayout: "oddQ" },
    darkness: 0, tokens: [], walls, levels: [], lights: [], sounds: [], tiles: [], regions: [], drawings: [], templates: [], notes: [],
  };
}

describe("scene opening sight geometry", () => {
  test("windows inherit scene policy, but legacy and explicit Full LOS stay fully open", () => {
    expect(sceneSightGeometry(scene()).proximityOpenings).toHaveLength(1);
    expect(sceneSightGeometry(scene([windowWall], null)).proximityOpenings).toHaveLength(0);
    expect(sceneSightGeometry(scene([{ ...windowWall, openingSightOverride: { mode: "full" } }])).proximityOpenings).toHaveLength(0);
    expect(sceneSightGeometry(scene()).blockers).toEqual([]);
  });

  test("closed and locked doors remain physical blockers regardless of the scene policy", () => {
    const closed: WallDocument = { ...windowWall, _id: "door", sight: 1, move: 1, sound: 1, light: 1, door: 0 };
    const locked = { ...closed, door: 2 as const, openingSightOverride: { mode: "full" as const } };
    expect(sceneSightGeometry(scene([closed])).blockers).toHaveLength(1);
    expect(sceneSightGeometry(scene([closed])).proximityOpenings).toHaveLength(0);
    expect(sceneSightGeometry(scene([locked])).blockers).toHaveLength(1);
  });

  test("near observers get the wider/deeper cone, intermediate observers interpolate, far observers are blocked", () => {
    const geometry = sceneSightGeometry(scene());
    const near = visibilityPolygon(9, 0, geometry.blockers, 100, geometry.proximityOpenings);
    expect(pointInPolygon(near, 25, 0)).toBe(true); // 16 units beyond; full depth is 20
    expect(pointInPolygon(near, 31, 0)).toBe(false); // 22 units beyond

    const middle = visibilityPolygon(0, 0, geometry.blockers, 100, geometry.proximityOpenings);
    expect(pointInPolygon(middle, 20, 0)).toBe(true);
    expect(pointInPolygon(middle, 30, 0)).toBe(false);
    expect(pointInPolygon(middle, 20, 60)).toBe(false); // outside the interpolated angular cone

    const far = visibilityPolygon(-20, 0, geometry.blockers, 100, geometry.proximityOpenings);
    expect(pointInPolygon(far, 9, 0)).toBe(true);
    expect(pointInPolygon(far, 11, 0)).toBe(false); // more than 20 units from the opening
  });

  test("a physical wall behind the window still clips the allowed sight depth", () => {
    const rear: WallDocument = { ...windowWall, _id: "rear", c: [18, -100, 18, 100], sight: 0, move: 0, sound: 0, light: 0 };
    const geometry = sceneSightGeometry(scene([windowWall, rear]));
    const poly = visibilityPolygon(9, 0, geometry.blockers, 100, geometry.proximityOpenings);
    expect(pointInPolygon(poly, 17, 0)).toBe(true);
    expect(pointInPolygon(poly, 19, 0)).toBe(false);
  });
});
