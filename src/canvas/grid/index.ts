/**
 * §9 grid geometry — pure math for the grid layer (square grid, M1 subset;
 * hex layouts land with the full §9 stack in M2).
 */
export interface SquareGrid {
  type: "square";
  /** Pixel size of one cell. */
  size: number;
}

export interface GridViewport {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface GridLines {
  /** Vertical line world-x positions intersecting the viewport. */
  verticals: number[];
  /** Horizontal line world-y positions intersecting the viewport. */
  horizontals: number[];
}

/** Line positions for the viewport, aligned to multiples of size (cell 0 at 0). */
export function squareGridLines(grid: SquareGrid, view: GridViewport): GridLines {
  if (grid.size <= 0) throw new Error("squareGridLines: size must be > 0");
  const range = (start: number, end: number): number[] => {
    const first = Math.ceil(start / grid.size) * grid.size;
    const lines: number[] = [];
    for (let at = first; at <= end; at += grid.size) lines.push(at === 0 ? 0 : at);
    return lines;
  };
  return {
    verticals: range(view.x, view.x + view.width),
    horizontals: range(view.y, view.y + view.height),
  };
}

/** Nearest grid-intersection snap for a world point (rulers/pings, §9). */
export function snapToGrid(grid: SquareGrid, x: number, y: number): { x: number; y: number } {
  if (grid.size <= 0) throw new Error("snapToGrid: size must be > 0");
  return {
    x: normalizeZero(Math.round(x / grid.size) * grid.size),
    y: normalizeZero(Math.round(y / grid.size) * grid.size),
  };
}

function normalizeZero(value: number): number {
  return value === 0 ? 0 : value;
}

// ─── §9 full grid set: hex (4 layouts) + gridless ─────────────────────────────

export type { HexGridSpec } from "./hex";
export type { HexLayout } from "../../core/documents";
export {
  axialToOffset,
  axialToPixel,
  hexCenter,
  hexCorners,
  hexDistance,
  hexesInView,
  hexFromPixel,
  hexNeighbors,
  offsetToAxial,
  pixelToAxial,
  roundAxial,
} from "./hex";

/** Any scene grid (§9); gridless scenes carry `{ type: "gridless" }`. */
export type GridSpec = SquareGrid | HexGridSpec | { type: "gridless" };

import type { HexGridSpec } from "./hex";
import { hexCenter, hexFromPixel } from "./hex";

/**
 * Snap a world point under any grid: square → nearest intersection,
 * hex → nearest hex CENTER, gridless → unchanged.
 */
export function snapPoint(grid: GridSpec, x: number, y: number): { x: number; y: number } {
  switch (grid.type) {
    case "square":
      return snapToGrid(grid, x, y);
    case "hex": {
      const { q, r } = hexFromPixel(grid, x, y);
      return hexCenter(grid, q, r);
    }
    case "gridless":
      return { x, y };
  }
}

/**
 * Snap a **token's centre** under any grid: square → the nearest cell **centre**
 * (a square of side `size` whose centre is `(col*size + size/2, row*size + size/2)`),
 * hex → nearest hex centre, gridless → unchanged.
 *
 * Tokens carry their centre in `x`/`y` (`tokenRect` halves `width`/`height`), so a
 * drag that snaps the centre to an *intersection* — what `snapPoint` does for
 * rulers/pings — leaves the token straddling four cells, and the PF1e move walk
 * (`cellsAlongSegment`) then cuts a diagonal through squares the mover never
 * entered. Hex has always snapped to hex centres, so this brings square tokens in
 * line with hex instead of leaving them half a cell off.
 */
export function snapTokenCenter(
  grid: GridSpec,
  x: number,
  y: number,
): { x: number; y: number } {
  switch (grid.type) {
    case "square": {
      const half = grid.size / 2;
      return {
        x: normalizeZero(Math.round((x - half) / grid.size) * grid.size + half),
        y: normalizeZero(Math.round((y - half) / grid.size) * grid.size + half),
      };
    }
    case "hex": {
      const { q, r } = hexFromPixel(grid, x, y);
      return hexCenter(grid, q, r);
    }
    case "gridless":
      return { x, y };
  }
}

