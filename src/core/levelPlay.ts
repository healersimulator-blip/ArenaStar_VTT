/** Discrete floor play. No vertical LOS, teleport permissions or secret-data guarantee is implied. */
import { isDoorWall, type SceneDocument, type RegionDocument, type TokenDocument, type LevelDocument, type LevelScope } from "./documents";
import type { Op } from "./ops";
import { snapTokenCenter, type GridSpec } from "../canvas/grid";
import { SpatialKernel, legacySpatialBarrier } from "./spatial/kernel";
import { applyDiff } from "./diff";
import { regionTriggerTile } from "./regionGeometry";
import { tileTriggerWorldPolygon, tileTriggerPolygonContains, type TileTriggerPoint } from "./tileTriggerZone";
import { inElevationBand } from "./multilevelGeometry";
import { scopeIncludes } from "./levelMembership";
export const LEVEL_PLAY_FEATURE = "scene-level-play-v1";
/** G-01 (D-430): stairwells serving several floors, player choice, locks, arrivals and markers. */
export const STAIRS_V2_FEATURE = "scene-level-stairs-v2";
export const MAX_STAIR_LEVELS = 8;
/** An unanswered stair choice lapses; the token simply stays where it stopped. */
export const STAIR_OFFER_TTL_MS = 60_000;
export interface FloorPresentation {
  tileIds: string[];
  wallIds: string[];
  lightIds: string[];
  useSceneBackground: boolean;
  darkness: number;
  epoch: string;
  /**
   * G-06 (D-432): presentation objects scoped to *other* floors. Unscoped objects show on every
   * floor, so an exclusion list stays small. Absent (hosts before D-432): the player hides these
   * layers entirely, exactly as before.
   */
  offFloor?: { regions: string[]; drawings: string[]; templates: string[]; notes: string[] };
  /** G-10 (D-430): non-secret stairs usable from this floor; geometry and direction only. */
  stairs?: StairMarker[];
  /**
   * G-19 (D-443): floors this floor sees beneath it (its `visibleLevelIds`), nearest first. Their
   * map art is drawn under this floor's, dimmed by depth, and shows through transparent parts of
   * this floor's art. Art only: their tokens, walls and lights stay on their own floor. Absent when
   * the floor sees nothing below (and from hosts before D-443).
   */
  below?: FloorBelow[];
  /**
   * D-443: this floor's own Z. Players never receive `levels` or `levelId`, so without it their
   * elevation badges (D-440) measured from 0 instead of from the floor they stand on.
   */
  floorZ?: number;
}
export interface FloorBelow {
  levelId: string;
  /** 1 = the floor directly beneath in the stack, 2 = the one under that, … */
  depth: number;
  tileIds: string[];
  useSceneBackground: boolean;
}
/** Dimming for art seen on lower floors, by depth (1, 2, 3+). */
export const LOWER_FLOOR_TINTS = [0xa6a6a6, 0x808080, 0x606060] as const;
export function lowerFloorTint(depth: number): number {
  return LOWER_FLOOR_TINTS[Math.min(LOWER_FLOOR_TINTS.length, Math.max(1, Math.floor(depth))) - 1] ?? 0x606060;
}
/** Bottom-up stack order: floor elevation, then display order, then id. */
function stackOf(levels: readonly LevelDocument[]): LevelDocument[] {
  return [...levels].sort((a, b) => a.floorZ - b.floorZ || a.sort - b.sort || (a._id < b._id ? -1 : a._id > b._id ? 1 : 0));
}
/** G-19 (D-443): the floors `level` sees beneath it, nearest first, with their depth in the stack. */
export function visibleFloorsBelow(scene: Pick<SceneDocument, "levels">, level: LevelDocument): Array<{ level: LevelDocument; depth: number }> {
  const stack = stackOf(scene.levels ?? []);
  const index = stack.findIndex((l) => l._id === level._id);
  const seen = new Set(level.visibleLevelIds);
  const out: Array<{ level: LevelDocument; depth: number }> = [];
  for (let i = index - 1; i >= 0; i--) {
    const below = stack[i] as LevelDocument;
    if (below.floorZ < level.floorZ && seen.has(below._id)) out.push({ level: below, depth: index - i });
  }
  return out;
}
/** Tile id → depth for the lower floors' art (the nearest floor wins a shared tile; this floor's own tiles are excluded). */
export function lowerFloorDepths(presentation: Pick<FloorPresentation, "tileIds" | "below"> | undefined | null): Map<string, number> {
  const depths = new Map<string, number>();
  if (!presentation?.below) return depths;
  const own = new Set(presentation.tileIds);
  for (const floor of presentation.below) for (const id of floor.tileIds) {
    if (own.has(id)) continue;
    const known = depths.get(id);
    if (known === undefined || floor.depth < known) depths.set(id, floor.depth);
  }
  return depths;
}
/** The depth at which the scene background is seen: 0 = on this floor, a number = a lower floor's, null = not drawn. */
export function backgroundDepth(presentation: Pick<FloorPresentation, "useSceneBackground" | "below"> | undefined | null): number | null {
  if (!presentation) return null;
  if (presentation.useSceneBackground) return 0;
  const floors = (presentation.below ?? []).filter((f) => f.useSceneBackground).map((f) => f.depth);
  return floors.length ? Math.min(...floors) : null;
}
/** Legacy one-way stair (D-428): entering on `from` moves the token to `to`. Still accepted. */
export interface StairBehaviorV1 { from: string; to: string }
export interface StairEdge { from: string; to: string }
/** Optional landing point (token center) on one destination floor. */
export interface StairArrival { levelId: string; x: number; y: number }
/** G-01 (D-430): one stairwell region connecting 2–8 floors. */
export interface StairBehaviorV2 {
  version: 2;
  levels: string[];
  /** `auto` takes a single available destination at once; `prompt` always asks the mover. */
  mode: "auto" | "prompt";
  /** Allowed directed moves; absent = every pair of `levels` in both directions. */
  edges?: StairEdge[];
  arrivals?: StairArrival[];
  /** G-11: a locked stairwell is ordinary floor; entering explains that it is locked. */
  locked?: boolean;
  /** Player-facing name shown on the marker and in the chooser. */
  label?: string;
  /** G-10: hidden passages are not marked for players. */
  secret?: boolean;
  /**
   * G-09 (D-437): `cross` also fires when a move passes through the stairwell, stopping (or, in
   * `auto` mode, continuing on the new floor) at the entry point. Absent/`end` = the move must end
   * inside, as before.
   */
  trigger?: "end" | "cross";
  /** G-11 (D-437): wall ID of a door; the stairwell works only while that door is open. */
  door?: string;
}
export type StairBehavior = StairBehaviorV1 | StairBehaviorV2;
/** Normalized view of either version. `locked` is the stored flag; see `stairLocked` for doors. */
export interface StairSpec { levels: string[]; mode: "auto" | "prompt"; edges: StairEdge[]; arrivals: StairArrival[]; locked: boolean; label?: string; secret: boolean; legacy: boolean;
  trigger: "end" | "cross"; door?: string }
