import { describe, expect, test } from "vitest";
import { SpatialKernel, legacySpatialBarrier, type BodySweep, type SpatialBarrier, type SpatialSurface } from "../../src/core/spatial/kernel";
import type { RegionShapeV2 } from "../../src/core/multilevelGeometry";
import { wallFieldsFor } from "../../src/canvas/vision/wallKinds";
import { movementFootprintBlocked, movementWallBlocked } from "../../src/core/movementPolicy";
import type { WallDocument } from "../../src/core/documents";
const rect = (a: number, b: number, c: number, d: number) => [{ x: a, y: b }, { x: c, y: b }, { x: c, y: d }, { x: a, y: d }];
const footprint = (hole = false): RegionShapeV2 => ({ version: 2, components: [{ outer: rect(0, 0, 1, 1), holes: hole ? [rect(.3, .3, .7, .7)] : [] }] });
const wall = (patch: Partial<SpatialBarrier> = {}): SpatialBarrier => ({ id: "wall", c: [50, 0, 50, 100], zSpan: { bottom: 0, top: 10 }, restrictions: { move: 0, sight: 0, light: 0, sound: 0 }, door: 0, direction: "both", ...patch });
const surface = (hole = false): SpatialSurface => ({ id: "deck", footprint: footprint(hole), transform: { x: 0, y: 0, width: 100, height: 100, rotation: 0 }, planes: [{ z: 10, blocks: ["move", "sight", "light", "sound"], supportsMovement: true }] });
const body = (patch: Partial<BodySweep> = {}): BodySweep => ({ from: { x: 0, y: 50, z: 0 }, to: { x: 100, y: 50, z: 0 }, width: 10, depth: 10, bodyHeight: 5, ...patch });
const p = (x: number, y: number, z: number) => ({ x, y, z });

describe("finite-height native wall kernel", () => {
  test("half-open wall heights: bottom blocks, top permits; unbounded spans work", () => {
    const k = new SpatialKernel([wall()], []);
    for (const z of [0, 5, 9.999]) expect(k.ray(p(0, 50, z), p(100, 50, z), "sight")[0]?.t).toBeCloseTo(.5);
    for (const z of [-1, 10, 100]) expect(k.ray(p(0, 50, z), p(100, 50, z), "sight")).toEqual([]);
    const infinite = new SpatialKernel([wall({ zSpan: { bottom: null, top: null } })], []);
    expect(infinite.ray(p(0, 50, -100), p(100, 50, -100), "sight")).toHaveLength(1);
  });
  test("uses actual intersection elevation, not either endpoint's level", () => {
    const k = new SpatialKernel([wall()], []);
    expect(k.ray(p(0, 50, -10), p(100, 50, 20), "sight")).toHaveLength(1);
    expect(k.ray(p(0, 50, 0), p(100, 50, 30), "sight")).toEqual([]);
  });
  test.each(["move", "sight", "light", "sound"] as const)("independent %s channel and conditional door state", (axis) => {
    const w = wall(); w.restrictions = { move: 2, sight: 2, light: 2, sound: 2 }; w.restrictions[axis] = 1;
    for (const door of [0, 1, 2] as const) {
      const k = new SpatialKernel([{ ...w, door }], []);
      expect(k.ray(p(0, 50, 5), p(100, 50, 5), axis)).toHaveLength(door === 1 ? 0 : 1);
      for (const other of ["move", "sight", "light", "sound"] as const) if (other !== axis) expect(k.ray(p(0, 50, 5), p(100, 50, 5), other)).toEqual([]);
    }
  });
  test("signed direction follows coordinate order, including reverse endpoints", () => {
    const k = new SpatialKernel([wall({ direction: "positiveCross" })], []);
    expect(k.ray(p(0, 50, 5), p(100, 50, 5), "sight")).toEqual([]);
    expect(k.ray(p(100, 50, 5), p(0, 50, 5), "sight")).toHaveLength(1);
    const reversed = new SpatialKernel([wall({ direction: "positiveCross", c: [50, 100, 50, 0] })], []);
    expect(reversed.ray(p(0, 50, 5), p(100, 50, 5), "sight")).toHaveLength(1);
  });
  test("segment endcaps, collinear and vertical rays cannot tunnel", () => {
    const k = new SpatialKernel([wall()], []);
    expect(k.ray(p(0, 100, 5), p(100, 100, 5), "move")).toHaveLength(1);
    expect(k.ray(p(0, 101, 5), p(100, 101, 5), "move")).toEqual([]);
    expect(k.ray(p(50, -10, 5), p(50, 110, 5), "sight")[0]?.t).toBeCloseTo(1 / 12);
    expect(k.ray(p(50, 50, -10), p(50, 50, 20), "sight")[0]?.t).toBeCloseTo(1 / 3);
  });
  test("continuous body checks finite footprint and head clearance at the same time", () => {
    const k = new SpatialKernel([wall()], []);
    expect(k.sweep(body())[0]?.t).toBeCloseTo(.45);
    expect(k.sweep(body({ from: p(0, 104, 0), to: p(100, 104, 0) }))).toHaveLength(1);
    expect(k.sweep(body({ from: p(0, 106, 0), to: p(100, 106, 0) }))).toEqual([]);
    expect(k.sweep(body({ from: p(0, 50, -5), to: p(100, 50, -5) }))).toEqual([]); // head exactly at bottom
    expect(k.sweep(body({ from: p(0, 50, -4.9), to: p(100, 50, -4.9) }))).toHaveLength(1);
    expect(k.sweep(body({ from: p(0, 50, 10), to: p(100, 50, 10) }))).toEqual([]);
    // XY and Z collision intervals do not overlap: not a collision despite overlapping 3D AABBs.
    expect(k.sweep(body({ from: p(0, 50, 0), to: p(100, 50, 100) }))).toEqual([]);
  });
  test("flat legacy adapter matches existing movement for a deterministic fixture matrix", () => {
    for (const kind of ["wall", "door", "window"] as const) for (const state of [0, 1, 2] as const) {
      const doc: WallDocument = { _id: "w", type: "wall", name: "w", flags: {}, system: {}, ownership: { default: 0 }, ...wallFieldsFor(kind, [50, 0, 50, 100], state) };
      const k = new SpatialKernel([legacySpatialBarrier(doc)], []);
      for (let y = -15; y <= 115; y += 5) {
        const from = p(0, y, 0), to = p(100, y, 0);
        expect(k.ray(from, to, "move").length > 0).toBe(movementWallBlocked(from, to, [doc]));
        for (const rotation of [0, 30, 90]) expect(k.sweep(body({ from, to, rotation, depth: 20 })).length > 0)
          .toBe(movementFootprintBlocked(from, to, 10, 20, rotation, [doc]));
      }
    }
  });
});

