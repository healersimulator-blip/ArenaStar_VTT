/**
 * Slice E (D-438): roofs. These rules decide which overhead tiles fade, how they fade, and when
 * a roof shows through fog. The renderer (`TilesLayer`), host validation and the roof editor
 * share them.
 *
 * A roof is presentation only. Nothing here touches explored fog, sight, light or movement.
 *
 * - G-26a "under": a viewer is under a roof when its centre is on the tile's opaque art. The art
 *   is a downsampled alpha map read from the loaded texture. Without readable art, the tile's
 *   alpha or polygon trigger zone is used, then its rotated rectangle. Bounding-box overlap no
 *   longer counts: a token beside the eaves does not open the roof.
 * - G-26b modes:
 *   - `roof` fades the whole tile while a viewer is under it.
 *   - `fade` is always translucent.
 *   - `radial` opens a circle around each viewer under it.
 *   - `vision` opens what the viewers currently see.
 *   Renderers without inverse masks (Canvas2D) and scenes without current sight fall back to
 *   `roof`. They never draw a hole they cannot clip.
 * - G-26c hover: a GM-local pointer counts as one more viewer. It never opens `vision` holes.
 * - G-25 groups: tiles with the same `roofGroup.id` fade together once any *source* member has a
 *   viewer under it. Followers never trigger the group. Groups are evaluated after every tile's
 *   direct result is known, so tile order never matters.
 * - G-24 reveal: a `revealInFog` roof that no viewer opened is drawn above the fog while any
 *   current vision polygon touches its outline (an exact polygon test). Explored fog is never
 *   written.
 */
import type { ActorDocument, SceneDocument, TileDocument, TokenDocument } from "./documents";
import type { PermissionUser } from "./ownership";
import { userControlsToken } from "./fogExploration";
import {
  tileTriggerAlphaContains,
  tileTriggerPolygonContains,
  tileTriggerWorldPolygon,
  tileWorldToLocalNormalized,
} from "./tileTriggerZone";

export type RoofMode = TileDocument["occlusion"]["mode"];
export const ROOF_MODES: readonly RoofMode[] = ["roof", "fade", "radial", "vision"];
/** Radial opening radius in grid cells when the tile does not set one. */
export const ROOF_RADIUS_DEFAULT = 2;
export const ROOF_RADIUS_MIN = 0.25;
export const ROOF_RADIUS_MAX = 20;
/** Art pixels at or above this alpha (0–255) count as roof. */
export const ROOF_ART_THRESHOLD = 128;
/** Longest side of the downsampled art alpha map. */
export const ROOF_ART_MAX_SIDE = 128;
const ROOF_GROUP_ID = /^[A-Za-z0-9_-]{1,64}$/;
const OCCLUSION_KEYS = new Set(["mode", "alpha", "radius"]);

export interface RoofPoint { x: number; y: number }
/** Downsampled art alpha: row-major, 1 = roof pixel. */
export interface RoofArtMask { width: number; height: number; opaque: Uint8Array }

function plainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/** Shape check for a tile's `occlusion` value. */
export function roofOcclusionError(value: unknown): string | null {
  if (!plainObject(value)) return "tile occlusion must be an object";
  if (Object.keys(value).some((key) => !OCCLUSION_KEYS.has(key)))
    return "tile occlusion accepts only mode, alpha and radius";
  if (!ROOF_MODES.includes(value.mode as RoofMode))
    return "tile occlusion mode must be roof, fade, radial or vision";
  if (typeof value.alpha !== "number" || !Number.isFinite(value.alpha) || value.alpha < 0 || value.alpha > 1)
    return "tile occlusion alpha must be between 0 and 1";
  if (value.radius !== undefined &&
      (typeof value.radius !== "number" || !Number.isFinite(value.radius) ||
       value.radius < ROOF_RADIUS_MIN || value.radius > ROOF_RADIUS_MAX))
    return `tile occlusion radius must be between ${ROOF_RADIUS_MIN} and ${ROOF_RADIUS_MAX} grid cells`;
  return null;
}

/** Shape check for a tile's `roofGroup`. `undefined` means the tile is in no group. */
export function roofGroupError(value: unknown): string | null {
  if (value === undefined) return null;
  if (!plainObject(value) || Object.keys(value).some((key) => key !== "id" && key !== "role"))
    return "roof group must be {id, role}";
  if (typeof value.id !== "string" || !ROOF_GROUP_ID.test(value.id))
    return "roof group id must be 1-64 letters, digits, '-' or '_'";
  if (value.role !== "source" && value.role !== "follower")
    return "roof group role must be source or follower";
  return null;
}

