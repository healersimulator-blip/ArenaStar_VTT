import { describe, expect, test } from "vitest";
import {
  axialToOffset,
  hexCenter,
  hexCorners,
  hexDistance,
  hexesInView,
  hexFromPixel,
  hexNeighbors,
  offsetToAxial,
  roundAxial,
  type HexGridSpec,
} from "../../src/canvas/grid/hex";
import type { HexLayout } from "../../src/core/documents";
import { snapPoint, type GridSpec } from "../../src/canvas/grid";
import { measurePath, measureSegment, type MeasureGrid } from "../../src/canvas/grid/measure";
import { pointInTemplate, templateShape } from "../../src/canvas/layers/templateGeometry";
import { drawingBounds } from "../../src/canvas/layers/drawingGeometry";
import type { DrawingDocument, TemplateDocument } from "../../src/core/documents";

const LAYOUTS: HexLayout[] = ["evenQ", "oddQ", "evenR", "oddR"];

function grid(layout: HexLayout, size = 20): HexGridSpec {
  return { type: "hex", size, layout };
}

describe("hex grids (§9, 4 layouts)", () => {
  test("offset ⇄ axial round-trips for every layout (incl. negatives)", () => {
    for (const layout of LAYOUTS) {
      for (let q = -5; q <= 5; q += 3) {
        for (let r = -5; r <= 5; r += 2) {
          const axial = offsetToAxial(layout, q, r);
          expect(axialToOffset(layout, axial)).toEqual({ q, r });
        }
      }
    }
  });

  test("pixel → hex → center → hex is stable across a fine grid of points", () => {
    for (const layout of LAYOUTS) {
      const g = grid(layout);
      for (let x = -80; x <= 80; x += 7) {
        for (let y = -80; y <= 80; y += 7) {
          const hex = hexFromPixel(g, x, y);
          const c = hexCenter(g, hex.q, hex.r);
          expect(hexFromPixel(g, c.x, c.y)).toEqual(hex);
        }
      }
    }
  });

  test("nearest-center snap: the containing hex center is the nearest center", () => {
    const g = grid("oddR", 10);
    for (let x = -30; x <= 30; x += 2.5) {
      for (let y = -30; y <= 30; y += 2.5) {
        const hex = hexFromPixel(g, x, y);
        const own = hexCenter(g, hex.q, hex.r);
        const ownD = Math.hypot(own.x - x, own.y - y);
        for (const n of hexNeighbors(g, hex.q, hex.r)) {
          const c = hexCenter(g, n.q, n.r);
          // strictly nearer neighbors would mean containment picked wrong
          // (centers can tie on borders; require own ≤ neighbor + ε)
          expect(ownD).toBeLessThanOrEqual(Math.hypot(c.x - x, c.y - y) + 1e-9);
        }
      }
    }
  });

  test("hexDistance: neighbors are 1, ring distances are cube distance", () => {
    const g = grid("evenQ", 15);
    expect(hexDistance(g, { q: 0, r: 0 }, { q: 0, r: 0 })).toBe(0);
    for (const n of hexNeighbors(g, 3, -2)) {
      expect(hexDistance(g, { q: 3, r: -2 }, n)).toBe(1);
    }
    expect(hexDistance(g, { q: 0, r: 0 }, { q: 3, r: 1 })).toBe(3);
  });

  test("hexCorners are 6 unique points at circumradius", () => {
    for (const layout of LAYOUTS) {
      const g = grid(layout, 12);
      const corners = hexCorners(g, { x: 40, y: 25 });
      expect(corners).toHaveLength(6);
      for (const c of corners) {
        expect(Math.hypot(c.x - 40, c.y - 25)).toBeCloseTo(12, 6);
      }
      const unique = new Set(corners.map((c) => `${c.x.toFixed(4)},${c.y.toFixed(4)}`));
      expect(unique.size).toBe(6);
    }
  });

  test("hexesInView returns exactly the centers inside the rect (+margin)", () => {
    const g = grid("oddR", 10);
    const view = { x: 0, y: 0, width: 100, height: 60 };
    const hexes = hexesInView(g, view);
    expect(hexes.length).toBeGreaterThan(10);
    for (const h of hexes) {
      const c = hexCenter(g, h.q, h.r);
      expect(c.x).toBeGreaterThanOrEqual(-20);
      expect(c.x).toBeLessThanOrEqual(120);
      expect(c.y).toBeGreaterThanOrEqual(-20);
      expect(c.y).toBeLessThanOrEqual(80);
    }
  });

  test("roundAxial picks the genuinely nearest hex", () => {
    expect(roundAxial({ q: 0.4, r: 0.4 })).toEqual({ q: 0, r: 1 }); // (0,1) is nearer than (0,0)
    expect(roundAxial({ q: 0.6, r: 0.1 })).toEqual({ q: 1, r: 0 });
    expect(roundAxial({ q: -0.6, r: -0.6 })).toEqual({ q: -1, r: 0 });
    expect(roundAxial({ q: 0, r: 0 })).toEqual({ q: 0, r: 0 }); // no -0 leakage
  });
});

describe("snapPoint (§9 grid set)", () => {
  test("square snaps to intersections", () => {
    const g: GridSpec = { type: "square", size: 50 };
    expect(snapPoint(g, 12, 88)).toEqual({ x: 0, y: 100 });
    expect(snapPoint(g, 74, 26)).toEqual({ x: 50, y: 50 });
  });

  test("hex snaps to the containing hex center", () => {
    const g: GridSpec = { type: "hex", size: 20, layout: "oddR" };
    const center = hexCenter({ type: "hex", size: 20, layout: "oddR" }, 2, 3);
    const snapped = snapPoint(g, center.x + 3, center.y - 2);
    expect(snapped.x).toBeCloseTo(center.x, 9);
    expect(snapped.y).toBeCloseTo(center.y, 9);
  });

  test("gridless is identity", () => {
    expect(snapPoint({ type: "gridless" }, 13.7, -4.2)).toEqual({ x: 13.7, y: -4.2 });
  });
});

