/**
 * Pure transform math for the scene background ("Map & background" layer).
 *
 * The background is a single image placed in scene pixels: its top-left corner is `x,y`
 * and each natural image pixel covers `scaleX` × `scaleY` scene pixels. Everything here is
 * free of DOM/Pixi so the same rules drive the canvas handles, the numeric panel, keyboard
 * nudges and the tests.
 *
 * Grid convention: scene grid lines sit at integer multiples of `grid.size` from the origin.
 * A map's own grid is described in NATIVE image pixels (`MapGridEstimate`), with offsets as
 * pixel-boundary coordinates in [0, size). Alignment means: map line k lands exactly on a
 * scene grid line.
 */

export interface BackgroundTransform {
  /** Top-left corner of the image, in scene pixels. */
  x: number;
  y: number;
  /** Scene pixels per natural image pixel, per axis. */
  scaleX: number;
  scaleY: number;
}

export interface NaturalSize {
  width: number;
  height: number;
}

/** A map's square grid in native image pixels. Offsets are boundary coordinates in [0, size). */
export interface MapGridEstimate {
  sizeX: number;
  sizeY: number;
  offsetX: number;
  offsetY: number;
}

export type BackgroundHandle = "move" | "nw" | "n" | "ne" | "e" | "se" | "s" | "sw" | "w";
export type BackgroundSnap = "off" | "grid" | "map";

export const MIN_BACKGROUND_SCALE = 1e-4;

/** Read the stored presentation fields. `scaleX/scaleY` override the uniform `scale` when present. */
export function backgroundTransformOf(background?: {
  offset?: { x: number; y: number };
  scale?: number;
  scaleX?: number;
  scaleY?: number;
} | null): BackgroundTransform {
  const pick = (value: number | undefined, fallback: number): number =>
    typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
  const uniform = pick(background?.scale, 1);
  return {
    x: background?.offset?.x ?? 0,
    y: background?.offset?.y ?? 0,
    scaleX: pick(background?.scaleX, uniform),
    scaleY: pick(background?.scaleY, uniform),
  };
}

/**
 * The fields written back to the scene. `scale` stays the uniform value older readers understand
 * (it is the X scale; they ignore the stretch), and `scaleX`/`scaleY` carry the exact transform.
 */
export function backgroundWriteFields(t: BackgroundTransform): {
  offset: { x: number; y: number };
  scale: number;
  scaleX: number;
  scaleY: number;
} {
  const scaleX = clampScale(t.scaleX);
  const scaleY = clampScale(t.scaleY);
  return { offset: { x: round(t.x), y: round(t.y) }, scale: scaleX, scaleX, scaleY };
}

export function backgroundRect(natural: NaturalSize, t: BackgroundTransform): {
  left: number;
  top: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
} {
  const width = natural.width * t.scaleX;
  const height = natural.height * t.scaleY;
  return { left: t.x, top: t.y, right: t.x + width, bottom: t.y + height, width, height };
}

/** Handle positions for the editor overlay and hit testing. */
export function backgroundHandlePoints(natural: NaturalSize, t: BackgroundTransform): Record<Exclude<BackgroundHandle, "move">, { x: number; y: number }> {
  const r = backgroundRect(natural, t);
  const cx = r.left + r.width / 2;
  const cy = r.top + r.height / 2;
  return {
    nw: { x: r.left, y: r.top },
    n: { x: cx, y: r.top },
    ne: { x: r.right, y: r.top },
    e: { x: r.right, y: cy },
    se: { x: r.right, y: r.bottom },
    s: { x: cx, y: r.bottom },
    sw: { x: r.left, y: r.bottom },
    w: { x: r.left, y: cy },
  };
}

/**
 * Handles win over the body. `handleRadius` is in scene pixels (callers pass screen pixels ÷ zoom),
 * so the grab target stays the same size at every zoom level.
 */
export function hitBackground(
  natural: NaturalSize,
  t: BackgroundTransform,
  point: { x: number; y: number },
  handleRadius: number,
): BackgroundHandle | null {
  const points = backgroundHandlePoints(natural, t);
  let best: { handle: BackgroundHandle; distance: number } | null = null;
  for (const [handle, p] of Object.entries(points) as Array<[Exclude<BackgroundHandle, "move">, { x: number; y: number }]>) {
    const distance = Math.hypot(point.x - p.x, point.y - p.y);
    if (distance <= handleRadius && (!best || distance < best.distance)) best = { handle, distance };
  }
  if (best) return best.handle;
  const r = backgroundRect(natural, t);
  if (point.x >= r.left && point.x <= r.right && point.y >= r.top && point.y <= r.bottom) return "move";
  return null;
}

