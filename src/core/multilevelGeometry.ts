/** Native 2.5D geometry. No Foundry/module code or runtime dependencies. */
export type SpatialPoint = { x: number; y: number };
export interface RegionShapeV2 {
  version: 2;
  /** Union of components; each component subtracts only its own holes. */
  components: Array<{ outer: SpatialPoint[]; holes: SpatialPoint[][] }>;
}
export interface ElevationBand {
  bottom: number | null;
  top: number | null;
}
const EPS = 1e-9;
export const MAX_SHAPE_VERTICES = 512;

export function elevationBandError(value: unknown): string | null {
  if (!value || typeof value !== "object")
    return "elevation band must be an object";
  const { bottom, top } = value as ElevationBand;
  if (
    ![bottom, top].every(
      (z) => z === null || (Number.isFinite(z) && Math.abs(z) <= 1_000_000),
    )
  )
    return "elevation bounds must be finite scene units or null";
  if (bottom !== null && top !== null && bottom >= top)
    return "elevation band must have bottom < top";
  return null;
}
export function inElevationBand(band: ElevationBand, z: number): boolean {
  return (
    Number.isFinite(z) &&
    (band.bottom === null || z >= band.bottom) &&
    (band.top === null || z < band.top)
  );
}
export function levelAtElevation<T extends ElevationBand & { id: string }>(
  levels: readonly T[],
  z: number,
): string | null {
  if (!Number.isFinite(z)) throw new Error("Elevation must be finite");
  const matches = levels.filter((level) => inElevationBand(level, z));
  if (matches.length > 1) throw new Error("Overlapping level bands");
  return matches[0]?.id ?? null;
}
/** Accesses are bounded by ring validation/loop limits; reject sparse input explicitly. */
function at<T>(items: readonly T[], index: number): T {
  const value = items[index];
  if (value === undefined) throw new Error("Sparse geometry array");
  return value;
}
function cross(a: SpatialPoint, b: SpatialPoint, p: SpatialPoint): number {
  return (b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x);
}
function onSegment(a: SpatialPoint, b: SpatialPoint, p: SpatialPoint): boolean {
  return (
    Math.abs(cross(a, b, p)) <= EPS &&
    p.x >= Math.min(a.x, b.x) - EPS &&
    p.x <= Math.max(a.x, b.x) + EPS &&
    p.y >= Math.min(a.y, b.y) - EPS &&
    p.y <= Math.max(a.y, b.y) + EPS
  );
}
function intersects(
  a: SpatialPoint,
  b: SpatialPoint,
  c: SpatialPoint,
  d: SpatialPoint,
): boolean {
  const abC = cross(a, b, c),
    abD = cross(a, b, d),
    cdA = cross(c, d, a),
    cdB = cross(c, d, b);
  return (
    (abC * abD < 0 && cdA * cdB < 0) ||
    onSegment(a, b, c) ||
    onSegment(a, b, d) ||
    onSegment(c, d, a) ||
    onSegment(c, d, b)
  );
}
/** -1 outside, 0 boundary, 1 inside. Inputs are validated simple rings. */
export function classifyRing(
  ring: readonly SpatialPoint[],
  p: SpatialPoint,
): -1 | 0 | 1 {
  let inside = false;
  for (let i = 0; i < ring.length; i++) {
    const a = at(ring, i),
      b = at(ring, (i + 1) % ring.length);
    if (onSegment(a, b, p)) return 0;
    if (
      a.y > p.y !== b.y > p.y &&
      p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x
    )
      inside = !inside;
  }
  return inside ? 1 : -1;
}
function ringsIntersect(a: SpatialPoint[], b: SpatialPoint[]): boolean {
  return a.some((p, i) =>
    b.some((q, j) =>
      intersects(p, at(a, (i + 1) % a.length), q, at(b, (j + 1) % b.length)),
    ),
  );
}
function ringError(value: unknown): string | null {
  if (
    !Array.isArray(value) ||
    value.length < 3 ||
    value.length > MAX_SHAPE_VERTICES
  )
    return "ring needs 3–512 vertices";
  for (const p of value) {
    if (
      !p ||
      typeof p !== "object" ||
      ![p.x, p.y].every(
        (n) => typeof n === "number" && Number.isFinite(n) && n >= 0 && n <= 1,
      )
    )
      return "footprint vertices must be normalized finite points in [0,1]";
  }
  const ring = value as SpatialPoint[];
  for (let i = 0; i < ring.length; i++) {
    const a = at(ring, i),
      b = at(ring, (i + 1) % ring.length);
    if (Math.hypot(a.x - b.x, a.y - b.y) <= EPS)
      return "ring contains a zero-length edge";
  }
  let area = 0;
  for (let i = 0; i < ring.length; i++) {
    const a = at(ring, i),
      b = at(ring, (i + 1) % ring.length),
      c = at(ring, (i + 2) % ring.length);
    if (Math.hypot(a.x - b.x, a.y - b.y) <= EPS)
      return "ring contains a zero-length edge";
    if (
      Math.abs(cross(a, b, c)) <= EPS &&
      (b.x - a.x) * (c.x - b.x) + (b.y - a.y) * (c.y - b.y) < 0
    )
      return "ring contains overlapping edges";
    area += a.x * b.y - b.x * a.y;
    for (let j = i + 2; j < ring.length; j++) {
      if (i === 0 && j === ring.length - 1) continue;
      if (intersects(a, b, at(ring, j), at(ring, (j + 1) % ring.length)))
        return "ring self-intersects";
    }
  }
  return Math.abs(area) <= EPS ? "ring has zero area" : null;
}
/** Bounded normalized authoring geometry; winding is immaterial. No silent repairs. */
export function regionShapeV2Error(value: unknown): string | null {
  if (!value || typeof value !== "object")
    return "footprint must be a v2 shape";
  const shape = value as RegionShapeV2;
  if (
    shape.version !== 2 ||
    !Array.isArray(shape.components) ||
    shape.components.length < 1 ||
    shape.components.length > 16
  )
    return "footprint needs 1–16 components and version 2";
  let count = 0;
  // Bound total work before any quadratic ring predicates.
  for (const c of shape.components) {
    if (
      !c ||
      !Array.isArray(c.outer) ||
      !Array.isArray(c.holes) ||
      c.holes.length > 16 ||
      !c.holes.every(Array.isArray)
    )
      return "component needs an outer ring and at most 16 holes";
    count += c.outer.length + c.holes.reduce((n, h) => n + h.length, 0);
  }
  if (count > MAX_SHAPE_VERTICES) return "footprint exceeds 512 total vertices";
  for (const c of shape.components) {
    for (const ring of [c.outer, ...c.holes]) {
      const error = ringError(ring);
      if (error) return error;
    }
    for (let i = 0; i < c.holes.length; i++) {
      const hole = at(c.holes, i);
      if (
        classifyRing(c.outer, at(hole, 0)) !== 1 ||
        ringsIntersect(c.outer, hole)
      )
        return "holes must be strictly inside their outer ring";
      for (const other of c.holes.slice(i + 1)) {
        if (
          ringsIntersect(hole, other) ||
          classifyRing(hole, at(other, 0)) >= 0 ||
          classifyRing(other, at(hole, 0)) >= 0
        )
          return "holes must not overlap, nest or touch";
      }
    }
  }
  return null;
}
/** Solid includes boundaries, including the rim of a hole. */
export function shapeContains(
  shape: RegionShapeV2,
  point: SpatialPoint,
): boolean {
  return shape.components.some(
    (c) =>
      classifyRing(c.outer, point) >= 0 &&
      !c.holes.some((h) => classifyRing(h, point) === 1),
  );
}
export function transformShape(
  shape: RegionShapeV2,
  map: (p: SpatialPoint) => SpatialPoint,
): RegionShapeV2 {
  return {
    version: 2,
    components: shape.components.map((c) => ({
      outer: c.outer.map(map),
      holes: c.holes.map((h) => h.map(map)),
    })),
  };
}
/** Exact footprint overlap with an axis-aligned box (not sparse vertex sampling). */
export function shapeIntersectsRect(
  shape: RegionShapeV2,
  rect: { x: number; y: number; width: number; height: number },
): boolean {
  const corners = [
    { x: rect.x, y: rect.y },
    { x: rect.x + rect.width, y: rect.y },
    { x: rect.x + rect.width, y: rect.y + rect.height },
    { x: rect.x, y: rect.y + rect.height },
  ];
  if (corners.some((p) => shapeContains(shape, p))) return true;
  return shape.components.some((c) =>
    [c.outer, ...c.holes].some(
      (ring) =>
        ringsIntersect(ring, corners) ||
        ring.some(
          (p) =>
            p.x >= rect.x &&
            p.x <= rect.x + rect.width &&
            p.y >= rect.y &&
            p.y <= rect.y + rect.height,
        ),
    ),
  );
}
/** Plane query only; callers separately decide contact, channel restrictions and body sweeps. */
export function surfaceRayHit(
  shape: RegionShapeV2,
  planeZ: number,
  a: SpatialPoint & { z: number },
  b: SpatialPoint & { z: number },
): number | null {
  if (![planeZ, a.x, a.y, a.z, b.x, b.y, b.z].every(Number.isFinite))
    throw new Error("Ray must be finite");
  const dz = b.z - a.z;
  if (Math.abs(dz) <= EPS) return null; // coplanar support/contact is not a crossing
  const t = (planeZ - a.z) / dz;
  if (t <= 0 || t >= 1) return null;
  return shapeContains(shape, {
    x: a.x + t * (b.x - a.x),
    y: a.y + t * (b.y - a.y),
  })
    ? t
    : null;
}
