import { describe, expect, test } from "vitest";
import { sweptTileEvents, tileContainsPoint } from "../../src/core/automation";
import { tileAlphaMaskFromRgba, tileTriggerCirclePolygon, tileTriggerElevationError, tileTriggerZoneError } from "../../src/core/tileTriggerZone";
import type { SceneGrid, TileDocument, TokenDocument } from "../../src/core/documents";

const tile = (triggerZone?: TileDocument["triggerZone"]): TileDocument => ({
  _id: "triangle", type: "tile", name: "Triangle", ownership: { default: 1 }, flags: {}, system: {},
  x: 100, y: 100, width: 200, height: 100, img: "", above: false,
  occlusion: { mode: "roof", alpha: 0.5 }, ...(triggerZone ? { triggerZone } : {}),
});
const token = (x: number, y: number): TokenDocument => ({
  _id: "mover", type: "token", name: "Mover", ownership: { default: 3 }, flags: {}, system: {},
  x, y, width: 20, height: 20, rotation: 0, img: "", hidden: false, disposition: "neutral", vision: true,
  light: { radius: 0, color: "#fff", alpha: 0.5 },
});
const triangle: NonNullable<TileDocument["triggerZone"]> = {
  kind: "polygon", points: [[0.5, 0], [1, 1], [0, 1]],
};