export function moveBackground(t: BackgroundTransform, dx: number, dy: number): BackgroundTransform {
  return { ...t, x: t.x + dx, y: t.y + dy };
}

/**
 * Scale about a point (default: the image centre) by `factor`. The anchor keeps its position on
 * screen, which is what a keyboard zoom of the map should do.
 */
export function scaleBackgroundAbout(
  natural: NaturalSize,
  t: BackgroundTransform,
  factor: number,
  anchor?: { x: number; y: number },
): BackgroundTransform {
  if (!(factor > 0) || !Number.isFinite(factor)) return t;
  const r = backgroundRect(natural, t);
  const ax = anchor?.x ?? r.left + r.width / 2;
  const ay = anchor?.y ?? r.top + r.height / 2;
  return {
    x: ax + (t.x - ax) * factor,
    y: ay + (t.y - ay) * factor,
    scaleX: clampScale(t.scaleX * factor),
    scaleY: clampScale(t.scaleY * factor),
  };
}

export interface ResizeOptions {
  /** Corners keep the aspect ratio by default; edges stretch one axis unless this is true. */
  keepAspect?: boolean | undefined;
  /** Snap the edge(s) being dragged to scene grid lines of this size. */
  gridSize?: number | undefined;
  /** Smallest drawn size in scene pixels. */
  minSceneSize?: number;
}

/**
 * Resize from a handle while the opposite side (or corner, or centre for uniform edge resize)
 * stays put. Returns the new transform; the caller decides when to commit.
 */
export function resizeBackground(
  natural: NaturalSize,
  start: BackgroundTransform,
  handle: Exclude<BackgroundHandle, "move">,
  pointer: { x: number; y: number },
  options: ResizeOptions = {},
): BackgroundTransform {
  const west = handle.includes("w");
  const east = handle.includes("e");
  const north = handle.includes("n");
  const south = handle.includes("s");
  const movesX = west || east;
  const movesY = north || south;
  const minSize = Math.max(options.minSceneSize ?? 1, 1e-6);

  const W0 = natural.width * start.scaleX;
  const H0 = natural.height * start.scaleY;
  const left0 = start.x;
  const top0 = start.y;
  const right0 = left0 + W0;
  const bottom0 = top0 + H0;

  let px = pointer.x;
  let py = pointer.y;
  if (options.gridSize && options.gridSize > 0) {
    if (movesX) px = Math.round(px / options.gridSize) * options.gridSize;
    if (movesY) py = Math.round(py / options.gridSize) * options.gridSize;
  }

  const wPointer = east ? px - left0 : west ? right0 - px : W0;
  const hPointer = south ? py - top0 : north ? bottom0 - py : H0;

  // Corners lock the aspect unless told otherwise; edges stretch one axis unless the lock is on.
  const uniform = (options.keepAspect ?? (movesX && movesY)) && (movesX || movesY);
  let wNew: number;
  let hNew: number;
  if (uniform) {
    const fx = wPointer / W0;
    const fy = hPointer / H0;
    let factor: number;
    if (movesX && movesY) factor = Math.abs(fx - 1) >= Math.abs(fy - 1) ? fx : fy;
    else factor = movesX ? fx : fy;
    factor = Math.max(factor, minSize / Math.max(W0, H0));
    wNew = W0 * factor;
    hNew = H0 * factor;
  } else {
    wNew = movesX ? Math.max(minSize, wPointer) : W0;
    hNew = movesY ? Math.max(minSize, hPointer) : H0;
  }

  const left = movesX
    ? west
      ? right0 - wNew
      : left0
    : uniform
      ? left0 + (W0 - wNew) / 2
      : left0;
  const top = movesY
    ? north
      ? bottom0 - hNew
      : top0
    : uniform
      ? top0 + (H0 - hNew) / 2
      : top0;

  return {
    x: left,
    y: top,
    scaleX: clampScale(wNew / natural.width),
    scaleY: clampScale(hNew / natural.height),
  };
}

/**
 * Fit the whole image inside the scene (`fit`), cover the scene (`cover`), keep it 1:1 at the
 * scene origin (`native`), or centre it at its current scale (`center`).
 */
