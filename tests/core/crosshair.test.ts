/**
 * SQ-10 — the shared crosshair's pure half. These tests pin the two properties
 * that make sharing worth it: the geometry an author is shown (angles, areas,
 * unit→pixel conversion) and the constraints that decide commit-or-refuse —
 * including the *same* wall rule the summon host applies, asserted side by side
 * with `summonPlacementError` so the preview and the authority cannot drift.
 */
import { describe, expect, test } from "vitest";
import {
  CROSSHAIR_ANGLE_STEP, CROSSHAIR_DEFAULT_SPREAD, CROSSHAIR_NAME_MAX,
  crosshairAngle, crosshairArea, crosshairCommit, crosshairFaultMessage, crosshairFaults,
  crosshairGridSpec, crosshairName, crosshairNormalizeAngle, crosshairPxPerUnit, crosshairSnapPoint,
  pathBlockedBetween, segmentsBlocked, sightBlockedBetween, type CrosshairRequest,
} from "../../src/core/crosshair";
import { summonPlacementError } from "../../src/core/summons";
import type { SceneDocument, SceneGrid, TokenDocument, WallDocument } from "../../src/core/documents";

const grid: SceneGrid = { type: "square", size: 100, distance: 5, units: "ft", diagonals: "555", hexLayout: "oddQ" };
const wallA: WallDocument = { _id: "wall-1", type: "wall", name: "Wall", ownership: { default: 0 },
  flags: {}, system: {}, c: [250, 0, 250, 400], door: 0, oneWay: false, move: 0, sight: 0, sound: 0, light: 0 };
const wallB: WallDocument = { _id: "wall-2", type: "wall", name: "North", ownership: { default: 0 },
  flags: {}, system: {}, c: [0, 500, 1000, 500], door: 0, oneWay: false, move: 0, sight: 0, sound: 0, light: 0 };
const walls: readonly WallDocument[] = [wallA, wallB];
const request: CrosshairRequest = { sceneId: "s1", bounds: { width: 1_000, height: 1_000 },
  grid, walls, origin: { x: 100, y: 100 }, maxDistance: 30 };

const caster: TokenDocument = { _id: "caster", type: "token", name: "Caster", ownership: { default: 0 },
  flags: {}, system: {}, x: 100, y: 100, width: 100, height: 100, rotation: 0, img: "", hidden: false,
  disposition: "friendly", vision: true, light: { radius: 0, alpha: 0, color: "#ffffff" } };
const scene: SceneDocument = { _id: "s1", type: "scene", name: "Field", ownership: { default: 2 },
  flags: {}, system: {}, active: true, img: null, width: 1_000, height: 1_000, darkness: 0, grid,
  tokens: [caster], walls: [...walls], lights: [], sounds: [], tiles: [], drawings: [], templates: [], notes: [] };

describe("crosshair metrics and snapping", () => {
  test("scene units convert through the grid's own metric", () => {
    expect(crosshairPxPerUnit(grid)).toBe(20); // 100 px per 5 ft
    expect(crosshairPxPerUnit({ ...grid, type: "gridless", size: 0 })).toBe(1); // honest fallback
    expect(crosshairPxPerUnit({ ...grid, distance: 0 })).toBe(1);
  });

  test("snapping lands on the cell centre the token rule uses, and gridless never snaps", () => {
    expect(crosshairSnapPoint({ x: 74, y: 31 }, grid, true)).toEqual({ x: 50, y: 50 });
    expect(crosshairSnapPoint({ x: 74.5, y: 31.25 }, grid, false)).toEqual({ x: 74.5, y: 31.25 });
    expect(crosshairSnapPoint({ x: 74.5, y: 31.25 }, { ...grid, type: "gridless" }, true))
      .toEqual({ x: 74.5, y: 31.25 });
    expect(crosshairGridSpec(grid)).toEqual({ type: "square", size: 100 });
    expect(crosshairGridSpec({ ...grid, type: "hex", hexLayout: "oddR" }))
      .toEqual({ type: "hex", size: 100, layout: "oddR" });
  });

  test("direction snaps to 15° steps only when snapping is on", () => {
    const origin = { x: 0, y: 0 };
    expect(crosshairAngle(origin, { x: 100, y: 0 }, true)).toBe(0);
    expect(crosshairAngle(origin, { x: 100, y: 18 }, true)).toBe(CROSSHAIR_ANGLE_STEP); // 10.2° → 15°
    expect(crosshairAngle(origin, { x: 100, y: 18 }, false)).toBeCloseTo(10.204, 2);
    // A degenerate segment keeps the previous angle instead of becoming NaN atan2.
    expect(crosshairAngle(origin, { x: 0, y: 0 }, true, 90)).toBe(90);
    expect(crosshairNormalizeAngle(-15)).toBe(345);
    expect(crosshairNormalizeAngle(720)).toBe(0);
  });
});

