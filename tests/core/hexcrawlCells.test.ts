/**
 * D-269 (plan §3.2) — the cell vocabulary on all three grid kinds.
 *
 * The point of these tests is that a hex, a square and a gridless zone are the *same* thing to
 * every caller above this module: a string key, a centre, a ring. The four hex layouts are
 * covered because offset-to-axial is where a hexcrawl quietly breaks (D-076).
 */
import { describe, expect, test } from "vitest";
import type {
  CellDocument,
  HexLayout,
  SceneDocument,
} from "../../src/core/documents";
import {
  cellAtPoint,
  cellCenterOf,
  cellCensus,
  cellDistance,
  cellKeyOf,
  cellNeighbors,
  cellsInMap,
  cellsOf,
  cellsWithin,
  parseCellKey,
  zonesWithinRadius,
} from "../../src/core/hexcrawl/cells";

const HEX_LAYOUTS: HexLayout[] = ["oddQ", "evenQ", "oddR", "evenR"];

function scene(over: Partial<SceneDocument> = {}): SceneDocument {
  return {
    _id: "scene-1",
    type: "scene",
    name: "Map",
    ownership: { default: 0 },
    flags: {},
    system: {},
    active: true,
    img: null,
    width: 1000,
    height: 800,
    darkness: 0,
    grid: {
      type: "hex",
      size: 50,
      distance: 6,
      units: "mi",
      diagonals: "555",
      hexLayout: "oddQ",
    },
    tokens: [],
    walls: [],
    cells: [],
    lights: [],
    sounds: [],
    tiles: [],
    drawings: [],
    templates: [],
    notes: [],
    ...over,
  };
}

const cell = (key: string, over: Partial<CellDocument> = {}): CellDocument => ({
  _id: `cell-${key.replace(",", "-")}`,
  type: "cell",
  name: key,
  ownership: { default: 0 },
  flags: {},
  system: {},
  key,
  ...over,
});

describe("cell keys", () => {
  test("a coordinate pair round-trips, negative and zero included", () => {
    expect(cellKeyOf({ q: 3, r: -2 })).toBe("3,-2");
    expect(parseCellKey("3,-2")).toEqual({ q: 3, r: -2 });
    expect(parseCellKey("0,0")).toEqual({ q: 0, r: 0 });
    expect(parseCellKey("-1,-1")).toEqual({ q: -1, r: -1 });
  });

  test("a zone id is not a coordinate pair", () => {
    expect(parseCellKey("zone-of-mist")).toBeNull();
    expect(parseCellKey("3")).toBeNull();
    expect(parseCellKey("3;4")).toBeNull();
    expect(parseCellKey("3,4,5")).toBeNull();
    expect(parseCellKey("a,4")).toBeNull();
  });
});

describe("cellsOf", () => {
  test("an old scene without the field reads as empty, not a crash", () => {
    const old = { ...scene(), cells: undefined } as unknown as SceneDocument;
    expect(cellsOf(old)).toEqual([]);
    expect(cellsOf(null)).toEqual([]);
    expect(cellsOf(scene({ cells: [cell("0,0")] }))).toHaveLength(1);
  });
});

