/**
 * SQ-10 — one shared crosshair: the placement instrument the FX wizard, the
 * summon windows and any future "put something on the map" flow all use.
 *
 * This module is the *rule*, not the authority. A crosshair answers a placement
 * — a named point plus the area the author was shown — and every consumer still
 * goes through a host check (`summonPlacementError`, `resolveFxSequence`,
 * trigger validation). Sharing the rule is the point: the red preview and the
 * host's refusal must be the same computation, or an author learns about a wall
 * only when a save fails.
 *
 * Pure: no DOM, no canvas, no host call. Shapes are the spec's five
 * (`point | circle | cone | ray | rect`); areas come back in **world**
 * coordinates so a caller can draw them without knowing the grid.
 *
 * Explicit non-claims: occupancy/terrain walkability (this codebase has no such
 * data, so "valid cell" means a scene cell that is inside the scene — snapping
 * lands on its centre), no per-viewer visibility (a hidden token is not a
 * fault), and no mechanical effect — an area is a measurement the author saw,
 * never a zone, template or summon in its own right.
 */
import type { SceneGrid, WallDocument } from "./documents";
import { snapTokenCenter, type GridSpec } from "../canvas/grid";
import { moveSegments, sightBlocked } from "../canvas/vision/wallSight";

export type CrosshairShapeKind = "point" | "circle" | "cone" | "ray" | "rect";

export interface CrosshairShape {
  kind: CrosshairShapeKind;
  /** Scene units: a circle/cone's reach, a ray/rect's depth. */
  length?: number;
  /** Scene units: a ray/rect's width. */
  width?: number;
  /** Degrees, 0 = east, growing clockwise on screen (canvas y is down). */
  angle?: number;
  /** Degrees of aperture for a cone. Defaults to {@link CROSSHAIR_DEFAULT_SPREAD}. */
  spread?: number;
}

/** Sequencer/Foundry's usual cone aperture, kept as the default so an author's
 * muscle memory produces the same wedge. */
export const CROSSHAIR_DEFAULT_SPREAD = 53.13;
/** Rotation snapping step, matching the 15° increments token rotation uses. */
export const CROSSHAIR_ANGLE_STEP = 15;
/** Longest name a placement may carry, so a name cannot become a document field. */
export const CROSSHAIR_NAME_MAX = 48;

export interface CrosshairPoint {
  x: number;
  y: number;
}

export interface CrosshairRequest {
  sceneId: string;
  bounds: { width: number; height: number };
  /** Only the grid's metric is needed: snapping, conversion and unit labels. */
  grid: Pick<SceneGrid, "type" | "size" | "distance" | "units" | "hexLayout">;
  /** Sight and movement axes are read from these; the crosshair owns no walls. */
  walls: readonly WallDocument[];
  /** Range/reach/LOS are measured from here (a caster or source token centre). */
  origin?: CrosshairPoint | null;
  /** Scene units; a point closer than this is refused. */
  minDistance?: number;
  /** Scene units; a point beyond this is refused (`summonPlacementError`'s rule). */
  maxDistance?: number;
  /** Require an unobstructed sight segment from `origin` (doors obey state). */
  requireLoS?: boolean;
  /** Require no *move*-blocking wall between `origin` and the point. */
  requireClearPath?: boolean;
  /** Half-extent kept inside the scene, in scene units (a summon's own size). */
  footprint?: number;
}

export type CrosshairFaultCode =
  | "not-finite"
  | "outside-scene"
  | "too-close"
  | "out-of-range"
  | "behind-wall"
  | "no-path";

export interface CrosshairFault {
  code: CrosshairFaultCode;
  message: string;
}

export interface CrosshairPlacement {
  name: string;
  point: CrosshairPoint;
  shape: CrosshairShape;
  /** Outline in world coordinates, closed implicitly; empty for a point. */
  area: CrosshairPoint[];
  /** Direction the shape faces, snapped with the rest of the geometry. */
  angleDeg: number;
  /** Scene units from `origin`, or `null` when the request has no origin. */
  distance: number | null;
}