describe("crosshair areas", () => {
  test("a point has no area — a marker, not a region", () => {
    expect(crosshairArea({ x: 10, y: 10 }, { kind: "point" }, grid)).toEqual([]);
  });

  test("a circle is a ring of samples at the requested radius, in world pixels", () => {
    const area = crosshairArea({ x: 400, y: 400 }, { kind: "circle", length: 10 }, grid);
    expect(area.length).toBeGreaterThanOrEqual(8);
    for (const point of area)
      expect(Math.hypot(point.x - 400, point.y - 400)).toBeCloseTo(200, 6); // 10 ft × 20 px/ft
  });

  test("a cone is a wedge of the requested aperture and reach", () => {
    const area = crosshairArea({ x: 0, y: 0 }, { kind: "cone", length: 5, spread: 90 }, grid);
    expect(area[0]).toEqual({ x: 0, y: 0 });
    const rim = area.slice(1);
    expect(rim).toHaveLength(13);
    // 45° above the axis on a 100 px radius: y = 100·sin(45°) (y grows downward)
    expect(rim[0]?.y).toBeCloseTo(-70.710678, 5);
    expect(rim[0]?.x).toBeCloseTo(70.710678, 5);
    expect(rim.at(-1)?.y).toBeCloseTo(70.710678, 5);
    expect(area[0]).not.toEqual(undefined);
  });

  test("a cone without an aperture uses the Sequencer default", () => {
    const shape = { kind: "cone" as const, length: 5 };
    const half = Math.sin(((CROSSHAIR_DEFAULT_SPREAD / 2) * Math.PI) / 180) * 100;
    const rim = crosshairArea({ x: 0, y: 0 }, shape, grid).slice(1);
    expect(Math.abs(rim[6]?.y ?? 0)).toBeCloseTo(0, 6); // aimed along +x
    expect(Math.abs(rim[0]?.y ?? 0)).toBeCloseTo(half, 5);
    expect(Math.abs(rim.at(-1)?.y ?? 0)).toBeCloseTo(half, 5); // symmetric wedge
    // An impossible aperture falls back rather than producing a degenerate area.
    expect(crosshairArea({ x: 0, y: 0 }, { kind: "cone", length: 5, spread: 400 }, grid)).toHaveLength(14);
  });

  test("a ray starts at the point; a rect straddles it — both honour rotation and width", () => {
    const ray = crosshairArea({ x: 100, y: 100 }, { kind: "ray", length: 10, width: 2 }, grid, 90);
    // Both near corners sit on the point, 2 ft (40 px) apart across the 90° axis,
    // and both far corners are 10 ft (200 px) along it.
    // Corners are listed near/far/near/far: the two on the point, then the two on the far edge.
    expect([ray[0]?.x, ray[3]?.x].map((x) => Math.round(x ?? 0)).sort((a, b) => a - b)).toEqual([80, 120]);
    expect([ray[0], ray[3]].every((corner) => Math.abs((corner?.y ?? 0) - 100) < 1e-6)).toBe(true);
    expect([ray[1], ray[2]].every((corner) => Math.abs((corner?.y ?? 0) - 300) < 1e-6)).toBe(true);
    const rect = crosshairArea({ x: 100, y: 100 }, { kind: "rect", length: 10, width: 10 }, grid, 0);
    expect(rect[0]?.x).toBeCloseTo(0, 6);   // 100 px each way from the centre
    expect(rect[2]?.x).toBeCloseTo(200, 6);
  });

  test("a malformed extent refuses to draw rather than drawing somewhere arbitrary", () => {
    expect(crosshairArea({ x: 1, y: 1 }, { kind: "circle" }, grid)).toEqual([]);
    expect(crosshairArea({ x: 1, y: 1 }, { kind: "circle", length: 0 }, grid)).toEqual([]);
    expect(crosshairArea({ x: 1, y: 1 }, { kind: "ray", length: 5 }, grid)).toEqual([]); // no width
    expect(crosshairArea({ x: Number.NaN, y: 1 }, { kind: "circle", length: 5 }, grid)).toEqual([]);
  });
});