export interface StairMarker { id: string; points: number[]; label?: string; up: boolean; down: boolean; locked: boolean }
export interface StairChoice { levelId: string; name: string; direction: "up" | "down" | "level" }
/** A move stopped inside a stairwell with a choice to make (or a locked one to explain). */
export interface StairPrompt { sceneId: string; tokenId: string; fromLevelId: string; regionIds: string[]; label?: string; choices: StairChoice[]; reason?: "locked" }

const STAIR_V2_KEYS = new Set(["version", "levels", "mode", "edges", "arrivals", "locked", "label", "secret", "trigger", "door"]);
const LEGACY_STAIR_ERROR = "Stairs require distinct existing source and destination levels";
const STAIR_REF = /^[A-Za-z0-9_-]{1,128}$/;
export function stairSpec(s: StairBehavior): StairSpec {
  if (!("version" in s)) return { levels: [s.from, s.to], mode: "auto", edges: [{ from: s.from, to: s.to }], arrivals: [], locked: false, secret: false, legacy: true, trigger: "end" };
  const edges = s.edges ?? s.levels.flatMap((from) => s.levels.filter((to) => to !== from).map((to) => ({ from, to })));
  return { levels: [...s.levels], mode: s.mode, edges: edges.map((e) => ({ ...e })), arrivals: (s.arrivals ?? []).map((a) => ({ ...a })), locked: s.locked === true,
    ...(s.label ? { label: s.label } : {}), secret: s.secret === true, legacy: false, trigger: s.trigger === "cross" ? "cross" : "end", ...(s.door ? { door: s.door } : {}) };
}
/**
 * G-11 (D-437): the door a stairwell is linked to, when that wall still exists and is a door.
 * A dangling link (wall deleted, or no longer a door) is ignored here and reported by the audit.
 */
