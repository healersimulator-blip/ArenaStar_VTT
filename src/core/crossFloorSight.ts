/**
 * G-20 (D-445): tokens on lower floors, seen through openings.
 *
 * A floor that sees floors below (G-19) shows their art. This module decides which of their
 * *tokens* a viewer actually sees. A token counts as seen when one of the viewer's own vision tokens
 * on this floor has a clear 3D sightline to it. That line must pass through openings in every
 * floor in between (G-21 surfaces), around those floors' walls, within sight range, onto a lit
 * spot or within darkvision. The host runs this; players never send geometry. Untraced floors
 * are solid everywhere, so nothing is seen through them.
 *
 * Bodies are a token's footprint. A creature is as tall as its size in cells times the grid
 * distance (one cell for a medium creature), with eyes at 90 %. Lights stand one grid distance
 * above their floor. The targets' floors, this floor and the floor above all light targets; the
 * floor planes pass light through openings only (G-22, D-446).
 */
import type { ActorDocument, LevelDocument, SceneDocument, TokenDocument } from "./documents";
import { maskHiddenTokenIds } from "./fogExploration";
import { floorSurfaces } from "./floorSurface";
import { floorAbove, visibleFloorsBelow } from "./levelPlay";
import type { PermissionUser } from "./ownership";
import { can } from "./permissions";
import { raisedBarriers } from "./raisedAreas";
import { SpatialKernel, legacySpatialBarrier, type SpatialBarrier } from "./spatial/kernel";
import { SpatialPerception, bodySamples, type PerceptionBody, type SpatialLight } from "./spatial/perception";

export interface TokenBelow { id: string; depth: number }
export const EYE_HEIGHT = 0.9;
const UNLIMITED = 1_000_000;

/** A token's perception body (scene units vertically, pixels across). */
export function perceptionBody(token: TokenDocument, grid: Pick<SceneDocument["grid"], "size" | "distance">): PerceptionBody {
  const size = grid.size > 0 ? grid.size : 100, distance = grid.distance > 0 ? grid.distance : 5;
  const height = Math.max(0.5, Math.max(token.width, token.height) / size) * distance;
  return {
    feet: { x: token.x, y: token.y, z: token.elevation ?? 0 }, width: Math.max(1, token.width), depth: Math.max(1, token.height),
    height, eyeHeight: height * EYE_HEIGHT, rotation: token.rotation ?? 0,
    sight: token.sight && token.sight > 0 ? token.sight : UNLIMITED, darkvision: token.darkvision && token.darkvision > 0 ? token.darkvision : 0,
  };
}

/** A body never reaches through its own ceiling: the next floor's plane caps it (eyes stay below). */
export function capToBand(body: PerceptionBody, level: Pick<LevelDocument, "top"> | undefined): PerceptionBody {
  if (!level || level.top === null) return body;
  const room = level.top - body.feet.z - 0.01;
  if (!(room > 0.001) || body.height <= room) return body;
  return { ...body, height: room, eyeHeight: room * EYE_HEIGHT };
}

/** Floor-scoped walls as kernel barriers, one per floor band. Unscoped walls do nothing in floor play. */
export function floorBarriers(scene: Pick<SceneDocument, "walls" | "levels">): SpatialBarrier[] {
  const levels = new Map((scene.levels ?? []).map((l) => [l._id, l] as const));
  return scene.walls.flatMap((wall) => {
    const scope = wall.levelScope;
    if (!scope) return [];
    const base = legacySpatialBarrier(wall);
    if (scope.mode === "all") return [base];
    return scope.ids.map((id) => levels.get(id)).filter((l): l is LevelDocument => !!l)
      .map((l) => ({ ...base, id: `${wall._id}@${l._id}`, zSpan: { bottom: l.bottom, top: l.top } }));
  });
}

