import { describe, expect, test } from "vitest";
import {
  pointInPolygon,
  polygonBounds,
  segmentCrossingPoint,
  segmentsCross,
  visibilityPolygon,
  type Segment,
} from "../../src/canvas/vision/polygon";
import {
  axisBlocks,
  sightBlocked,
  soundSegments,
  sightSegments,
  wallStroke,
  WALL_COLORS,
} from "../../src/canvas/vision/wallSight";
import { InlineVisionWorker, WorkerVisionComputer } from "../../src/workers/visionWorkerClient";
import type { WallDocument } from "../../src/core/documents";
import type { VisionWorkerRequest } from "../../src/workers/vision.worker";
import * as lights from "../../src/canvas/vision/lights";

function wall(over: Partial<WallDocument> & { c: [number, number, number, number] }): WallDocument {
  return {
    _id: "w",
    type: "wall",
    name: "w",
    ownership: { default: 0 },
    flags: {},
    system: {},
    door: 0,
    oneWay: false,
    move: 2,
    sight: 0,
    sound: 2,
    light: 2,
    ...over,
  };
}

/** Closed square room [0,100]² as four wall segments. */
function room(): Segment[] {
  return [
    { x1: 0, y1: 0, x2: 100, y2: 0 },
    { x1: 100, y1: 0, x2: 100, y2: 100 },
    { x1: 100, y1: 100, x2: 0, y2: 100 },
    { x1: 0, y1: 100, x2: 0, y2: 0 },
  ];
}

describe("visibilityPolygon (§9 angular sweep)", () => {
  test("viewer inside a closed room sees only the room", () => {
    const poly = visibilityPolygon(50, 50, room(), null);
    const b = polygonBounds(poly);
    expect(b.minX).toBeGreaterThanOrEqual(-1e-6);
    expect(b.maxX).toBeLessThanOrEqual(100 + 1e-6);
    expect(b.minY).toBeGreaterThanOrEqual(-1e-6);
    expect(b.maxY).toBeLessThanOrEqual(100 + 1e-6);
    // walls' corners are visible points
    expect(poly.length).toBeGreaterThanOrEqual(16);
    // nothing beyond the walls (boundary vertices allowed within ε)
    for (let i = 0; i < poly.length; i += 2) {
      const x = poly[i] ?? 0;
      const y = poly[i + 1] ?? 0;
      expect(x).toBeGreaterThanOrEqual(-1e-3);
      expect(x).toBeLessThanOrEqual(100 + 1e-3);
      expect(y).toBeGreaterThanOrEqual(-1e-3);
      expect(y).toBeLessThanOrEqual(100 + 1e-3);
    }
  });

  test("open doorway extends sight beyond the room", () => {
    // room with a gap in the bottom wall (20..80 open)
    const open: Segment[] = [
      { x1: 0, y1: 0, x2: 20, y2: 0 },
      { x1: 80, y1: 0, x2: 100, y2: 0 },
      { x1: 100, y1: 0, x2: 100, y2: 100 },
      { x1: 100, y1: 100, x2: 0, y2: 100 },
      { x1: 0, y1: 100, x2: 0, y2: 0 },
    ];
    const poly = visibilityPolygon(50, 50, open, 200);
    const b = polygonBounds(poly);
    expect(b.minY).toBeLessThan(-1); // sight escapes through the gap
    expect(pointInPolygon(poly, 50, -5)).toBe(true); // through the open middle
    expect(pointInPolygon(poly, 5, -5)).toBe(false); // blocked by the wall stub
  });

  test("radius caps an open field", () => {
    const poly = visibilityPolygon(50, 50, [], 30);
    const b = polygonBounds(poly);
    expect(b.maxX - b.minX).toBeCloseTo(60, 0);
    expect(b.maxY - b.minY).toBeCloseTo(60, 0);
  });

  test("single wall casts a shadow behind it", () => {
    const poly = visibilityPolygon(50, 50, [{ x1: 40, y1: 40, x2: 60, y2: 40 }], 100);
    // the viewer's own side of the wall is visible
    expect(pointInPolygon(poly, 50, 60)).toBe(true);
    // directly behind the wall (y < 40) is not
    expect(pointInPolygon(poly, 50, 30)).toBe(false);
    // past the wall's end it is again
    expect(pointInPolygon(poly, 80, 30)).toBe(true);
  });

  test("deterministic output", () => {
    const segs = room();
    expect(visibilityPolygon(50, 50, segs, null)).toEqual(visibilityPolygon(50, 50, segs, null));
  });
});

