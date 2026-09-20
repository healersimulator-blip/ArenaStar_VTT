/**
 * §10 measure/placement snapping (pure). Roll20's Measure tool offers three snapping
 * modes — Snap to Center (`Q` then `1`), Snap to Corner (`Q` then `2`) and No Snapping
 * (`Q` then `3`) — and the same modes govern where walls and lights land.
 *
 * The geometry itself lives in `./index` (`snapPoint` = nearest intersection,
 * `snapTokenCenter` = nearest cell centre); this module is the mode switch both the tool
 * controller and the shells read, so a mode change is a one-line test.
 */
import type { MeasureGrid } from "./measure";
import { snapPoint, snapTokenCenter, type GridSpec } from "./index";

export type SnapMode = "none" | "centre" | "corner";

export const SNAP_MODES: readonly SnapMode[] = ["none", "centre", "corner"];

/** Human label for the rail (Roll20 wording). */
export function snapModeLabel(mode: SnapMode): string {
  switch (mode) {
    case "centre":
      return "Snap to center";
    case "corner":
      return "Snap to corner";
    case "none":
      return "No snapping";
  }
}

/** MeasureGrid → the GridSpec the snapping helpers take (null = gridless). */
function specOf(grid: MeasureGrid | null): GridSpec | null {
  if (!grid || grid.type === "gridless" || grid.size <= 0) return null;
  if (grid.type === "hex") return { type: "hex", size: grid.size, layout: grid.layout ?? "oddR" };
  return { type: "square", size: grid.size };
}

/** Snap one world point under the scene grid and the chosen mode. */
export function snapWorldWith(
  grid: MeasureGrid | null,
  point: { x: number; y: number },
  mode: SnapMode,
): { x: number; y: number } {
  if (mode === "none") return { ...point };
  const spec = specOf(grid);
  if (!spec) return { ...point };
  return mode === "centre"
    ? snapTokenCenter(spec, point.x, point.y)
    : snapPoint(spec, point.x, point.y);
}

/** Snap a whole path (a measurement, a polygon brush, a wall's endpoints). */
export function snapPathWith(
  grid: MeasureGrid | null,
  points: ReadonlyArray<{ x: number; y: number }>,
  mode: SnapMode,
): Array<{ x: number; y: number }> {
  return points.map((p) => snapWorldWith(grid, p, mode));
}
