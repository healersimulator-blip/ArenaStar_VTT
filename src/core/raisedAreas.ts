/**
 * D-453: raised areas inside a floor, such as crate stacks, a dais or a scaffold.
 *
 * A region with `raised: { height, solid }` is a box standing on its floor, `height` scene units
 * tall. An unscoped area stands on every floor, as other regions are shown on every floor. In a
 * scene without floors it stands on the ground (0). A player's floor scene holds no levels, so its
 * areas stand on the floor being looked at (`floorZ`).
 *
 * - **Ground.** A token whose centre is over a raised area stands on its top. The host keeps walking
 *   tokens on the ground they walk over (`raisedGroundOps`). A token above the ground keeps its
 *   height unless it ends inside a taller area, which lifts it onto the top. An area as tall as its
 *   floor (reaching the next floor up) is never stood on.
 * - **Sight (solid areas only).** A solid area hides what is behind it from eyes below its top. On
 *   a floor, its edges join the walls in that viewer's fog polygon (`raisedEyeSegments`), and token
 *   visibility tests 3D rays against the boxes (`raisedTokenSeen`). Across floors, its sides become
 *   kernel barriers (`raisedBarriers`). Open areas such as a scaffold or a platform never block
 *   sight. Raised areas never block movement, light or sound.
 */
import type { LevelDocument, RegionDocument, SceneDocument, TileDocument, TokenDocument } from "./documents";
import type { Op } from "./ops";
import { applyDiff } from "./diff";
import { inElevationBand } from "./multilevelGeometry";
import { tileTriggerPolygonContains, tileTriggerWorldPolygon } from "./tileTriggerZone";
import type { SpatialBarrier } from "./spatial/kernel";
import { pointInPolygon } from "../canvas/vision/polygon";

export interface RaisedArea {
  /** Scene units (feet on a PF1e grid) above the floor it stands on. */
  height: number;
  /** Solid areas block sight for eyes below their top; open ones (scaffolds, platforms) never do. */
  solid: boolean;
}
export const RAISED_MAX_HEIGHT = 1000;
/** At most this many raised areas per scene (sight passes and kernel barriers stay bounded). */
export const RAISED_MAX_AREAS = 128;
const EPS = 0.01;

export function raisedAreaError(value: unknown): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "Raised area must be an object";
  if (Object.keys(value).some((k) => k !== "height" && k !== "solid")) return "Raised area accepts only height and solid";
  const { height, solid } = value as Partial<RaisedArea>;
  if (typeof height !== "number" || !Number.isFinite(height) || height <= 0 || height > RAISED_MAX_HEIGHT)
    return `Raised area height must be above 0 and at most ${RAISED_MAX_HEIGHT}`;
  if (typeof solid !== "boolean") return "Raised area solid must be true or false";
  return null;
}

/** One raised area standing on one floor, as world geometry. */
export interface RaisedVolume {
  /** `region` or `region@level`. */
  id: string;
  regionId: string;
  name: string;
  /** The floor it stands on; null in a scene without floors (or a player's floor scene). */
  levelId: string | null;
  /** Convex, in scene pixels. */
  polygon: Array<{ x: number; y: number }>;
  /** Its floor's Z and its top, in scene units. The top is capped at the next floor up. */
  bottom: number;
  top: number;
  solid: boolean;
  /** False when the area reaches the next floor up: nobody can stand on it. */
  standable: boolean;
}

export function raisedPolygon(region: Pick<RegionDocument, "x" | "y" | "width" | "height" | "rotation" | "shape">): Array<{ x: number; y: number }> | null {
  return tileTriggerWorldPolygon({ x: region.x, y: region.y, width: region.width, height: region.height, rotation: region.rotation ?? 0,
    triggerZone: region.shape } as TileDocument);
}

/** Every raised area of the scene, once per floor it stands on (`floorZ`: the floor of a scene without levels). */
export function raisedVolumes(scene: Pick<SceneDocument, "regions" | "levels">, floorZ = 0): RaisedVolume[] {
  const levels = scene.levels ?? [];
  const out: RaisedVolume[] = [];
  for (const region of scene.regions ?? []) {
    if (!region.raised || raisedAreaError(region.raised) || region.stairs) continue;
    const polygon = raisedPolygon(region);
    if (!polygon || polygon.length < 3) continue;
    const base = { regionId: region._id, name: region.name, polygon, solid: region.raised.solid };
    if (!levels.length) {
      out.push({ ...base, id: region._id, levelId: null, bottom: floorZ, top: floorZ + region.raised.height, standable: true });
      continue;
    }
    const scope = region.levelScope;
    const floors = !scope || scope.mode === "all" ? levels : levels.filter((l) => scope.ids.includes(l._id));
    for (const level of floors) {
      const top = level.floorZ + region.raised.height;
      const ceiling = level.top;
      out.push({ ...base, id: `${region._id}@${level._id}`, levelId: level._id, bottom: level.floorZ,
        top: ceiling === null ? top : Math.min(top, ceiling), standable: ceiling === null || top < ceiling - EPS });
    }
  }
  return out;
}