export function stairDoor(scene: Pick<SceneDocument, "walls">, spec: Pick<StairSpec, "door">) {
  const wall = spec.door ? scene.walls.find((w) => w._id === spec.door) : undefined;
  return wall && isDoorWall(wall) ? wall : undefined;
}
/** Effective lock: the stored flag, or a linked door that is closed or locked (door state ≠ open). */
export function stairLocked(scene: Pick<SceneDocument, "walls">, spec: Pick<StairSpec, "locked" | "door">): boolean {
  if (spec.locked) return true;
  const door = stairDoor(scene, spec);
  return !!door && door.door !== 1;
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
export function stairBehaviorError(raw: unknown, levels: readonly LevelDocument[]): string | null {
  if (!isRecord(raw)) return LEGACY_STAIR_ERROR;
  const known = (id: unknown) => typeof id === "string" && levels.some((l) => l._id === id);
  if (raw.version === undefined) {
    return Object.keys(raw).some((k) => k !== "from" && k !== "to") || raw.from === raw.to || !known(raw.from) || !known(raw.to) ? LEGACY_STAIR_ERROR : null;
  }
  if (raw.version !== 2) return "Unsupported stair version";
  if (Object.keys(raw).some((k) => !STAIR_V2_KEYS.has(k))) return "Stairs contain unknown fields";
  const ids = raw.levels;
  if (!Array.isArray(ids) || ids.length < 2 || ids.length > MAX_STAIR_LEVELS || new Set(ids).size !== ids.length || !ids.every(known))
    return `A stairwell connects 2–${MAX_STAIR_LEVELS} distinct existing floors`;
  if (raw.mode !== "auto" && raw.mode !== "prompt") return "Stair mode must be auto or prompt";
  if (raw.edges !== undefined) {
    const edges = raw.edges;
    if (!Array.isArray(edges) || !edges.length || edges.length > MAX_STAIR_LEVELS * (MAX_STAIR_LEVELS - 1)) return "Stair directions must list 1–56 moves";
    const seen = new Set<string>();
    for (const e of edges) {
      if (!isRecord(e) || Object.keys(e).length !== 2 || typeof e.from !== "string" || typeof e.to !== "string" || e.from === e.to ||
          !ids.includes(e.from) || !ids.includes(e.to) || seen.has(`${e.from}\u0000${e.to}`)) return "Stair directions must be distinct moves between the stairwell's floors";
      seen.add(`${e.from}\u0000${e.to}`);
    }
  }
  if (raw.arrivals !== undefined) {
    const arrivals = raw.arrivals;
    if (!Array.isArray(arrivals) || arrivals.length > MAX_STAIR_LEVELS) return "Too many stair arrival points";
    const seen = new Set<string>();
    for (const a of arrivals) {
      if (!isRecord(a) || Object.keys(a).some((k) => k !== "levelId" && k !== "x" && k !== "y") || typeof a.levelId !== "string" || !ids.includes(a.levelId) || seen.has(a.levelId) ||
          typeof a.x !== "number" || typeof a.y !== "number" || !Number.isFinite(a.x) || !Number.isFinite(a.y) || Math.abs(a.x) > 1_000_000 || Math.abs(a.y) > 1_000_000)
        return "Stair arrivals need one finite point per connected floor";
      seen.add(a.levelId);
    }
  }
  if (raw.locked !== undefined && typeof raw.locked !== "boolean") return "Stair lock must be true or false";
  if (raw.trigger !== undefined && raw.trigger !== "end" && raw.trigger !== "cross") return "Stair trigger must be end or cross";
  // Shape only: the wall may be deleted later, and a level transaction must never fail on that (D-437).
  if (raw.door !== undefined && (typeof raw.door !== "string" || !STAIR_REF.test(raw.door))) return "Stair door must be a wall ID";
  if (raw.secret !== undefined && typeof raw.secret !== "boolean") return "Stair secrecy must be true or false";
  if (raw.label !== undefined && (typeof raw.label !== "string" || !raw.label.trim() || raw.label.length > 64 || [...raw.label].some((ch) => ch.charCodeAt(0) < 32 || ch.charCodeAt(0) === 127)))
    return "Stair label needs 1–64 printable characters";
  return null;
}
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
  for (const r of stairs) { const error = stairBehaviorError(r.stairs, levels); if (error) return error; }
  return null;
}
function regionPolygon(region: RegionDocument): TileTriggerPoint[] | null {
  return tileTriggerWorldPolygon(regionTriggerTile(region));
}
const byRegionOrder = (a: RegionDocument, b: RegionDocument) => (a.sort ?? 0) - (b.sort ?? 0) || a._id.localeCompare(b._id);
function directionOf(from: LevelDocument, to: LevelDocument): StairChoice["direction"] {
  return to.floorZ > from.floorZ ? "up" : to.floorZ < from.floorZ ? "down" : "level";
}
/** G-10: markers for one floor. Secret stairs are omitted unless explicitly requested (GM canvas). */
export function stairMarkers(scene: SceneDocument, levelId: string | null, includeSecret = false): StairMarker[] {
  const levels = scene.levels ?? [];
  const here = levels.find((l) => l._id === levelId);
  const markers: StairMarker[] = [];
  for (const region of [...(scene.regions ?? [])].sort(byRegionOrder)) {
    if (!region.stairs) continue;
    const spec = stairSpec(region.stairs);
    if (spec.secret && !includeSecret) continue;
    if (levelId !== null && !spec.levels.includes(levelId)) continue;
    const polygon = regionPolygon(region);
    if (!polygon) continue;
    const targets = spec.edges.filter((e) => levelId === null || e.from === levelId).map((e) => levels.find((l) => l._id === e.to)).filter((l): l is LevelDocument => !!l);
    if (levelId !== null && !targets.length) continue;
    const origin = here ?? levels.find((l) => l._id === spec.levels[0]);
    const up = !!origin && targets.some((l) => l.floorZ > origin.floorZ) || (levelId === null && spec.levels.length > 1);
    const down = !!origin && targets.some((l) => l.floorZ < origin.floorZ) || (levelId === null && spec.levels.length > 1);
    markers.push({ id: region._id, points: polygon.flatMap((p) => [Math.round(p.x * 10) / 10, Math.round(p.y * 10) / 10]),
      ...(spec.label ? { label: spec.label } : levelId === null ? { label: region.name } : {}), up, down, locked: stairLocked(scene, spec) });
  }
  return markers;
}
export function floorPresentation(scene: SceneDocument, level: LevelDocument): FloorPresentation {
  const belongs = (scope: LevelScope | undefined) => scope?.mode === "all" || (scope?.mode === "levels" && scope.ids.includes(level._id));
  const off = (rows: ReadonlyArray<{ _id: string; levelScope?: LevelScope }> | undefined) =>
    (rows ?? []).filter((r) => !scopeIncludes(r.levelScope, level._id)).map((r) => r._id);
  const below: FloorBelow[] = visibleFloorsBelow(scene, level).map(({ level: l, depth }) => ({ levelId: l._id, depth, tileIds: l.tileIds ?? [], useSceneBackground: l.useSceneBackground === true }));
  return { tileIds: level.tileIds ?? [], wallIds: scene.walls.filter((w) => belongs(w.levelScope)).map((w) => w._id),
    lightIds: scene.lights.filter((l) => belongs(l.levelScope)).map((l) => l._id), useSceneBackground: level.useSceneBackground === true,
    darkness: level.darkness ?? scene.darkness, epoch: level.fogEpoch ?? "", floorZ: level.floorZ,
    offFloor: { regions: off((scene.regions ?? []).filter((r) => r.stairs === undefined)), drawings: off(scene.drawings), templates: off(scene.templates), notes: off(scene.notes) },
    stairs: stairMarkers(scene, level._id), ...(below.length ? { below } : {}) };
}
/** Clear every unspecified layer, including legacy foreground and manual exploration mask. */
export function floorScene(scene: SceneDocument, view: { isolated?: boolean; levelId: string | null; tokenIds: string[] | null; presentation?: FloorPresentation } | null): SceneDocument {
  if (scene.levelMode !== "isolated") return scene;
  const p = view?.isolated ? view.presentation : undefined;
  const core = { ...(scene.flags.core ?? {}), fogMask: [] };
  const flags: SceneDocument["flags"] = { ...scene.flags, core }; delete flags.arenaDarkness;
  const { foreground: _foreground, ...base } = scene; void _foreground;
  const off = p?.offFloor;
  const keep = <T extends { _id: string }>(rows: readonly T[] | undefined, hidden: readonly string[] | undefined): T[] => {
    if (!off) return [];
    const skip = new Set(hidden ?? []);
    return (rows ?? []).filter((r) => !skip.has(r._id));
  };
  // G-19: lower floors' art comes along (the renderer dims it and draws it beneath this floor's).
  const lower = lowerFloorDepths(p);
  return { ...base, flags, img: backgroundDepth(p) !== null ? scene.img : null,
    darkness: p?.darkness ?? 1, tokens: p ? scene.tokens.filter((t) => view?.tokenIds?.includes(t._id)) : [],
    tiles: p ? scene.tiles.filter((t) => p.tileIds.includes(t._id) || lower.has(t._id)) : [], walls: p ? scene.walls.filter((w) => p.wallIds.includes(w._id)) : [],
    lights: p ? scene.lights.filter((l) => p.lightIds.includes(l._id)) : [], sounds: [],
    regions: keep((scene.regions ?? []).filter((r) => r.stairs === undefined), off?.regions), drawings: keep(scene.drawings, off?.drawings),
    templates: keep(scene.templates, off?.templates), notes: keep(scene.notes, off?.notes), cells: [] };
}
/** Scenes whose levels/regions are edited in the same transaction: floor automation stays out of them. */
function editedLevelScenes(ops: readonly Op[]): Set<string> {
  return new Set(ops.flatMap((op) => {
    const c = op.kind === "create" ? op.coll : op.ref.coll;
    const p = op.kind === "create" ? op.parent : op.ref.parent;
    return c === "scenes" ? [op.kind === "create" ? op.data._id : op.ref.id] : (c === "levels" || c === "regions") && p ? [p.id] : [];
  }));
}
/**
 * Creation-time floor stamping (G-06/G-07/G-13). `preferred` is a player's viewed floor and only
 * applies in isolated play; `build` is a GM's explicit build floor (D-434) and applies in any scene
 * with levels, to every kind: walls, lights, regions, drawings, templates and notes get
 * `levelScope:{levels:[floor]}`, tiles are appended to that floor's art, tokens get the floor.
 * G-07 (D-431): a token created in isolated play always lands on a floor — its prefab parent's,
 * the build/viewed floor, the band containing its feet, else the lowest floor. Feet elevation is
 * kept when it already lies in the chosen band. Explicit fields are never overwritten.
 */
