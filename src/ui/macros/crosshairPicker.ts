/**
 * SQ-10 — the UI contract for the shared crosshair.
 *
 * The crosshair's *rule* lives in `core/crosshair.ts` (pure, host-checkable);
 * this module is the wizard/window-facing shape of a request. A consumer states
 * what it is placing (`label`), which shapes are meaningful for it, the
 * constraints its own host check will enforce, and the placements it already
 * committed (so the author can reuse one by name instead of re-picking).
 *
 * The scene's bounds/grid/walls are attached by whoever owns the live scene
 * (`resolveCrosshairPick`), so a window never has to hold a scene document.
 */
import type { SceneDocument } from "../../core/documents";
import type {
  CrosshairPlacement, CrosshairPoint, CrosshairRequest, CrosshairShape, CrosshairShapeKind,
} from "../../core/crosshair";
import type { SummonPickOptions } from "./summonPicker";

/** A placement the author already committed and named in this session. */
export interface NamedPlacement {
  name: string;
  point: CrosshairPoint;
}

/**
 * How the author places: a click (`point`) or a drag from a start to an end
 * (`drag`, SQ-12's second mode). A drag placement carries both ends, so one gesture
 * can fill an FX section's start *and* destination.
 */
export type CrosshairGesture = "click" | "drag";

export interface CrosshairPickOptions {
  sceneId: string;
  /** Click (default) or drag source → target. */
  gesture?: CrosshairGesture;
  /** What the author is placing, e.g. "the destination point". */
  label?: string;
  /** Shapes the author may switch between; `point` is always offered. */
  shapes?: readonly CrosshairShapeKind[];
  /** Starting shape and extent. */
  shape?: CrosshairShape;
  /**
   * The rules the consumer's host check will repeat. Shown faults come from
   * here, so a green preview is exactly what a save will accept.
   */
  constraints?: Pick<CrosshairRequest, "origin" | "minDistance" | "maxDistance"
    | "requireLoS" | "requireClearPath" | "footprint">;
  /** Previously committed placements, offered for reuse by name. */
  named?: readonly NamedPlacement[];
  /** One line about who re-checks the placement once the author commits. */
  hint?: string;
}

export interface ResolvedCrosshairPick {
  options: CrosshairPickOptions;
  request: CrosshairRequest;
}

export type RequestCrosshairPick = (options: CrosshairPickOptions) => Promise<CrosshairPlacement | null>;

/** Attach the live scene's geometry to a request — the only place a scene is read. */
export function resolveCrosshairPick(scene: SceneDocument, options: CrosshairPickOptions): ResolvedCrosshairPick {
  return { options, request: {
    sceneId: options.sceneId,
    bounds: { width: scene.width, height: scene.height },
    grid: scene.grid,
    walls: scene.walls ?? [],
    ...options.constraints,
  } };
}

/**
 * The summon window's request: a summon's range and line of sight are the
 * *host's* rules (`summonPlacementError`), so the crosshair previews exactly
 * them — including the footprint inset that keeps a large creature inside the
 * map. A GM placing without a caster keeps the exemption the host grants
 * (`gmManual`), so the preview does not invent a range it will not enforce.
 */
export function summonCrosshairOptions(scene: SceneDocument, options: SummonPickOptions): CrosshairPickOptions {
  const caster = options.summonerTokenId
    ? scene.tokens.find((token) => token._id === options.summonerTokenId)
    : undefined;
  const enforced = options.gmManual !== true && caster !== undefined;
  const size = options.size ?? 1;
  return {
    sceneId: options.sceneId,
    label: "a summon point",
    shapes: ["point", "circle", "cone", "ray", "rect"],
    shape: { kind: "circle", length: size * scene.grid.distance },
    constraints: {
      footprint: size * scene.grid.distance,
      ...(enforced ? {
        origin: { x: caster.x, y: caster.y },
        maxDistance: options.maxDistance,
        requireLoS: options.requireLoS === true,
      } : {}),
    },
    // Summoning is a click placement: one point, checked on its own.
    gesture: "click",
    hint: options.gmManual
      ? "GM placement: range and line of sight are not enforced here."
      : "The host repeats the footprint, range and line-of-sight checks before anything is created.",
  };
}

/** Sensible starting extents per shape, in scene units, so switching a shape
 * never produces an invisible (zero-extent) area. */
export const CROSSHAIR_SHAPE_DEFAULTS: Record<Exclude<CrosshairShapeKind, "point">, CrosshairShape> = {
  circle: { kind: "circle", length: 5 },
  cone: { kind: "cone", length: 15, spread: 53.13 },
  ray: { kind: "ray", length: 30, width: 1 },
  rect: { kind: "rect", length: 5, width: 5 },
};

/** Switch to a shape, keeping an extent the author already typed. */
export function shapeWithExtent(kind: CrosshairShapeKind, current: CrosshairShape): CrosshairShape {
  if (kind === "point") return { kind: "point" };
  const fallback = CROSSHAIR_SHAPE_DEFAULTS[kind];
  const kept = current.kind !== "point" && Number.isFinite(current.length) && (current.length ?? 0) > 0
    ? current.length as number
    : undefined;
  const length = kept ?? fallback.length as number;
  const width = Number.isFinite(current.width) && (current.width ?? 0) > 0
    ? current.width as number
    : fallback.width;
  const spread = Number.isFinite(current.spread) && (current.spread ?? 0) > 0
    ? current.spread as number
    : fallback.spread;
  return { kind, length, ...(width !== undefined ? { width } : {}), ...(spread !== undefined ? { spread } : {}) };
}

/**
 * Record a committed placement for later reuse. Same name *and* same point is
 * one entry — committing the same thing twice must not grow the list, while a
 * moved placement keeps its name and replaces the old point.
 */
export function rememberPlacement(list: readonly NamedPlacement[],
  placement: Pick<CrosshairPlacement, "name" | "point">): NamedPlacement[] {
  const point = { x: placement.point.x, y: placement.point.y };
  return [...list.filter((entry) => entry.name !== placement.name), { name: placement.name, point }];
}