/** True when the scene has at least one solid raised area (the extra sight work is needed). */
export function hasSolidRaisedAreas(scene: Pick<SceneDocument, "regions">): boolean {
  return (scene.regions ?? []).some((r) => r.raised?.solid === true && !r.stairs && !raisedAreaError(r.raised));
}

type Placed = Pick<TokenDocument, "x" | "y" | "elevation" | "levelId">;

/** The floor a token stands on: its level, else the band its feet are in. Null in a scene without floors. */
function floorOf(scene: Pick<SceneDocument, "levels">, token: Pick<TokenDocument, "elevation" | "levelId">): LevelDocument | null {
  const levels = scene.levels ?? [];
  if (!levels.length) return null;
  const z = token.elevation ?? 0;
  return (token.levelId !== undefined ? levels.find((l) => l._id === token.levelId) : undefined) ?? levels.find((l) => inElevationBand(l, z)) ?? null;
}

/**
 * The ground under a token's centre on its floor: the floor's Z (0 without floors), or the top of
 * the highest standable raised area there.
 */
export function groundAt(scene: Pick<SceneDocument, "regions" | "levels">, token: Placed, at: { x: number; y: number } = token,
  volumes: readonly RaisedVolume[] = raisedVolumes(scene)): number {
  const level = floorOf(scene, token);
  const floor = level?.floorZ ?? 0;
  let ground = floor;
  for (const v of volumes) {
    if (!v.standable || (level ? v.levelId !== level._id : v.levelId !== null)) continue;
    if (v.top > ground && tileTriggerPolygonContains(v.polygon, at)) ground = v.top;
  }
  return ground;
}

/**
 * Where a token's feet end after walking from `start` to `end` (only x and y differ). A token that
 * stood on the ground takes the ground height at the end. A token above the ground keeps its
 * height, unless the ground at the end is higher.
 */
export function followedElevation(scene: Pick<SceneDocument, "regions" | "levels">, start: Placed, end: { x: number; y: number },
  volumes: readonly RaisedVolume[] = raisedVolumes(scene)): number {
  const z = start.elevation ?? 0;
  if (!volumes.length) return z;
  const from = groundAt(scene, start, start, volumes);
  const to = groundAt(scene, start, end, volumes);
  if (Math.abs(z - from) < EPS) return to;
  return z < to ? to : z;
}

const tokenRefOf = (op: Op) => {
  const ref = op.kind === "create" ? { coll: op.coll, id: op.data._id, parent: op.parent } : op.ref;
  return ref.coll === "tokens" && ref.parent?.coll === "scenes" ? { sceneId: ref.parent.id, tokenId: ref.id } : null;
};

/**
 * D-453 host rule: elevation updates that keep walking tokens on the ground under them, to append
 * to `ops`. A token whose x or y changes without an elevation or level change of its own follows
 * `followedElevation`. A token created at its floor's height over a raised area stands on top of
 * it. Tokens on prefab parents ride their parent and are left alone.
 */
export function raisedGroundOps(ops: readonly Op[], sceneById: (id: string) => SceneDocument | undefined): Op[] {
  const rows = new Map<string, { sceneId: string; tokenId: string; start: TokenDocument | null; after: TokenDocument; explicit: boolean; walked: boolean }>();
  for (const op of ops) {
    const ref = tokenRefOf(op);
    if (!ref) continue;
    const key = `${ref.sceneId}\u0000${ref.tokenId}`;
    if (op.kind === "delete") { rows.delete(key); continue; }
    if (op.kind === "create") {
      rows.set(key, { ...ref, start: null, after: structuredClone(op.data) as TokenDocument, explicit: false, walked: false });
      continue;
    }
    let row = rows.get(key);
    if (!row) {
      const start = sceneById(ref.sceneId)?.tokens.find((t) => t._id === ref.tokenId);
      if (!start) continue;
      row = { ...ref, start, after: start, explicit: false, walked: false };
      rows.set(key, row);
    }
    const next = applyDiff(row.after, op.diff);
    if (!next.ok) continue;
    row.after = next.value;
    const keys = Object.keys(op.diff);
    row.explicit ||= keys.some((k) => /^(?:-=)?(?:elevation|levelId)(?:\.|$)/.test(k));
    row.walked ||= keys.some((k) => k === "x" || k === "y");
  }
  const out: Op[] = [];
  const volumesOf = new Map<string, RaisedVolume[]>();
  for (const row of rows.values()) {
    if (typeof (row.after.flags?.prefab as { parentId?: unknown } | undefined)?.parentId === "string") continue;
    const scene = sceneById(row.sceneId);
    if (!scene || !(scene.regions ?? []).some((r) => r.raised)) continue;
    let volumes = volumesOf.get(scene._id);
    if (!volumes) { volumes = raisedVolumes(scene); volumesOf.set(scene._id, volumes); }
    if (!volumes.length) continue;
    const z = row.after.elevation ?? 0;
    let target: number;
    if (row.start === null) {
      const floor = floorOf(scene, row.after)?.floorZ ?? 0;
      if (Math.abs(z - floor) >= EPS) continue;
      target = groundAt(scene, row.after, row.after, volumes);
    } else {
      if (row.explicit || !row.walked) continue;
      target = followedElevation(scene, row.start, row.after, volumes);
    }
    if (Math.abs(target - z) < EPS) continue;
    out.push({ kind: "update", ref: { coll: "tokens", id: row.tokenId, parent: { coll: "scenes", id: row.sceneId } }, diff: { elevation: Math.round(target * 100) / 100 } });
  }
  return out;
}

