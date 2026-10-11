/* eslint-disable @typescript-eslint/no-non-null-assertion -- explicit fixtures and required renderer readbacks; absence fails the test */
import { describe, expect, test } from "vitest";
import {
  elevationBandError,
  inElevationBand,
  levelAtElevation,
  regionShapeV2Error,
  shapeContains,
  shapeIntersectsRect,
  surfaceRayHit,
  transformShape,
  type RegionShapeV2,
  type SpatialPoint,
} from "../../src/core/multilevelGeometry";
const ring = (x = 0, y = 0, size = 1): SpatialPoint[] => [
  { x, y },
  { x: x + size, y },
  { x: x + size, y: y + size },
  { x, y: y + size },
];
const shape = (holes: SpatialPoint[][] = []): RegionShapeV2 => ({
  version: 2,
  components: [{ outer: ring(), holes }],
});

describe("native multilevel geometry", () => {
  test("bands have one half-open owner at zero and negative shared boundaries", () => {
    const levels = [
      { id: "below", bottom: null, top: 0 },
      { id: "base", bottom: 0, top: 10 },
      { id: "up", bottom: 10, top: null },
    ];
    expect(levelAtElevation(levels, -1)).toBe("below");
    expect(levelAtElevation(levels, 0)).toBe("base");
    expect(levelAtElevation(levels, 10)).toBe("up");
    expect(inElevationBand(levels[0]!, NaN)).toBe(false);
    expect(() =>
      levelAtElevation([...levels, { id: "bad", bottom: 0, top: 2 }], 1),
    ).toThrow("Overlapping");
    expect(elevationBandError({ bottom: 0, top: 0 })).not.toBeNull();
    expect(elevationBandError({ bottom: undefined, top: 1 })).not.toBeNull();
    expect(elevationBandError({ bottom: -Infinity, top: 1 })).not.toBeNull();
  });
  test("holes are local subtraction; overlapping components may fill a hole", () => {
    const s = shape([ring(0.2, 0.2, 0.6)]);
    expect(regionShapeV2Error(s)).toBeNull();
    expect(shapeContains(s, { x: 0.5, y: 0.5 })).toBe(false);
    expect(shapeContains(s, { x: 0.2, y: 0.5 })).toBe(true); // rim stays solid
    s.components.push({ outer: ring(0.4, 0.4, 0.2), holes: [] });
    expect(shapeContains(s, { x: 0.5, y: 0.5 })).toBe(true);
    expect(shapeContains(s, { x: 0.3, y: 0.3 })).toBe(false);
  });
  test("concave simple polygons, winding reversal and boundary coordinates are supported", () => {
    const s: RegionShapeV2 = {
      version: 2,
      components: [
        {
          holes: [],
          outer: [
            { x: 0, y: 0 },
            { x: 1, y: 0 },
            { x: 1, y: 0.4 },
            { x: 0.4, y: 0.4 },
            { x: 0.4, y: 1 },
            { x: 0, y: 1 },
          ],
        },
      ],
    };
    expect(regionShapeV2Error(s)).toBeNull();
    expect(shapeContains(s, { x: 0, y: 0 })).toBe(true);
    expect(shapeContains(s, { x: 0.8, y: 0.8 })).toBe(false);
    s.components[0]!.outer.reverse();
    expect(regionShapeV2Error(s)).toBeNull();
    expect(shapeContains(s, { x: 0.2, y: 0.8 })).toBe(true);
  });
  test("rejects self crossings, zero edges, touching/nested/escaping holes and excessive work", () => {
    const s = shape();
    s.components[0]!.outer = [
      { x: 0, y: 0 },
      { x: 1, y: 1 },
      { x: 0, y: 1 },
      { x: 1, y: 0 },
    ];
    expect(regionShapeV2Error(s)).not.toBeNull();
    expect(regionShapeV2Error(shape([ring(0, 0, 0.5)]))).toContain(
      "strictly inside",
    );
    expect(
      regionShapeV2Error(shape([ring(0.1, 0.1, 0.8), ring(0.2, 0.2, 0.1)])),
    ).toContain("overlap");
    expect(regionShapeV2Error(shape([ring(0.9, 0.9, 0.2)]))).toContain(
      "normalized",
    );
    expect(
      regionShapeV2Error({
        version: 2,
        components: [{ outer: Array(513).fill({ x: 0, y: 0 }), holes: [] }],
      }),
    ).toContain("512");
    expect(
      regionShapeV2Error({ version: 2, components: [null] }),
    ).not.toBeNull();
    expect(
      regionShapeV2Error({
        version: 2,
        components: [{ outer: [null, {}, 4], holes: [] }],
      }),
    ).not.toBeNull();
    const dup = shape();
    dup.components[0]!.outer.push({ x: 0, y: 0 });
    expect(regionShapeV2Error(dup)).toContain("zero-length");
  });
  test("rectangle overlap detects enclosure and edge crossings, not just sampled vertices", () => {
    const s = shape([ring(0.2, 0.2, 0.6)]);
    expect(
      shapeIntersectsRect(s, { x: 0.3, y: 0.3, width: 0.1, height: 0.1 }),
    ).toBe(false);
    expect(shapeIntersectsRect(s, { x: -1, y: -1, width: 3, height: 3 })).toBe(
      true,
    );
    expect(
      shapeIntersectsRect(s, { x: -0.2, y: 0.05, width: 1.4, height: 0.1 }),
    ).toBe(true);
    expect(shapeIntersectsRect(s, { x: 2, y: 2, width: 1, height: 1 })).toBe(
      false,
    );
  });
  test("transform and repeated queries never mutate input geometry", () => {
    const s = shape([ring(0.2, 0.2, 0.3)]),
      before = JSON.stringify(s);
    const mapped = transformShape(s, ({ x, y }) => ({
      x: 100 + y * 200,
      y: 300 - x * 100,
    }));
    for (let i = 0; i < 30; i++) shapeContains(mapped, { x: 100, y: 300 });
    expect(JSON.stringify(s)).toBe(before);
    expect(mapped.components[0]!.outer[1]).toEqual({ x: 100, y: 200 });
  });
  test("rays test actual elevation crossing, openings and endpoint/parallel policy", () => {
    const s = shape([ring(0.4, 0.4, 0.2)]);
    expect(
      surfaceRayHit(s, 10, { x: 0, y: 0, z: 25 }, { x: 1, y: 1, z: 5 }),
    ).toBe(0.75);
    expect(
      surfaceRayHit(s, 15, { x: 0, y: 0, z: 25 }, { x: 1, y: 1, z: 5 }),
    ).toBeNull();
    expect(
      surfaceRayHit(s, 25, { x: 0, y: 0, z: 25 }, { x: 1, y: 1, z: 5 }),
    ).toBeNull();
    expect(
      surfaceRayHit(s, 10, { x: 0, y: 0, z: 10 }, { x: 1, y: 1, z: 10 }),
    ).toBeNull();
    expect(() =>
      surfaceRayHit(s, Infinity, { x: 0, y: 0, z: 0 }, { x: 1, y: 1, z: 10 }),
    ).toThrow();
  });
});