describe("convex tile trigger shapes (TR-02)", () => {
  test("validates bounded, normalized, ordered convex polygons", () => {
    expect(tileTriggerZoneError(triangle)).toBeNull();
    const circle = tileTriggerCirclePolygon();
    expect(circle.points).toHaveLength(32);
    expect(tileTriggerZoneError(circle)).toBeNull();
    expect(tileTriggerElevationError({ min: -5, max: 25 })).toBeNull();
    expect(tileTriggerElevationError({ min: 25, max: -5 })).toMatch(/ordered finite range/);
    expect(tileTriggerElevationError({ min: Number.NaN, max: 5 })).toMatch(/ordered finite range/);
    expect(tileTriggerZoneError({ kind: "polygon", points: [[0, 0], [1, 1], [0, 1], [1, 0]] })).toMatch(/convex/);
    expect(tileTriggerZoneError({ kind: "polygon", points: [[0, 0], [1, 1], [0, 1], [0, 0]] })).toMatch(/unique/);
    expect(tileTriggerZoneError({ kind: "polygon", points: [[-0.1, 0], [1, 0], [0, 1]] })).toMatch(/normalized/);
  });

  test("pointer hits use the authored polygon rather than its rectangular bounds", () => {
    const zone = tile(triangle);
    expect(tileContainsPoint(zone, { x: 130, y: 150 })).toBe(false);
    expect(tileContainsPoint(zone, { x: 220, y: 150 })).toBe(true);
    expect(tileContainsPoint(tile(), { x: 130, y: 150 })).toBe(true); // legacy rectangle
  });

  test("sweeps preserve token footprint and strict edge contact for polygon zones", () => {
    const shaped = tile(triangle), rectangle = tile();
    const before = token(50, 110), rectangleOnly = token(140, 110), entersShape = token(200, 110);
    expect(sweptTileEvents(shaped, before, rectangleOnly)).toEqual([]);
    expect(sweptTileEvents(rectangle, before, rectangleOnly).map((event) => event.method)).toEqual(["enter", "stop"]);
    expect(sweptTileEvents(shaped, before, entersShape).map((event) => event.method)).toEqual(["enter", "stop"]);
    const pass = sweptTileEvents(shaped, before, token(300, 110));
    expect(pass.map((event) => event.method)).toEqual(["enter", "exit"]);
    expect(pass[0]?.fraction).toBeLessThan(pass[1]?.fraction ?? 0);
  });

  test("image alpha is encoded as bounded runs and movement crosses disconnected opaque islands", () => {
    const rgba = new Uint8ClampedArray(64 * 64 * 4);
    for (let y = 0; y < 64; y++) for (let x = 0; x < 64; x++) {
      if (x < 16 || x >= 48) rgba[(y * 64 + x) * 4 + 3] = 255;
    }
    const mask = tileAlphaMaskFromRgba(rgba, 64, 64, "a".repeat(64));
    expect(mask).not.toBeNull();
    expect(tileTriggerZoneError(mask)).toBeNull();
    const zone = tile(mask ?? undefined);
    expect(tileContainsPoint(zone, { x: 125, y: 150 })).toBe(true);
    expect(tileContainsPoint(zone, { x: 200, y: 150 })).toBe(false);
    expect(tileContainsPoint(zone, { x: 275, y: 150 })).toBe(true);
    const events = sweptTileEvents(zone, token(50, 150), token(350, 150));
    expect(events.map(({ method }) => method)).toEqual(["enter", "exit", "enter", "exit"]);
    expect(events[0]?.fraction).toBeLessThan(events[1]?.fraction ?? 0);
    expect(events[1]?.fraction).toBeLessThan(events[2]?.fraction ?? 0);
    const rotated = { ...zone, rotation: 90 };
    expect(tileContainsPoint(rotated, { x: 200, y: 75 })).toBe(true);
    expect(tileContainsPoint(rotated, { x: 200, y: 150 })).toBe(false);
    expect(tileContainsPoint(rotated, { x: 200, y: 225 })).toBe(true);
    expect(sweptTileEvents(rotated, token(200, 0), token(200, 300)).map(({ method }) => method))
      .toEqual(["enter", "exit", "enter", "exit"]);
  });

  test("rejects malformed and over-budget alpha masks", () => {
    const empty = { kind: "alpha", width: 64, height: 64, imageHash: "a".repeat(64), rows: Array.from({ length: 64 }, () => []) };
    expect(tileTriggerZoneError(empty)).toMatch(/no opaque pixels/);
    const adjacent = { kind: "alpha", width: 64, height: 64, imageHash: "a".repeat(64),
      rows: Array.from({ length: 64 }, (_row, index) => index === 0 ? [[0, 1], [1, 2]] : []) };
    expect(tileTriggerZoneError(adjacent)).toMatch(/ordered/);
  });

  test("hex-grid sweeps use the cell-shaped token footprint rather than its square artwork bounds", () => {
    const corner = { ...tile(), x: 40, y: 40, width: 8, height: 8 };
    const mover = { ...token(0, 0), width: 100, height: 100 };
    expect(sweptTileEvents(corner, undefined, mover).map(({ method }) => method)).toEqual(["create"]);
    for (const hexLayout of ["oddQ", "evenQ", "oddR", "evenR"] as const) {
      const hexGrid: SceneGrid = { type: "hex", size: 50, units: "ft", distance: 5, diagonals: "euclidean", hexLayout };
      expect(sweptTileEvents(corner, undefined, mover, hexGrid), hexLayout).toEqual([]);
      expect(sweptTileEvents(corner, undefined, { ...mover, rotation: 45 }, hexGrid), hexLayout).toEqual([]);
    }
  });

  test("elevation bands filter movement and emit enter, exit and elevation events at vertical crossings", () => {
    const band = { ...tile(), x: 100, y: 100, width: 200, height: 100, triggerElevation: { min: 5, max: 10 } };
    const grounded = { ...token(150, 150), elevation: 0 };
    const raised = { ...grounded, elevation: 6 };
    expect(sweptTileEvents(band, grounded, raised)).toEqual([
      { method: "enter", fraction: 5 / 6 }, { method: "elevation", fraction: 1 },
    ]);
    expect(sweptTileEvents(band, raised, { ...raised, elevation: 8 })).toEqual([
      { method: "elevation", fraction: 1 },
    ]);
    expect(sweptTileEvents(band, raised, { ...raised, x: 400 })).toEqual([{ method: "exit", fraction: 0.64 }]);
    expect(sweptTileEvents(band, grounded, { ...grounded, x: 400 })).toEqual([]);
    expect(sweptTileEvents(band, grounded, { ...grounded, elevation: 20 })).toEqual([
      { method: "enter", fraction: 0.25 }, { method: "exit", fraction: 0.5 },
      { method: "elevation", fraction: 1 },
    ]);
  });

  test("tile rotation transforms polygon picking and swept events together", () => {
    const rotated = { ...tile(triangle), rotation: 90 };
    expect(tileContainsPoint(rotated, { x: 200, y: 150 })).toBe(true);
    expect(tileContainsPoint(rotated, { x: 240, y: 60 })).toBe(false);
    expect(sweptTileEvents(rotated, token(50, 150), token(150, 50)).map((event) => event.method))
      .toEqual(["enter", "stop"]);
  });
});
