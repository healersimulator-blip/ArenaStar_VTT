/**
 * §9 visibility polygon — angular sweep, O(n log n) sort + sweep with an
 * incrementally maintained active set. Pure module: used directly by tests,
 * by the Lighting/Fog layers, and inside vision.worker.ts.
 *
 * Algorithm: collect segment endpoint angles from the origin, sort them,
 * sweep a ray counter-clockwise; at each event angle the active set (segments
 * whose angular span contains the ray) is updated (insert at span start,
 * remove at span end), and the polygon vertex is the nearest intersection of
 * the ray (angled ε past the event) with any active segment — or the ray
 * capped at `radius` when nothing blocks. One-way walls are included by the
 * caller (see wallSight.ts); here segments are opaque lines.
 */

export interface Segment {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

const EPS = 1e-9;

/** Angularly normalized [0, 2π) direction from origin to a point. */
function angleTo(ox: number, oy: number, px: number, py: number): number {
  let a = Math.atan2(py - oy, px - ox);
  if (a < 0) a += Math.PI * 2;
  return a;
}

/** Ray (origin, angle) ↔ segment intersection distance, or -1. */
function raySegment(ox: number, oy: number, dx: number, dy: number, s: Segment): number {
  const sx = s.x2 - s.x1;
  const sy = s.y2 - s.y1;
  const denom = dx * sy - dy * sx;
  if (Math.abs(denom) < EPS) return -1; // parallel
  const t = ((s.x1 - ox) * sy - (s.y1 - oy) * sx) / denom; // along the ray
  if (t < -EPS) return -1;
  const u = ((s.x1 - ox) * dy - (s.y1 - oy) * dx) / denom; // along the segment
  // ±1 ulp tolerance: rays aimed exactly at an endpoint must still hit
  if (u < -1e-9 || u > 1 + 1e-9) return -1;
  return Math.max(0, t);
}

interface SweepEvent {
  angle: number;
  /** +1 = segment span starts, -1 = span ends (at angle + ε removal). */
  delta: number;
  seg: Segment;
}

/**
 * Angular span of a segment as seen from the origin. When the CCW span
 * between the endpoints exceeds π the complementary (CW) span is used, so a
 * segment "behind" its own endpoints still blocks the rays it faces.
 */
function spanEvents(ox: number, oy: number, s: Segment): Array<[Segment, number, number]> {
  const a1 = angleTo(ox, oy, s.x1, s.y1);
  const a2 = angleTo(ox, oy, s.x2, s.y2);
  let ccw = a2 - a1;
  if (ccw < 0) ccw += Math.PI * 2;
  if (ccw > Math.PI) {
    const cw = Math.PI * 2 - ccw; // span from a2 back to a1
    return [[s, a2, cw]];
  }
  return [[s, a1, ccw]];
}

/**
 * Visibility polygon around (ox, oy): output vertices in counter-clockwise
 * order, flat [x0, y0, x1, y1, …]. `radius` caps sight (null = unbounded;
 * callers should always cap for a finite scene).
 */
export function visibilityPolygon(
  ox: number,
  oy: number,
  segments: readonly Segment[],
  radius: number | null,
): Float32Array {
  const r = radius ?? Number.POSITIVE_INFINITY;
  const events: SweepEvent[] = [];
  /** Segments whose span crosses angle 0: active at the sweep start. */
  const wrapped = new Set<Segment>();
  for (const seg of segments) {
    // skip degenerate segments
    if (Math.abs(seg.x2 - seg.x1) < EPS && Math.abs(seg.y2 - seg.y1) < EPS) continue;
    for (const [s, start, span] of spanEvents(ox, oy, seg)) {
      const end = start + span;
      if (end >= Math.PI * 2) {
        // wraps past 2π: active from the sweep start until `end − 2π`,
        // then again from `start` — pre-seeded here, removed at its end event
        wrapped.add(s);
        events.push({ angle: end - Math.PI * 2, delta: -1, seg: s });
        events.push({ angle: start, delta: 1, seg: s });
      } else {
        events.push({ angle: start, delta: 1, seg: s });
        events.push({ angle: end, delta: -1, seg: s });
      }
    }
  }
  // at equal angles process STARTS before ENDS: a wall ending exactly where
  // another begins must hand over the ray without an empty active-set gap
  events.sort((a, b) => a.angle - b.angle || b.delta - a.delta);

  const active = new Set<Segment>(wrapped);
  const out: number[] = [];
  const castAt = (angle: number): void => {
    const dx = Math.cos(angle);
    const dy = Math.sin(angle);
    let best = r;
    for (const s of active) {
      const t = raySegment(ox, oy, dx, dy, s);
      if (t >= 0 && t < best) best = t;
    }
    out.push(ox + dx * best, oy + dy * best);
  };

  // angular step for arc sampling (radius-capped arcs become 64-gon edges)
  const STEP = (Math.PI * 2) / 64;
  const castArc = (from: number, to: number): void => {
    const span = to - from;
    if (span <= EPS) return;
    const steps = Math.max(1, Math.ceil(span / STEP));
    for (let i = 0; i <= steps; i++) castAt(from + (span * i) / steps);
  };

  if (events.length === 0) {
    castArc(0, Math.PI * 2);
    return new Float32Array(out);
  }

  // process events in order; the stable arc BEFORE each event is sampled so
  // radius-capped regions become proper arc polygons
  let prev = events[0]?.angle ?? 0;
  for (const ev of events) {
    const gap = ev.angle - prev;
    if (gap > EPS) castArc(prev, ev.angle);
    if (ev.delta > 0) active.add(ev.seg);
    else active.delete(ev.seg);
    castAt(ev.angle + EPS);
    prev = ev.angle;
  }
  // wrap-around arc back to the first event
  const first = events[0]?.angle ?? 0;
  castArc(prev, Math.PI * 2 + first);
  return new Float32Array(out);
}

/** Winding-agnostic point-in-polygon over a flat [x,y,…] polygon. */
export function pointInPolygon(poly: Float32Array, x: number, y: number): boolean {
  let inside = false;
  const n = poly.length / 2;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = poly[i * 2] ?? 0;
    const yi = poly[i * 2 + 1] ?? 0;
    const xj = poly[j * 2] ?? 0;
    const yj = poly[j * 2 + 1] ?? 0;
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Axis-aligned bounds of a flat polygon (min/max per axis). */
export function polygonBounds(poly: Float32Array): {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
} {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let i = 0; i < poly.length; i += 2) {
    const x = poly[i] ?? 0;
    const y = poly[i + 1] ?? 0;
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  return { minX, minY, maxX, maxY };
}
