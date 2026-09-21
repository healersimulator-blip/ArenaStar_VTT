// D-257 (gaps G-43/G-27): the kind → document mapping, the door toggle and the wall picker.
// These are the rules the rail's wall/door/window sub-toolbar and the canvas click rely on.
import { describe, expect, test } from "vitest";
import {
  distanceToSegment,
  doorToggleDiff,
  wallAxesFor,
  wallFieldsFor,
  wallKindName,
  wallKindOf,
  wallPickAt,
  WALL_KINDS,
} from "../../src/canvas/vision/wallKinds";
import type { WallDocument } from "../../src/core/documents";
import { moveSegments, sightSegments } from "../../src/canvas/vision/wallSight";

function wall(over: Partial<WallDocument> = {}): WallDocument {
  return {
    _id: "w1",
    type: "wall",
    name: "Wall",
    ownership: { default: 0 },
    flags: {},
    system: {},
    c: [0, 0, 100, 0],
    door: 0,
    oneWay: false,
    move: 0,
    sight: 0,
    sound: 0,
    light: 0,
    ...over,
  };
}

describe("wall kinds (D-257)", () => {
  test("a wall blocks every axis unconditionally, so a door state can never open it", () => {
    expect(wallAxesFor("wall")).toEqual({ sight: 0, move: 0, sound: 0, light: 0 });
  });

  test("a door is conditional on every axis (closed/locked block, open permits)", () => {
    expect(wallAxesFor("door")).toEqual({ sight: 1, move: 1, sound: 1, light: 1 });
  });

  test("a window passes sight and light but blocks movement and sound — no door state", () => {
    expect(wallAxesFor("window")).toEqual({ sight: 2, move: 0, sound: 2, light: 2 });
  });

  test("every kind has a display name", () => {
    for (const kind of WALL_KINDS) expect(wallKindName(kind)).toMatch(/^[A-Z]/);
  });

  test("wallFieldsFor writes the kind's axes: a door keeps the chosen state, others are 0", () => {
    const wallDoc = wallFieldsFor("wall", [1, 2, 3, 4], 2);
    expect(wallDoc).toEqual({
      c: [1, 2, 3, 4],
      door: 0,
      oneWay: false,
      sight: 0,
      move: 0,
      sound: 0,
      light: 0,
    });
    expect(wallFieldsFor("door", [0, 0, 1, 1], 2).door).toBe(2); // locked
    expect(wallFieldsFor("door", [0, 0, 1, 1]).door).toBe(0); // placed closed
    expect(wallFieldsFor("window", [0, 0, 1, 1], 1).door).toBe(0);
  });

  test("wallKindOf recovers each kind from the axes alone (world files have no kind field)", () => {
    expect(wallKindOf(wallFieldsFor("wall", [0, 0, 1, 1]))).toBe("wall");
    expect(wallKindOf(wallFieldsFor("door", [0, 0, 1, 1]))).toBe("door");
    expect(wallKindOf(wallFieldsFor("window", [0, 0, 1, 1]))).toBe("window");
    // a door written open is still a door
    expect(wallKindOf(wallFieldsFor("door", [0, 0, 1, 1], 1))).toBe("door");
    // legacy walls (D-009's conditional axes, no kind) classify as doors
    expect(wallKindOf(wall({ sight: 1, move: 1, sound: 1, light: 1 }))).toBe("door");
  });

  test("doorToggleDiff toggles closed ⇄ open, ignores locked, and never answers for a wall", () => {
    expect(doorToggleDiff(wallFieldsFor("door", [0, 0, 1, 1], 0))).toEqual({ door: 1 });
    expect(doorToggleDiff(wallFieldsFor("door", [0, 0, 1, 1], 1))).toEqual({ door: 0 });
    expect(doorToggleDiff(wallFieldsFor("door", [0, 0, 1, 1], 2))).toBeNull();
    expect(doorToggleDiff(wallFieldsFor("wall", [0, 0, 1, 1]))).toBeNull();
    expect(doorToggleDiff(wallFieldsFor("window", [0, 0, 1, 1]))).toBeNull();
  });
});

describe("the axes a kind writes in the vision/movement pipelines (D-257)", () => {
  const place = (kind: "wall" | "door" | "window", door: 0 | 1 | 2 = 0): WallDocument =>
    wall({ _id: kind, ...wallFieldsFor(kind, [0, 0, 100, 0], door) });

  test("a wall blocks sight and movement, closed and open alike", () => {
    expect(sightSegments([place("wall")])).toHaveLength(1);
    expect(moveSegments([place("wall")])).toHaveLength(1);
  });

  test("a door blocks both while closed, and neither once open", () => {
    expect(sightSegments([place("door", 0)])).toHaveLength(1);
    expect(moveSegments([place("door", 0)])).toHaveLength(1);
    expect(sightSegments([place("door", 1)])).toHaveLength(0);
    expect(moveSegments([place("door", 1)])).toHaveLength(0);
  });

  test("a locked door blocks both — a click cannot open it (G-43)", () => {
    expect(sightSegments([place("door", 2)])).toHaveLength(1);
    expect(moveSegments([place("door", 2)])).toHaveLength(1);
  });

  test("a window never blocks sight or light but always blocks movement", () => {
    expect(sightSegments([place("window")])).toHaveLength(0);
    expect(moveSegments([place("window")])).toHaveLength(1);
  });
});

describe("wall picking (D-257)", () => {
  test("distanceToSegment measures perpendicular distance and clamps past the ends", () => {
    expect(distanceToSegment({ x: 50, y: 10 }, { x: 0, y: 0 }, { x: 100, y: 0 })).toBeCloseTo(10);
    expect(distanceToSegment({ x: -30, y: 0 }, { x: 0, y: 0 }, { x: 100, y: 0 })).toBeCloseTo(30);
    expect(distanceToSegment({ x: 5, y: 0 }, { x: 5, y: 0 }, { x: 5, y: 0 })).toBe(0);
  });

  test("wallPickAt returns the nearest wall inside the tolerance, null otherwise", () => {
    const near = wall({ _id: "near", c: [0, 0, 100, 0] });
    const far = wall({ _id: "far", c: [0, 40, 100, 40] });
    const hit = wallPickAt([far, near], { x: 50, y: 6 }, 10);
    expect(hit?.wall._id).toBe("near");
    expect(hit?.distance).toBeCloseTo(6);
    expect(hit?.at).toEqual({ x: 50, y: 0 });
    // the tolerance is inclusive: y=30 is exactly 10 from `far` (and 30 from `near`)
    expect(wallPickAt([far, near], { x: 50, y: 30 }, 10)?.wall._id).toBe("far");
    expect(wallPickAt([far, near], { x: 50, y: 30 }, 9)).toBeNull();
    // closest wins when two walls are both in range
    expect(wallPickAt([near, far], { x: 50, y: 12 }, 40)?.wall._id).toBe("near");
  });

  test("a click past a segment's end picks the endpoint, not the infinite line", () => {
    const w = wall({ c: [0, 0, 100, 0] });
    expect(wallPickAt([w], { x: 120, y: 0 }, 25)?.at).toEqual({ x: 100, y: 0 });
    expect(wallPickAt([w], { x: 120, y: 0 }, 15)).toBeNull();
  });
});