export function placeBackground(
  natural: NaturalSize,
  scene: { width: number; height: number },
  mode: "fit" | "cover" | "native" | "center",
  current: BackgroundTransform,
): BackgroundTransform {
  if (mode === "native") return { x: 0, y: 0, scaleX: 1, scaleY: 1 };
  if (mode === "center") {
    const w = natural.width * current.scaleX;
    const h = natural.height * current.scaleY;
    return { x: (scene.width - w) / 2, y: (scene.height - h) / 2, scaleX: current.scaleX, scaleY: current.scaleY };
  }
  const sx = scene.width / natural.width;
  const sy = scene.height / natural.height;
  const s = clampScale(mode === "fit" ? Math.min(sx, sy) : Math.max(sx, sy));
  const w = natural.width * s;
  const h = natural.height * s;
  return { x: (scene.width - w) / 2, y: (scene.height - h) / 2, scaleX: s, scaleY: s };
}

/**
 * Snap a position for a move. `grid` puts the image's top-left on a grid intersection.
 * `map` puts one of the map's own grid lines on a scene grid line (needs a `mapGrid`).
 */
export function snapBackgroundPosition(
  t: BackgroundTransform,
  gridSize: number,
  mode: BackgroundSnap,
  mapGrid?: MapGridEstimate | null,
): BackgroundTransform {
  if (!(gridSize > 0) || mode === "off") return t;
  if (mode === "grid") {
    return { ...t, x: Math.round(t.x / gridSize) * gridSize, y: Math.round(t.y / gridSize) * gridSize };
  }
  if (!mapGrid) return t;
  return {
    ...t,
    x: placeOnGrid(t.x, t.scaleX * mapGrid.offsetX, gridSize),
    y: placeOnGrid(t.y, t.scaleY * mapGrid.offsetY, gridSize),
  };
}

/**
 * Scale the map so one of its squares is exactly `gridSize` scene pixels, then shift it so the
 * map's lines fall on the scene lines. Keeps the grid size and changes the image.
 */
export function matchMapToGrid(
  t: BackgroundTransform,
  mapGrid: MapGridEstimate,
  gridSize: number,
): BackgroundTransform {
  const scaleX = clampScale(gridSize / mapGrid.sizeX);
  const scaleY = clampScale(gridSize / mapGrid.sizeY);
  return {
    x: placeOnGrid(t.x, scaleX * mapGrid.offsetX, gridSize),
    y: placeOnGrid(t.y, scaleY * mapGrid.offsetY, gridSize),
    scaleX,
    scaleY,
  };
}

/**
 * Keep the image's scale and change the scene grid instead: the new grid size is the map's square
 * as drawn now, and the map is shifted so its lines sit on that grid.
 */
export function mapSquaresAsGrid(
  t: BackgroundTransform,
  mapGrid: MapGridEstimate,
): { transform: BackgroundTransform; gridSize: number } {
  const drawn = (mapGrid.sizeX * t.scaleX + mapGrid.sizeY * t.scaleY) / 2;
  const gridSize = Math.max(1, Math.round(drawn));
  return {
    gridSize,
    transform: {
      ...t,
      x: placeOnGrid(t.x, t.scaleX * mapGrid.offsetX, gridSize),
      y: placeOnGrid(t.y, t.scaleY * mapGrid.offsetY, gridSize),
    },
  };
}

/**
 * How far the map's lines are from the scene grid. `phasePx` is the worst offset of any map line
 * from a scene line near the origin; `pitchPx` is how much one map square differs from `gridSize`
 * (the drift over the whole map is roughly `pitchPx × squares`). Both are 0 when aligned.
 */
export function gridAlignmentError(
  t: BackgroundTransform,
  mapGrid: MapGridEstimate,
  gridSize: number,
): { phasePx: number; pitchPx: number } {
  const phase = (origin: number): number => {
    const r = mod(origin, gridSize);
    return Math.min(r, gridSize - r);
  };
  return {
    phasePx: Math.max(phase(t.x + t.scaleX * mapGrid.offsetX), phase(t.y + t.scaleY * mapGrid.offsetY)),
    pitchPx: Math.max(
      Math.abs(mapGrid.sizeX * t.scaleX - gridSize),
      Math.abs(mapGrid.sizeY * t.scaleY - gridSize),
    ),
  };
}

// ─── internals ───────────────────────────────────────────────────────────────

/** Smallest adjustment of `x` such that `x + lineOffset` is a multiple of `gridSize`. */
function placeOnGrid(x: number, lineOffset: number, gridSize: number): number {
  return gridSize * Math.round((x + lineOffset) / gridSize) - lineOffset;
}

function mod(value: number, m: number): number {
  return ((value % m) + m) % m;
}

function clampScale(value: number): number {
  return Number.isFinite(value) && value > MIN_BACKGROUND_SCALE ? value : MIN_BACKGROUND_SCALE;
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}
