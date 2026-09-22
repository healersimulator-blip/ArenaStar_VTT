/**
 * **The hex overlay's paint plan (Phase 2, plan §5.1/§8).**
 *
 * The canvas layer that draws the hexcrawl map is deliberately dumb: it strokes polygons and
 * fills them. *What* to paint — which cells the map has, which of them are open to this viewer,
 * what colour each terrain is — is decided here, in pure code, so it can be unit-tested in Node
 * and so the GM's view and a player's view are two arguments to one function rather than two
 * code paths that drift.
 *
 * Two costs are kept apart on purpose, because a refresh runs on every store change:
 *
 * - `hexOverlayKey` is the **cheap** signature (scene, grid, map size, the open set, the
 *   authored cells, the catalog, the viewer). The app rebuilds the plan only when this changes.
 * - `hexOverlayPlan` is the **expensive** half — every cell's polygon. On a 40×30 hex map that
 *   is 1,200 polygons; `cellsInMap` caps the enumeration at 20,000 cells (plan §9.1).
 */
import { hexCenter, hexCorners, type HexGridSpec } from "../../canvas/grid/hex";
import type { SceneDocument } from "../documents";
import {
  cellByKey,
  cellPixelSizeOf,
  cellsInMap,
  cellsOf,
  hexSpecOf,
  parseCellKey,
} from "./cells";
import { PF1E_TERRAIN_CATALOG, type TerrainCatalog } from "./terrain";
import { openCellKeys } from "./visibility";

/** One paintable cell: where it is, what it looks like, and whether the table may see it. */
export interface OverlayCell {
  key: string;
  /** Flat `[x1,y1,…]` polygon in world pixels (a square's rect, a hex's six corners, a zone). */
  poly: number[];
  /** Terrain fill as `0xRRGGBB`, or null when the cell has no terrain of its own. */
  fill: number | null;
  /** True when this viewer may see the cell (the reveal set ∪ the party's ring). */
  open: boolean;
  /** True when a GM authored a cell document here (a tint of its own, not the map default). */
  authored: boolean;
}

export interface HexOverlayPlan {
  viewer: "gm" | "player";
  cells: OverlayCell[];
  /** World-pixel bounds of the map the cover is painted over. */
  map: { width: number; height: number };
  /** True when this viewer gets the cover: a player, on a map with at least one closed cell. */
  covers: boolean;
  openCells: number;
  closedCells: number;
  authoredCells: number;
  /** The catalog the fills came from (the layer's readback names it). */
  catalogId: string;
}

const NEUTRAL_FILL = 0x8a8f96;

/** `#rrggbb` → `0xRRGGBB`; anything else falls back to the neutral tint. */
export function parseTerrainColor(color: string | undefined): number {
  if (typeof color !== "string") return NEUTRAL_FILL;
  const m = /^#?([0-9a-f]{6})$/i.exec(color.trim());
  if (!m?.[1]) return NEUTRAL_FILL;
  const n = Number.parseInt(m[1], 16);
  return Number.isFinite(n) ? n : NEUTRAL_FILL;
}

/**
 * The cheap signature: rebuild the plan exactly when this string changes. A rolling hash over
 * the open set and the authored keys keeps it O(n) in the two lists a move actually touches,
 * instead of stringifying every cell of the map.
 */
export function hexOverlayKey(
  scene: SceneDocument | null | undefined,
  viewer: "gm" | "player",
  catalog: TerrainCatalog | null = null,
): string {
  if (!scene) return `none|${viewer}`;
  const grid = scene.grid;
  const open = [...openCellKeys(scene)].sort();
  const authored = cellsOf(scene)
    .map((c) => `${c.key}:${c.terrain ?? ""}`)
    .sort();
  return [
    scene._id,
    viewer,
    grid.type,
    grid.size,
    grid.hexLayout,
    `${Math.trunc(scene.width)}x${Math.trunc(scene.height)}`,
    catalog?.id ?? "default",
    `${open.length}:${hashList(open)}`,
    `${authored.length}:${hashList(authored)}`,
  ].join("|");
}

/** FNV-1a/32 over a list of strings — a signature, not a security primitive. */
function hashList(items: readonly string[]): string {
  let h = 0x811c9dc5;
  for (const item of items) {
    for (let i = 0; i < item.length; i++) {
      h ^= item.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    h ^= 0x2c; // a separator the key strings themselves cannot contain
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

/** Every cell's polygon, in world pixels, for the plan below. Null when the key names none. */
export function cellPolygonOf(
  scene: SceneDocument | null | undefined,
  key: string,
): number[] | null {
  const grid = scene?.grid;
  if (!grid) return null;
  if (grid.type === "hex") {
    const spec = hexSpecOf(scene);
    const coords = parseCellKey(key);
    if (!spec || !coords) return null;
    return flatCorners(spec, coords);
  }
  if (grid.type === "square") {
    const size = cellPixelSizeOf(scene);
    const coords = parseCellKey(key);
    if (!(size > 0) || !coords) return null;
    const x = coords.q * size;
    const y = coords.r * size;
    return [x, y, x + size, y, x + size, y + size, x, y + size];
  }
  const cell = cellByKey(scene, key);
  return cell?.poly && cell.poly.length >= 6 ? [...cell.poly] : null;
}

function flatCorners(
  spec: HexGridSpec,
  coords: { q: number; r: number },
): number[] {
  const corners = hexCorners(spec, hexCenter(spec, coords.q, coords.r));
  const out: number[] = [];
  for (const c of corners) out.push(c.x, c.y);
  return out;
}

/**
 * The plan the layer paints.
 *
 * A **player** sees every cell the map has, painted open or covered; the cover is applied by
 * the layer, so this function only names which cells are closed. A **GM** sees the same cells
 * plus a faint wash over the closed ones, so "what has the table actually been told" is visible
 * at a glance without hiding the map the GM is preparing.
 */
export function hexOverlayPlan(
  scene: SceneDocument | null | undefined,
  options: { viewer: "gm" | "player"; catalog?: TerrainCatalog | null } = {
    viewer: "gm",
  },
): HexOverlayPlan | null {
  if (!scene) return null;
  const catalog = options.catalog ?? PF1E_TERRAIN_CATALOG;
  const viewer = options.viewer;
  const open = openCellKeys(scene);
  const defaultTerrain = catalog.defaultTerrain;
  const fills = new Map<string, number>();
  for (const t of catalog.terrains) fills.set(t.id, parseTerrainColor(t.color));

  const keys = cellsInMap(scene);
  const cells: OverlayCell[] = [];
  let openCells = 0;
  let authoredCells = 0;
  for (const key of keys) {
    const poly = cellPolygonOf(scene, key);
    if (!poly) continue;
    const doc = cellByKey(scene, key);
    const terrain = doc?.terrain ?? defaultTerrain;
    const isOpen = open.has(key);
    if (isOpen) openCells++;
    if (doc) authoredCells++;
    cells.push({
      key,
      poly,
      fill: fills.get(terrain) ?? NEUTRAL_FILL,
      open: isOpen,
      authored: doc !== null,
    });
  }
  return {
    viewer,
    cells,
    map: {
      width: Math.max(0, Math.trunc(scene.width)),
      height: Math.max(0, Math.trunc(scene.height)),
    },
    // The cover is painted as "everything, minus the open cells" — so it needs no closed cell
    // document to exist on this replica (see `projectCellForViewer`).
    covers: viewer === "player" && cells.length > openCells,
    openCells,
    closedCells: cells.length - openCells,
    authoredCells,
    catalogId: catalog.id,
  };
}