export type CrosshairCommit =
  | { ok: true; placement: CrosshairPlacement }
  | { ok: false; faults: CrosshairFault[] };

/** Square/hex/gridless → the shared snapping spec; gridless never snaps. */
export function crosshairGridSpec(grid: CrosshairRequest["grid"]): GridSpec {
  if (grid.type === "hex") return { type: "hex", size: grid.size, layout: grid.hexLayout };
  if (grid.type === "square") return { type: "square", size: grid.size };
  return { type: "gridless" };
}

/** Scene units → pixels. A malformed metric falls back to 1:1 rather than NaN. */
export function crosshairPxPerUnit(grid: CrosshairRequest["grid"]): number {
  const { size, distance } = grid;
  if (!Number.isFinite(size) || !Number.isFinite(distance) || size <= 0 || distance <= 0) return 1;
  return size / distance;
}

/** Snap a picked world point to the cell/hex centre (`snapTokenCenter`'s rule). */
export function crosshairSnapPoint(
  point: CrosshairPoint,
  grid: CrosshairRequest["grid"],
  snap: boolean,
): CrosshairPoint {
  if (!snap || grid.type === "gridless" || !Number.isFinite(grid.size) || grid.size <= 0) return point;
  const snapped = snapTokenCenter(crosshairGridSpec(grid), point.x, point.y);
  return { x: snapped.x, y: snapped.y };
}

/** Direction of `point` seen from `origin`, in degrees; snapping quantizes to
 * {@link CROSSHAIR_ANGLE_STEP} so a rotated rect/ray/cone cannot be placed at an
 * arbitrary angle by accident. */
export function crosshairAngle(
  origin: CrosshairPoint,
  point: CrosshairPoint,
  snap: boolean,
  fallback = 0,
): number {
  const dx = point.x - origin.x;
  const dy = point.y - origin.y;
  if (!Number.isFinite(dx) || !Number.isFinite(dy) || (dx === 0 && dy === 0)) return fallback;
  const raw = (Math.atan2(dy, dx) * 180) / Math.PI;
  if (!snap) return raw;
  return Math.round(raw / CROSSHAIR_ANGLE_STEP) * CROSSHAIR_ANGLE_STEP;
}

/** Normalize any degree value into [0, 360). */
export function crosshairNormalizeAngle(deg: number): number {
  const wrapped = deg % 360;
  return wrapped < 0 ? wrapped + 360 : wrapped;
}

const CIRCLE_STEPS = 16;
const CONE_STEPS = 12;

/**
 * The outline a placement shows. Points are world coordinates; a `point` shape
 * has no area (a marker, not a region) and a malformed metric or non-finite
 * extent yields `[]` rather than a shape that renders somewhere arbitrary.
 */
export function crosshairArea(
  point: CrosshairPoint,
  shape: CrosshairShape,
  grid: CrosshairRequest["grid"],
  angleDeg = 0,
): CrosshairPoint[] {
  const scale = crosshairPxPerUnit(grid);
  const finite = (value: number | undefined): number | null =>
    value !== undefined && Number.isFinite(value) && value > 0 ? value : null;
  if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) return [];
  if (shape.kind === "point") return [];
  const rad = (angleDeg * Math.PI) / 180;

  if (shape.kind === "circle") {
    const radius = finite(shape.length);
    if (radius === null) return [];
    const out: CrosshairPoint[] = [];
    for (let i = 0; i < CIRCLE_STEPS; i += 1) {
      const a = (i / CIRCLE_STEPS) * Math.PI * 2;
      out.push({ x: point.x + Math.cos(a) * radius * scale, y: point.y + Math.sin(a) * radius * scale });
    }
    return out;
  }

  if (shape.kind === "cone") {
    const radius = finite(shape.length);
    if (radius === null) return [];
    const spread = Number.isFinite(shape.spread) && (shape.spread ?? 0) > 0 && (shape.spread ?? 0) < 360
      ? (shape.spread as number)
      : CROSSHAIR_DEFAULT_SPREAD;
    const half = (spread / 2) * (Math.PI / 180);
    const out: CrosshairPoint[] = [{ x: point.x, y: point.y }];
    for (let i = 0; i <= CONE_STEPS; i += 1) {
      const a = rad - half + (i / CONE_STEPS) * half * 2;
      out.push({ x: point.x + Math.cos(a) * radius * scale, y: point.y + Math.sin(a) * radius * scale });
    }
    return out;
  }

  const depth = finite(shape.length);
  const width = finite(shape.width);
  if (depth === null || width === null) return [];
  const halfWidth = (width * scale) / 2;
  const forward = { x: Math.cos(rad), y: Math.sin(rad) };
  const side = { x: -Math.sin(rad), y: Math.cos(rad) };
  // A ray starts at the point; a rect straddles it.
  const from = shape.kind === "ray" ? 0 : -depth * scale / 2;
  const to = shape.kind === "ray" ? depth * scale : depth * scale / 2;
  const corners: CrosshairPoint[] = [];
  for (const [along, across] of [[from, -halfWidth], [to, -halfWidth], [to, halfWidth], [from, halfWidth]] as const) {
    corners.push({
      x: point.x + forward.x * along + side.x * across,
      y: point.y + forward.y * along + side.y * across,
    });
  }
  return corners;
}

