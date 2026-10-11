/** Discrete floor play. No vertical LOS, teleport permissions or secret-data guarantee is implied. */
import type { SceneDocument, RegionDocument, TokenDocument, LevelDocument, LevelScope } from "./documents";
import type { Op } from "./ops";
import { SpatialKernel, legacySpatialBarrier } from "./spatial/kernel";
import { applyDiff } from "./diff";
import { regionTriggerTile } from "./regionGeometry";
import { tileTriggerWorldPolygon, tileTriggerPolygonContains } from "./tileTriggerZone";
export const LEVEL_PLAY_FEATURE = "scene-level-play-v1";
export interface FloorPresentation {
  tileIds: string[];
  wallIds: string[];
  lightIds: string[];
  useSceneBackground: boolean;
  darkness: number;
  epoch: string;
}
export interface StairBehavior { from: string; to: string; }
/** Cross-reference validation runs on final staged scenes and archive imports. */
export function levelPlayError(scene: { levelMode?: unknown; levels?: unknown; tiles?: unknown; regions?: unknown }): string | null {
  if (scene.levelMode !== undefined && scene.levelMode !== "isolated") return "Invalid floor play mode";
  const levels = Array.isArray(scene.levels) ? scene.levels as LevelDocument[] : [];
  if (scene.levelMode === "isolated" && !levels.length) return "Isolated floor play requires saved levels";
  const tiles = Array.isArray(scene.tiles) ? scene.tiles as SceneDocument["tiles"] : [];
  for (const l of levels) {
    if (!l || typeof l !== "object") return "Invalid level record";
    if (l.useSceneBackground !== undefined && typeof l.useSceneBackground !== "boolean") return "Invalid floor background choice";
    if (l.tileIds !== undefined && (!Array.isArray(l.tileIds) || l.tileIds.length > 1000 || new Set(l.tileIds).size !== l.tileIds.length ||
      !Array.from(l.tileIds).every((id) => typeof id === "string" && tiles.some((t) => t?._id === id)))) return "Floor artwork references missing or duplicate tiles";
  }
  const stairs = (Array.isArray(scene.regions) ? scene.regions as RegionDocument[] : []).filter((r) => r?.stairs !== undefined);
  if (stairs.length > 128) return "At most 128 stair regions per scene";
  for (const r of stairs) {
    const s = r.stairs;
    if (!s || typeof s !== "object" || Array.isArray(s) || Object.keys(s).some((k) => k !== "from" && k !== "to") || s.from === s.to ||
        !levels.some((l) => l._id === s.from) || !levels.some((l) => l._id === s.to)) return "Stairs require distinct existing source and destination levels";
  }
  return null;
}
export function floorPresentation(scene: SceneDocument, level: LevelDocument): FloorPresentation {
  const belongs = (scope: LevelScope | undefined) => scope?.mode === "all" || (scope?.mode === "levels" && scope.ids.includes(level._id));
  return { tileIds: level.tileIds ?? [], wallIds: scene.walls.filter((w) => belongs(w.levelScope)).map((w) => w._id),
    lightIds: scene.lights.filter((l) => belongs(l.levelScope)).map((l) => l._id), useSceneBackground: level.useSceneBackground === true,
    darkness: level.darkness ?? scene.darkness, epoch: level.fogEpoch ?? "" };
}
/** Clear every unspecified layer, including legacy foreground and manual exploration mask. */
export function floorScene(scene: SceneDocument, view: { isolated?: boolean; levelId: string | null; tokenIds: string[] | null; presentation?: FloorPresentation } | null): SceneDocument {
  if (scene.levelMode !== "isolated") return scene;
  const p = view?.isolated ? view.presentation : undefined;
  const core = { ...(scene.flags.core ?? {}), fogMask: [] };
  const flags: SceneDocument["flags"] = { ...scene.flags, core }; delete flags.arenaDarkness;
  const { foreground: _foreground, ...base } = scene; void _foreground;
  return { ...base, flags, img: p?.useSceneBackground ? scene.img : null,
    darkness: p?.darkness ?? 1, tokens: p ? scene.tokens.filter((t) => view?.tokenIds?.includes(t._id)) : [],
    tiles: p ? scene.tiles.filter((t) => p.tileIds.includes(t._id)) : [], walls: p ? scene.walls.filter((w) => p.wallIds.includes(w._id)) : [],
    lights: p ? scene.lights.filter((l) => p.lightIds.includes(l._id)) : [], sounds: [], regions: [], drawings: [], templates: [], notes: [], cells: [] };
}
/** One edge-triggered transition per committed drag. No pass-through, spawn, undo or ping-pong triggers.
 * XY remains the accepted movement endpoint; only membership and feet Z change atomically.
 */
