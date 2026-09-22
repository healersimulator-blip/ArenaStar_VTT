/**
 * **Hexcrawl cells — keys, geometry and the cells a party can see (D-269, plan §3.2).**
 *
 * A *cell* is a hex, a square, or — on a gridless map — a drawn **zone**. This module is the
 * one place that answers "which cell is this point in?", "where is that cell?", "which cells are
 * within N of it?" and "which cells does this map have at all?", for the three grid kinds, on
 * top of the geometry the canvas already ships (`canvas/grid/hex.ts` — the four §0 layouts,
 * `hexCenter`, `hexFromPixel`, `hexDistance`, `hexNeighbors`; `canvas/vision/polygon.ts` —
 * `pointInPolygon`, `polygonBounds`). Nothing here is new geometry; what is new is the *cell
 * vocabulary* the hexcrawl feature speaks.
 *
 * Cells are **sparse**: only authored ones exist as documents (see `CellDocument`), so every
 * reader here has a "no document" answer — the scene's default terrain, and unexplored.
 */
import {
  hexCenter,
  hexDistance,
  hexFromPixel,
  hexNeighbors,
  hexesInView,
  type HexGridSpec,
} from "../../canvas/grid/hex";
import { layoutIsFlat } from "../../canvas/grid/hex";
import { pointInPolygon, polygonBounds } from "../../canvas/vision/polygon";
import type { CellDocument, SceneDocument } from "../documents";

/** A hex or square address in offset coordinates (the key's own shape). */
export interface CellCoords {
  q: number;
  r: number;
}

/** `q,r` — the key format for hex and square scenes. Zones use their document `_id`. */
export function cellKeyOf(c: CellCoords): string {
  return `${c.q},${c.r}`;
}

/** Parse a gridded key; null for a zone id (which is not a coordinate pair). */
export function parseCellKey(key: string): CellCoords | null {
  const at = key.indexOf(",");
  if (at <= 0) return null;
  const q = Number(key.slice(0, at));
  const r = Number(key.slice(at + 1));
  if (!Number.isInteger(q) || !Number.isInteger(r)) return null;
  return { q, r };
}

/** The authored cells of a scene, tolerating scenes written before the feature. */
export function cellsOf(
  scene: SceneDocument | null | undefined,
): CellDocument[] {
  return scene?.cells ?? [];
}

/** The cell with this key, or null when the GM never authored it. */
export function cellByKey(
  scene: SceneDocument | null | undefined,
  key: string,
): CellDocument | null {
  return cellsOf(scene).find((c) => c.key === key) ?? null;
}

/** The hex geometry of a hex scene; null for the other two grid kinds. */
export function hexSpecOf(
  scene: SceneDocument | null | undefined,
): HexGridSpec | null {
  const grid = scene?.grid;
  if (!grid || grid.type !== "hex" || !(grid.size > 0)) return null;
  return { type: "hex", size: grid.size, layout: grid.hexLayout };
}

/** How many world units one cell spans — the grid's own `distance` in its own `units`. */
export function cellSpanOf(scene: SceneDocument | null | undefined): number {
  const grid = scene?.grid;
  return grid && grid.distance > 0 ? grid.distance : 1;
}

/** Cell size in world pixels (square and hex alike); 0 for a gridless scene. */
export function cellPixelSizeOf(
  scene: SceneDocument | null | undefined,
): number {
  const grid = scene?.grid;
  return grid && grid.size > 0 ? grid.size : 0;
}

/**
 * The cell containing a world point. Gridless scenes answer from the authored zones, so a point
 * outside every zone is `null` — the caller decides what "in the wild" means.
 */
export function cellAtPoint(
  scene: SceneDocument | null | undefined,
  x: number,
  y: number,
): string | null {
  const grid = scene?.grid;
  if (!grid) return null;
  if (grid.type === "hex") {
    const spec = hexSpecOf(scene);
    if (!spec) return null;
    const c = hexFromPixel(spec, x, y);
    return cellKeyOf(c);
  }
  if (grid.type === "square") {
    const size = cellPixelSizeOf(scene);
    if (!(size > 0)) return null;
    return cellKeyOf({ q: Math.floor(x / size), r: Math.floor(y / size) });
  }
  for (const cell of cellsOf(scene)) {
    if (!cell.poly || cell.poly.length < 6) continue;
    if (pointInPolygon(Float32Array.from(cell.poly), x, y)) return cell.key;
  }
  return null;
}