describe("native horizontal surfaces and cutouts", () => {
  test("solid floor blocks vertical/diagonal rays and boundary contact, not coplanar rays", () => {
    const k = new SpatialKernel([], [surface()]);
    expect(k.ray(p(50, 50, 0), p(50, 50, 20), "sight")[0]?.t).toBeCloseTo(.5);
    expect(k.ray(p(-50, 50, 0), p(150, 50, 20), "light")).toHaveLength(1);
    expect(k.ray(p(50, 50, 10), p(50, 50, 20), "sight")[0]?.t).toBe(0);
    expect(k.ray(p(50, 50, 0), p(50, 50, 10), "sight")[0]?.t).toBe(1);
    expect(k.ray(p(0, 50, 10), p(100, 50, 10), "sight")).toEqual([]);
  });
  test("hole interiors pass, rims block, and union components can fill an opening", () => {
    const s = surface(true), k = new SpatialKernel([], [s]);
    expect(k.ray(p(50, 50, 0), p(50, 50, 20), "sight")).toEqual([]);
    expect(k.ray(p(30, 50, 0), p(30, 50, 20), "sight")).toHaveLength(1);
    s.footprint.components.push({ outer: rect(.4, .4, .6, .6), holes: [] });
    expect(new SpatialKernel([], [s]).ray(p(50, 50, 0), p(50, 50, 20), "sight")).toHaveLength(1);
  });
  test("standing on a floor and fitting exactly under a ceiling is not penetration", () => {
    const k = new SpatialKernel([], [surface()]);
    expect(k.sweep(body({ from: p(20, 50, 10), to: p(80, 50, 10) }))).toEqual([]);
    expect(k.sweep(body({ from: p(20, 50, 5), to: p(80, 50, 5) }))).toEqual([]);
    expect(k.sweep(body({ from: p(20, 50, 5.1), to: p(80, 50, 5.1) }))).toHaveLength(1);
  });
  test("full body must fit an opening; center-only ray is insufficient", () => {
    const k = new SpatialKernel([], [surface(true)]);
    const through = body({ from: p(50, 50, 0), to: p(50, 50, 20) });
    expect(k.sweep(through)).toEqual([]);
    expect(k.sweep({ ...through, width: 50 })).toHaveLength(1);
    expect(k.sweep({ ...through, from: p(33, 50, 0), to: p(33, 50, 20) })).toHaveLength(1);
  });
  test("continuous horizontal head sweep catches narrow islands without sampling", () => {
    const s = surface(); s.transform = { x: 49.9, y: 0, width: .2, height: 100, rotation: 0 };
    const k = new SpatialKernel([], [s]);
    expect(k.sweep(body({ from: p(0, 50, 8), to: p(100, 50, 8), width: 1 }))[0]?.t).toBeCloseTo(.494);
    expect(k.sweep(body({ from: p(0, 50, 8), to: p(100, 50, 108), width: 1 }))).toEqual([]);
  });
  test("multiple floor/ceiling planes share the same opening", () => {
    const s = surface(true); s.planes.push({ z: 12, blocks: ["move", "sight"], supportsMovement: false });
    const k = new SpatialKernel([], [s]);
    expect(k.ray(p(50, 50, 0), p(50, 50, 20), "sight")).toEqual([]);
    expect(k.ray(p(10, 10, 0), p(10, 10, 20), "sight").map((h) => h.plane)).toEqual([0, 1]);
  });
  test("rotated/transformed surface footprint and explicit support queries", () => {
    const s = surface(); s.transform = { x: 100, y: 200, width: 100, height: 20, rotation: 90 };
    const k = new SpatialKernel([], [s]);
    expect(k.supportBelow(p(150, 250, 15))).toEqual({ id: "deck", plane: 0, z: 10 });
    expect(k.supportBelow(p(110, 210, 15))).toBeNull();
    expect(k.supportBelow(p(150, 210, 9))).toBeNull();
    expect(new SpatialKernel([], [surface(true)]).supportBelow(p(50, 50, 20))).toBeNull();
    expect(new SpatialKernel([], []).supportBelow(p(50, 50, 20))).toBeNull();
  });
  test("supportsMovement is independent of collision channels", () => {
    const s = surface(); s.planes[0] = { z: 10, blocks: ["sound"], supportsMovement: true };
    const k = new SpatialKernel([], [s]);
    expect(k.ray(p(50, 50, 0), p(50, 50, 20), "sight")).toEqual([]);
    expect(k.ray(p(50, 50, 0), p(50, 50, 20), "sound")).toHaveLength(1);
    expect(k.sweep(body({ from: p(50, 50, 0), to: p(50, 50, 20) }))).toEqual([]);
    expect(k.supportBelow(p(50, 50, 10))?.z).toBe(10);
  });
});