export function levelCreationOps(ops: readonly Op[], sceneById: (id: string) => SceneDocument | undefined,
  preferred: (sceneId: string) => string | null = () => null, build: (sceneId: string) => string | null = () => null): Op[] {
  const edited = editedLevelScenes(ops);
  const created: TokenDocument[] = [];
  const tiles = new Map<string, { scene: SceneDocument; levelId: string; ids: string[] }>();
  const floorOf = (scene: SceneDocument, pick: (sceneId: string) => string | null) => {
    const id = pick(scene._id);
    return id && scene.levels?.some((l) => l._id === id) ? id : null;
  };
  const result = ops.map((op): Op => {
    if (op.kind !== "create" || op.parent?.coll !== "scenes") return op;
    const scene = sceneById(op.parent.id);
    if (!scene || edited.has(scene._id) || !scene.levels?.length) { if (op.coll === "tokens") created.push(op.data as TokenDocument); return op; }
    const builder = floorOf(scene, build);
    const viewer = scene.levelMode === "isolated" ? floorOf(scene, preferred) : null;
    if (op.coll === "drawings" || op.coll === "templates" || op.coll === "notes" || op.coll === "walls" || op.coll === "lights" || op.coll === "regions") {
      // G-06 (D-432): presentation objects made while viewing a floor belong to it; G-13: so does
      // everything a GM builds while a build floor is active.
      const level = builder ?? (op.coll === "drawings" || op.coll === "templates" || op.coll === "notes" ? viewer : null);
      if (!level || Object.hasOwn(op.data, "levelScope")) return op;
      return { ...op, data: { ...op.data, levelScope: { mode: "levels", ids: [level] } } as typeof op.data };
    }
    if (op.coll === "tiles") {
      if (builder && !scene.levels.some((l) => l.tileIds?.includes(op.data._id))) {
        const key = `${scene._id}\u0000${builder}`;
        const row = tiles.get(key) ?? { scene, levelId: builder, ids: [] };
        row.ids.push(op.data._id); tiles.set(key, row);
      }
      return op;
    }
    if (op.coll !== "tokens") return op;
    const data = op.data as TokenDocument;
    if (data.levelId !== undefined || (scene.levelMode !== "isolated" && !builder)) { created.push(data); return op; }
    const levels = scene.levels, elevation = Number.isFinite(data.elevation) ? data.elevation ?? 0 : 0;
    const parentId = (data.flags?.prefab as { parentId?: unknown } | undefined)?.parentId;
    const parent = typeof parentId === "string" ? [...created, ...scene.tokens].find((t) => t._id === parentId) : undefined;
    const level = [parent?.levelId, builder ?? viewer].map((id) => levels.find((l) => l._id === id)).find((l) => !!l) ??
      levels.find((l) => inElevationBand(l, elevation)) ?? [...levels].sort((a, b) => (a.bottom ?? -Infinity) - (b.bottom ?? -Infinity) || a.sort - b.sort)[0];
    if (!level) { created.push(data); return op; }
    const stamped = { ...data, levelId: level._id, elevation: inElevationBand(level, elevation) ? elevation : level.floorZ };
    created.push(stamped);
    return { ...op, data: stamped };
  });
  for (const { scene, levelId, ids } of tiles.values()) {
    const level = scene.levels?.find((l) => l._id === levelId);
    if (!level) continue;
    result.push({ kind: "update", ref: { coll: "levels", id: levelId, parent: { coll: "scenes", id: scene._id } }, diff: { tileIds: [...(level.tileIds ?? []), ...ids] } });
  }
  return result;
}
function wallsOn(scene: SceneDocument, levelId: string) {
  return scene.walls.filter((w) => w.levelScope?.mode === "all" || (w.levelScope?.mode === "levels" && w.levelScope.ids.includes(levelId)));
}
function bodyOf(token: TokenDocument) {
  return { width: token.width, depth: token.height, bodyHeight: 1, rotation: token.rotation };
}
function landingBlocked(scene: SceneDocument, token: TokenDocument, level: LevelDocument, at: { x: number; y: number }): boolean {
  const landing = { x: at.x, y: at.y, z: level.floorZ };
  return new SpatialKernel(wallsOn(scene, level._id).map(legacySpatialBarrier), []).sweep({ ...bodyOf(token), from: landing, to: landing }).length > 0;
}
interface ResolvedChoice { level: LevelDocument; region: RegionDocument; arrival?: StairArrival }
/** Union of the destinations offered by `regions` to a token on `source` (G-01: overlaps combine). */
function choicesFrom(scene: SceneDocument, source: LevelDocument, regions: readonly RegionDocument[]): { choices: ResolvedChoice[]; locked: boolean; regionIds: string[]; label?: string } {
  const levels = scene.levels ?? [];
  const byLevel = new Map<string, ResolvedChoice>();
  let locked = false, label: string | undefined;
  const regionIds: string[] = [];
  for (const region of [...regions].sort(byRegionOrder)) {
    if (!region.stairs) continue;
    const spec = stairSpec(region.stairs);
    const outgoing = spec.edges.filter((e) => e.from === source._id);
    if (!outgoing.length) continue;
    if (stairLocked(scene, spec)) { locked = true; continue; }
    regionIds.push(region._id);
    label ??= spec.label;
    for (const edge of outgoing) {
      const level = levels.find((l) => l._id === edge.to);
      const arrival = spec.arrivals.find((a) => a.levelId === edge.to);
      if (level && !byLevel.has(level._id)) byLevel.set(level._id, { level, region, ...(arrival ? { arrival } : {}) });
    }
  }
  const choices = [...byLevel.values()].sort((a, b) => b.level.floorZ - a.level.floorZ || a.level.sort - b.level.sort || a.level._id.localeCompare(b.level._id));
  return { choices, locked: locked && !choices.length, regionIds, ...(label ? { label } : {}) };
}
function promptChoices(source: LevelDocument, choices: readonly ResolvedChoice[]): StairChoice[] {
  return choices.map(({ level }) => ({ levelId: level._id, name: level.name, direction: directionOf(source, level) }));
}
/** Prefab descendants of `tokenId` currently sharing its floor: they travel with it. */
function attachedFollowers(scene: SceneDocument, tokenId: string, levelId: string): TokenDocument[] {
  const parentOf = new Map(scene.tokens.map((t) => [t._id, (t.flags?.prefab as { parentId?: unknown } | undefined)?.parentId] as const));
  return scene.tokens.filter((t) => {
    if (t._id === tokenId || t.levelId !== levelId) return false;
    let at = parentOf.get(t._id);
    for (let depth = 0; typeof at === "string" && depth < 8; depth++) {
      if (at === tokenId) return true;
      at = parentOf.get(at);
    }
    return false;
  });
}
type Point = { x: number; y: number };
type Follower = { token: TokenDocument; at: Point };
/**
 * Floor change for the mover and its attached followers. `at` is where the commit leaves the mover;
 * `land` is where it ends up (an arrival point, a pass-through stop, or `at` itself). Followers keep
 * their offset from the mover.
 */
