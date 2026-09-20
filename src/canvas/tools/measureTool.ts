/**
 * §10 measure tool geometry. Roll20's Measure tool draws not just a ruler but area-of-effect
 * shapes (circle / cone / ray, added in the 2023 "new measure tool" and part of the 2024
 * redesign). Those shapes are the *same* geometry the templates layer already renders, so the
 * preview and a committed `TemplateDocument` can never disagree.
 *
 * Angle/width defaults are ours: a cone opens 53° (the 5e/PF "every other diagonal" cone),
 * a ray corridor is one grid cell wide — both overridable by the caller.
 */
import { measurePath, type MeasureGrid } from "../grid/measure";
import { templateShape, type TemplateShape } from "../layers/templateGeometry";
import type { TemplateDocument } from "../../core/documents";
import type { Point } from "./drawing";

export interface RadiusMeasure {
  origin: Point;
  radiusWorld: number;
  radiusPx: number;
}

/** Measure sub-shapes: a plain ruler plus the three AoE shapes. */
export type MeasureShape = "line" | "circle" | "cone" | "ray";

export const MEASURE_SHAPES: readonly MeasureShape[] = ["line", "circle", "cone", "ray"];

/** Cone aperture in degrees (Roll20's narrow-cone default). */
export const MEASURE_CONE_ANGLE_DEG = 53;

export function measureShapeLabel(shape: MeasureShape): string {
  switch (shape) {
    case "line":
      return "Line";
    case "circle":
      return "Circle (AoE)";
    case "cone":
      return "Cone (AoE)";
    case "ray":
      return "Ray (AoE)";
  }
}

export function measureRulerPath(grid: MeasureGrid | null, points: readonly Point[]): number {
  return points.length < 2 ? 0 : measurePath(grid, points);
}

export function radiusMeasure(grid: MeasureGrid | null, origin: Point, edge: Point): RadiusMeasure {
  const radiusPx = Math.hypot(edge.x - origin.x, edge.y - origin.y);
  return { origin: { ...origin }, radiusWorld: measurePath(grid, [origin, edge]), radiusPx };
}

/** A `TemplateDocument`-shaped spec for one AoE measure, or null for the plain ruler. */
export function measureTemplate(
  shape: MeasureShape,
  origin: Point,
  edge: Point,
  cellSize: number,
): Pick<TemplateDocument, "kind" | "x" | "y" | "distance" | "direction" | "width"> | null {
  if (shape === "line") return null;
  const dx = edge.x - origin.x;
  const dy = edge.y - origin.y;
  const length = Math.hypot(dx, dy);
  const direction = Math.atan2(dy, dx);
  if (shape === "circle") {
    return { kind: "circle", x: origin.x, y: origin.y, distance: length, direction: 0, width: 0 };
  }
  if (shape === "cone") {
    return {
      kind: "cone",
      x: origin.x,
      y: origin.y,
      distance: length,
      direction,
      width: MEASURE_CONE_ANGLE_DEG,
    };
  }
  return {
    kind: "ray",
    x: origin.x,
    y: origin.y,
    distance: length,
    direction,
    width: Math.max(1, cellSize),
  };
}

/** The preview geometry (world coords) for an AoE measure — identical to `TemplatesLayer`. */
export function measureArea(
  shape: MeasureShape,
  grid: MeasureGrid | null,
  origin: Point,
  edge: Point,
): TemplateShape | null {
  const spec = measureTemplate(shape, origin, edge, grid?.size ?? 100);
  return spec ? templateShape(spec) : null;
}