describe("wall restriction semantics (§9 / D-009)", () => {
  test("axisBlocks: blocks / conditional-by-door / permits", () => {
    expect(axisBlocks(0, 1)).toBe(true); // blocks even with the door open
    expect(axisBlocks(2, 0)).toBe(false); // permits always
    expect(axisBlocks(1, 0)).toBe(true); // conditional, door closed → blocks
    expect(axisBlocks(1, 2)).toBe(true); // locked → blocks
    expect(axisBlocks(1, 1)).toBe(false); // open → permits
  });

  test("sightSegments filters to sight-blocking geometry", () => {
    const walls = [
      wall({ _id: "a", c: [0, 0, 10, 0], sight: 0 }),
      wall({ _id: "b", c: [0, 10, 10, 10], sight: 2 }),
      wall({ _id: "c", c: [0, 20, 10, 20], sight: 1, door: 1 }), // open door → see-through
      wall({ _id: "d", c: [0, 30, 10, 30], sight: 1, door: 0 }), // closed → blocks
    ];
    const segs = sightSegments(walls);
    expect(segs.map((s) => s.y1)).toEqual([0, 30]);
    expect(walls.filter(sightBlocked).map((w) => w._id)).toEqual(["a", "d"]);
  });

  test("soundSegments asks the sound axis, not the sight axis (D-309)", () => {
    // The same fixture as sight, read down the other axis: a window passes sound and a
    // closed door does not, so what a viewer *hears* through is not what they see through.
    const walls = [
      wall({ _id: "a", c: [0, 0, 10, 0], sight: 2, sound: 0 }), // opaque to sound only
      wall({ _id: "b", c: [0, 10, 10, 10], sight: 0, sound: 2 }), // see-through, sound-porous
      wall({ _id: "c", c: [0, 20, 10, 20], sight: 0, sound: 1, door: 1 }), // open door
      wall({ _id: "d", c: [0, 30, 10, 30], sight: 0, sound: 1, door: 0 }), // closed door
      wall({ _id: "e", c: [0, 40, 10, 40], sight: 0, sound: 2 }), // and the light-only case
    ];
    // A window is the D-009 case that makes this whole distinction load-bearing: sight
    // passes, sound is conditional, and a closed window is where a listener cannot see
    // what they hear.
    const window = wall({ _id: "w", c: [0, 50, 10, 50], sight: 2, light: 2, move: 0, sound: 1, door: 0 });
    // Three of the five walls stop sound (a: opaque, d: closed door, the window: closed and
    // conditional on the sound axis), while sight — asked the same question — keeps a
    // different three: the two answers are genuinely different, which is the point.
    expect(soundSegments([...walls, window]).map((s) => s.y1)).toEqual([0, 30, 50]);
    expect(sightSegments(walls).map((s) => s.y1)).toEqual([10, 20, 30, 40]);
    expect(soundSegments([])).toEqual([]);
  });

  test("a segment crossing is a pure geometric question (D-309)", () => {
    const a = { x: 0, y: 0 };
    const b = { x: 10, y: 0 };
    expect(segmentsCross(a, b, { x: 5, y: -5 }, { x: 5, y: 5 })).toBe(true);
    expect(segmentCrossingPoint(a, b, { x: 5, y: -5 }, { x: 5, y: 5 })).toEqual({ x: 5, y: 0 });
    expect(segmentsCross(a, b, { x: 5, y: 5 }, { x: 5, y: 15 })).toBe(false); // clear of the line
    expect(segmentCrossingPoint(a, b, { x: 5, y: 5 }, { x: 5, y: 15 })).toBeNull();
    // Touching counts: a listener standing exactly on a wall is behind it, which is the
    // same convention the D-307 mask trim uses. A wall that stops short does not.
    expect(segmentsCross(a, b, { x: 5, y: 0 }, { x: 5, y: 5 })).toBe(true);
    expect(segmentsCross(a, b, { x: 20, y: -5 }, { x: 20, y: 5 })).toBe(false);
    // Parallel (and collinear) is never a crossing, however close the lines run.
    expect(segmentsCross(a, b, { x: 0, y: 1 }, { x: 10, y: 1 })).toBe(false);
    expect(segmentsCross(a, b, { x: 0, y: 0 }, { x: 10, y: 0 })).toBe(false);
  });

  test("wallStroke picks the dominant restriction color", () => {
    expect(wallStroke(wall({ c: [0, 0, 1, 0], sight: 0 }))).toBe(WALL_COLORS.sight);
    expect(wallStroke(wall({ c: [0, 0, 1, 0], sight: 2, move: 0 }))).toBe(WALL_COLORS.move);
    expect(wallStroke(wall({ c: [0, 0, 1, 0], sight: 2, move: 2, light: 0 }))).toBe(
      WALL_COLORS.light,
    );
  });
});