function transitionOps(scene: SceneDocument, token: TokenDocument, level: LevelDocument, followers: readonly Follower[], at: Point, land: Point): Op[] {
  const parent = { coll: "scenes" as const, id: scene._id };
  const dx = land.x - at.x, dy = land.y - at.y;
  const move = (dx || dy) ? { x: land.x, y: land.y } : {};
  return [
    { kind: "update", ref: { coll: "tokens", id: token._id, parent }, diff: { levelId: level._id, elevation: level.floorZ, ...move } },
    ...followers.map(({ token: f, at: fAt }): Op => ({ kind: "update", ref: { coll: "tokens", id: f._id, parent },
      diff: { levelId: level._id, elevation: level.floorZ, ...((dx || dy) ? { x: fAt.x + dx, y: fAt.y + dy } : {}) } })),
  ];
}
/** G-09: stop the mover (and its followers, by the same offset) short of its submitted endpoint. */
function shiftOps(scene: SceneDocument, token: TokenDocument, followers: readonly Follower[], at: Point, stop: Point): Op[] {
  const parent = { coll: "scenes" as const, id: scene._id };
  const dx = stop.x - at.x, dy = stop.y - at.y;
  if (!dx && !dy) return [];
  return [{ kind: "update", ref: { coll: "tokens", id: token._id, parent }, diff: { x: stop.x, y: stop.y } },
    ...followers.map(({ token: f, at: fAt }): Op => ({ kind: "update", ref: { coll: "tokens", id: f._id, parent }, diff: { x: fAt.x + dx, y: fAt.y + dy } }))];
}
/** Filter out destinations whose landing would put the body inside a wall. */
function clearChoices(scene: SceneDocument, token: TokenDocument, at: Point, choices: readonly ResolvedChoice[]): ResolvedChoice[] {
  return choices.filter((c) => !landingBlocked(scene, token, c.level, c.arrival ?? at));
}
function sweepBlocked(scene: SceneDocument, levelId: string, token: TokenDocument, from: Point, to: Point, z: number): boolean {
  return new SpatialKernel(wallsOn(scene, levelId).map(legacySpatialBarrier), []).sweep({ ...bodyOf(token), from: { ...from, z }, to: { ...to, z } }).length > 0;
}
/**
 * G-09: where the segment `a → b` runs inside a convex polygon, as parameters `enter ≤ exit` in
 * [0, 1] (Cyrus–Beck). Null when it misses. Orientation-independent.
 */