describe("kernel input contracts", () => {
  test("snapshots detach geometry, door state and metadata; order is deterministic", () => {
    const walls = [wall({ id: "b" }), wall({ id: "a" })], s = surface();
    const k = new SpatialKernel(walls, [s]);
    walls[0] = wall({ id: "changed", c: [100, 0, 100, 100] }); s.planes.length = 0;
    expect(k.ray(p(0, 50, 5), p(100, 50, 5), "sight").map((h) => h.id)).toEqual(["a", "b"]);
    expect(k.supportBelow(p(50, 50, 20))?.z).toBe(10);
  });
  test.each([NaN, Infinity, -Infinity, 1_000_001])("invalid query %s never silently becomes clear", (bad) => {
    const k = new SpatialKernel([], []);
    expect(() => k.ray(p(bad, 0, 0), p(1, 0, 0), "sight")).toThrow();
    expect(() => k.sweep(body({ bodyHeight: bad }))).toThrow();
    expect(() => k.supportBelow(p(0, 0, bad))).toThrow();
  });
  test("rejects malformed barriers, shapes, channels, duplicate IDs and budgets", () => {
    expect(() => new SpatialKernel([wall({ c: [0, 0, 0, 0] })], [])).toThrow();
    expect(() => new SpatialKernel([wall({ zSpan: { bottom: 10, top: 0 } })], [])).toThrow();
    expect(() => new SpatialKernel([wall(), wall()], [])).toThrow();
    expect(() => new SpatialKernel(new Array(10_001).fill(wall()), [])).toThrow(/budget/);
    const s = surface(); s.planes[0] = { z: 10, blocks: ["bogus" as never], supportsMovement: true };
    expect(() => new SpatialKernel([], [s])).toThrow();
    s.planes = []; expect(() => new SpatialKernel([], [s])).toThrow();
    expect(() => new SpatialKernel([], [{ ...surface(), footprint: {} as never }])).toThrow();
  });
});


test("sparse or precision-collapsed geometry is rejected before querying", () => {
  // eslint-disable-next-line no-sparse-arrays -- deliberately malformed input must fail closed
  expect(() => new SpatialKernel([wall({ c: [0, , 100, 100] as never })], [])).toThrow();
  expect(() => new SpatialKernel([], new Array(1))).toThrow();
  const s = surface(); s.planes = new Array(1);
  expect(() => new SpatialKernel([], [s])).toThrow();
  s.planes = [{ z: 10, blocks: new Array(1), supportsMovement: true }];
  expect(() => new SpatialKernel([], [s])).toThrow();
  const tiny = surface(); tiny.transform.width = 1e-20;
  expect(() => new SpatialKernel([], [tiny])).toThrow();
  const outside = surface(); outside.transform.x = 1_000_000;
  expect(() => new SpatialKernel([], [outside])).toThrow();
});

