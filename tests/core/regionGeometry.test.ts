import { describe, expect, test } from "vitest";
import type { RegionDocument } from "../../src/core/documents";
import { regionGeometryError, regionTriggerTile } from "../../src/core/regionGeometry";
import { tileTriggerWorldPolygon } from "../../src/core/tileTriggerZone";

const region = (overrides: Partial<RegionDocument> = {}): RegionDocument => ({
  _id: "courtyard",
  type: "region",
  name: "Courtyard",
  ownership: { default: 0 },
  flags: {},
  system: {},
  x: 100,
  y: 200,
  width: 300,
  height: 180,
  rotation: 30,
  shape: { kind: "polygon", points: [[0.5, 0], [1, 1], [0, 1]] },
  ...overrides,
});

describe("first-class region geometry", () => {
  test("validates bounded convex normalized shapes, elevation, and rotation", () => {
    expect(regionGeometryError(region())).toBeNull();
    expect(regionGeometryError(region({ width: 0 }))).toContain("bounds");
    expect(regionGeometryError(region({ shape: { kind: "polygon", points: [[0, 0], [1, 1], [0, 1], [1, 0]] } }))).toContain("convex");
    expect(regionGeometryError(region({ shape: { kind: "alpha", width: 64, height: 64, imageHash: "a".repeat(64), rows: Array.from({ length: 64 }, () => [[0, 1]]) } as never }))).toContain("convex polygon");
    expect(regionGeometryError(region({ triggerElevation: { min: 5, max: -5 } }))).toContain("elevation");
  });

  test("adapts a region to the shared rotated polygon geometry without inventing image art", () => {
    const doc = region();
    const tile = regionTriggerTile(doc);
    expect(tile._id).toBe(doc._id);
    expect(tile.img).toBe("");
    expect(tileTriggerWorldPolygon(tile)).toHaveLength(3);
    expect(tile.rotation).toBe(30);
    expect(tile.above).toBe(false);
  });
});
