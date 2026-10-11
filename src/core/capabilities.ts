import { LEVEL_PLAY_FEATURE } from "./levelPlay";
import { LEVEL_NAVIGATION_FEATURE } from "./levelNavigation";
import { LEVEL_FOG_FEATURE, LEVEL_FOG_RESET_FEATURE } from "./levelFog";
/** Wire compatibility declarations, never permission grants. Missing lists mean legacy. */
import type { Role, SceneDocument } from "./documents";
import type { Op } from "./ops";
export const DRAFT_LEVELS_FEATURE = "scene-level-drafts-v1";
export const LEVEL_AMBIENT_FEATURE = "scene-level-ambient-v1";
export const LEVEL_LIGHTING_FEATURE = "scene-level-lighting-v1";
export const LEVEL_SCOPES_FEATURE = "scene-level-scopes-v1";
export const SUPPORTED_WIRE_FEATURES: readonly string[] = Object.freeze([LEVEL_PLAY_FEATURE, LEVEL_NAVIGATION_FEATURE, DRAFT_LEVELS_FEATURE, LEVEL_SCOPES_FEATURE, LEVEL_FOG_FEATURE, LEVEL_LIGHTING_FEATURE, LEVEL_AMBIENT_FEATURE, LEVEL_FOG_RESET_FEATURE]);