/**
 * Validates the roof fields a create or update carries. Absent fields are not checked, so older
 * documents keep loading. Legacy roofs only ever carry `{mode: "roof" | "fade", alpha}`.
 */
export function tileRoofError(fields: { occlusion?: unknown; roofGroup?: unknown; revealInFog?: unknown }): string | null {
  if (fields.occlusion !== undefined) {
    const error = roofOcclusionError(fields.occlusion);
    if (error) return error;
  }
  const group = roofGroupError(fields.roofGroup);
  if (group) return group;
  if (fields.revealInFog !== undefined && typeof fields.revealInFog !== "boolean")
    return "revealInFog must be true or false";
  return null;
}

/** The radial opening radius in grid cells. */
export function roofRadius(tile: Pick<TileDocument, "occlusion">): number {
  const radius = tile.occlusion.radius;
  return typeof radius === "number" && Number.isFinite(radius)
    ? Math.min(ROOF_RADIUS_MAX, Math.max(ROOF_RADIUS_MIN, radius))
    : ROOF_RADIUS_DEFAULT;
}

function roofAlpha(tile: Pick<TileDocument, "occlusion">): number {
  const alpha = tile.occlusion.alpha;
  return Number.isFinite(alpha) ? Math.min(1, Math.max(0, alpha)) : 0.5;
}

/** Downsampled RGBA → roof art mask. Returns null for malformed input. */
export function roofArtMaskFromRgba(rgba: ArrayLike<number>, width: number, height: number,
  threshold = ROOF_ART_THRESHOLD): RoofArtMask | null {
  if (!Number.isSafeInteger(width) || width < 1 || !Number.isSafeInteger(height) || height < 1 ||
      width * height > ROOF_ART_MAX_SIDE * ROOF_ART_MAX_SIDE * 4 || rgba.length !== width * height * 4)
    return null;
  const opaque = new Uint8Array(width * height);
  for (let i = 0; i < opaque.length; i++) {
    const alpha = Number(rgba[i * 4 + 3]);
    opaque[i] = Number.isFinite(alpha) && alpha >= threshold ? 1 : 0;
  }
  return { width, height, opaque };
}

/** Art-mask query in the tile's normalized frame. Points outside [0, 1] are not on the art. */
export function roofArtCovers(mask: RoofArtMask, u: number, v: number): boolean {
  if (!(u >= 0 && u <= 1 && v >= 0 && v <= 1)) return false;
  const x = Math.min(mask.width - 1, Math.floor(u * mask.width));
  const y = Math.min(mask.height - 1, Math.floor(v * mask.height));
  return mask.opaque[y * mask.width + x] === 1;
}

/** The roof's world outline: its convex trigger polygon when authored, else its rotated rectangle. */
export function roofOutline(tile: TileDocument): RoofPoint[] | null {
  const polygon = tileTriggerWorldPolygon(tile);
  if (polygon || tile.triggerZone?.kind !== "alpha") return polygon;
  const { triggerZone: _alpha, ...rect } = tile;
  void _alpha;
  return tileTriggerWorldPolygon(rect);
}

/**
 * Is `point` under the roof? Checked in order: readable art, then an alpha trigger zone, then a
 * polygon trigger zone, then the rotated rectangle. Boundaries count as under.
 */
export function roofCovers(tile: TileDocument, point: RoofPoint, art?: RoofArtMask | null): boolean {
  const local = tileWorldToLocalNormalized(tile, point);
  if (!local || local.x < 0 || local.x > 1 || local.y < 0 || local.y > 1) return false;
  if (art) return roofArtCovers(art, local.x, local.y);
  if (tile.triggerZone?.kind === "alpha") return tileTriggerAlphaContains(tile, point);
  const outline = roofOutline(tile);
  return !!outline && tileTriggerPolygonContains(outline, point);
}