describe("vision worker (§9)", () => {
  test("InlineVisionWorker computes the same polygon as the pure module", async () => {
    const flat = new Float32Array([0, 0, 100, 0, 100, 0, 100, 100, 100, 100, 0, 100, 0, 100, 0, 0]);
    const inline = new InlineVisionWorker();
    const poly = await inline.compute(50, 50, flat, null);
    expect(poly).toEqual(visibilityPolygon(50, 50, room(), null));
  });

  test("WorkerVisionComputer: real worker handler via a stub Worker scope", async () => {
    // Import the worker module with a fake `self` so the real onmessage
    // handler is installed, then bridge it as a Worker ctor.
    const handlers: Array<(ev: { data: VisionWorkerRequest }) => void> = [];
    const fakeSelf = {
      set onmessage(fn: (ev: { data: VisionWorkerRequest }) => void) {
        handlers.push(fn);
      },
      postMessage: (res: unknown): void => {
        listener({ data: res as MessageEvent<unknown>["data"] });
      },
    };
    let listener: (ev: { data: unknown }) => void = () => undefined;
    const previousSelf = (globalThis as { self?: unknown }).self;
    (globalThis as { self?: unknown }).self = fakeSelf;
    try {
      await import("../../src/workers/vision.worker");
    } finally {
      if (previousSelf === undefined) delete (globalThis as { self?: unknown }).self;
      else (globalThis as { self?: unknown }).self = previousSelf;
    }
    expect(handlers.length).toBe(1);

    class FakeWorker {
      onmessage: ((ev: { data: unknown }) => void) | null = null;
      constructor() {
        listener = (ev): void => this.onmessage?.(ev);
      }
      postMessage(req: VisionWorkerRequest): void {
        for (const h of handlers) h({ data: req });
      }
      terminate(): void {}
    }

    const computer = new WorkerVisionComputer(FakeWorker as unknown as new () => Worker);
    const flat = new Float32Array([0, 0, 100, 0, 100, 0, 100, 100, 100, 100, 0, 100, 0, 100, 0, 0]);
    const poly = await computer.compute(50, 50, flat, 40);
    expect(poly.length).toBeGreaterThan(8);
    const b = polygonBounds(poly);
    expect(b.maxX - b.minX).toBeCloseTo(80, 0); // radius 40 cap inside the room
    computer.terminate();
  });
});

describe("lighting pure helpers (§9)", () => {
  test("parseLightColor + viewport rejection", () => {
    const { lightAffectsViewport, parseLightColor } = lights;
    expect(parseLightColor("#ff8800")).toBe(0xff8800);
    expect(parseLightColor("junk", 0x123456)).toBe(0x123456);
    const view = { x: 0, y: 0, width: 100, height: 100 };
    expect(lightAffectsViewport({ x: 50, y: 50, dim: 30 }, view)).toBe(true);
    expect(lightAffectsViewport({ x: 200, y: 200, dim: 30 }, view)).toBe(false);
    expect(lightAffectsViewport({ x: 95, y: 50, dim: 30 }, view)).toBe(true); // edge overlap
  });
});
