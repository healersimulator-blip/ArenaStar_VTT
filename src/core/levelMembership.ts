/** Authoring membership and topology. Never use these filters as physical collision filters. */
import type { LevelDocument, LevelScope, SceneDocument, WallDocument } from "./documents";
import { inElevationBand } from "./multilevelGeometry";
import type { Op } from "./ops";
export function levelScopeError(scope: unknown, levels: readonly LevelDocument[]): string | null {
  if (scope === undefined) return null;
  if (!scope || typeof scope !== "object" || Array.isArray(scope)) return "Invalid level scope";
  const s = scope as LevelScope;
  if (s.mode === "all") return Object.keys(s).length === 1 ? null : "All-level scope cannot contain IDs";
  if (s.mode !== "levels" || !Array.isArray(s.ids) || !s.ids.length || s.ids.length > 32 || new Set(s.ids).size !== s.ids.length ||
      !Array.from(s.ids).every((id) => typeof id === "string" && levels.some((l) => l._id === id))) return "Scope requires distinct existing level IDs";
  return null;
}
export function wallTopologyKey(w: Pick<WallDocument, "levelScope">): string {
  return w.levelScope === undefined ? "legacy" : w.levelScope.mode === "all" ? "all" : JSON.stringify([...w.levelScope.ids].sort());
}
/** Null is the legacy/unassigned editing partition; '*' deliberately edits all-level walls. */
export function wallsForAuthoring(walls: readonly WallDocument[], level: string | null): WallDocument[] {
  return walls.filter((w) => level === null ? w.levelScope === undefined : level === "*" ? w.levelScope?.mode === "all" :
    w.levelScope?.mode === "levels" && w.levelScope.ids.includes(level));
}
/** Scene collections that carry an authoring floor scope. G-06 (D-432) adds the presentation kinds. */
export const SCOPED_COLLECTIONS = ["walls", "lights", "regions", "drawings", "templates", "notes"] as const;
export type ScopedCollection = typeof SCOPED_COLLECTIONS[number];
export function isScopedCollection(coll: string): coll is ScopedCollection {
  return (SCOPED_COLLECTIONS as readonly string[]).includes(coll);
}
type ScopedScene = { levels?: LevelDocument[]; tokens?: unknown } & { [K in ScopedCollection]?: unknown };
export function sceneMembershipError(scene: ScopedScene): string | null {
  for (const coll of SCOPED_COLLECTIONS) for (const raw of Array.isArray(scene[coll]) ? scene[coll] as unknown[] : []) {
    const w = raw as { levelScope?: unknown } | null;
    if (w?.levelScope !== undefined && scene.levels === undefined) return "Scoped objects require an explicit draft level collection";
    const error = levelScopeError(w?.levelScope, scene.levels ?? []); if (error) return error;
  }
  for (const raw of Array.isArray(scene.tokens) ? scene.tokens : []) {
    const t = raw as { levelId?: unknown; elevation?: number };
    if (t?.levelId === undefined) continue;
    const l = scene.levels?.find((l) => l._id === t.levelId);
    if (typeof t.levelId !== "string" || !l) return "Token membership references a missing level";
    if (!inElevationBand(l, t.elevation ?? 0)) return "Token level and feet elevation must agree in the same transaction";
  }
  return null;
}
/** Explicit relocation: stable membership and absolute feet elevation in one update. */
export function tokenLevelAssignment(scene: SceneDocument, tokenId: string, levelId: string): Op {
  const level = scene.levels?.find((l) => l._id === levelId);
  if (!level || !scene.tokens.some((t) => t._id === tokenId)) throw new Error("Token or destination level does not exist");
  return { kind: "update", ref: { coll: "tokens", id: tokenId, parent: { coll: "scenes", id: scene._id } }, diff: { levelId, elevation: level.floorZ } };
}
/** Removing a level is explicit: callers must reassign or clear every binding first. */
export function levelBindings(scene: SceneDocument, levelId: string): { tokens: string[] } & Record<ScopedCollection, string[]> {
  const scoped = (rows: ReadonlyArray<{ _id: string; levelScope?: LevelScope }> | undefined) =>
    (rows ?? []).filter((w) => w.levelScope?.mode === "levels" && w.levelScope.ids.includes(levelId)).map((w) => w._id);
  return {
    lights: scoped(scene.lights), walls: scoped(scene.walls), regions: scoped(scene.regions),
    drawings: scoped(scene.drawings), templates: scoped(scene.templates), notes: scoped(scene.notes),
    tokens: scene.tokens.filter((t) => t.levelId === levelId).map((t) => t._id),
  };
}
/** True when an object with this scope is drawn on `levelId` (absent scope = every floor). */
export function scopeIncludes(scope: LevelScope | undefined, levelId: string): boolean {
  return scope === undefined || scope.mode === "all" || scope.ids.includes(levelId);
}
