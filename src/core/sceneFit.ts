/**
 * D-465 — fitting a scene to a background by its grid *count*.
 *
 * Testers found two ways a map and the VTT grid drift apart: there was no way to set the scene's
 * size after import, and a detected square size that is off by an octave (the detector measuring
 * every second line) puts four map squares in one VTT square. Both are solved the way Roll20 and
 * Foundry's grid tool do it — the GM states how many squares (or hexes) the map really has, e.g.
 * 48 × 64 squares or 32 × 32 hexes, and the scene is derived from that:
 *
 *   • the map's native square size is `natural / count` (no detection involved),
 *   • the image is scaled so one map square is exactly one grid cell,
 *   • the scene becomes `columns × rows` cells, so the map fills it edge to edge.
 *
 * Everything here is pure; the shells submit the returned scene diff as one update.
 */
import type { BackgroundTransform, MapGridEstimate, NaturalSize } from "./backgroundTransform";
import type { HexLayout } from "./documents";

export type FitGridType = "square" | "hex";

export interface GridCount {
  columns: number;
  rows: number;
}

export interface GridCountFitInput {
  natural: NaturalSize;
  count: GridCount;
  /** Scene grid cell size to keep (pixels). */
  gridSize: number;
  type: FitGridType;
  hexLayout?: HexLayout;
  /** The map's measured lines, when known: they fix the phase so lines land on the grid. */
  mapGrid?: MapGridEstimate | null;
}

export interface GridCountFit {
  /** New scene size in pixels (`columns × gridSize`, `rows × gridSize` for squares). */
  width: number;
  height: number;
  gridSize: number;
  transform: BackgroundTransform;
  /** One map cell in native image pixels, per axis (what the count implies). */
  cell: { width: number; height: number };
  /** Set when the two axes disagree by more than a few percent — the counts are probably off. */
  warning: string | null;
}

/** Counts above this are a typo rather than a map; the UI clamps to it. */
export const MAX_GRID_COUNT = 400;
const SQRT3 = Math.sqrt(3);

/** Whole, positive counts within range; anything else is rejected (null). */
export function normalizeGridCount(count: GridCount): GridCount | null {
  const columns = Math.round(count.columns);
  const rows = Math.round(count.rows);
  if (!Number.isFinite(columns) || !Number.isFinite(rows)) return null;
  if (columns < 1 || rows < 1 || columns > MAX_GRID_COUNT || rows > MAX_GRID_COUNT) return null;
  return { columns, rows };
}

/**
 * The native cell size (in the grid's own `size` sense: a square's side, a hex's circumradius)
 * implied by `count` cells spanning the image, measured along each axis separately.
 *
 * Flat-top hexes (Q layouts): N columns span (1.5 N + 0.5) r, M rows span (M + 0.5) √3 r.
 * Pointy-top hexes (R layouts): N columns span (N + 0.5) √3 r, M rows span (1.5 M + 0.5) r.
 */
export function cellSizeForCount(natural: NaturalSize, count: GridCount, type: FitGridType, hexLayout?: HexLayout): { width: number; height: number } {
  if (type === "square") return { width: natural.width / count.columns, height: natural.height / count.rows };
  const flat = hexLayout === "oddQ" || hexLayout === "evenQ";
  if (flat) {
    return { width: natural.width / (1.5 * count.columns + 0.5), height: natural.height / (SQRT3 * (count.rows + 0.5)) };
  }
  return { width: natural.width / (SQRT3 * (count.columns + 0.5)), height: natural.height / (1.5 * count.rows + 0.5) };
}

/** The map grid a stated count implies (phase 0: the first line sits on the image edge). */
export function mapGridFromCount(natural: NaturalSize, count: GridCount): MapGridEstimate | null {
  const normalized = normalizeGridCount(count);
  if (!normalized) return null;
  return { sizeX: natural.width / normalized.columns, sizeY: natural.height / normalized.rows, offsetX: 0, offsetY: 0 };
}

/** How many squares a measured map grid spans across the image (what the GM should recognise). */
export function gridCountOfMap(natural: NaturalSize, mapGrid: MapGridEstimate): GridCount {
  return {
    columns: Math.max(1, Math.round(natural.width / mapGrid.sizeX)),
    rows: Math.max(1, Math.round(natural.height / mapGrid.sizeY)),
  };
}

/**
 * Octave correction for a detection that measured every second (or every half) line: the
 * square size doubles or halves and the line phase stays valid (folded into the new period).
 */
export function rescaleMapGrid(mapGrid: MapGridEstimate, factor: number): MapGridEstimate {
  const sizeX = mapGrid.sizeX * factor;
  const sizeY = mapGrid.sizeY * factor;
  return { sizeX, sizeY, offsetX: wrap(mapGrid.offsetX, sizeX), offsetY: wrap(mapGrid.offsetY, sizeY) };
}

/**
 * Scale and place the background so `count` cells of the map are `count` cells of the scene
 * grid, and size the scene to exactly that many cells. With a measured `mapGrid` the image is
 * shifted so its lines fall on the grid lines; otherwise the image's edge is the first line.
 */
export function fitSceneToGridCount(input: GridCountFitInput): GridCountFit | null {
  const count = normalizeGridCount(input.count);
  const gridSize = Math.round(input.gridSize);
  if (!count || !(gridSize > 0) || !(input.natural.width > 0) || !(input.natural.height > 0)) return null;
  const pitch = cellSizeForCount(input.natural, count, input.type, input.hexLayout);
  const square = input.type === "square";
  // Squares scale per axis so the stated count is exact even on a slightly stretched scan; hexes
  // keep the image's aspect (a hex grid cannot be stretched without breaking its geometry).
  const scaleX = gridSize / pitch.width;
  const scaleY = square ? gridSize / pitch.height : scaleX;
  let x = 0;
  let y = 0;
  if (square && input.mapGrid) {
    x = phaseShift(input.mapGrid.offsetX * scaleX, gridSize);
    y = phaseShift(input.mapGrid.offsetY * scaleY, gridSize);
  }
  const width = square ? count.columns * gridSize : Math.round(input.natural.width * scaleX);
  const height = square ? count.rows * gridSize : Math.round(input.natural.height * scaleY);
  const skew = Math.abs(pitch.width - pitch.height) / Math.max(pitch.width, pitch.height);
  const warning =
    skew > 0.03
      ? `The counts give ${fmt(pitch.width)} × ${fmt(pitch.height)} px cells — not square. Check the columns and rows.`
      : null;
  return {
    width,
    height,
    gridSize,
    // Offsets are rounded like every other background write; scales stay exact — a rounded
    // scale drifts by a pixel across a large map, which is the misalignment being fixed.
    transform: { x: round3(x), y: round3(y), scaleX, scaleY },
    cell: pitch,
    warning,
  };
}

/** The smallest shift (toward zero) that puts a line drawn `linePx` from the image edge on a grid line. */
function phaseShift(linePx: number, gridSize: number): number {
  const r = wrap(linePx, gridSize);
  return r <= gridSize / 2 ? -r : gridSize - r;
}

function wrap(value: number, m: number): number {
  if (!(m > 0)) return 0;
  return ((value % m) + m) % m;
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function fmt(value: number): string {
  return (Math.round(value * 10) / 10).toString();
}
