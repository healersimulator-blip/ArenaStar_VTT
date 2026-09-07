/**
 * §9 pluggable measurement (555 / 5105 / euclidean) — the ruler math behind
 * waypoint move orders (§9A) and distance readouts. Pure world-unit math:
 * grid `size` is world-units-per-cell; hex grids measure euclidean until the
 * hex unit lands (comment-only deviation, logged in PLAN).
 */

export type DiagonalRule = "555" | "5105" | "euclidean";

export interface MeasureGrid {
  type: "square" | "hex" | "gridless";
  /** World units per grid cell (hex: circumradius). */
  size: number;
  diagonals: DiagonalRule;
  /** Hex layout (§9, four orientations; hex measurement ignores `diagonals`). */
  layout?: HexLayout;
}

import type { HexLayout } from "../../core/documents";
import { hexDistance, hexFromPixel, type HexGridSpec } from "./hex";

/** Cell-count cost of a displacement in whole-grid units. */
export function cellDistance(rule: DiagonalRule, dxCells: number, dyCells: number): number {
  const dx = Math.abs(dxCells);
  const dy = Math.abs(dyCells);
  switch (rule) {
    case "555":
      // every diagonal costs one cell (5-5-5)
      return Math.max(dx, dy);
    case "5105":
      // diagonals alternate 1,2,1,2 cells (5-10-5)
      return Math.max(dx, dy) + Math.floor(Math.min(dx, dy) / 2);
    case "euclidean":
      return Math.hypot(dx, dy);
  }
}

/** Measured length of one segment in world units under the grid's rule. */
export function measureSegment(
  grid: MeasureGrid | null,
  a: { x: number; y: number },
  b: { x: number; y: number },
): number {
  if (!grid || grid.type === "gridless" || grid.size <= 0) {
    return Math.hypot(b.x - a.x, b.y - a.y);
  }
  if (grid.type === "hex") {
    // hex distance = hex count between the containing cells × size
    const spec: HexGridSpec = { type: "hex", size: grid.size, layout: grid.layout ?? "oddR" };
    const cells = hexDistance(spec, hexFromPixel(spec, a.x, a.y), hexFromPixel(spec, b.x, b.y));
    return cells * grid.size;
  }
  const dxCells = Math.abs(b.x - a.x) / grid.size;
  const dyCells = Math.abs(b.y - a.y) / grid.size;
  return cellDistance(grid.diagonals, dxCells, dyCells) * grid.size;
}

/** Measured length of a waypoint path (§9A ruler); ≥ 2 points required. */
export function measurePath(
  grid: MeasureGrid | null,
  path: ReadonlyArray<{ x: number; y: number }>,
): number {
  let total = 0;
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1];
    const b = path[i];
    if (a && b) total += measureSegment(grid, a, b);
  }
  return total;
}

/**
 * Quantize a drag trail into waypoints: a point is captured only once it is
 * ≥ minSpacing (world units) from the last captured one. Returns the same
 * array reference when nothing changed (cheap immutable updates), capped at
 * maxWaypoints (§4A: 12) — callers wanting the exact endpoint commit it
 * explicitly (gestures append the release point themselves).
 */
export function captureWaypoints(
  path: ReadonlyArray<{ x: number; y: number }>,
  point: { x: number; y: number },
  minSpacing: number,
  maxWaypoints = 12,
): { x: number; y: number }[] {
  const last = path[path.length - 1];
  const far = !last || Math.hypot(point.x - last.x, point.y - last.y) >= minSpacing;
  if (!far) return path as { x: number; y: number }[];
  if (path.length >= maxWaypoints) return path as { x: number; y: number }[];
  return [...path, { x: point.x, y: point.y }];
}