/** Even-odd point test against a flat `[x0, y0, x1, y1, …]` polygon. */
function flatContains(poly: ArrayLike<number>, x: number, y: number): boolean {
  let inside = false;
  const n = Math.floor(poly.length / 2);
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = poly[i * 2] as number, yi = poly[i * 2 + 1] as number;
    const xj = poly[j * 2] as number, yj = poly[j * 2 + 1] as number;
    if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function cross(ax: number, ay: number, bx: number, by: number, cx: number, cy: number): number {
  return (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
}

function segmentsTouch(ax: number, ay: number, bx: number, by: number,
  cx: number, cy: number, dx: number, dy: number): boolean {
  const d1 = cross(cx, cy, dx, dy, ax, ay), d2 = cross(cx, cy, dx, dy, bx, by);
  const d3 = cross(ax, ay, bx, by, cx, cy), d4 = cross(ax, ay, bx, by, dx, dy);
  if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) return true;
  const on = (px: number, py: number, qx: number, qy: number, rx: number, ry: number, d: number) =>
    Math.abs(d) <= 1e-9 && Math.min(px, qx) - 1e-9 <= rx && rx <= Math.max(px, qx) + 1e-9 &&
    Math.min(py, qy) - 1e-9 <= ry && ry <= Math.max(py, qy) + 1e-9;
  return on(cx, cy, dx, dy, ax, ay, d1) || on(cx, cy, dx, dy, bx, by, d2) ||
    on(ax, ay, bx, by, cx, cy, d3) || on(ax, ay, bx, by, dx, dy, d4);
}

/**
 * Exact test: does a vision polygon (flat world coordinates) touch the outline? They touch when
 * an edge crosses an edge, or when either one lies inside the other. A roof wholly inside sight
 * and sight wholly inside a roof both count.
 */
export function visionTouchesOutline(vision: ArrayLike<number>, outline: readonly RoofPoint[]): boolean {
  const n = Math.floor(vision.length / 2);
  if (n < 3 || outline.length < 3) return false;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (let i = 0; i < n; i++) {
    const x = vision[i * 2] as number, y = vision[i * 2 + 1] as number;
    if (!Number.isFinite(x) || !Number.isFinite(y)) return false;
    minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y);
  }
  if (outline.every((p) => p.x < minX) || outline.every((p) => p.x > maxX) ||
      outline.every((p) => p.y < minY) || outline.every((p) => p.y > maxY)) return false;
  if (outline.some((p) => flatContains(vision, p.x, p.y))) return true;
  const first = { x: vision[0] as number, y: vision[1] as number };
  if (tileTriggerPolygonContains(outline, first)) return true;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const ax = vision[i * 2] as number, ay = vision[i * 2 + 1] as number;
    const bx = vision[j * 2] as number, by = vision[j * 2 + 1] as number;
    for (let k = 0; k < outline.length; k++) {
      const c = outline[k] as RoofPoint, d = outline[(k + 1) % outline.length] as RoofPoint;
      if (segmentsTouch(ax, ay, bx, by, c.x, c.y, d.x, d.y)) return true;
    }
  }
  return false;
}

export interface RoofInputs {
  /** Centres of the viewer's own vision tokens. */
  viewers: readonly RoofPoint[];
  /** G-26c: a GM-local pointer that counts as one more viewer (never opens `vision` holes). */
  hover?: RoofPoint | null;
  /** Current vision polygons in flat world coordinates. Empty when there is no live sight. */
  vision?: readonly ArrayLike<number>[];
  /** Scene grid size in px (the radial radius unit). */
  gridSize: number;
  /** The renderer can cut holes (inverse masks). False makes radial and vision fall back to roof. */
  masks: boolean;
  /** Readable art for a tile, if its texture has loaded. */
  art?: (tile: TileDocument) => RoofArtMask | null | undefined;
}

export type RoofHoles =
  | { kind: "circles"; circles: Array<{ x: number; y: number; r: number }> }
  | { kind: "vision" };

export interface RoofState {
  /** Alpha of the tile outside any hole. */
  alpha: number;
  /** Openings, drawn at `holeAlpha`. Null when the tile fades (or not) as a whole. */
  holes: RoofHoles | null;
  holeAlpha: number;
  /** A viewer (or the GM's pointer) is under this tile. */
  under: boolean;
  /** Faded because a source tile in its roof group has a viewer under it. */
  linked: boolean;
  /** G-24: draw a copy above the fog. */
  reveal: boolean;
}

export const ROOF_IDLE: RoofState = Object.freeze({ alpha: 1, holes: null, holeAlpha: 1, under: false, linked: false, reveal: false });

/** A stable key for change detection between frames. */
export function roofStateKey(state: RoofState | undefined): string {
  if (!state) return "";
  const holes = !state.holes ? "-" : state.holes.kind === "vision" ? "v"
    : state.holes.circles.map((c) => `${c.x.toFixed(1)},${c.y.toFixed(1)},${c.r.toFixed(1)}`).join(";");
  return `${state.alpha}|${state.holeAlpha}|${holes}|${+state.under}${+state.linked}${+state.reveal}`;
}

