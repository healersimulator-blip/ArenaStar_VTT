/**
 * §9 template geometry (pure) — cone/circle/ray/rect shapes derived from
 * TemplateDocument fields, with point hit-testing for interactions.
 *
 * Field semantics (recorded D-076):
 *   circle: distance = radius; width unused
 *   ray:    distance = length along `direction` (radians), width = corridor breadth
 *   cone:   distance = length, direction = bisector heading, width = aperture in DEGREES
 *   rect:   distance = length along `direction`, width = breadth (perpendicular)
 */
import type { TemplateDocument } from "../../core/documents";

export interface Pt {
  x: number;
  y: number;
}

export type TemplateShape =
  | { kind: "circle"; center: Pt; radius: number }
  | { kind: "polygon"; points: Pt[] } // cone (arc approximated), rect (4 corners), ray cap
  | { kind: "segment"; a: Pt; b: Pt; width: number }; // ray corridor (hit-test inflated)

/** Geometry of one template. */
export function templateShape(
  t: Pick<TemplateDocument, "kind" | "x" | "y" | "distance" | "direction" | "width">,
): TemplateShape {
  const origin: Pt = { x: t.x, y: t.y };
  switch (t.kind) {
    case "circle":
      return { kind: "circle", center: origin, radius: Math.max(0, t.distance) };
    case "ray": {
      const dx = Math.cos(t.direction);
      const dy = Math.sin(t.direction);
      return {
        kind: "segment",
        a: origin,
        b: { x: origin.x + dx * t.distance, y: origin.y + dy * t.distance },
        width: Math.max(0, t.width),
      };
    }
    case "cone": {
      const aperture = (Math.max(0, t.width) * Math.PI) / 180;
      const steps = Math.max(2, Math.ceil(aperture / (Math.PI / 12))); // ≤15° arc steps
      const points: Pt[] = [origin];
      for (let i = 0; i <= steps; i++) {
        const ang = t.direction - aperture / 2 + (aperture * i) / steps;
        points.push({
          x: origin.x + Math.cos(ang) * t.distance,
          y: origin.y + Math.sin(ang) * t.distance,
        });
      }
      return { kind: "polygon", points };
    }
    case "rect": {
      const dx = Math.cos(t.direction);
      const dy = Math.sin(t.direction);
      const px = -dy;
      const py = dx;
      const halfW = Math.max(0, t.width) / 2;
      return {
        kind: "polygon",
        points: [
          { x: origin.x + px * halfW, y: origin.y + py * halfW },
          {
            x: origin.x + dx * t.distance + px * halfW,
            y: origin.y + dy * t.distance + py * halfW,
          },
          {
            x: origin.x + dx * t.distance - px * halfW,
            y: origin.y + dy * t.distance - py * halfW,
          },
          { x: origin.x - px * halfW, y: origin.y - py * halfW },
        ],
      };
    }
  }
}

function pointInPoly(points: Pt[], x: number, y: number): boolean {
  let inside = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const a = points[j] as Pt;
    const b = points[i] as Pt;
    if (a.y > y !== b.y > y && x < ((b.x - a.x) * (y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

function distToSegment(p: Pt, a: Pt, b: Pt): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  if (len2 < 1e-12) return Math.hypot(p.x - a.x, p.y - a.y);
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2));
  return Math.hypot(p.x - (a.x + dx * t), p.y - (a.y + dy * t));
}

/** Hit-test a world point against a template (ray = corridor test). */
export function pointInTemplate(
  t: Pick<TemplateDocument, "kind" | "x" | "y" | "distance" | "direction" | "width">,
  x: number,
  y: number,
): boolean {
  const shape = templateShape(t);
  switch (shape.kind) {
    case "circle":
      return Math.hypot(x - shape.center.x, y - shape.center.y) <= shape.radius;
    case "polygon":
      return pointInPoly(shape.points, x, y);
    case "segment":
      return distToSegment({ x, y }, shape.a, shape.b) <= shape.width / 2;
  }
}