/** Strict interior crossing test: touching an endpoint is not "through" a wall. */
function crossesSegment(from: CrosshairPoint, to: CrosshairPoint,
  wall: readonly number[]): boolean {
  const [x1 = 0, y1 = 0, x2 = 0, y2 = 0] = wall;
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const wx = x2 - x1;
  const wy = y2 - y1;
  const denominator = dx * wy - dy * wx;
  if (Math.abs(denominator) < 1e-8) return false; // parallel or collinear
  const rx = x1 - from.x;
  const ry = y1 - from.y;
  const along = (rx * wy - ry * wx) / denominator;
  const onWall = (rx * dy - ry * dx) / denominator;
  return along > 1e-7 && along < 1 - 1e-7 && onWall >= 0 && onWall <= 1;
}

/**
 * The one wall rule, used by the crosshair preview *and* by the summon host
 * check: `segments` are those of a single axis (sight or movement), already
 * reduced by the doors' open/closed state (`sightSegments`/`moveSegments`).
 */
export function segmentsBlocked(from: CrosshairPoint, to: CrosshairPoint,
  segments: readonly (readonly number[])[]): boolean {
  for (const segment of segments) if (crossesSegment(from, to, segment)) return true;
  return false;
}

/** Is the sight segment from `from` to `to` unobstructed? */
export function sightBlockedBetween(walls: readonly WallDocument[], from: CrosshairPoint,
  to: CrosshairPoint): boolean {
  const segments = walls.filter((wall) => sightBlocked(wall)).map((wall) => wall.c);
  return segmentsBlocked(from, to, segments);
}

/** Is the movement segment from `from` to `to` unobstructed? */
export function pathBlockedBetween(walls: readonly WallDocument[], from: CrosshairPoint,
  to: CrosshairPoint): boolean {
  const segments = moveSegments(walls).map((segment) => [segment.x1, segment.y1, segment.x2, segment.y2]);
  return segmentsBlocked(from, to, segments);
}

/**
 * Why this placement cannot be committed, or `[]`. Order is deliberate: a
 * non-finite point outranks everything, bounds outrank range, and range
 * outranks walls — an author fixes the first thing a host would also refuse
 * first (the summon host checks bounds, then range, then sight).
 */