export function segmentPolygonSpan(polygon: readonly Point[], a: Point, b: Point): { enter: number; exit: number } | null {
  const n = polygon.length;
  if (n < 3) return null;
  let area = 0;
  for (let i = 0; i < n; i++) { const p = polygon[i] as Point, q = polygon[(i + 1) % n] as Point; area += p.x * q.y - q.x * p.y; }
  if (!Number.isFinite(area) || Math.abs(area) < 1e-9) return null;
  const orient = Math.sign(area), dx = b.x - a.x, dy = b.y - a.y;
  let enter = 0, exit = 1;
  for (let i = 0; i < n; i++) {
    const p = polygon[i] as Point, q = polygon[(i + 1) % n] as Point;
    const ex = q.x - p.x, ey = q.y - p.y;
    const inside0 = (ex * (a.y - p.y) - ey * (a.x - p.x)) * orient; // ≥ 0 on the inner side
    const rate = (ex * dy - ey * dx) * orient;
    if (Math.abs(rate) < 1e-12) { if (inside0 < 0) return null; continue; }
    const t = -inside0 / rate;
    if (rate > 0) enter = Math.max(enter, t); else exit = Math.min(exit, t);
    if (enter > exit) return null;
  }
  return { enter, exit };
}
/** A centre path running less than this far inside a pass-through stairwell only grazed it. */
const MIN_CROSSING_PX = 1;
interface StairEntry { region: RegionDocument; polygon: TileTriggerPoint[]; t: number; exit: number; ends: boolean }
/**
 * Stairwells on `source` the centre path enters, outside → inside, in path order. Every stairwell
 * counts when the move ends inside it (`ends`); a `cross` stairwell also counts when the path only
 * passes through it (G-09).
 */
function stairEntries(scene: SceneDocument, source: LevelDocument, before: Point, after: Point): StairEntry[] {
  const out: StairEntry[] = [];
  const length = Math.hypot(after.x - before.x, after.y - before.y);
  for (const region of [...(scene.regions ?? [])].sort(byRegionOrder)) {
    if (!region.stairs) continue;
    const spec = stairSpec(region.stairs);
    if (!spec.levels.includes(source._id)) continue;
    const polygon = regionPolygon(region);
    if (!polygon || tileTriggerPolygonContains(polygon, before)) continue;
    const ends = tileTriggerPolygonContains(polygon, after);
    if (!ends && spec.trigger !== "cross") continue;
    const span = segmentPolygonSpan(polygon, before, after);
    if (ends) { out.push({ region, polygon, t: span?.enter ?? 1, exit: 1, ends }); continue; }
    if (!span || (span.exit - span.enter) * length < MIN_CROSSING_PX) continue;
    out.push({ region, polygon, t: span.enter, exit: span.exit, ends });
  }
  return out.sort((a, b) => a.t - b.t);
}
function gridSpec(scene: SceneDocument): GridSpec | null {
  const g = scene.grid;
  if (!g || !Number.isFinite(g.size) || g.size <= 0) return null;
  if (g.type === "square") return { type: "square", size: g.size };
  if (g.type === "hex" && (["oddQ", "evenQ", "oddR", "evenR"] as string[]).includes(g.hexLayout)) return { type: "hex", size: g.size, layout: g.hexLayout };
  return null;
}
/**
 * Where a pass-through stops: just inside the entry edge of every stairwell entered there, on the
 * nearest grid cell centre when that centre is inside too.
 */
function passStop(scene: SceneDocument, group: readonly StairEntry[], before: Point, after: Point): Point {
  const t0 = group[0]?.t ?? 1, exit = Math.min(...group.map((e) => e.exit));
  const length = Math.hypot(after.x - before.x, after.y - before.y) || 1;
  const t = t0 + Math.min(1 / length, (exit - t0) / 2);
  const raw = { x: before.x + (after.x - before.x) * t, y: before.y + (after.y - before.y) * t };
  const inside = (p: Point) => group.every((e) => tileTriggerPolygonContains(e.polygon, p));
  const grid = gridSpec(scene);
  const snapped = grid ? snapTokenCenter(grid, raw.x, raw.y) : null;
  const rounded = { x: Math.round(raw.x * 100) / 100, y: Math.round(raw.y * 100) / 100 };
  return [snapped, rounded].find((p): p is Point => !!p && inside(p)) ?? raw;
}
/**
 * One edge-triggered transition per committed drag (outside→inside, token center). XY remains the
 * accepted endpoint unless the stairwell defines an arrival point. A single destination in `auto`
 * mode is appended atomically; several destinations, or `prompt` mode, stop the token in the
 * stairwell and return a prompt for the mover (G-01). Undo/redo never re-enter this function.
 *
 * G-09 (D-437): a `cross` stairwell also fires when the path passes through it. The first stairwell
 * along the path wins. Passing through stops the token just inside it and asks, or — in `auto` mode
 * with one destination — changes floor there and continues to the endpoint when the new floor's
 * walls allow (else it stays at the stop). A pass-through that cannot be used now (locked, landing
 * blocked, a wall before it) is walked over like ordinary floor, silently.
 */
