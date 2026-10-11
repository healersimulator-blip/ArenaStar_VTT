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
export function sceneMembershipError(scene: { levels?: LevelDocument[]; walls?: unknown; lights?: unknown; tokens?: unknown }): string | null {
  for (const raw of [...(Array.isArray(scene.walls) ? scene.walls : []), ...(Array.isArray(scene.lights) ? scene.lights : [])]) {
    const w = raw as WallDocument;
    if (w?.levelScope !== undefined && scene.levels === undefined) return "Scoped walls/lights require an explicit draft level collection";
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
export function levelBindings(scene: SceneDocument, levelId: string): { walls: string[]; tokens: string[]; lights: string[] } {
  return {
    lights: scene.lights.filter((w) => w.levelScope?.mode === "levels" && w.levelScope.ids.includes(levelId)).map((w) => w._id),
    walls: scene.walls.filter((w) => w.levelScope?.mode === "levels" && w.levelScope.ids.includes(levelId)).map((w) => w._id),
    tokens: scene.tokens.filter((t) => t.levelId === levelId).map((t) => t._id),
  };
}