export function crosshairFaults(
  request: CrosshairRequest,
  point: CrosshairPoint,
  shape: CrosshairShape = { kind: "point" },
  angleDeg = 0,
): CrosshairFault[] {
  const faults: CrosshairFault[] = [];
  if (!Number.isFinite(point.x) || !Number.isFinite(point.y))
    return [{ code: "not-finite", message: "Not a finite point" }];
  const inset = Number.isFinite(request.footprint) && (request.footprint ?? 0) > 0
    ? ((request.footprint as number) * crosshairPxPerUnit(request.grid)) / 2
    : 0;
  const { width, height } = request.bounds;
  if (point.x - inset < 0 || point.y - inset < 0 || point.x + inset > width || point.y + inset > height) {
    faults.push({ code: "outside-scene",
      message: inset > 0 ? "Footprint outside the scene" : "Outside the scene" });
  }

  const origin = request.origin;
  if (origin && Number.isFinite(origin.x) && Number.isFinite(origin.y)) {
    // Range is measured in scene units, like the host's own check (grid-true feet).
    const perUnit = crosshairPxPerUnit(request.grid);
    const distance = Math.hypot(point.x - origin.x, point.y - origin.y) / perUnit;
    if (request.minDistance !== undefined && Number.isFinite(request.minDistance) && distance < request.minDistance)
      faults.push({ code: "too-close", message: `Closer than the minimum ${request.minDistance} ${request.grid.units ?? "units"}` });
    if (request.maxDistance !== undefined && Number.isFinite(request.maxDistance) && distance > request.maxDistance)
      faults.push({ code: "out-of-range", message: `Beyond the maximum ${request.maxDistance} ${request.grid.units ?? "units"}` });

    // An area is checked at its outline too: a circle half-buried in a wall is the
    // case an author would otherwise only discover after a failed save.
    const samples = [point, ...crosshairArea(point, shape, request.grid, angleDeg)];
    if (request.requireLoS && samples.some((sample) => sightBlockedBetween(request.walls, origin, sample)))
      faults.push({ code: "behind-wall", message: "Behind a sight-blocking wall" });
    if (request.requireClearPath && samples.some((sample) => pathBlockedBetween(request.walls, origin, sample)))
      faults.push({ code: "no-path", message: "A blocking wall stands between" });
  }
  return faults;
}

/** The first fault message — what a one-line readout shows. */
export function crosshairFaultMessage(faults: readonly CrosshairFault[]): string | null {
  return faults.length > 0 ? faults[0]?.message ?? null : null;
}

/**
 * Normalize an authored name: trimmed, single-line, bounded, and made unique
 * against the names already in use so "reuse the second one" can never be
 * ambiguous. An empty name becomes "Placement N".
 */
export function crosshairName(preferred: string | undefined, taken: readonly string[] = []): string {
  const base = (preferred ?? "").replace(/\s+/g, " ").trim().slice(0, CROSSHAIR_NAME_MAX)
    || `Placement ${taken.length + 1}`;
  if (!taken.includes(base)) return base;
  for (let n = 2; n < 100; n += 1) {
    const candidate = `${base} (${n})`.slice(0, CROSSHAIR_NAME_MAX);
    if (!taken.includes(candidate)) return candidate;
  }
  return `${base} (${taken.length + 1})`.slice(0, CROSSHAIR_NAME_MAX);
}

/**
 * Commit a placement: geometry + the same faults the preview showed. `name` is
 * resolved against `taken` so the returned placement is directly reusable.
 */
export function crosshairCommit(input: {
  request: CrosshairRequest;
  point: CrosshairPoint;
  shape?: CrosshairShape;
  angleDeg?: number;
  name?: string;
  taken?: readonly string[];
}): CrosshairCommit {
  const shape = input.shape ?? { kind: "point" as const };
  const angleDeg = crosshairNormalizeAngle(input.angleDeg ?? 0);
  const faults = crosshairFaults(input.request, input.point, shape, angleDeg);
  if (faults.length > 0) return { ok: false, faults };
  const origin = input.request.origin;
  const distance = origin && Number.isFinite(origin.x) && Number.isFinite(origin.y)
    ? Math.hypot(input.point.x - origin.x, input.point.y - origin.y) / crosshairPxPerUnit(input.request.grid)
    : null;
  return { ok: true, placement: {
    name: crosshairName(input.name, input.taken),
    point: input.point,
    shape: { ...shape, angle: angleDeg },
    area: crosshairArea(input.point, shape, input.request.grid, angleDeg),
    angleDeg,
    distance,
  } };
}