test("continuous sweeps agree with dense occupancy samples without missing a collision", () => {
  let seed = 12345;
  const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
  const k = new SpatialKernel([wall({ c: [10, 20, 90, 80] })], [surface(true)]);
  for (let n = 0; n < 150; n++) {
    const from = p(random() * 140 - 20, random() * 140 - 20, random() * 30 - 10);
    const to = p(random() * 140 - 20, random() * 140 - 20, random() * 30 - 10);
    const sweep = body({ from, to, width: 2 + random() * 15, depth: 2 + random() * 15, rotation: random() * 360 });
    const hits = k.sweep(sweep);
    for (let step = 0; step <= 40; step++) {
      const t = step / 40, at = p(from.x + (to.x - from.x) * t, from.y + (to.y - from.y) * t, from.z + (to.z - from.z) * t);
      for (const sample of k.sweep({ ...sweep, from: at, to: at })) {
        expect(hits.some((hit) => hit.kind === sample.kind && hit.id === sample.id && hit.plane === sample.plane && hit.t <= t + 1e-7)).toBe(true);
      }
    }
  }
});


test("rotated body clearance cannot use just an unrotated box or its center", () => {
  const k = new SpatialKernel([], [surface(true)]);
  const sweep = body({ from: p(50, 50, 0), to: p(50, 50, 20), width: 35, depth: 35 });
  expect(k.sweep(sweep)).toEqual([]);
  expect(k.sweep({ ...sweep, rotation: 45 })).toHaveLength(1);
  expect(() => k.sweep({ ...sweep, rotation: NaN })).toThrow();
});

describe("three-floor geometry conformance fixture (not multiplayer authorization)", () => {
  const stack = (openGroundDoor: boolean, stairs: boolean) => {
    const base = surface(stairs); base.id = "ground-floor"; base.planes[0] = { z: 0, blocks: ["move", "sight", "light", "sound"], supportsMovement: true };
    const upper = surface(stairs); upper.id = "upper-floor";
    const roof = surface(); roof.id = "roof"; roof.planes[0] = { z: 20, blocks: ["move", "sight", "light", "sound"], supportsMovement: true };
    const door = wall({ id: "ground-door", door: openGroundDoor ? 1 : 0, restrictions: { move: 1, sight: 1, light: 1, sound: 1 } });
    return new SpatialKernel([
      wall({ id: "basement-wall", zSpan: { bottom: -10, top: 0 } }), door,
      wall({ id: "upper-wall", zSpan: { bottom: 10, top: 20 } }),
    ], [base, upper, roof]);
  };
  test("sealed floor blocks every physical channel despite an open same-XY ground door", () => {
    const k = stack(true, false);
    for (const axis of ["move", "sight", "light", "sound"] as const) {
      expect(k.ray(p(20, 20, -5), p(80, 80, 5), axis).some((h) => h.id === "ground-floor")).toBe(true);
      expect(k.ray(p(20, 20, 5), p(80, 80, 15), axis).some((h) => h.id === "upper-floor")).toBe(true);
    }
    expect(k.ray(p(20, 20, 5), p(80, 20, 5), "sight")).toEqual([]);
    expect(k.ray(p(20, 20, 15), p(80, 20, 15), "sight").map((h) => h.id)).toEqual(["upper-wall"]);
    expect(k.ray(p(20, 20, -5), p(80, 20, -5), "sight").map((h) => h.id)).toEqual(["basement-wall"]);
  });
  test("openings allow geometric passage but never imply support or permission", () => {
    const k = stack(true, true);
    // Offset from the vertical wall inside the same staircase opening.
    expect(k.ray(p(60, 50, -5), p(60, 50, 15), "sight")).toEqual([]);
    expect(k.supportBelow(p(60, 50, 15))).toBeNull();
    expect(k.supportBelow(p(20, 20, 15))?.id).toBe("upper-floor");
    expect(k.sweep(body({ from: p(60, 50, -5), to: p(60, 50, 11), width: 5, depth: 5, bodyHeight: 3 }))).toEqual([]);
    expect(k.sweep(body({ from: p(60, 50, -5), to: p(60, 50, 11), width: 25, depth: 5, bodyHeight: 3 })).some((h) => h.kind === "surface")).toBe(true);
    expect(k.ray(p(60, 50, 15), p(60, 50, 25), "sight").map((h) => h.id)).toEqual(["roof"]);
  });
});
