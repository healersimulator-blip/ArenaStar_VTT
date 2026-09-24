/**
 * UI-only point picking for the FX wizard. Picking answers an **authored anchor**,
 * not a playback: the point lands in the unsaved draft, and the host still
 * validates the whole sequence (bounds, media, audience) before any cue leaves
 * the tab. There is deliberately no wire message here — a preview of a draft is a
 * GM-local render, so it can neither create an instance nor grant a player a read.
 *
 * The geometry is pure so it can be unit-tested without a canvas: snapping reuses
 * the token-centre rule (`snapTokenCenter`), because an FX anchored "on a cell"
 * should land where a token on that cell would.
 */
import { snapTokenCenter, type GridSpec } from "../../canvas/grid";
import type { SceneGrid } from "../../core/documents";

export interface AnchorPickOptions {
  sceneId: string;
  /** Overlay heading, e.g. "the start point" — the wizard names the anchor it wants. */
  label?: string;
  /** The chosen scene's own bounds: an anchor outside them fails host validation. */
  bounds: { width: number; height: number };
}
export type AnchorPickPoint = { x: number; y: number };
/** Cancelled picking resolves `null` and leaves the draft exactly as it was. */
export type AnchorPickResult = AnchorPickPoint | null;
export type RequestAnchorPick = (options: AnchorPickOptions) => Promise<AnchorPickResult>;

/** Scene grid → the pure snapping spec; gridless scenes never snap. */
export function anchorGridSpec(grid: SceneGrid): GridSpec {
  if (grid.type === "hex") return { type: "hex", size: grid.size, layout: grid.hexLayout };
  if (grid.type === "square") return { type: "square", size: grid.size };
  return { type: "gridless" };
}

/** Snap a picked world point to the cell/hex centre; gridless or malformed stays exact. */
export function snapAnchorPoint(
  point: AnchorPickPoint,
  grid: SceneGrid,
  snap: boolean,
): AnchorPickPoint {
  if (!snap || grid.type === "gridless" || !Number.isFinite(grid.size) || grid.size <= 0) return point;
  const snapped = snapTokenCenter(anchorGridSpec(grid), point.x, point.y);
  return { x: snapped.x, y: snapped.y };
}

/**
 * Why this point cannot be committed, or `null`. This mirrors the host's own
 * `resolveFxSequence` bounds check, so the overlay refuses exactly what the run
 * would refuse — a red preview instead of a save that fails later.
 */
export function anchorPickError(
  point: AnchorPickPoint,
  bounds: { width: number; height: number },
): string | null {
  if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) return "Not a finite point";
  if (point.x < 0 || point.y < 0 || point.x > bounds.width || point.y > bounds.height)
    return "Outside the scene";
  return null;
}