describe("hex measurement (§9 pluggability)", () => {
  const g: MeasureGrid = { type: "hex", size: 20, layout: "oddR", diagonals: "555" };

  test("adjacent hexes measure one cell", () => {
    const hex = { type: "hex", size: 20, layout: "oddR" } as HexGridSpec;
    const a = hexCenter(hex, 0, 0);
    const b = hexCenter(hex, 1, 0);
    expect(measureSegment(g, a, b)).toBeCloseTo(20, 6);
  });

  test("same-hex points measure zero", () => {
    expect(measureSegment(g, { x: 3, y: 2 }, { x: 5, y: 4 })).toBeCloseTo(0, 9);
  });

  test("two-hex path sums", () => {
    const hex = { type: "hex", size: 20, layout: "oddR" } as HexGridSpec;
    const a = hexCenter(hex, 0, 0);
    const b = hexCenter(hex, 1, 0);
    const c = hexCenter(hex, 2, 1);
    expect(measurePath(g, [a, b, c])).toBeCloseTo(60, 6); // (1,0)→(2,1) is a 2-hex step
  });
});

describe("template geometry (§9)", () => {
  const tpl = (
    over: Partial<TemplateDocument> & Pick<TemplateDocument, "kind">,
  ): TemplateDocument => ({
    _id: "t",
    type: "template",
    name: "t",
    ownership: { default: 0 },
    flags: {},
    system: {},
    x: 100,
    y: 100,
    distance: 60,
    direction: 0,
    width: 0,
    ...over,
  });

  test("circle: radius membership", () => {
    const t = tpl({ kind: "circle" });
    expect(pointInTemplate(t, 130, 100)).toBe(true);
    expect(pointInTemplate(t, 170, 100)).toBe(false);
    expect(pointInTemplate(t, 100, 35)).toBe(false); // 65 > 60 radius
  });

  test("ray: corridor along direction with width", () => {
    const t = tpl({ kind: "ray", width: 20, direction: 0 });
    expect(pointInTemplate(t, 150, 105)).toBe(true); // inside corridor
    expect(pointInTemplate(t, 150, 118)).toBe(false); // outside width
    expect(pointInTemplate(t, 170, 100)).toBe(true); // round cap: ≤ half-width past the end
    expect(pointInTemplate(t, 180, 100)).toBe(false); // beyond the cap
    expect(pointInTemplate(t, 95, 100)).toBe(true); // behind origin, within cap
  });

  test("cone: aperture in degrees, bisector along direction", () => {
    const t = tpl({ kind: "cone", width: 60, direction: Math.PI / 2 });
    expect(pointInTemplate(t, 100, 150)).toBe(true); // on bisector
    expect(pointInTemplate(t, 130, 130)).toBe(false); // 45° off bisector > 30° half-aperture
    const edgeInX = 100 + 50 * Math.cos(Math.PI / 2 - Math.PI / 6);
    const edgeInY = 100 + 50 * Math.sin(Math.PI / 2 - Math.PI / 6);
    expect(pointInTemplate(t, edgeInX, edgeInY)).toBe(true); // 15° off bisector, strictly inside
    expect(pointInTemplate(t, 100, 40)).toBe(false); // behind the apex
  });

  test("rect: rotated rectangle membership", () => {
    const t = tpl({ kind: "rect", distance: 60, width: 20, direction: 0 });
    expect(pointInTemplate(t, 130, 105)).toBe(true);
    expect(pointInTemplate(t, 130, 115)).toBe(false);
    expect(pointInTemplate(t, 165, 100)).toBe(false);
  });

  test("cone shape is a fan polygon; rect is a quad", () => {
    const cone = templateShape(tpl({ kind: "cone", width: 90 }));
    if (cone.kind !== "polygon") throw new Error("expected polygon");
    expect(cone.points.length).toBeGreaterThanOrEqual(5); // apex + arc
    const rect = templateShape(tpl({ kind: "rect", width: 30 }));
    if (rect.kind !== "polygon") throw new Error("expected polygon");
    expect(rect.points).toHaveLength(4);
  });
});

describe("drawing bounds (§9)", () => {
  const draw = (
    over: Partial<DrawingDocument> & Pick<DrawingDocument, "kind">,
  ): DrawingDocument => ({
    _id: "d",
    type: "drawing",
    name: "d",
    ownership: { default: 0 },
    flags: {},
    system: {},
    points: [],
    box: null,
    stroke: "#fff",
    fill: "",
    strokeWidth: 2,
    text: null,
    ...over,
  });

  test("freehand/poly bounds from the point list", () => {
    expect(drawingBounds(draw({ kind: "freehand", points: [10, 20, 30, 25, 22, 60] }))).toEqual({
      x: 10,
      y: 20,
      width: 20,
      height: 40,
    });
    expect(drawingBounds(draw({ kind: "poly", points: [0, 0] }))).toBeNull();
  });

  test("rect/text bounds from the box", () => {
    expect(drawingBounds(draw({ kind: "rect", box: [5, 6, 40, 30] }))).toEqual({
      x: 5,
      y: 6,
      width: 40,
      height: 30,
    });
    expect(drawingBounds(draw({ kind: "text", box: null }))).toBeNull();
  });
});