export function stairMovementOps(ops: readonly Op[], sceneById: (id: string) => SceneDocument | undefined): Op[] {
  const movers = new Map<string, { scene: SceneDocument; before: TokenDocument; after: TokenDocument; explicit: boolean }>();
  const editedScenes = new Set(ops.flatMap((op) => {
    const c = op.kind === "create" ? op.coll : op.ref.coll;
    const p = op.kind === "create" ? op.parent : op.ref.parent;
    return c === "scenes" ? [op.kind === "create" ? op.data._id : op.ref.id] : (c === "levels" || c === "regions") && p ? [p.id] : [];
  }));
  for (const op of ops) {
    if (op.kind !== "update" || op.ref.coll !== "tokens" || op.ref.parent?.coll !== "scenes") continue;
    const scene = sceneById(op.ref.parent.id);
    if (!scene || scene.levelMode !== "isolated" || editedScenes.has(scene._id)) continue;
    const key = JSON.stringify([scene._id, op.ref.id]);
    const before = scene.tokens.find((t) => t._id === op.ref.id); if (!before) continue;
    const row = movers.get(key) ?? { scene, before, after: before, explicit: false };
    const next = applyDiff(row.after, op.diff); if (!next.ok) throw new Error(next.error);
    row.after = next.value;
    row.explicit ||= Object.keys(op.diff).some((k) => /^(?:-=)?(?:elevation|levelId)(?:\.|$)/.test(k)); movers.set(key, row);
  }
  const result: Op[] = [...ops];
  for (const { scene, before, after, explicit } of movers.values()) {
    if (explicit || !before.levelId || (before.x === after.x && before.y === after.y) || before.flags.prefab || before.flags.summon) continue;
    const matches = (scene.regions ?? []).filter((r) => {
      if (r.stairs?.from !== before.levelId) return false;
      const polygon = tileTriggerWorldPolygon(regionTriggerTile(r));
      return polygon && !tileTriggerPolygonContains(polygon, before) && tileTriggerPolygonContains(polygon, after);
    });
    if (matches.length > 1) throw new Error("Overlapping stair destinations: GM must resolve the regions");
    const destination = scene.levels?.find((l) => l._id === matches[0]?.stairs?.to);
    const sourceWalls = scene.walls.filter((w) => w.levelScope?.mode === "all" || (w.levelScope?.mode === "levels" && w.levelScope.ids.includes(before.levelId ?? "")));
    if (destination) {
      const body = { width: after.width, depth: after.height, bodyHeight: 1, rotation: after.rotation };
      const start = { x: before.x, y: before.y, z: before.elevation ?? 0 }, end = { x: after.x, y: after.y, z: before.elevation ?? 0 };
      if (new SpatialKernel(sourceWalls.map(legacySpatialBarrier), []).sweep({ ...body, from: start, to: end }).length) throw new Error("A wall blocks entry to the stairs");
      const landing = { ...end, z: destination.floorZ };
      const destinationWalls = scene.walls.filter((w) => w.levelScope?.mode === "all" || (w.levelScope?.mode === "levels" && w.levelScope.ids.includes(destination._id)));
      if (new SpatialKernel(destinationWalls.map(legacySpatialBarrier), []).sweep({ ...body, from: landing, to: landing }).length) throw new Error("Stair landing overlaps a wall");
    }
    if (destination) result.push({ kind: "update", ref: { coll: "tokens", id: before._id, parent: { coll: "scenes", id: scene._id } }, diff: { levelId: destination._id, elevation: destination.floorZ } });
  }
  return result;
}
