/**
 * P5/C01 (D-154) — the PF1e area preview model: the single seam that turns an
 * area spec + the active scene into a canvas draw list.
 *
 * Composes D-148's pure targeting (`pf1eAreaGridFromScene` →
 * `resolveAreaCells`) with the draw list (`areaPreviewRects`) and the
 * affected-token read (`affectedTokens`), so the canvas overlay, any future
 * casting UI and the e2e surfaces all consume ONE composition instead of
 * re-wiring the chain per consumer.
 *
 * Diceless and Pixi-free like the rest of the package: walls arrive as
 * caller-supplied line-of-effect `segments` (the canvas side owns
 * `sightSegments`), and the model is safe to compute on every refresh.
 */
import type { Segment } from "../../canvas/vision/polygon";
import type { PF1eAreaIssue, PF1eAreaSpec } from "./targeting";
import {
  affectedTokens,
  areaPreviewRects,
  describeArea,
  pf1eAreaGridFromScene,
  resolveAreaCells,
} from "./targeting";

/** A token's replicated footprint facts (centre + world size). */
export interface PF1eAreaPreviewToken {
  _id: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

/** World-space square for one affected cell — the fill/stroke draw list. */
export interface PF1eAreaPreviewRect {
  x: number;
  y: number;
  size: number;
}

/** World-space rect of an affected token — the highlight draw list. */
export interface PF1eAreaPreviewHighlight {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface PF1eAreaPreviewModel {
  /** True when the area resolved cleanly (empty issues, rects usable). */
  ok: boolean;
  /** Named problems — bad scene grid, refused shape, LoE to origin, caps. */
  issues: readonly PF1eAreaIssue[];
  /** Number of affected cells (`rects.length`; 0 on any issue). */
  cells: number;
  rects: readonly PF1eAreaPreviewRect[];
  affectedTokenIds: readonly string[];
  highlightRects: readonly PF1eAreaPreviewHighlight[];
  /** Human label for UI ("20-ft. radius burst"). */
  label: string;
}

export interface PF1eAreaPreviewInput {
  /** Scene grid facts (`SceneGrid` shape: size/distance/units). */
  grid: { size: number; distance: number; units: string };
  tokens: readonly PF1eAreaPreviewToken[];
  /** Solid barriers for line-of-effect (canvas owns WallDocument → segments). */
  segments: readonly Segment[];
}

const empty = (
  issues: readonly PF1eAreaIssue[],
  label: string,
): PF1eAreaPreviewModel => ({
  ok: false,
  issues,
  cells: 0,
  rects: [],
  affectedTokenIds: [],
  highlightRects: [],
  label,
});

/**
 * Resolve an area spec against a scene into the preview model. Every refusal
 * is a named issue, never an exception and never a guessed conversion: a
 * metric scene or a refused shape yields `ok: false` with empty draw lists.
 */
export function pf1eAreaPreviewModel(
  input: PF1eAreaPreviewInput,
  spec: PF1eAreaSpec,
): PF1eAreaPreviewModel {
  const label = describeArea(spec);
  const { grid, issues } = pf1eAreaGridFromScene(input.grid);
  if (issues.length > 0) return empty(issues, label);
  const res = resolveAreaCells(spec, grid, { segments: input.segments });
  if (res.issues.length > 0) return empty(res.issues, label);
  const affected = affectedTokens(res.cells, input.tokens, grid);
  return {
    ok: true,
    issues: [],
    cells: res.cells.length,
    rects: areaPreviewRects(res.cells, grid),
    affectedTokenIds: affected.map((t) => t._id),
    highlightRects: affected.map((t) => ({
      x: t.x - Math.max(0, t.width) / 2,
      y: t.y - Math.max(0, t.height) / 2,
      width: Math.max(0, t.width),
      height: Math.max(0, t.height),
    })),
    label,
  };
}
