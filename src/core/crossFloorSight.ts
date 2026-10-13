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
import type { ActorDocument, LevelDocument, SceneDocument, TokenDocument, WallDocument } from "./documents";
import { maskHiddenTokenIds } from "./fogExploration";
import { floorSurfaces, surfaceApertures } from "./floorSurface";
import { floorAbove, visibleFloorsBelow } from "./levelPlay";
import type { PermissionUser } from "./ownership";
import { can } from "./permissions";
import { raisedBarriers } from "./raisedAreas";
import { classifyRing, type SpatialPoint } from "./multilevelGeometry";
import { apertureOpeningSightCurve, pixelsPerSceneUnit, wallOpeningSightCurve } from "../canvas/vision/openings";
import { openingSightConeAt, openingSightPolicyOf, type OpeningSightCurve } from "./openingSightPolicy";
import { SpatialKernel, legacySpatialBarrier, type Point3, type SpatialBarrier } from "./spatial/kernel";
import { SpatialPerception, bodySamples, type PerceptionBody, type SpatialLight, type SightRayPolicy } from "./spatial/perception";

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
export function floorBarriers(
  scene: Pick<SceneDocument, "walls" | "levels" | "flags" | "grid">,
  includeProximitySightOpenings = false,
): SpatialBarrier[] {
  const levels = new Map((scene.levels ?? []).map((l) => [l._id, l] as const));
  const policy = includeProximitySightOpenings
    ? openingSightPolicyOf(scene as Pick<SceneDocument, "flags" | "grid">)
    : null;
  return scene.walls.flatMap((wall) => {
    const scope = wall.levelScope;
    if (!scope) return [];
    const base = legacySpatialBarrier(wall);
    const curve = policy ? wallOpeningSightCurve(policy, wall) : null;
    // Proximity openings are virtual sight hits only for the sight-disclosure query. Other
    // spatial consumers (e.g. spell effects) keep the physical wall axes they already used.
    const barrier = curve
      ? { ...base, restrictions: { ...base.restrictions, sight: 0 as const } }
      : base;
    if (scope.mode === "all") return [barrier];
    return scope.ids.map((id) => levels.get(id)).filter((l): l is LevelDocument => !!l)
      .map((l) => ({ ...barrier, id: `${wall._id}@${l._id}`, zSpan: { bottom: l.bottom, top: l.top } }));
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

interface WallSightOpeningRule {
  wall: WallDocument;
  curve: OpeningSightCurve;
  pixelsPerUnit: number;
}
interface FloorApertureSightRule {
  id: string;
  level: LevelDocument;
  points: SpatialPoint[];
  curve: OpeningSightCurve;
}

/** Virtual hit rules match the same scoped wall identities installed in `floorBarriers`. */
function wallSightOpeningRules(scene: SceneDocument): Map<string, WallSightOpeningRule> {
  const policy = openingSightPolicyOf(scene);
  const levelIds = new Set((scene.levels ?? []).map((level) => level._id));
  const pixelsPerUnit = pixelsPerSceneUnit(scene);
  const rules = new Map<string, WallSightOpeningRule>();
  for (const wall of scene.walls) {
    const curve = wallOpeningSightCurve(policy, wall);
    const scope = wall.levelScope;
    if (!curve || !scope) continue;
    const rule = { wall, curve, pixelsPerUnit };
    if (scope.mode === "all") rules.set(wall._id, rule);
    else for (const id of scope.ids) if (levelIds.has(id)) rules.set(`${wall._id}@${id}`, rule);
  }
  return rules;
}

/** Only valid traced holes can acquire a proximity rule; solid floor geometry is never removed. */
function floorApertureSightRules(scene: SceneDocument): FloorApertureSightRule[] {
  const policy = openingSightPolicyOf(scene);
  const rules: FloorApertureSightRule[] = [];
  for (const level of scene.levels ?? []) for (const aperture of surfaceApertures(level)) {
    const curve = apertureOpeningSightCurve(policy, level, aperture.id);
    if (curve) rules.push({ id: `${level._id}:${aperture.id}`, level, points: aperture.points, curve });
  }
  return rules;
}

function distanceToSegment2D(point: { x: number; y: number }, segment: readonly [number, number, number, number]): number {
  const [x1, y1, x2, y2] = segment;
  const dx = x2 - x1, dy = y2 - y1, length2 = dx * dx + dy * dy;
  if (length2 === 0) return Math.hypot(point.x - x1, point.y - y1);
  const amount = Math.max(0, Math.min(1, ((point.x - x1) * dx + (point.y - y1) * dy) / length2));
  return Math.hypot(point.x - (x1 + amount * dx), point.y - (y1 + amount * dy));
}

function wallRayPassesOpening(rule: WallSightOpeningRule, from: Point3, to: Point3, t: number): boolean {
  const { wall, curve, pixelsPerUnit } = rule;
  const cone = openingSightConeAt(curve, distanceToSegment2D(from, wall.c) / pixelsPerUnit);
  if (!cone) return false;
  const [x1, y1, x2, y2] = wall.c;
  const sx = x2 - x1, sy = y2 - y1, length = Math.hypot(sx, sy);
  if (length <= 1e-9) return false;
  const sideValue = sx * (from.y - y1) - sy * (from.x - x1);
  const side = Math.abs(sideValue) <= 1e-9 ? 0 : Math.sign(sideValue);
  const rayX = to.x - from.x, rayY = to.y - from.y;
  const rayLength = Math.hypot(rayX, rayY);
  if (side !== 0 && cone.widthDeg < 360) {
    if (rayLength <= 1e-9) return false;
    const normalX = side * sy / length, normalY = -side * sx / length;
    const dot = (rayX * normalX + rayY * normalY) / rayLength;
    if (dot + 1e-9 < Math.cos(cone.widthDeg * Math.PI / 360)) return false;
  }
  const hitZ = from.z + (to.z - from.z) * t;
  const remaining = Math.hypot((to.x - (from.x + rayX * t)) / pixelsPerUnit,
    (to.y - (from.y + rayY * t)) / pixelsPerUnit, to.z - hitZ);
  return remaining <= cone.depth + 1e-9;
}

function distanceToRing2D(point: { x: number; y: number }, ring: readonly SpatialPoint[]): number {
  if (classifyRing(ring, point) === 1) return 0;
  let best = Infinity;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i], b = ring[(i + 1) % ring.length];
    if (!a || !b) continue;
    const dx = b.x - a.x, dy = b.y - a.y, length2 = dx * dx + dy * dy;
    const amount = length2 === 0 ? 0 : Math.max(0, Math.min(1, ((point.x - a.x) * dx + (point.y - a.y) * dy) / length2));
    best = Math.min(best, Math.hypot(point.x - (a.x + amount * dx), point.y - (a.y + amount * dy)));
  }
  return best;
}

function apertureRayPassesOpening(rule: FloorApertureSightRule, from: Point3, to: Point3, t: number, pixelsPerUnit: number): boolean {
  const horizontalDistance = distanceToRing2D(from, rule.points) / pixelsPerUnit;
  const cone = openingSightConeAt(rule.curve, Math.hypot(horizontalDistance, from.z - rule.level.floorZ));
  if (!cone) return false;
  const dz = to.z - from.z;
  if (Math.abs(dz) <= 1e-9) return false;
  const horizontalRay = Math.hypot((to.x - from.x) / pixelsPerUnit, (to.y - from.y) / pixelsPerUnit);
  const deviation = Math.atan2(horizontalRay, Math.abs(dz));
  if (deviation > cone.widthDeg * Math.PI / 360 + 1e-9) return false;
  const hitX = from.x + (to.x - from.x) * t;
  const hitY = from.y + (to.y - from.y) * t;
  const hitZ = from.z + dz * t;
  const remaining = Math.hypot((to.x - hitX) / pixelsPerUnit, (to.y - hitY) / pixelsPerUnit, to.z - hitZ);
  return remaining <= cone.depth + 1e-9;
}

function crossFloorSightRayPolicy(
  openings: ReadonlyMap<string, WallSightOpeningRule>,
  apertures: readonly FloorApertureSightRule[],
  pixelsPerUnit: number,
): SightRayPolicy {
  return (from, to, hits) => {
    const events: Array<{ t: number; id: string; opening: WallSightOpeningRule | FloorApertureSightRule | null; aperture: boolean }> =
      hits.map((hit) => ({ t: hit.t, id: `${hit.kind}:${hit.id}:${hit.plane ?? ""}`,
        opening: hit.kind === "wall" ? openings.get(hit.id) ?? null : null, aperture: false }));
    const dz = to.z - from.z;
    if (Math.abs(dz) > 1e-9) for (const rule of apertures) {
      const t = (rule.level.floorZ - from.z) / dz;
      if (t < 0 || t > 1) continue;
      const point = { x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t };
      // Strict interior only: the traced aperture's rim belongs to the solid floor.
      if (classifyRing(rule.points, point) === 1)
        events.push({ t, id: `aperture:${rule.id}`, opening: rule, aperture: true });
    }
    events.sort((a, b) => a.t - b.t || Number(!!a.opening) - Number(!!b.opening) || a.id.localeCompare(b.id));
    for (const event of events) {
      if (!event.opening) return false; // hard wall, raised area or solid floor always wins
      const passes = event.aperture
        ? apertureRayPassesOpening(event.opening as FloorApertureSightRule, from, to, event.t, pixelsPerUnit)
        : wallRayPassesOpening(event.opening as WallSightOpeningRule, from, to, event.t);
      if (!passes) return false;
    }
    return true;
  };
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
    const barriers = floorBarriers(scene, true);
    const wallOpenings = wallSightOpeningRules(scene);
    const apertureOpenings = floorApertureSightRules(scene);
    const kernel = new SpatialKernel([...barriers, ...raisedBarriers(scene)], floorSurfaces(scene));
    const perUnit = scene.grid.size / (scene.grid.distance > 0 ? scene.grid.distance : 5);
    // G-22 (D-446): light from this floor and the floor above counts too; the floor planes let it
    // through openings only. Past the perception light budget, only the targets' floors light them.
    const up = floorAbove(scene, levelId);
    let lights = floorLights(scene, new Set([...below.keys(), levelId, ...(up ? [up._id] : [])]));
    if (lights.length > 256) lights = floorLights(scene, new Set(below.keys())).slice(0, 256);
    const perception = new SpatialPerception(kernel, lights, perUnit, options.rayBudget ?? 20_000,
      crossFloorSightRayPolicy(wallOpenings, apertureOpenings, perUnit));
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