// ─── sight ─────────────────────────────────────────────────────────────────────

/** A token's body height in scene units: its size in cells × the grid distance (half a cell at least). */
export function raisedBodyHeight(token: Pick<TokenDocument, "width" | "height">, grid: Pick<SceneDocument["grid"], "size" | "distance">): number {
  const size = grid.size > 0 ? grid.size : 100, distance = grid.distance > 0 ? grid.distance : 5;
  return Math.max(0.5, Math.max(token.width, token.height) / size) * distance;
}
/** Eyes sit at 90 % of the body, as in cross-floor sight (G-20). */
export const RAISED_EYE_HEIGHT = 0.9;

export interface RaisedEye { x: number; y: number; z: number; levelId: string | null }
/** What a fog pass needs: the solid boxes and each viewer's eye, in viewer order. */
export interface RaisedSight { volumes: RaisedVolume[]; eyes: RaisedEye[] }

/**
 * The raised-area context for these viewers, or null when the scene has no solid raised area
 * (nothing changes then). `floorZ`: the floor of a scene without levels.
 */
export function raisedSight(scene: Pick<SceneDocument, "regions" | "levels" | "tokens" | "grid">, viewers: ReadonlyArray<{ tokenId: string; x: number; y: number }>,
  floorZ = 0): RaisedSight | null {
  if (!hasSolidRaisedAreas(scene)) return null;
  const volumes = raisedVolumes(scene, floorZ).filter((v) => v.solid);
  if (!volumes.length) return null;
  const eyes = viewers.map((v) => {
    const token = scene.tokens.find((t) => t._id === v.tokenId);
    const feet = token?.elevation ?? floorZ;
    const level = token ? floorOf(scene, token) : null;
    return { x: v.x, y: v.y, z: feet + (token ? raisedBodyHeight(token, scene.grid) * RAISED_EYE_HEIGHT : 0), levelId: level?._id ?? null };
  });
  return { volumes, eyes };
}

/** A cache key for the sight context: the boxes and the eyes' heights. */
export function raisedSightKey(sight: RaisedSight | null): string {
  if (!sight) return "";
  const boxes = sight.volumes.map((v) => `${v.id}:${v.polygon.map((p) => `${Math.round(p.x)},${Math.round(p.y)}`).join(" ")}:${Math.round(v.bottom * 100)}:${Math.round(v.top * 100)}`).join(";");
  return `${boxes}|${sight.eyes.map((e) => `${Math.round(e.z * 10)}@${e.levelId ?? "-"}`).join(",")}`;
}

const onFloor = (v: RaisedVolume, eye: RaisedEye) => v.levelId === null || eye.levelId === null || v.levelId === eye.levelId;
const insideBelowTop = (v: RaisedVolume, eye: RaisedEye) => eye.z < v.top && tileTriggerPolygonContains(v.polygon, eye);

/**
 * Extra sight segments for one viewer's fog polygon: the edges of the solid boxes on its floor
 * that rise above its eyes. A box the viewer stands inside is skipped, so it never blinds itself.
 */
export function raisedEyeSegments(sight: RaisedSight | null, index: number): Array<{ x1: number; y1: number; x2: number; y2: number }> {
  const eye = sight?.eyes[index];
  if (!sight || !eye) return [];
  const out: Array<{ x1: number; y1: number; x2: number; y2: number }> = [];
  for (const v of sight.volumes) {
    if (!onFloor(v, eye) || v.top <= eye.z + EPS || v.bottom > eye.z || insideBelowTop(v, eye)) continue;
    v.polygon.forEach((a, i) => {
      const b = v.polygon[(i + 1) % v.polygon.length] as { x: number; y: number };
      out.push({ x1: a.x, y1: a.y, x2: b.x, y2: b.y });
    });
  }
  return out;
}