describe("point → cell, for every grid kind", () => {
  test("square: the floor division of the point", () => {
    const s = scene({
      grid: {
        type: "square",
        size: 100,
        distance: 5,
        units: "ft",
        diagonals: "555",
        hexLayout: "oddQ",
      },
    });
    expect(cellAtPoint(s, 5, 5)).toBe("0,0");
    expect(cellAtPoint(s, 105, 5)).toBe("1,0");
    expect(cellAtPoint(s, -5, -5)).toBe("-1,-1");
  });

  for (const layout of HEX_LAYOUTS) {
    test(`hex (${layout}): the centre of a cell lands in that cell`, () => {
      const s = scene({
        grid: {
          type: "hex",
          size: 40,
          distance: 6,
          units: "mi",
          diagonals: "555",
          hexLayout: layout,
        },
      });
      // The property that matters is the round trip: centre → cell → same cell. If the offset
      // formulas disagree anywhere, this catches it on the corners of a 5×5 patch.
      for (let q = -2; q <= 2; q++) {
        for (let r = -2; r <= 2; r++) {
          const key = cellKeyOf({ q, r });
          const centre = cellCenterOf(s, key) as { x: number; y: number };
          expect(cellAtPoint(s, centre.x, centre.y)).toBe(key);
          // …and just inside every corner, so the rounding is tested, not only the centre.
          for (const [dx, dy] of [
            [1, 1],
            [-1, 1],
            [1, -1],
            [-1, -1],
          ] as const) {
            expect(cellAtPoint(s, centre.x + dx * 6, centre.y + dy * 6)).toBe(
              key,
            );
          }
        }
      }
    });
  }

  test("gridless: only the authored zones answer, and a point outside them is null", () => {
    const zone = cell("zone-1", { poly: [0, 0, 100, 0, 100, 100, 0, 100] });
    const s = scene({
      grid: {
        type: "gridless",
        size: 0,
        distance: 6,
        units: "mi",
        diagonals: "555",
        hexLayout: "oddQ",
      },
      cells: [zone],
    });
    expect(cellAtPoint(s, 50, 50)).toBe("zone-1");
    expect(cellAtPoint(s, 150, 50)).toBeNull();
    // A zone with no polygon cannot be hit-tested (and must not throw).
    expect(
      cellAtPoint(scene({ ...s, cells: [cell("zone-2")] }), 50, 50),
    ).toBeNull();
  });
});

describe("distance, neighbours and rings", () => {
  test("hex distance is the cube distance and is symmetric", () => {
    const s = scene();
    expect(cellDistance(s, "0,0", "0,0")).toBe(0);
    expect(cellDistance(s, "0,0", "1,0")).toBe(1);
    expect(cellDistance(s, "0,0", "2,0")).toBe(2);
    expect(cellDistance(s, "0,0", "2,0")).toBe(cellDistance(s, "2,0", "0,0"));
    // Every neighbour is exactly 1 away, in every layout.
    for (const layout of HEX_LAYOUTS) {
      const grid = scene({
        grid: {
          type: "hex",
          size: 40,
          distance: 6,
          units: "mi",
          diagonals: "555",
          hexLayout: layout,
        },
      });
      for (const n of cellNeighbors(grid, "0,0"))
        expect(cellDistance(grid, "0,0", n)).toBe(1);
      expect(cellNeighbors(grid, "0,0")).toHaveLength(6);
    }
  });

  test("square distance is Chebyshev and neighbours are 8", () => {
    const s = scene({
      grid: {
        type: "square",
        size: 100,
        distance: 5,
        units: "ft",
        diagonals: "555",
        hexLayout: "oddQ",
      },
    });
    expect(cellDistance(s, "0,0", "2,2")).toBe(2);
    expect(cellDistance(s, "0,0", "3,1")).toBe(3);
    expect(cellNeighbors(s, "0,0")).toHaveLength(8);
  });

  test("gridless has no rings or distances — the caller uses world units instead", () => {
    const s = scene({
      grid: {
        type: "gridless",
        size: 0,
        distance: 6,
        units: "mi",
        diagonals: "555",
        hexLayout: "oddQ",
      },
      cells: [
        cell("z1", { poly: [0, 0, 50, 0, 50, 50, 0, 50] }),
        cell("z2", { poly: [60, 0, 200, 0, 200, 50, 60, 50] }),
      ],
    });
    expect(cellDistance(s, "z1", "z2")).toBeNull();
    expect(cellNeighbors(s, "z1")).toEqual([]);
    // zonesWithinRadius is the gridless ring: bounds within `radius` of the point.
    // The test is a bounds distance, so it is the *gap* from the point to the zone that counts:
    // (25,25) is 35 units from z2's left edge.
    expect(zonesWithinRadius(s, { x: 25, y: 25 }, 0)).toEqual(["z1"]);
    expect(zonesWithinRadius(s, { x: 25, y: 25 }, 30)).toEqual(["z1"]);
    expect(zonesWithinRadius(s, { x: 25, y: 25 }, 35)).toEqual(["z1", "z2"]);
  });

  test("cellsWithin returns ring 0, 1 and 2 counts for hexes (1, 7, 19) and squares (1, 9, 25)", () => {
    const hex = scene();
    expect(cellsWithin(hex, "0,0", 0)).toEqual(["0,0"]);
    expect(cellsWithin(hex, "0,0", 1)).toHaveLength(7);
    expect(cellsWithin(hex, "0,0", 2)).toHaveLength(19);
    // Every returned cell is genuinely within the radius, and the centre is always present.
    for (const r of [0, 1, 2]) {
      const ring = cellsWithin(hex, "0,0", r);
      expect(ring).toContain("0,0");
      for (const key of ring)
        expect(cellDistance(hex, "0,0", key)).toBeLessThanOrEqual(r);
    }
    const square = scene({
      grid: {
        type: "square",
        size: 100,
        distance: 5,
        units: "ft",
        diagonals: "555",
        hexLayout: "oddQ",
      },
    });
    expect(cellsWithin(square, "0,0", 0)).toHaveLength(1);
    expect(cellsWithin(square, "0,0", 1)).toHaveLength(9);
    expect(cellsWithin(square, "0,0", 2)).toHaveLength(25);
  });

  test("rings work away from the origin and clamp a silly radius", () => {
    const hex = scene();
    const ring = cellsWithin(hex, "-3,2", 1);
    expect(ring).toHaveLength(7);
    expect(ring).toContain("-3,2");
    // A radius past the cap does not walk forever or throw.
    expect(cellsWithin(hex, "0,0", 10_000).length).toBeGreaterThan(100);
    // A gridless / zone key has no rings to walk.
    expect(cellsWithin(hex, "zone-1", 2)).toEqual(["zone-1"]);
    expect(cellsWithin(hex, "nonsense", 0)).toEqual(["nonsense"]);
  });
});