describe("wall and path constraints", () => {
  test("the segment rule ignores endpoint touches and parallel walls", () => {
    const wall: readonly number[] = [250, 0, 250, 400];
    expect(segmentsBlocked({ x: 100, y: 200 }, { x: 400, y: 200 }, [wall])).toBe(true);
    expect(segmentsBlocked({ x: 100, y: 200 }, { x: 250, y: 200 }, [wall])).toBe(false); // ends on the wall
    expect(segmentsBlocked({ x: 100, y: 200 }, { x: 400, y: 200 }, [[250, 200, 450, 200]])).toBe(false);
  });

  test("a closed door blocks sight, an open one does not — the same rule the host uses", () => {
    const door: WallDocument = { ...wallA, _id: "door", sight: 1, move: 1, door: 0 };
    expect(sightBlockedBetween([door], { x: 100, y: 200 }, { x: 400, y: 200 })).toBe(true);
    expect(sightBlockedBetween([{ ...door, door: 1 }], { x: 100, y: 200 }, { x: 400, y: 200 })).toBe(false);
    // Sight-permitting walls never block, whatever the door state says.
    expect(sightBlockedBetween([{ ...door, sight: 2 }], { x: 100, y: 200 }, { x: 400, y: 200 })).toBe(false);
  });

  test("movement and sight are separate axes: a window blocks movement but not sight", () => {
    const window: WallDocument = { ...wallA, _id: "window", move: 0, sight: 2 };
    expect(pathBlockedBetween([window], { x: 100, y: 200 }, { x: 400, y: 200 })).toBe(true);
    expect(sightBlockedBetween([window], { x: 100, y: 200 }, { x: 400, y: 200 })).toBe(false);
  });

  test("the crosshair and `summonPlacementError` agree on the same fixture and wall", () => {
    const at = { x: 500, y: 200 }; // behind `wall-1` seen from the caster
    const faults = crosshairFaults({ ...request, requireLoS: true }, at);
    expect(faults.map((fault) => fault.code)).toEqual(["behind-wall"]);
    expect(summonPlacementError(scene, { sceneId: "s1", maxDistance: 30, requireLoS: true }, at, caster))
      .toBe("summon placement is behind a sight-blocking wall");
    // ...and both accept the same legal point, so the green preview is honest.
    const legal = { x: 200, y: 200 };
    expect(crosshairFaults({ ...request, requireLoS: true }, legal)).toEqual([]);
    expect(summonPlacementError(scene, { sceneId: "s1", maxDistance: 30, requireLoS: true }, legal, caster))
      .toBeNull();
  });
});