/** The centre of a cell in world pixels; null when the key names nothing this scene has. */
export function cellCenterOf(
  scene: SceneDocument | null | undefined,
  key: string,
): { x: number; y: number } | null {
  const grid = scene?.grid;
  if (!grid) return null;
  if (grid.type === "hex") {
    const spec = hexSpecOf(scene);
    const coords = parseCellKey(key);
    if (!spec || !coords) return null;
    return hexCenter(spec, coords.q, coords.r);
  }
  if (grid.type === "square") {
    const size = cellPixelSizeOf(scene);
    const coords = parseCellKey(key);
    if (!(size > 0) || !coords) return null;
    return { x: (coords.q + 0.5) * size, y: (coords.r + 0.5) * size };
  }
  // Gridless: the zone's own middle — the average of its vertices (a stable, cheap centre;
  // a zone's exact centroid is not worth the arithmetic for a map marker).
  const cell = cellByKey(scene, key);
  if (!cell?.poly || cell.poly.length < 2) return null;
  let sx = 0;
  let sy = 0;
  const n = Math.floor(cell.poly.length / 2);
  for (let i = 0; i < n; i++) {
    sx += cell.poly[i * 2] ?? 0;
    sy += cell.poly[i * 2 + 1] ?? 0;
  }
  return { x: sx / n, y: sy / n };
}

/** World-pixel centre of a *coordinate*, whether or not a cell document exists there. */
export function coordsToWorld(
  scene: SceneDocument | null | undefined,
  c: CellCoords,
): { x: number; y: number } | null {
  return cellCenterOf(scene, cellKeyOf(c));
}

/** Cell-count distance: hex distance, or the square grid's Chebyshev rings. Null when gridless. */
export function cellDistance(
  scene: SceneDocument | null | undefined,
  a: string,
  b: string,
): number | null {
  const grid = scene?.grid;
  if (!grid || grid.type === "gridless") return null;
  const ca = parseCellKey(a);
  const cb = parseCellKey(b);
  if (!ca || !cb) return null;
  if (grid.type === "hex") {
    const spec = hexSpecOf(scene);
    return spec ? hexDistance(spec, ca, cb) : null;
  }
  return Math.max(Math.abs(ca.q - cb.q), Math.abs(ca.r - cb.r));
}

/** Straight-line distance in world units between two cells' centres (gridless-friendly). */
export function cellWorldDistance(
  scene: SceneDocument | null | undefined,
  a: string,
  b: string,
): number | null {
  const pa = cellCenterOf(scene, a);
  const pb = cellCenterOf(scene, b);
  if (!pa || !pb) return null;
  return Math.hypot(pb.x - pa.x, pb.y - pa.y);
}

/** Neighbours of a gridded cell: 6 on a hex map, 8 on a square map. Empty when gridless. */
export function cellNeighbors(
  scene: SceneDocument | null | undefined,
  key: string,
): string[] {
  const grid = scene?.grid;
  const coords = parseCellKey(key);
  if (!grid || !coords) return [];
  if (grid.type === "hex") {
    const spec = hexSpecOf(scene);
    if (!spec) return [];
    return hexNeighbors(spec, coords.q, coords.r).map(cellKeyOf);
  }
  if (grid.type !== "square") return [];
  const out: string[] = [];
  for (let dq = -1; dq <= 1; dq++) {
    for (let dr = -1; dr <= 1; dr++) {
      if (dq === 0 && dr === 0) continue;
      out.push(cellKeyOf({ q: coords.q + dq, r: coords.r + dr }));
    }
  }
  return out;
}

/** A cap on ring walking: radius 12 is 469 hexes, and anything past that is a data mistake. */
export const MAX_RING_RADIUS = 12;

/**
 * The cells within `radius` steps of `center`, in rings (index 0 = the centre itself). The
 * sight ring draws exactly this. Cells are *keys*, not documents — most of a hex map has no
 * authored cell, and the ring must still be paintable.
 */