/**
 * Resolves every tile's roof state for one frame:
 * 1. direct occupancy,
 * 2. hot groups (a source member is occupied),
 * 3. per-tile state.
 * The result does not depend on tile order.
 */
export function resolveRoofs(tiles: readonly TileDocument[], input: RoofInputs): Map<string, RoofState> {
  const out = new Map<string, RoofState>();
  const viewers = input.viewers.filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y));
  const hover = input.hover && Number.isFinite(input.hover.x) && Number.isFinite(input.hover.y) ? input.hover : null;
  const vision = (input.vision ?? []).filter((poly) => poly.length >= 6);
  const grid = Number.isFinite(input.gridSize) && input.gridSize > 0 ? input.gridSize : 100;
  const direct = new Map<string, { viewers: RoofPoint[]; hover: boolean }>();
  for (const tile of tiles) {
    if (!tile.above) continue;
    const art = input.art?.(tile) ?? null;
    direct.set(tile._id, {
      viewers: viewers.filter((p) => roofCovers(tile, p, art)),
      hover: !!hover && roofCovers(tile, hover, art),
    });
  }
  const hot = new Set<string>();
  for (const tile of tiles) {
    const hit = direct.get(tile._id);
    if (tile.roofGroup?.role === "source" && hit && (hit.viewers.length > 0 || hit.hover)) hot.add(tile.roofGroup.id);
  }
  for (const tile of tiles) {
    const hit = direct.get(tile._id);
    if (!tile.above || !hit) { out.set(tile._id, ROOF_IDLE); continue; }
    const faded = roofAlpha(tile);
    const under = hit.viewers.length > 0 || hit.hover;
    const linked = !under && !!tile.roofGroup && hot.has(tile.roofGroup.id);
    let alpha = 1, holes: RoofHoles | null = null;
    const mode = tile.occlusion.mode;
    if (mode === "fade" || linked) alpha = faded;
    else if (under) {
      if (mode === "radial" && input.masks) {
        const r = roofRadius(tile) * grid;
        const centres = [...hit.viewers, ...(hit.hover && hover ? [hover] : [])];
        holes = { kind: "circles", circles: centres.map((p) => ({ x: p.x, y: p.y, r })) };
      } else if (mode === "vision" && input.masks && hit.viewers.length > 0 && vision.length > 0) {
        holes = { kind: "vision" };
      } else alpha = faded;
    }
    let reveal = false;
    if (tile.revealInFog === true && !under && !linked && vision.length > 0) {
      const outline = roofOutline(tile);
      reveal = !!outline && vision.some((poly) => visionTouchesOutline(poly, outline));
    }
    out.set(tile._id, { alpha, holes, holeAlpha: holes ? faded : alpha, under, linked, reveal });
  }
  return out;
}

/**
 * D-438 (Levels T9): the tokens that open roofs for `user`. These are the user's own vision
 * tokens; a GM controls every one. When the selection includes any of them, only the selected
 * ones count, so a roof does not open just because another owned token is inside. Other
 * players' tokens never open your roofs.
 */
export function roofViewerTokens(scene: SceneDocument, user: PermissionUser | null,
  actors: readonly ActorDocument[], selection: readonly string[] = []): TokenDocument[] {
  if (!user) return [];
  const own = scene.tokens.filter((token) => token.vision && userControlsToken(user, token, scene, actors));
  const picked = own.filter((token) => selection.includes(token._id));
  return picked.length > 0 ? picked : own;
}

/** A short summary for the roof editor. */
export function describeRoof(tile: TileDocument): string {
  if (!tile.above) return "floor tile";
  const alpha = `${Math.round(roofAlpha(tile) * 100)}%`;
  const mode = tile.occlusion.mode === "fade" ? `always ${alpha}`
    : tile.occlusion.mode === "radial" ? `opens ${roofRadius(tile)} cells around tokens (${alpha})`
      : tile.occlusion.mode === "vision" ? `opens what tokens beneath see (${alpha})`
        : `fades to ${alpha} with a token beneath`;
  const group = tile.roofGroup ? ` · group ${tile.roofGroup.id} (${tile.roofGroup.role})` : "";
  return `roof · ${mode}${group}${tile.revealInFog ? " · shows through fog" : ""}`;
}