export function featureListError(value: unknown): string | null {
  if (value === undefined) return null;
  if (!Array.isArray(value) || value.length > 32 || new Set(value).size !== value.length ||
      !Array.from(value).every((f) => typeof f === "string" && /^[a-z][a-z0-9._-]{0,63}$/.test(f)))
    return "Capabilities must be at most 32 unique feature names (1–64 characters each)";
  return null;
}
export function opsNeedLevelDrafts(ops: readonly Op[]): boolean {
  return ops.some((op) => {
    if (!op || typeof op !== "object") return false; // ordinary schema validation owns malformed Ops
    if ((op.kind === "create" ? op.coll : op.ref?.coll) === "levels") return true;
    if (op.kind === "create" && op.coll === "scenes") return (op.data as Partial<SceneDocument> | undefined)?.levels !== undefined;
    return op.kind === "update" && op.ref?.coll === "scenes" && !!op.diff &&
      Object.keys(op.diff).some((key) => /^(?:-=)?levels(?:\.|$)/.test(key));
  });
}
export function sceneHasLevelScopes(scene: Partial<SceneDocument>): boolean {
  return (Array.isArray(scene?.lights) && scene.lights.some((w) => w?.levelScope !== undefined)) || (Array.isArray(scene?.walls) && scene.walls.some((w) => w?.levelScope !== undefined)) || (Array.isArray(scene?.tokens) && scene.tokens.some((t) => t?.levelId !== undefined));
}
function hasLevelField(value: unknown, field: string): boolean {
  return !!value && typeof value === "object" && Object.hasOwn(value, field);
}
function sceneHasAmbient(scene: Partial<SceneDocument>): boolean {
  return Array.isArray(scene?.levels) && scene.levels.some((l) => hasLevelField(l, "darkness"));
}
/** Explicit field removals also require support, so undo and historical replay stay fenced. */
function opsNeedLevelField(ops: readonly Op[], field: "darkness" | "fogEpoch" | "tileIds" | "useSceneBackground"): boolean {
  return ops.some((op) => {
    if (!op) return false;
    if (op.kind === "create") return op.coll === "levels" ? hasLevelField(op.data, field) : op.coll === "scenes" && Array.isArray((op.data as SceneDocument)?.levels) && ((op.data as SceneDocument).levels ?? []).some((l) => hasLevelField(l, field));
    if (op.kind !== "update") return false;
    if (op.ref?.coll === "levels") return Object.keys(op.diff ?? {}).some((k) => new RegExp(`^(?:-=)?${field}(?:\\.|$)`).test(k));
    if (op.ref?.coll !== "scenes") return false;
    return Object.entries(op.diff ?? {}).some(([key, value]) => {
      const path = key.replace(/^-=/, "");
      if (new RegExp(`^levels\\.\\d+\\.${field}(?:\\.|$)`).test(path)) return true;
      if (path === "levels" && Array.isArray(value)) return value.some((l) => hasLevelField(l, field));
      return /^levels\.\d+$/.test(path) && hasLevelField(value, field);
    });
  });
}
export function opsNeedLevelAmbient(ops: readonly Op[]): boolean { return opsNeedLevelField(ops, "darkness"); }
export function requiredOpFeatures(ops: readonly Op[]): string[] {
  const play = opsNeedLevelPlay(ops);
  const reset = opsNeedLevelField(ops, "fogEpoch");
  const ambient = opsNeedLevelAmbient(ops);
  const scoped = ops.some((op) => {
    if (!op) return false;
    if (op.kind === "create") {
      if (op.coll === "scenes") return sceneHasLevelScopes(op.data as SceneDocument);
      return ((op.coll === "walls" || op.coll === "lights") && Object.hasOwn(op.data ?? {}, "levelScope")) || (op.coll === "tokens" && Object.hasOwn(op.data ?? {}, "levelId"));
    }
    if (op.kind !== "update") return false;
    if (op.ref?.coll === "walls" || op.ref?.coll === "lights" || op.ref?.coll === "tokens") return Object.keys(op.diff ?? {}).some((k) => /^(?:-=)?(?:levelId|levelScope)(?:\.|$)/.test(k));
    if (op.ref?.coll !== "scenes") return false;
    return Object.entries(op.diff ?? {}).some(([k, v]) => /(?:^|\.)(?:levelId|levelScope)(?:\.|$)/.test(k.replace(/^-=/, "")) ||
      (/^(?:walls|lights|tokens)(?:\.\d+)?$/.test(k) && (Array.isArray(v) ? v : [v]).some((d) => d && typeof d === "object" && (Object.hasOwn(d, "levelId") || Object.hasOwn(d, "levelScope")))));
  });
  const lighting = ops.some((op) => !!op && (op.kind === "create" ? (op.coll === "lights" && Object.hasOwn(op.data ?? {}, "levelScope")) ||
    (op.coll === "scenes" && (Array.isArray((op.data as SceneDocument)?.lights) && (op.data as SceneDocument).lights.some((l) => l?.levelScope !== undefined))) :
    op.kind === "update" && ((op.ref?.coll === "lights" && Object.keys(op.diff ?? {}).some((k) => /^(?:-=)?levelScope(?:\.|$)/.test(k))) ||
    (op.ref?.coll === "scenes" && Object.keys(op.diff ?? {}).some((k) => /^(?:-=)?lights(?:\.|$)/.test(k)) && scoped))));
  return [...(play ? [LEVEL_PLAY_FEATURE] : []), ...(opsNeedLevelDrafts(ops) || scoped || ambient || reset ? [DRAFT_LEVELS_FEATURE] : []), ...(scoped ? [LEVEL_SCOPES_FEATURE] : []), ...(lighting ? [LEVEL_LIGHTING_FEATURE] : []), ...(ambient ? [LEVEL_AMBIENT_FEATURE] : []), ...(reset ? [LEVEL_FOG_RESET_FEATURE] : [])];
}
export function requiredWorldFeatures(scenes: readonly SceneDocument[], role: Role): string[] {
  const play = scenes.some((s) => s.levelMode === "isolated" || s.levels?.some((l) => l.tileIds !== undefined || l.useSceneBackground !== undefined) || s.regions?.some((r) => r.stairs !== undefined));
  if (role !== "GM" && role !== "ASSISTANT") return scenes.some((s) => s.levelMode === "isolated") ? [LEVEL_PLAY_FEATURE] : [];
  const scopes = scenes.some(sceneHasLevelScopes);
  return [...(play ? [LEVEL_PLAY_FEATURE] : []), ...(scopes || scenes.some((s) => s.levels !== undefined) ? [DRAFT_LEVELS_FEATURE] : []), ...(scopes ? [LEVEL_SCOPES_FEATURE] : []), ...(scenes.some((s) => s.lights?.some((l) => l.levelScope !== undefined)) ? [LEVEL_LIGHTING_FEATURE] : []), ...(scenes.some(sceneHasAmbient) ? [LEVEL_AMBIENT_FEATURE] : []), ...(scenes.some((s) => s.levels?.some((l) => l.fogEpoch !== undefined)) ? [LEVEL_FOG_RESET_FEATURE] : [])];
}

export function opsNeedLevelPlay(ops: readonly Op[]): boolean {
  if (opsNeedLevelField(ops, "tileIds") || opsNeedLevelField(ops, "useSceneBackground")) return true;
  return ops.some((op) => {
    if (op.kind === "create") return (op.coll === "regions" && Object.hasOwn(op.data, "stairs")) || (op.coll === "scenes" && ((op.data as SceneDocument).levelMode !== undefined || (op.data as SceneDocument).regions?.some((r) => r.stairs !== undefined)));
    if (op.kind !== "update") return false;
    return (op.ref.coll === "regions" && Object.keys(op.diff).some((k) => /^(?:-=)?stairs(?:\.|$)/.test(k))) || (op.ref.coll === "scenes" && Object.entries(op.diff).some(([k, v]) => /^(?:-=)?levelMode(?:\.|$)/.test(k) || /^regions(?:\.|$)/.test(k) && JSON.stringify(v).includes('"stairs"')));
  });
}
