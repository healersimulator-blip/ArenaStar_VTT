/** Native, renderer-independent 2.5D queries. Not yet the live scene authority path.
 * XY is pixels; Z is scene distance units. No conversion is needed for intersection times.
 * Inputs are compiled once into a detached snapshot. Queries throw on invalid geometry rather
 * than treating invalid input as clear. Level membership is deliberately NOT a collision filter.
 */
import type { WallDocument } from "../documents";
import { elevationBandError, regionShapeV2Error, shapeContains, transformShape,
  type ElevationBand, type RegionShapeV2 } from "../multilevelGeometry";

export type SpatialAxis = "move" | "sight" | "light" | "sound";
export interface Point3 { x: number; y: number; z: number }
export interface SpatialBarrier {
  id: string;
  c: [number, number, number, number];
  zSpan: ElevationBand;
  restrictions: Record<SpatialAxis, 0 | 1 | 2>;
  door: 0 | 1 | 2;
  /** Positive = increasing cross(B-A, point-A). Tangential contact is conservative. */
  direction: "both" | "positiveCross" | "negativeCross";
}
export interface SpatialSurface {
  id: string;
  footprint: RegionShapeV2;
  transform: { x: number; y: number; width: number; height: number; rotation: number };
  planes: Array<{ z: number; blocks: SpatialAxis[]; supportsMovement: boolean }>;
}
export interface BodySweep {
  from: Point3; to: Point3;
  /** Fixed-orientation rectangular footprint in pixels; bodyHeight is in scene distance units. */
  width: number; depth: number; bodyHeight: number;
  rotation?: number; // degrees, constant throughout this translation
}
export interface SpatialHit { kind: "wall" | "surface"; id: string; plane: number | null; t: number }
interface Interval { lo: number; hi: number; loOpen: boolean; hiOpen: boolean }
const axes: SpatialAxis[] = ["move", "sight", "light", "sound"];
const bounded = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n) && Math.abs(n) <= 1_000_000;
const positive = (n: unknown): n is number => bounded(n) && n >= .001;
const XY_EPS = 1e-7;
const full = (): Interval => ({ lo: 0, hi: 1, loOpen: false, hiOpen: false });
const nonempty = (i: Interval) => i.lo < i.hi || (i.lo === i.hi && !i.loOpen && !i.hiOpen);
function requirePoint(p: Point3): void {
  if (!p || ![p.x, p.y, p.z].every(bounded)) throw new Error("Spatial query requires bounded finite coordinates");
}
/** Restrict time to value(t) >= limit (or > for strict body clearance). */
function lower(i: Interval, start: number, velocity: number, limit: number, strict = false): boolean {
  if (velocity === 0) return strict ? start > limit : start >= limit;
  const t = (limit - start) / velocity;
  if (velocity > 0) {
    if (t > i.lo) { i.lo = t; i.loOpen = strict; }
    else if (t === i.lo) i.loOpen ||= strict;
  } else {
    if (t < i.hi) { i.hi = t; i.hiOpen = strict; }
    else if (t === i.hi) i.hiOpen ||= strict;
  }
  return nonempty(i);
}
/** Continuous separating-axis test: fixed oriented box translating against a finite segment. */
function segmentInterval(from: Point3, to: Point3, width: number, depth: number,
  c: readonly [number, number, number, number], range = full(), rotation = 0): Interval | null {
  const [x, y, u, v] = c, length = Math.hypot(u - x, v - y);
  const angle = rotation * Math.PI / 180, cos = Math.cos(angle), sin = Math.sin(angle);
  const normals = [[cos, sin], [-sin, cos], [-(v - y) / length, (u - x) / length]] as const;
  for (const [nx, ny] of normals) {
    const start = from.x * nx + from.y * ny, velocity = (to.x - from.x) * nx + (to.y - from.y) * ny;
    const radius = (width * Math.abs(nx * cos + ny * sin) + depth * Math.abs(-nx * sin + ny * cos)) / 2 + XY_EPS;
    const a = x * nx + y * ny, b = u * nx + v * ny;
    if (!lower(range, start, velocity, Math.min(a, b) - radius) ||
        !lower(range, -start, -velocity, -Math.max(a, b) - radius)) return null;
  }
  return range;
}
function enabled(w: SpatialBarrier, axis: SpatialAxis): boolean {
  return w.restrictions[axis] === 0 || (w.restrictions[axis] === 1 && w.door !== 1);
}
function directed(w: SpatialBarrier, a: Point3, b: Point3): boolean {
  const [x, y, u, v] = w.c;
  const delta = (u - x) * (b.y - a.y) - (v - y) * (b.x - a.x);
  return w.direction === "both" || (w.direction === "positiveCross" ? delta >= 0 : delta <= 0);
}
function wallInterval(w: SpatialBarrier, a: Point3, b: Point3, width: number, depth: number, height: number, rotation = 0): Interval | null {
  if (!directed(w, a, b)) return null;
  const i = full(), dz = b.z - a.z;
  // Body interior must overlap the barrier band; standing exactly above/below is allowed.
  // Point rays instead use the authored half-open band [bottom, top).
  if (w.zSpan.bottom !== null && !lower(i, a.z + height, dz, w.zSpan.bottom, height > 0)) return null;
  if (w.zSpan.top !== null && !lower(i, -a.z, -dz, -w.zSpan.top, true)) return null;
  return segmentInterval(a, b, width, depth, w.c, i, rotation);
}
const at = (a: Point3, b: Point3, t: number): Point3 => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, z: a.z + (b.z - a.z) * t });
function compare(a: SpatialHit, b: SpatialHit): number {
  return a.t - b.t || (a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0) ||
    (a.id < b.id ? -1 : a.id > b.id ? 1 : 0) || (a.plane ?? -1) - (b.plane ?? -1);
}
/** Preserve legacy codes and conservatively two-sided legacy oneWay semantics. */
export function legacySpatialBarrier(wall: WallDocument): SpatialBarrier {
  return { id: wall._id, c: [...wall.c], zSpan: { bottom: null, top: null },
    restrictions: { move: wall.move, sight: wall.sight, light: wall.light, sound: wall.sound }, door: wall.door, direction: "both" };
}

