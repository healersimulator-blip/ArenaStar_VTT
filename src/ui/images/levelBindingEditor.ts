import type { LevelScope, SceneDocument, WallDocument } from "../../core/documents";
import type { Op } from "../../core/ops";
import { levelScopeError, tokenLevelAssignment, wallTopologyKey, type ScopedCollection } from "../../core/levelMembership";
import { wallEditLocked } from "../../core/wallEditing";

/** G-06 (D-432): drawings, templates, notes and regions are scoped like walls and lights. */
export type BindingKind = "tokens" | ScopedCollection;
export function bindingRows(scene: SceneDocument, kind: BindingKind): ReadonlyArray<{ _id: string; name: string; type: string; levelScope?: LevelScope; levelId?: string; flags: Record<string, unknown> }> {
  return (scene[kind] ?? []) as ReadonlyArray<{ _id: string; name: string; type: string; levelScope?: LevelScope; levelId?: string; flags: Record<string, unknown> }>;
}
/** Local stale-editor fence, not a host compare-and-swap or physical authorization. */
export function bindingRevision(scene: SceneDocument, kind: BindingKind, id: string): string {
  return JSON.stringify([scene._id, scene.levels, bindingRows(scene, kind).find((doc) => doc._id === id)]);
}
export function planTokenBinding(scene: SceneDocument, id: string, levelId: string | null): Op[] {
  const token = scene.tokens.find((doc) => doc._id === id);
  if (!token) throw new Error("Token no longer exists. Reload the selection.");
  if (token.flags.prefab !== undefined || token.flags.summon !== undefined)
    throw new Error("Attached or summoned tokens must be edited through their owning workflow.");
  if (levelId === null) return token.levelId === undefined ? [] : [{ kind: "update", ref: { coll: "tokens", id, parent: { coll: "scenes", id: scene._id } }, diff: { "-=levelId": null } }];
  const op = tokenLevelAssignment(scene, id, levelId);
  const level = scene.levels?.find((l) => l._id === levelId);
  return token.levelId === levelId && (token.elevation ?? 0) === level?.floorZ ? [] : [op];
}
export function planWallBinding(scene: SceneDocument, id: string, scope: LevelScope | undefined, kind: ScopedCollection = "walls"): Op[] {
  const wall = bindingRows(scene, kind).find((doc) => doc._id === id);
  if (!wall) throw new Error(`${kind === "walls" ? "Wall" : "Object"} no longer exists. Reload the selection.`);
  if (wall.flags.prefab !== undefined || (kind === "walls" && wallEditLocked(wall as unknown as WallDocument))) throw new Error("Locked or prefab objects cannot be reassigned here.");
  if (scope !== undefined && scene.levels === undefined) throw new Error("Save draft levels before assigning a floor scope.");
  const error = levelScopeError(scope, scene.levels ?? []);
  if (error) throw new Error(error);
  if (wallTopologyKey(wall) === wallTopologyKey(scope === undefined ? {} : { levelScope: scope })) return [];
  return [{ kind: "update", ref: { coll: kind, id, parent: { coll: "scenes", id: scene._id } },
    diff: scope === undefined ? { "-=levelScope": null } : { levelScope: scope.mode === "all" ? { mode: "all" } : { mode: "levels", ids: [...scope.ids].sort() } } }];
}