export function cellsWithin(
  scene: SceneDocument | null | undefined,
  center: string,
  radius: number,
): string[] {
  const r = Math.max(0, Math.min(MAX_RING_RADIUS, Math.trunc(radius)));
  // A zone key has no neighbours to walk: on a gridless map the ring *is* the party's own zone
  // (the distance ring is `zonesWithinRadius`), so the answer is always the centre itself.
  if (!parseCellKey(center)) return [center];
  const seen = new Set<string>([center]);
  let frontier = [center];
  for (let step = 0; step < r; step++) {
    const next: string[] = [];
    for (const key of frontier) {
      for (const n of cellNeighbors(scene, key)) {
        if (seen.has(n)) continue;
        seen.add(n);
        next.push(n);
      }
    }
    frontier = next;
    if (frontier.length === 0) break;
  }
  return [...seen];
}

/**
 * Gridless sight: the authored zones whose bounds come within `radius` world units of a point,
 * plus the zone the party stands in. This is deliberately a *bounds* test rather than exact
 * polygon buffering: a zone is a coarse region on a hexcrawl map, and a distance-accurate
 * buffer is Phase 2 work (`HEXCRAWL_SCENE_SPEC_AND_PLAN.md` §4) that would not change which
 * zones a party can see on any real map.
 */
export function zonesWithinRadius(
  scene: SceneDocument | null | undefined,
  point: { x: number; y: number },
  radius: number,
): string[] {
  const r = Math.max(0, radius);
  const out: string[] = [];
  for (const cell of cellsOf(scene)) {
    if (!cell.poly || cell.poly.length < 6) continue;
    const bounds = polygonBounds(Float32Array.from(cell.poly));
    const dx = Math.max(bounds.minX - point.x, 0, point.x - bounds.maxX);
    const dy = Math.max(bounds.minY - point.y, 0, point.y - bounds.maxY);
    if (Math.hypot(dx, dy) <= r) out.push(cell.key);
  }
  return out;
}

/** A generous cap so a huge map cannot be enumerated by accident (plan §9.1: measure, then cap). */
export const MAX_MAP_CELLS = 20_000;

/**
 * Every cell a map *has* (not just the authored ones), in row-major order, capped at
 * `maxCells`. This is what the hex overlay paints and what "1,200 cells, 14 authored" counts.
 * Gridless scenes return their authored zones — there is no grid to enumerate.
 */
export function cellsInMap(
  scene: SceneDocument | null | undefined,
  maxCells = MAX_MAP_CELLS,
): string[] {
  const grid = scene?.grid;
  if (!grid) return [];
  if (grid.type === "gridless") {
    return cellsOf(scene)
      .filter((c) => Array.isArray(c.poly) && c.poly.length >= 6)
      .slice(0, maxCells)
      .map((c) => c.key);
  }
  const width = Math.max(0, Math.trunc(scene?.width ?? 0));
  const height = Math.max(0, Math.trunc(scene?.height ?? 0));
  if (!(width > 0) || !(height > 0)) return [];
  if (grid.type === "hex") {
    const spec = hexSpecOf(scene);
    if (!spec) return [];
    return hexesInView(spec, { x: 0, y: 0, width, height })
      .slice(0, maxCells)
      .map(cellKeyOf);
  }
  const size = cellPixelSizeOf(scene);
  if (!(size > 0)) return [];
  const cols = Math.ceil(width / size);
  const rows = Math.ceil(height / size);
  const out: string[] = [];
  for (let r = 0; r < rows; r++) {
    for (let q = 0; q < cols; q++) {
      if (out.length >= maxCells) return out;
      out.push(cellKeyOf({ q, r }));
    }
  }
  return out;
}

/**
 * The hex overlay's own count: how many cells the map has and how many the GM authored. Used by
 * the panel header and by the tests that pin "a 40×30 map is 1,200 cells, not 1,200 documents".
 */
export function cellCensus(scene: SceneDocument | null | undefined): {
  total: number;
  authored: number;
  gridless: boolean;
} {
  const grid = scene?.grid;
  const authored = cellsOf(scene).length;
  if (grid?.type === "gridless")
    return { total: authored, authored, gridless: true };
  return { total: cellsInMap(scene).length, authored, gridless: false };
}

/** True when the layouts are flat-top (the four §0 names, exposed for the panel's preview). */
export function layoutIsFlatTop(
  scene: SceneDocument | null | undefined,
): boolean {
  const spec = hexSpecOf(scene);
  return spec ? layoutIsFlat(spec.layout) : false;
}
