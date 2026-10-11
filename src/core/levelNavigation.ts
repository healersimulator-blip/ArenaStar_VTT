import { floorPresentation, type FloorPresentation } from "./levelPlay";
import { tokensSeenBelow } from "./crossFloorSight";
/** Floor focus is presentation, not secret-floor disclosure or movement authority. */
import type { ActorDocument, BaseDocument, SceneDocument } from "./documents";
import { docVisibleTo } from "./projection";
import type { PermissionUser } from "./ownership";
import { can } from "./permissions";
export const LEVEL_NAVIGATION_FEATURE = "scene-level-navigation-v1";
export interface LevelFocusView {
  isolated?: boolean;
  followTokenId?: string;
  presentation?: FloorPresentation;
  levels: Array<{ id: string; name: string }>;
  levelId: string | null;
  tokenIds: string[] | null;
}
/** Only token owners (including actor ownership) learn their assigned floor names. */
export function levelFocusView(scene: SceneDocument | undefined, actors: readonly ActorDocument[], user: PermissionUser, requested: string | null, followTokenId?: string): LevelFocusView {
  const empty: LevelFocusView = { levels: [], levelId: null, tokenIds: null };
  if (!scene || !can(user, "read", scene, "scenes")) return empty;
  const owned = scene.tokens.filter((t) => !t.hidden && (can(user, "update", t, "tokens", { parent: scene }) ||
    actors.some((a) => a._id === t.actorId && can(user, "update", a, "actors"))));
  // G-12 (D-434): a GM/assistant may focus any floor (their build floor), even an empty one.
  const gm = user.role === "GM" || user.role === "ASSISTANT";
  const levels = (scene.levels ?? []).filter((l) => gm || owned.some((t) => t.levelId === l._id))
    .sort((a, b) => a.sort - b.sort || a._id.localeCompare(b._id)).map((l) => ({ id: l._id, name: l.name }));
  const isolated = scene.levelMode === "isolated";
  const follow = owned.find((t) => t._id === followTokenId && levels.some((l) => l.id === t.levelId)) ?? [...owned].sort((a, b) => a._id.localeCompare(b._id)).find((t) => levels.some((l) => l.id === t.levelId));
  const levelId = levels.some((l) => l.id === requested) ? requested : isolated ? follow?.levelId ?? null : null;
  const level = scene.levels?.find((l) => l._id === levelId);
  const presentation = level ? floorPresentation(scene, level) : undefined;
  if (presentation) presentation.tileIds = presentation.tileIds.filter((id) => scene.tiles.some((t) => t._id === id && !t.hidden && can(user, "read", t, "tiles", { parent: scene })));
  if (presentation?.offFloor) {
    // Only IDs this viewer already receives (projection rules: hidden regions, pin visibility, ownership).
    const readable = (rows: readonly BaseDocument[] | undefined) => new Set((rows ?? []).filter((d) => docVisibleTo(user, d, scene)).map((d) => d._id));
    const { regions, drawings, templates, notes } = presentation.offFloor;
    const r = readable(scene.regions), d = readable(scene.drawings), t = readable(scene.templates), n = readable(scene.notes);
    presentation.offFloor = { regions: regions.filter((id) => r.has(id)), drawings: drawings.filter((id) => d.has(id)), templates: templates.filter((id) => t.has(id)), notes: notes.filter((id) => n.has(id)) };
  }
  // G-20 (D-445): tokens below that this viewer's own vision tokens see through the openings.
  if (presentation && level && isolated && presentation.below?.length) {
    const belowTokens = tokensSeenBelow(scene, actors, user, level._id);
    if (belowTokens.length) presentation.belowTokens = belowTokens;
  }
  const extra = isolated ? { isolated: true, ...(follow ? { followTokenId: follow._id } : {}), ...(presentation ? { presentation } : {}) } : {};
  return { ...extra, levels, levelId, tokenIds: levelId === null ? (isolated ? [] : null) : scene.tokens.filter((t) => t.levelId === levelId && !t.hidden && can(user, "read", t, "tokens", { parent: scene })).map((t) => t._id).sort() };
}
/** Intersect with ordinary fog; focus can only hide, never reveal a token. */
export function focusedTokenIds(view: LevelFocusView | null, fog: ReadonlySet<string> | null): ReadonlySet<string> | null {
  return view?.tokenIds ? new Set(view.tokenIds.filter((id) => fog === null || fog.has(id))) : fog;
}
