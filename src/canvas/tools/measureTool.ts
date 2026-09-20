import { measurePath, type MeasureGrid } from "../grid/measure";
import type { Point } from "./drawing";

export interface RadiusMeasure { origin: Point; radiusWorld: number; radiusPx: number }

export function measureRulerPath(grid: MeasureGrid | null, points: readonly Point[]): number {
  return points.length < 2 ? 0 : measurePath(grid, points);
}

export function radiusMeasure(grid: MeasureGrid | null, origin: Point, edge: Point): RadiusMeasure {
  const radiusPx = Math.hypot(edge.x - origin.x, edge.y - origin.y);
  return { origin: { ...origin }, radiusWorld: measurePath(grid, [origin, edge]), radiusPx };
}