export class SpatialKernel {
  private readonly walls: SpatialBarrier[];
  private readonly surfaces: Array<{ id: string; shape: RegionShapeV2; planes: SpatialSurface["planes"] }>;
  constructor(walls: readonly SpatialBarrier[], surfaces: readonly SpatialSurface[]) {
    if (!Array.isArray(walls) || !Array.isArray(surfaces) || walls.length > 10_000 || surfaces.length > 128)
      throw new Error("Spatial budget is 10,000 walls / 128 surfaces");
    const sourceWalls: readonly SpatialBarrier[] = walls;
    const sourceSurfaces: readonly SpatialSurface[] = surfaces;
    const ids = new Set<string>();
    const identity = (kind: string, id: string) => {
      if (typeof id !== "string" || !id.length || id.length > 128 || ids.has(`${kind}:${id}`)) throw new Error("Invalid or duplicate spatial identity");
      ids.add(`${kind}:${id}`);
    };
    for (const w of sourceWalls) {
      if (!w) throw new Error("Missing barrier");
      identity("wall", w.id);
      if (!Array.isArray(w.c) || w.c.length !== 4 || !Array.from(w.c).every(bounded) || Math.hypot(w.c[2] - w.c[0], w.c[3] - w.c[1]) < .01 ||
          elevationBandError(w.zSpan) || ![0, 1, 2].includes(w.door) ||
          !["both", "positiveCross", "negativeCross"].includes(w.direction) ||
          !w.restrictions || !axes.every((axis) => [0, 1, 2].includes(w.restrictions[axis]))) throw new Error("Invalid spatial barrier");
    }
    this.walls = structuredClone([...sourceWalls]);
    let vertices = 0;
    this.surfaces = Array.from(sourceSurfaces, (s) => {
      if (!s) throw new Error("Missing surface");
      identity("surface", s.id);
      const t = s.transform;
      if (regionShapeV2Error(s.footprint) || !t || ![t.x, t.y, t.rotation].every(bounded) || !positive(t.width) || !positive(t.height) ||
          !Array.isArray(s.planes) || !s.planes.length || s.planes.length > 8 ||
          !Array.from(s.planes).every((p) => p && bounded(p.z) && typeof p.supportsMovement === "boolean" && Array.isArray(p.blocks) &&
            p.blocks.length <= 4 && new Set(p.blocks).size === p.blocks.length && Array.from(p.blocks).every((axis) => axes.includes(axis)))) throw new Error("Invalid spatial surface");
      vertices += s.footprint.components.reduce((n, c) => n + c.outer.length + c.holes.reduce((m, h) => m + h.length, 0), 0);
      if (vertices > 4096) throw new Error("Spatial surface budget is 4096 vertices");
      const angle = t.rotation * Math.PI / 180, cos = Math.cos(angle), sin = Math.sin(angle);
      const shape = transformShape(s.footprint, (p) => {
        const x = (p.x - .5) * t.width, y = (p.y - .5) * t.height;
        return { x: t.x + t.width / 2 + x * cos - y * sin, y: t.y + t.height / 2 + x * sin + y * cos };
      });
      for (const component of shape.components) for (const ring of [component.outer, ...component.holes]) {
        ring.forEach((a, index) => {
          const b = ring[(index + 1) % ring.length];
          if (!b || ![a.x, a.y].every(bounded) || Math.hypot(a.x - b.x, a.y - b.y) <= XY_EPS)
            throw new Error("Surface transform exceeds coordinate bounds or collapses an edge");
        });
      }
      return { id: s.id, shape, planes: structuredClone(s.planes) };
    });
  }
  /** Sight/light/sound/move point rays. Surface endpoint contact blocks; coplanar rays do not cross.
   * Returns sorted contact times (infima for open bounds), not permission or disclosure decisions. */
  ray(from: Point3, to: Point3, axis: SpatialAxis): SpatialHit[] {
    requirePoint(from); requirePoint(to);
    if (!axes.includes(axis)) throw new Error("Unknown spatial axis");
    const hits: SpatialHit[] = [];
    for (const w of this.walls) {
      if (!enabled(w, axis)) continue;
      const i = wallInterval(w, from, to, 0, 0, 0);
      if (i) hits.push({ kind: "wall", id: w.id, plane: null, t: i.lo });
    }
    const dz = to.z - from.z;
    if (dz !== 0) for (const s of this.surfaces) s.planes.forEach((p, plane) => {
      if (!p.blocks.includes(axis)) return;
      const t = (p.z - from.z) / dz;
      if (t >= 0 && t <= 1 && shapeContains(s.shape, at(from, to, t))) hits.push({ kind: "surface", id: s.id, plane, t });
    });
    return hits.sort(compare);
  }
  /** Continuous, fixed-orientation rectangular body sweep, including head/feet clearance.
   * Surface rim contact is conservative, including simultaneous horizontal/vertical grazing.
   * This does not authorize flight, falling, stairs, changing rotation or movement without support. */
  sweep(body: BodySweep): SpatialHit[] {
    const { from, to, width, depth, bodyHeight, rotation = 0 } = body;
    requirePoint(from); requirePoint(to);
    if (![width, depth, bodyHeight].every(positive)) throw new Error("Body dimensions must be finite and at least 0.001");
    if (!bounded(rotation)) throw new Error("Body rotation must be finite and bounded");
    const angle = rotation * Math.PI / 180, cos = Math.cos(angle), sin = Math.sin(angle);
    const corners = [-1, 1].flatMap((sx) => [-1, 1].map((sy) => ({
      x: sx * width / 2 * cos - sy * depth / 2 * sin,
      y: sx * width / 2 * sin + sy * depth / 2 * cos,
    })));
    const hits: SpatialHit[] = [];
    for (const w of this.walls) {
      if (!enabled(w, "move")) continue;
      const i = wallInterval(w, from, to, width, depth, bodyHeight, rotation);
      if (i) hits.push({ kind: "wall", id: w.id, plane: null, t: i.lo });
    }
    for (const s of this.surfaces) s.planes.forEach((p, plane) => {
      if (!p.blocks.includes("move")) return;
      const i = full(), dz = to.z - from.z;
      if (!lower(i, from.z + bodyHeight, dz, p.z, true) || !lower(i, -from.z, -dz, -p.z, true)) return;
      const start = at(from, to, i.lo);
      let first = corners.some((c) => shapeContains(s.shape, { x: start.x + c.x, y: start.y + c.y })) ? i.lo : Infinity;
      for (const c of s.shape.components) for (const ring of [c.outer, ...c.holes]) ring.forEach((a, index) => {
        const b = ring[(index + 1) % ring.length];
        if (!b) return;
        const contact = segmentInterval(from, to, width, depth, [a.x, a.y, b.x, b.y], { ...i }, rotation);
        if (contact) first = Math.min(first, contact.lo);
      });
      if (Number.isFinite(first)) hits.push({ kind: "surface", id: s.id, plane, t: first });
    });
    return hits.sort(compare);
  }
  /** Highest authored support at/below a point. No implicit full-map floor, no gravity policy.
   * A center probe is NOT proof that an entire body is supported or allowed to move there. */
  supportBelow(point: Point3): { id: string; plane: number; z: number } | null {
    requirePoint(point);
    const candidates: Array<{ id: string; plane: number; z: number }> = [];
    for (const s of this.surfaces) {
      if (!shapeContains(s.shape, point)) continue;
      s.planes.forEach((p, plane) => { if (p.supportsMovement && p.z <= point.z) candidates.push({ id: s.id, plane, z: p.z }); });
    }
    candidates.sort((a, b) => b.z - a.z || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0) || a.plane - b.plane);
    return candidates[0] ?? null;
  }
}