/** The given floors' own lights, one grid distance above each floor (radii converted to scene units). */
export function floorLights(scene: Pick<SceneDocument, "lights" | "levels" | "grid">, levelIds: ReadonlySet<string>): SpatialLight[] {
  const perUnit = scene.grid.size / (scene.grid.distance > 0 ? scene.grid.distance : 5);
  const up = scene.grid.distance > 0 ? scene.grid.distance : 5;
  return (scene.levels ?? []).filter((l) => levelIds.has(l._id)).flatMap((level) => scene.lights
    .filter((light) => light.levelScope && (light.levelScope.mode === "all" || light.levelScope.ids.includes(level._id)) && light.dim > 0)
    .map((light) => {
      const z = level.top === null ? level.floorZ + up : Math.min(level.floorZ + up, (level.floorZ + level.top) / 2);
      return { id: `${light._id}@${level._id}`, at: { x: light.x, y: light.y, z }, bright: Math.max(0, light.bright) / perUnit, dim: Math.max(light.dim, light.bright, 0) / perUnit };
    }));
}

/**
 * Tokens on floors below `levelId` that `user`'s vision tokens on that floor see through its
 * openings, nearest floor first by depth. Fails closed: an over-budget or invalid snapshot sees nothing.
 */
export function tokensSeenBelow(scene: SceneDocument, actors: readonly ActorDocument[], user: PermissionUser, levelId: string,
  options: { rayBudget?: number } = {}): TokenBelow[] {
  const level = scene.levels?.find((l) => l._id === levelId);
  if (!level) return [];
  const below = new Map(visibleFloorsBelow(scene, level).map((f) => [f.level._id, f.depth] as const));
  if (!below.size) return [];
  const owns = (t: TokenDocument) => can(user, "update", t, "tokens", { parent: scene }) ||
    actors.some((a) => a._id === t.actorId && can(user, "update", a, "actors"));
  const observers = scene.tokens.filter((t) => t.levelId === levelId && t.vision && !t.hidden && owns(t)).slice(0, 8);
  if (!observers.length) return [];
  const masked = maskHiddenTokenIds(scene, user, { actors });
  const targets = scene.tokens.filter((t) => t.levelId !== undefined && below.has(t.levelId) && !t.hidden && !masked.has(t._id) &&
    can(user, "read", t, "tokens", { parent: scene }));
  if (!targets.length) return [];
  try {
    // D-453: solid raised areas hide what is behind them, up to their tops.
    const kernel = new SpatialKernel([...floorBarriers(scene), ...raisedBarriers(scene)], floorSurfaces(scene));
    const perUnit = scene.grid.size / (scene.grid.distance > 0 ? scene.grid.distance : 5);
    // G-22 (D-446): light from this floor and the floor above counts too; the floor planes let it
    // through openings only. Past the perception light budget, only the targets' floors light them.
    const up = floorAbove(scene, levelId);
    let lights = floorLights(scene, new Set([...below.keys(), levelId, ...(up ? [up._id] : [])]));
    if (lights.length > 256) lights = floorLights(scene, new Set(below.keys())).slice(0, 256);
    const perception = new SpatialPerception(kernel, lights, perUnit, options.rayBudget ?? 20_000);
    const levelOf = (t: TokenDocument) => scene.levels?.find((l) => l._id === t.levelId);
    const eyes = observers.map((t) => capToBand(perceptionBody(t, scene.grid), levelOf(t)));
    const darkness = new Map((scene.levels ?? []).map((l) => [l._id, l.darkness ?? scene.darkness ?? 0] as const));
    perception.begin();
    const seen: TokenBelow[] = [];
    for (const target of targets) {
      const samples = bodySamples(capToBand(perceptionBody(target, scene.grid), levelOf(target)));
      const reach = (eye: PerceptionBody) => Math.max(eye.sight, eye.darkvision);
      const near = eyes.filter((eye) => Math.hypot((target.x - eye.feet.x) / perUnit, (target.y - eye.feet.y) / perUnit) <= reach(eye) + 1e-9);
      if (near.some((eye) => perception.sees(eye, samples, Math.max(0, Math.min(1, darkness.get(target.levelId as string) ?? 0)))))
        seen.push({ id: target._id, depth: below.get(target.levelId as string) as number });
    }
    return seen.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  } catch {
    return [];
  }
}