describe("crosshair faults", () => {
  test("a non-finite point outranks every other fault", () => {
    const faults = crosshairFaults(request, { x: Number.NaN, y: 5_000 });
    expect(faults).toHaveLength(1);
    expect(faults[0]?.message).toBe("Not a finite point");
  });

  test("bounds use the footprint inset, so a big creature cannot hang over the edge", () => {
    const free = { ...request, origin: null }; // a GM placing without a caster
    expect(crosshairFaults(free, { x: 995, y: 500 })).toEqual([]);
    expect(crosshairFaultMessage(crosshairFaults(free, { x: 1_050, y: 500 }))).toBe("Outside the scene");
    const footprinted = { ...free, footprint: 1.5 }; // 150 px cell: a 75 px inset
    expect(crosshairFaultMessage(crosshairFaults(footprinted, { x: 995, y: 500 })))
      .toBe("Footprint outside the scene");
    expect(crosshairFaultMessage(crosshairFaults(footprinted, { x: 900, y: 400 }))).toBeNull();
  });

  test("range is measured in scene units from the origin, in both directions", () => {
    // (700, 100) is 30 ft from (100, 100): exactly at the limit.
    expect(crosshairFaultMessage(crosshairFaults(request, { x: 700, y: 100 }))).toBeNull();
    expect(crosshairFaultMessage(crosshairFaults(request, { x: 720, y: 100 })))
      .toBe("Beyond the maximum 30 ft");
    expect(crosshairFaultMessage(crosshairFaults({ ...request, minDistance: 10 }, { x: 150, y: 100 })))
      .toBe("Closer than the minimum 10 ft");
    // No origin (a GM placing freely) means no range faults at all.
    expect(crosshairFaults({ ...request, origin: null }, { x: 900, y: 900 })).toEqual([]);
  });

  test("an area is checked at its outline: a circle half-buried in a wall is refused", () => {
    const small = { kind: "circle" as const, length: 2 }; // 40 px radius, clear of `wall-1`
    expect(crosshairFaults({ ...request, requireLoS: true }, { x: 200, y: 200 }, small)).toEqual([]);
    const wide = { kind: "circle" as const, length: 5 }; // 100 px radius: the rim crosses x=250
    expect(crosshairFaultMessage(crosshairFaults({ ...request, requireLoS: true }, { x: 320, y: 200 }, wide)))
      .toBe("Behind a sight-blocking wall");
    // The same point as a bare marker is fine on the wall's near side — the author chose an area.
    expect(crosshairFaults({ ...request, requireLoS: true }, { x: 200, y: 200 }, { kind: "point" }))
      .toEqual([]);
  });

  test("a reach constraint uses the movement axis, independently of sight", () => {
    const window: WallDocument = { ...wallA, _id: "window", move: 0, sight: 2 };
    const withWindow = { ...request, walls: [window], requireClearPath: true };
    expect(crosshairFaultMessage(crosshairFaults(withWindow, { x: 500, y: 200 }))).toBe("A blocking wall stands between");
    expect(crosshairFaultMessage(crosshairFaults({ ...withWindow, requireLoS: true }, { x: 500, y: 200 })))
      .toBe("A blocking wall stands between"); // sight alone would have allowed it
  });

  test("a legal placement lists no faults and no message", () => {
    expect(crosshairFaults({ ...request, requireLoS: true }, { x: 200, y: 300 })).toEqual([]);
    expect(crosshairFaultMessage([])).toBeNull();
  });
});

describe("commit and naming", () => {
  test("a refused commit returns the faults the preview showed and no placement", () => {
    const committed = crosshairCommit({ request: { ...request, requireLoS: true }, point: { x: 500, y: 200 } });
    expect(committed.ok).toBe(false);
    if (committed.ok) return;
    expect(committed.faults.map((fault) => fault.code)).toEqual(["behind-wall"]);
  });

  test("a committed placement carries its area, angle, distance and a usable name", () => {
    const committed = crosshairCommit({ request, point: { x: 300, y: 100 },
      shape: { kind: "ray", length: 10, width: 2 }, angleDeg: -20, name: "  Burning hands  " });
    expect(committed.ok).toBe(true);
    if (!committed.ok) return;
    expect(committed.placement.name).toBe("Burning hands");
    expect(committed.placement.angleDeg).toBe(340);
    expect(committed.placement.distance).toBeCloseTo(10, 6); // 200 px / 20 px-per-ft
    expect(committed.placement.area).toHaveLength(4);
    expect(committed.placement.shape.angle).toBe(340); // the area and the record agree
  });

  test("names are trimmed, bounded, defaulted and made unique against the ones in use", () => {
    expect(crosshairName(undefined, [])).toBe("Placement 1");
    expect(crosshairName("  two   words\n", [])).toBe("two words");
    expect(crosshairName("Portal", ["Portal"])).toBe("Portal (2)");
    expect(crosshairName("Portal", ["Portal", "Portal (2)"])).toBe("Portal (3)");
    expect(crosshairName("x".repeat(400), []).length).toBe(CROSSHAIR_NAME_MAX);
    const reused = crosshairCommit({ request, point: { x: 300, y: 100 }, name: "Portal", taken: ["Portal"] });
    expect(reused.ok && reused.placement.name).toBe("Portal (2)");
  });
});