/** The part [t0, t1] of segment a→b (t in 0..1) inside a convex polygon, or null (Cyrus–Beck). */
export function clipToConvex(polygon: ReadonlyArray<{ x: number; y: number }>, a: { x: number; y: number }, b: { x: number; y: number }): [number, number] | null {
  let area = 0;
  for (let i = 0; i < polygon.length; i++) {
    const p = polygon[i] as { x: number; y: number }, q = polygon[(i + 1) % polygon.length] as { x: number; y: number };
    area += p.x * q.y - q.x * p.y;
  }
  if (Math.abs(area) < 1e-9) return null;
  const sign = area > 0 ? 1 : -1;
  let t0 = 0, t1 = 1;
  const dx = b.x - a.x, dy = b.y - a.y;
  for (let i = 0; i < polygon.length; i++) {
    const p = polygon[i] as { x: number; y: number }, q = polygon[(i + 1) % polygon.length] as { x: number; y: number };
    // Inside is where cross(q - p, x - p) has the polygon's winding sign.
    const ex = q.x - p.x, ey = q.y - p.y;
    const num = sign * (ex * (a.y - p.y) - ey * (a.x - p.x));
    const den = sign * (ex * dy - ey * dx);
    if (Math.abs(den) < 1e-12) { if (num < 0) return null; continue; }
    const t = -num / den;
    if (den > 0) t0 = Math.max(t0, t); else t1 = Math.min(t1, t);
    if (t0 > t1) return null;
  }
  return [t0, t1];
}

type Point3 = { x: number; y: number; z: number };
/** Does the straight line from `from` to `to` pass through the inside of any of these boxes? */
export function raisedBlocks(volumes: readonly RaisedVolume[], from: Point3, to: Point3): boolean {
  for (const v of volumes) {
    const span = clipToConvex(v.polygon, from, to);
    if (!span || span[1] - span[0] < 1e-9) continue;
    const z0 = from.z + (to.z - from.z) * span[0], z1 = from.z + (to.z - from.z) * span[1];
    if (Math.min(z0, z1) < v.top - EPS && Math.max(z0, z1) > v.bottom + EPS) return true;
  }
  return false;
}

/**
 * Does viewer `index` see the target past the solid boxes? The target's centre and four points a
 * quarter of its footprint in from the corners (as `tokenInSight`) must lie in `wallPoly`, the
 * viewer's walls-only polygon. From one of them a point 10 %, 50 % or 90 % up its body must be
 * visible from the eye without passing through a box. Boxes the viewer stands inside are ignored.
 */
export function raisedTokenSeen(sight: RaisedSight, index: number, wallPoly: Float32Array | undefined,
  target: Pick<TokenDocument, "x" | "y" | "width" | "height" | "elevation">, grid: Pick<SceneDocument["grid"], "size" | "distance">): boolean {
  const eye = sight.eyes[index];
  if (!eye || !wallPoly || wallPoly.length < 6) return false;
  const boxes = sight.volumes.filter((v) => onFloor(v, eye) && !insideBelowTop(v, eye));
  const dx = Math.max(0, target.width) / 4, dy = Math.max(0, target.height) / 4;
  const probes: ReadonlyArray<readonly [number, number]> = [
    [target.x, target.y], [target.x - dx, target.y - dy], [target.x + dx, target.y - dy], [target.x - dx, target.y + dy], [target.x + dx, target.y + dy],
  ];
  const feet = target.elevation ?? 0, body = raisedBodyHeight(target, grid);
  for (const [px, py] of probes) {
    if (!pointInPolygon(wallPoly, px, py)) continue;
    if (!boxes.length) return true;
    for (const f of [0.1, 0.5, 0.9]) if (!raisedBlocks(boxes, eye, { x: px, y: py, z: feet + body * f })) return true;
  }
  return false;
}

/**
 * The sides of every solid raised area as kernel barriers (host cross-floor sight, G-20): they
 * block sight from their floor up to their top, and nothing else.
 */
export function raisedBarriers(scene: Pick<SceneDocument, "regions" | "levels">): SpatialBarrier[] {
  if (!hasSolidRaisedAreas(scene) || !scene.levels?.length) return [];
  const out: SpatialBarrier[] = [];
  for (const v of raisedVolumes(scene)) {
    if (!v.solid || v.top <= v.bottom + EPS) continue;
    v.polygon.forEach((a, i) => {
      const b = v.polygon[(i + 1) % v.polygon.length] as { x: number; y: number };
      if (Math.hypot(b.x - a.x, b.y - a.y) < 0.01) return;
      out.push({ id: `raised:${v.id}:${i}`, c: [a.x, a.y, b.x, b.y], zSpan: { bottom: v.bottom, top: v.top },
        restrictions: { move: 2, sight: 0, light: 2, sound: 2 }, door: 0, direction: "both" });
    });
  }
  return out;
}