describe("cellsInMap and the census", () => {
  test("a hex map enumerates the hexes whose centres are inside it", () => {
    const s = scene({ width: 600, height: 600 });
    const keys = cellsInMap(s);
    expect(keys.length).toBeGreaterThan(50);
    expect(keys.length).toBeLessThan(400);
    // The enumerator is deliberately over-inclusive by a hex diameter (the drawing layer wants
    // the hexes whose *bodies* touch the map), so the bound is the expanded rect, not the map.
    for (const key of keys) {
      const centre = cellCenterOf(s, key) as { x: number; y: number };
      expect(centre.x).toBeGreaterThanOrEqual(-100);
      expect(centre.x).toBeLessThanOrEqual(700);
      expect(centre.y).toBeGreaterThanOrEqual(-100);
      expect(centre.y).toBeLessThanOrEqual(700);
    }
  });

  test("a square map is cols × rows and stops at the cap", () => {
    const s = scene({
      width: 400,
      height: 300,
      grid: {
        type: "square",
        size: 100,
        distance: 5,
        units: "ft",
        diagonals: "555",
        hexLayout: "oddQ",
      },
    });
    expect(cellsInMap(s)).toHaveLength(12); // 4 × 3
    expect(cellsInMap(s, 5)).toHaveLength(5);
  });

  test("a gridless map enumerates its authored zones only", () => {
    const s = scene({
      grid: {
        type: "gridless",
        size: 0,
        distance: 6,
        units: "mi",
        diagonals: "555",
        hexLayout: "oddQ",
      },
      cells: [
        cell("z1", { poly: [0, 0, 10, 0, 10, 10] }),
        cell("z2"),
        cell("z3", { poly: [0, 0, 5, 0, 5, 5] }),
      ],
    });
    expect(cellsInMap(s)).toEqual(["z1", "z3"]);
    expect(cellCensus(s)).toEqual({ total: 3, authored: 3, gridless: true });
  });

  test("the census counts the map, not the documents", () => {
    const s = scene({
      width: 400,
      height: 300,
      grid: {
        type: "square",
        size: 100,
        distance: 5,
        units: "ft",
        diagonals: "555",
        hexLayout: "oddQ",
      },
      cells: [cell("0,0"), cell("1,0")],
    });
    expect(cellCensus(s)).toEqual({ total: 12, authored: 2, gridless: false });
    // A scene with no size can enumerate nothing but must not throw.
    expect(cellsInMap(scene({ width: 0, height: 0 }))).toEqual([]);
    expect(cellsInMap(null)).toEqual([]);
  });
});
