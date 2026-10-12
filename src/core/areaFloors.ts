/**
 * G-27 (D-447): area effects on isolated floors.
 *
 * An area happens on its caster's floor. Tokens on that floor count as they always did: the
 * area's cells decide. A token on another floor counts only when the area reaches it through an
 * opening (D-444). Radius areas (bursts, spreads, emanations, circles, cylinders) are spheres
 * around their origin, which hangs one grid distance above the caster's floor (where that
 * floor's lights hang, G-20). Part of the token's body must be within the radius with a clear
 * line of effect: floor planes and that floor's walls stop it, as they stop sight. Lines and
 * cones stay on the caster's floor. Floorless tokens never count on a floor.
 *
 * Scenes without isolated floor play change nothing: draft levels have no physics.
 */
import type { SceneDocument, TokenDocument, WallDocument } from "./documents";
import { capToBand, floorBarriers, perceptionBody } from "./crossFloorSight";
import { floorSurfaces } from "./floorSurface";
import { SpatialKernel } from "./spatial/kernel";
import { bodySamples } from "./spatial/perception";

export interface FloorAreaSpec {
  /** The area's point of origin, in scene pixels. */
  origin: { x: number; y: number };
  /** Radius in scene distance units (feet) for radius areas; absent for lines and cones. */
  radius?: number;
}

/** The caster's floor when floor play is on and the caster stands on a floor, else null. */
export function areaFloorOf(scene: Pick<SceneDocument, "levelMode" | "levels">, caster: Pick<TokenDocument, "levelId"> | undefined): string | null {
  return scene.levelMode === "isolated" && caster?.levelId && scene.levels?.some((l) => l._id === caster.levelId) ? caster.levelId : null;
}

/** The walls that exist on a floor in floor play: scoped to it or to every floor. */
export function wallsOnFloor(walls: readonly WallDocument[], levelId: string): WallDocument[] {
  return walls.filter((w) => w.levelScope?.mode === "all" || (w.levelScope?.mode === "levels" && w.levelScope.ids.includes(levelId)));
}

/**
 * Which tokens an area cast by `caster` may affect, by floor. The area's own cells (and its
 * line of effect on the caster's floor) still decide; this only adds the floor rule.
 */
export function areaFloorReach(scene: SceneDocument, caster: Pick<TokenDocument, "levelId"> | undefined, area: FloorAreaSpec): (token: TokenDocument) => boolean {
  const levelId = areaFloorOf(scene, caster);
  const level = levelId ? scene.levels?.find((l) => l._id === levelId) : undefined;
  if (!level) return () => true;
  const distance = scene.grid.distance > 0 ? scene.grid.distance : 5;
  const perUnit = (scene.grid.size > 0 ? scene.grid.size : 100) / distance;
  const radius = area.radius !== undefined && Number.isFinite(area.radius) && area.radius > 0 ? area.radius : null;
  const origin = { x: area.origin.x, y: area.origin.y,
    z: level.top === null ? level.floorZ + distance : Math.min(level.floorZ + distance, (level.floorZ + level.top) / 2) };
  const levels = new Map((scene.levels ?? []).map((l) => [l._id, l] as const));
  let kernel: SpatialKernel | null | undefined;
  return (token) => {
    if (token.levelId === level._id) return true;
    const own = token.levelId === undefined ? undefined : levels.get(token.levelId);
    if (radius === null || !own || !Number.isFinite(origin.x) || !Number.isFinite(origin.y)) return false;
    if (kernel === undefined) {
      try { kernel = new SpatialKernel(floorBarriers(scene), floorSurfaces(scene)); } catch { kernel = null; }
    }
    if (!kernel) return false; // fails closed
    const k = kernel;
    try {
      return bodySamples(capToBand(perceptionBody(token, scene.grid), own)).some((p) =>
        Math.hypot((p.x - origin.x) / perUnit, (p.y - origin.y) / perUnit, p.z - origin.z) <= radius + 1e-9 && k.ray(origin, p, "sight").length === 0);
    } catch {
      return false;
    }
  };
}