export function stairMovementPlan(ops: readonly Op[], sceneById: (id: string) => SceneDocument | undefined): { ops: Op[]; prompts: StairPrompt[] } {
  const movers = new Map<string, { scene: SceneDocument; before: TokenDocument; after: TokenDocument; explicit: boolean }>();
  const editedScenes = editedLevelScenes(ops);
  const moved = new Set<string>();
  for (const op of ops) {
    if (op.kind !== "update" || op.ref.coll !== "tokens" || op.ref.parent?.coll !== "scenes") {
      if (op.kind === "update" && op.ref.parent?.coll === "scenes") moved.add(`${op.ref.coll}:${op.ref.id}`);
      continue;
    }
    moved.add(`tokens:${op.ref.id}`);
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
  const prompts: StairPrompt[] = [];
  const parentMoving = (token: TokenDocument) => {
    const parentId = (token.flags?.prefab as { parentId?: unknown } | undefined)?.parentId;
    return typeof parentId === "string" && [...moved].some((key) => key.endsWith(`:${parentId}`));
  };
  const isAuto = (regions: readonly RegionDocument[], ids: readonly string[]) => ids.every((id) => {
    const region = regions.find((r) => r._id === id);
    return !region?.stairs || stairSpec(region.stairs).mode === "auto";
  });
  for (const { scene, before, after, explicit } of movers.values()) {
    if (explicit || !before.levelId || (before.x === after.x && before.y === after.y)) continue;
    // An attached prefab part travels with its parent (below); it never takes stairs on its own.
    if (parentMoving(before)) continue;
    const source = scene.levels?.find((l) => l._id === before.levelId);
    if (!source) continue;
    const entries = stairEntries(scene, source, before, after);
    if (!entries.length) continue;
    const followers = (): Follower[] => attachedFollowers(scene, before._id, source._id).map((token) => {
      const row = movers.get(JSON.stringify([scene._id, token._id]));
      return { token, at: row ? { x: row.after.x, y: row.after.y } : { x: token.x, y: token.y } };
    });
    const z = before.elevation ?? 0;
    for (let i = 0; i < entries.length;) {
      const first = entries[i] as StairEntry;
      const group = entries.filter((e) => e.t <= first.t + 1e-6 && e.t >= first.t - 1e-6);
      i += group.length;
      if (group.some((e) => e.ends)) {
        // The move ends in a stairwell entered first: today's endpoint rule, over every stairwell
        // that holds the endpoint (overlaps combine).
        const entered = entries.filter((e) => e.ends).map((e) => e.region);
        const offered = choicesFrom(scene, source, entered);
        if (offered.locked) { prompts.push({ sceneId: scene._id, tokenId: before._id, fromLevelId: source._id, regionIds: entered.map((r) => r._id), choices: [], reason: "locked" }); break; }
        if (!offered.choices.length) break;
        if (sweepBlocked(scene, source._id, after, before, after, z)) throw new Error("A wall blocks entry to the stairs");
        const clear = clearChoices(scene, after, after, offered.choices);
        if (!clear.length) throw new Error("Stair landing overlaps a wall");
        const only = clear[0];
        if (only && clear.length === 1 && offered.choices.length === 1 && isAuto(entered, offered.regionIds)) {
          result.push(...transitionOps(scene, after, only.level, followers(), after, only.arrival ?? after));
          break;
        }
        prompts.push({ sceneId: scene._id, tokenId: before._id, fromLevelId: source._id, regionIds: offered.regionIds, ...(offered.label ? { label: offered.label } : {}),
          choices: promptChoices(source, clear) });
        break;
      }
      // G-09: passing through. Unusable right now → walk on as over ordinary floor.
      const regions = group.map((e) => e.region);
      const offered = choicesFrom(scene, source, regions);
      if (offered.locked || !offered.choices.length) continue;
      const stop = passStop(scene, group, before, after);
      if (sweepBlocked(scene, source._id, after, before, stop, z)) continue;
      const clear = clearChoices(scene, after, stop, offered.choices);
      if (!clear.length) continue;
      const only = clear[0];
      if (only && clear.length === 1 && offered.choices.length === 1 && isAuto(regions, offered.regionIds)) {
        const land = only.arrival ?? (sweepBlocked(scene, only.level._id, after, stop, after, only.level.floorZ) ? stop : after);
        result.push(...transitionOps(scene, after, only.level, followers(), after, land));
        break;
      }
      result.push(...shiftOps(scene, after, followers(), after, stop));
      prompts.push({ sceneId: scene._id, tokenId: before._id, fromLevelId: source._id, regionIds: offered.regionIds, ...(offered.label ? { label: offered.label } : {}),
        choices: promptChoices(source, clear) });
      break;
    }
  }
  return { ops: result, prompts };
}
/** Compatibility wrapper: the ops of `stairMovementPlan`, prompts discarded. */
export function stairMovementOps(ops: readonly Op[], sceneById: (id: string) => SceneDocument | undefined): Op[] {
  return stairMovementPlan(ops, sceneById).ops;
}
/** G-08: choices for a token already standing in stairs on its own floor (an explicit request). */
export function stairChoicesHere(scene: SceneDocument, token: TokenDocument, regionIds?: readonly string[]): StairPrompt {
  const source = scene.levels?.find((l) => l._id === token.levelId);
  const empty: StairPrompt = { sceneId: scene._id, tokenId: token._id, fromLevelId: token.levelId ?? "", regionIds: [], choices: [] };
  if (scene.levelMode !== "isolated" || !source) return empty;
  const standing = (scene.regions ?? []).filter((r) => {
    if (!r.stairs || (regionIds && !regionIds.includes(r._id)) || !stairSpec(r.stairs).levels.includes(source._id)) return false;
    const polygon = regionPolygon(r);
    return !!polygon && tileTriggerPolygonContains(polygon, token);
  });
  const offered = choicesFrom(scene, source, standing);
  if (offered.locked) return { ...empty, regionIds: standing.map((r) => r._id), reason: "locked" };
  return { ...empty, regionIds: offered.regionIds, ...(offered.label ? { label: offered.label } : {}),
    choices: promptChoices(source, clearChoices(scene, token, token, offered.choices)) };
}
/** Host revalidation of a chosen floor: still on the source floor, still inside, still allowed and clear. */
export function stairChoiceOps(scene: SceneDocument, prompt: Pick<StairPrompt, "tokenId" | "fromLevelId" | "regionIds">, levelId: string): Op[] {
  const token = scene.tokens.find((t) => t._id === prompt.tokenId);
  const source = scene.levels?.find((l) => l._id === prompt.fromLevelId);
  if (!token || !source || token.levelId !== source._id || scene.levelMode !== "isolated") throw new Error("That stair choice is no longer available");
  const standing = (scene.regions ?? []).filter((r) => {
    if (!r.stairs || !prompt.regionIds.includes(r._id)) return false;
    const polygon = regionPolygon(r);
    return !!polygon && tileTriggerPolygonContains(polygon, token);
  });
  const offered = choicesFrom(scene, source, standing);
  if (offered.locked) throw new Error("The stairs are locked");
  const choice = offered.choices.find((c) => c.level._id === levelId);
  if (!choice) throw new Error("That stair choice is no longer available");
  if (landingBlocked(scene, token, choice.level, choice.arrival ?? token)) throw new Error("Stair landing overlaps a wall");
  const followers = attachedFollowers(scene, token._id, source._id).map((f) => ({ token: f, at: { x: f.x, y: f.y } }));
  return transitionOps(scene, token, choice.level, followers, token, choice.arrival ?? token);
}
/** Scene copy/import re-keying for either stair version. */
export function remapStairLevels(s: StairBehavior, map: (id: string) => string, mapWall: (id: string) => string = (id) => id): StairBehavior {
  if (!("version" in s)) return { from: map(s.from), to: map(s.to) };
  return { ...s, levels: s.levels.map(map), ...(s.edges ? { edges: s.edges.map((e) => ({ from: map(e.from), to: map(e.to) })) } : {}),
    ...(s.arrivals ? { arrivals: s.arrivals.map((a) => ({ ...a, levelId: map(a.levelId) })) } : {}), ...(s.door ? { door: mapWall(s.door) } : {}) };
}
/** True when any value carries a version-2 stair behavior (capability detection). */
export function containsStairsV2(value: unknown, depth = 0): boolean {
  if (!value || typeof value !== "object" || depth > 6) return false;
  if (Array.isArray(value)) return value.some((v) => containsStairsV2(v, depth + 1));
  const record = value as Record<string, unknown>;
  const stairs = record.stairs;
  if (stairs && typeof stairs === "object" && (stairs as { version?: unknown }).version === 2) return true;
  return Object.entries(record).some(([k, v]) => k !== "stairs" && containsStairsV2(v, depth + 1));
}
/** World polygon of a stair (or any) region; null when its geometry is invalid. */
export function stairRegionPolygon(region: RegionDocument): Array<{ x: number; y: number }> | null {
  return regionPolygon(region);
}
/** Audit helper: would a one-cell body standing at `at` on `levelId` overlap that floor's walls? */
export function stairLandingBlocked(scene: SceneDocument, levelId: string, at: { x: number; y: number }, size = scene.grid?.size ?? 50): boolean {
  const level = scene.levels?.find((l) => l._id === levelId);
  if (!level) return false;
  const body = { _id: "audit", type: "token", name: "", ownership: { default: 0 }, flags: {}, system: {}, x: at.x, y: at.y, width: size * 0.8, height: size * 0.8, rotation: 0,
    img: "", hidden: false, disposition: "neutral", vision: false, light: { radius: 0, color: "#ffffff", alpha: 0 } } as TokenDocument;
  return landingBlocked(scene, body, level, at);
}
/**
 * G-16 (D-435): explicit "move to floor" for one or more tokens. Floor and feet elevation change
 * together; prefab-attached tokens travel with their parent. `elevation` is kept when it lies in the
 * destination band, otherwise the floor's Floor Z is used.
 */
export function floorMoveOps(scene: SceneDocument, tokenIds: readonly string[], levelId: string, elevation?: number): Op[] {
  const level = scene.levels?.find((l) => l._id === levelId);
  if (!level) throw new Error("That floor no longer exists");
  const z = elevation !== undefined && inElevationBand(level, elevation) ? elevation : level.floorZ;
  const parentOf = new Map(scene.tokens.map((t) => [t._id, (t.flags?.prefab as { parentId?: unknown } | undefined)?.parentId] as const));
  const chosen = new Set(tokenIds.filter((id) => parentOf.has(id)));
  for (const token of scene.tokens) {
    let at = parentOf.get(token._id);
    for (let depth = 0; typeof at === "string" && depth < 8; depth++) {
      if (tokenIds.includes(at)) { chosen.add(token._id); break; }
      at = parentOf.get(at);
    }
  }
  const parent = { coll: "scenes" as const, id: scene._id };
  return scene.tokens.filter((t) => chosen.has(t._id) && (t.levelId !== level._id || (t.elevation ?? 0) !== z))
    .map((t): Op => ({ kind: "update", ref: { coll: "tokens", id: t._id, parent }, diff: { levelId: level._id, elevation: z } }));
}
/** G-16: which floor's band holds this feet elevation (null in a gap or with no levels). */
export function floorForElevation(scene: SceneDocument, elevation: number): LevelDocument | null {
  return scene.levels?.find((l) => inElevationBand(l, elevation)) ?? null;
}
