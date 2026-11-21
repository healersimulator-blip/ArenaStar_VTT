/**
 * Multi-image background map stitching.
 *
 * Places 1..64 raster panels into an edge-to-edge `columns × rows` floor-tile grid
 * (`above: false`) with shared integer pixel boundaries so adjacent map panels never
 * exhibit sub-pixel seams on either the VTT PixiJS stage or the hosted 2D battlefield.
 */
import { OWNERSHIP_LEVELS, type SceneDocument, type TileDocument } from "./documents";

export const MAX_SCENE_DIMENSION_PX = 200_000;
export const MAX_STITCH_PANELS = 64;

export interface StitchPanelInput {
  id: string;
  name: string;
  image: string;
  width: number;
  height: number;
}

export interface StitchMapPlanOptions {
  columns?: number;
  rows?: number;
  mode: "resizeScene" | "fitScene";
  sceneSize: { width: number; height: number };
  gridSize: number;
  /** Optional explicit grid-square dimensions (`cols × rows`) when `mode === "resizeScene"`. */
  targetSquares?: { cols: number; rows: number } | null;
}

export interface StitchMapPlanResult {
  columns: number;
  rows: number;
  width: number;
  height: number;
  tiles: TileDocument[];
}

export function defaultStitchColumns(panelCount: number): number {
  const n = Math.max(1, Math.min(MAX_STITCH_PANELS, Math.floor(panelCount)));
  return Math.max(1, Math.ceil(Math.sqrt(n)));
}

export function isStitchedMapTile(tile: Pick<TileDocument, "flags" | "above">): boolean {
  if (tile.above) return false;
  const core = tile.flags?.core;
  return (
    typeof core === "object" &&
    core !== null &&
    !Array.isArray(core) &&
    (core as Record<string, unknown>).stitchedMap === true
  );
}

/** Merge newly planned stitched floor tiles with any non-stitched tiles on `scene`. */
export function mergeStitchedSceneTiles(
  existing: readonly TileDocument[],
  stitched: readonly TileDocument[],
): TileDocument[] {
  return [...stitched, ...existing.filter((tile) => !isStitchedMapTile(tile))];
}

export function planStitchedMapTiles(
  panels: readonly StitchPanelInput[],
  options: StitchMapPlanOptions,
): StitchMapPlanResult {
  if (panels.length < 1 || panels.length > MAX_STITCH_PANELS) {
    throw new Error(`Choose 1–${MAX_STITCH_PANELS} map images to stitch together.`);
  }
  const cols = Math.max(
    1,
    Math.min(
      MAX_STITCH_PANELS,
      Math.round(options.columns ?? defaultStitchColumns(panels.length)),
    ),
  );
  const minRows = Math.max(1, Math.ceil(panels.length / cols));
  const rows = Math.max(
    minRows,
    Math.min(MAX_STITCH_PANELS, Math.round(options.rows ?? minRows)),
  );
  const gridSize = Math.max(10, Math.min(1000, Math.round(options.gridSize || 20)));

  let totalWidth: number;
  let totalHeight: number;
  if (options.mode === "fitScene") {
    totalWidth = Math.max(100, Math.min(MAX_SCENE_DIMENSION_PX, Math.round(options.sceneSize.width)));
    totalHeight = Math.max(100, Math.min(MAX_SCENE_DIMENSION_PX, Math.round(options.sceneSize.height)));
  } else if (
    options.targetSquares &&
    options.targetSquares.cols >= 1 &&
    options.targetSquares.rows >= 1
  ) {
    totalWidth = Math.max(
      100,
      Math.min(MAX_SCENE_DIMENSION_PX, Math.round(options.targetSquares.cols * gridSize)),
    );
    totalHeight = Math.max(
      100,
      Math.min(MAX_SCENE_DIMENSION_PX, Math.round(options.targetSquares.rows * gridSize)),
    );
  } else {
    const first = panels[0];
    const refW = Math.max(64, Math.round(first?.width ?? 1000));
    const refH = Math.max(64, Math.round(first?.height ?? 1000));
    const rawW = refW * cols;
    const rawH = refH * rows;
    const scale = Math.min(1, MAX_SCENE_DIMENSION_PX / Math.max(rawW, rawH, 1));
    totalWidth = Math.max(100, Math.round((rawW * scale) / gridSize) * gridSize || Math.round(rawW * scale));
    totalHeight = Math.max(100, Math.round((rawH * scale) / gridSize) * gridSize || Math.round(rawH * scale));
  }

  const tiles: TileDocument[] = panels.map((panel, index) => {
    const col = index % cols;
    const row = Math.floor(index / cols);
    const x0 = Math.round((col * totalWidth) / cols);
    const x1 = Math.round(((col + 1) * totalWidth) / cols);
    const y0 = Math.round((row * totalHeight) / rows);
    const y1 = Math.round(((row + 1) * totalHeight) / rows);
    return {
      _id: panel.id,
      type: "tile",
      name: panel.name || `Map panel ${row + 1}-${col + 1}`,
      ownership: { default: OWNERSHIP_LEVELS.NONE },
      flags: {
        core: {
          stitchedMap: true,
          stitchIndex: index,
          stitchCols: cols,
          stitchRows: rows,
        },
      },
      system: {},
      x: x0,
      y: y0,
      width: Math.max(1, x1 - x0),
      height: Math.max(1, y1 - y0),
      img: panel.image,
      above: false,
      occlusion: { mode: "roof", alpha: 0.5 },
    };
  });

  return { columns: cols, rows, width: totalWidth, height: totalHeight, tiles };
}

/** Extract visible floor-layer map tiles in deterministic render order for hosted projection. */
export function visibleFloorMapTiles(scene: Pick<SceneDocument, "tiles">): TileDocument[] {
  return (scene.tiles ?? []).filter(
    (tile) => !tile.hidden && !tile.above && typeof tile.img === "string" && tile.img.length > 0 && tile.width > 0 && tile.height > 0,
  );
}
