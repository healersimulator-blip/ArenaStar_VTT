/** Observer-dependent LOS rules for windows and physically open doors. */
import type { LevelDocument, SceneDocument, WallDocument } from "../../core/documents";
import {
  openingSightOverrideOf,
  openingSightPolicyOf,
  type OpeningSightCurve,
  type SceneOpeningSightPolicy,
} from "../../core/openingSightPolicy";
import type { ProximityOpeningSegment, Segment } from "./polygon";
import { wallKindOf } from "./wallKinds";
import { sightBlocked } from "./wallSight";

export interface SceneSightGeometry {
  /** Physical sight blockers remain opaque at every distance and through every policy. */
  blockers: Segment[];
  /** Transparent opening segments whose LOS is observer-dependent. */
  proximityOpenings: ProximityOpeningSegment[];
}

export function pixelsPerSceneUnit(scene: Pick<SceneDocument, "grid">): number {
  const size = Number.isFinite(scene.grid?.size) && scene.grid.size > 0 ? scene.grid.size : 100;
  const distance = Number.isFinite(scene.grid?.distance) && scene.grid.distance > 0 ? scene.grid.distance : 5;
  return size / distance;
}

/**
 * The effective proximity curve for a window or door. A physically blocked wall/door is never
 * converted into an opening. An explicit local Full LOS override intentionally bypasses the
 * scene category switch; Custom does likewise with its own curve.
 */
export function wallOpeningSightCurve(
  policy: SceneOpeningSightPolicy,
  wall: WallDocument,
): OpeningSightCurve | null {
  if (sightBlocked(wall)) return null;
  const kind = wallKindOf(wall);
  if (kind !== "window" && kind !== "door") return null;

  const override = openingSightOverrideOf(wall.openingSightOverride);
  if (override?.mode === "full") return null;
  if (override?.mode === "custom") return override.curve;

  if (!policy.enabled || !policy.applyTo[kind === "window" ? "windows" : "doors"])
    return null;
  return {
    partialAt: policy.partialAt,
    partial: { ...policy.partial },
    fullAt: policy.fullAt,
    full: { ...policy.full },
  };
}

/** Effective policy for one actual hole in a traced floor surface. Its rim/solid floor stay solid. */
export function apertureOpeningSightCurve(
  policy: SceneOpeningSightPolicy,
  level: Pick<LevelDocument, "apertureSightOverrides">,
  apertureId: string,
): OpeningSightCurve | null {
  const override = openingSightOverrideOf(level.apertureSightOverrides?.[apertureId]);
  if (override?.mode === "full") return null;
  if (override?.mode === "custom") return override.curve;
  if (!policy.enabled || !policy.applyTo.apertures) return null;
  return {
    partialAt: policy.partialAt,
    partial: { ...policy.partial },
    fullAt: policy.fullAt,
    full: { ...policy.full },
  };
}

/** Build static blockers and scene/local-policy openings from the same wall documents. */
export function sceneSightGeometry(scene: SceneDocument): SceneSightGeometry {
  const blockers: Segment[] = [];
  const proximityOpenings: ProximityOpeningSegment[] = [];
  const policy = openingSightPolicyOf(scene);
  const pixelsPerUnit = pixelsPerSceneUnit(scene);
  for (const wall of scene.walls ?? []) {
    const [x1, y1, x2, y2] = wall.c;
    const segment = { x1, y1, x2, y2 };
    if (sightBlocked(wall)) {
      blockers.push(segment);
      continue;
    }
    const curve = wallOpeningSightCurve(policy, wall);
    if (curve) proximityOpenings.push({ segment, curve, pixelsPerUnit, wallId: wall._id });
  }
  return { blockers, proximityOpenings };
}
