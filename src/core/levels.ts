import { levelPlayError } from "./levelPlay";
/** Draft-only level contracts. No migration, token movement or physical activation is implicit. */
import type { BaseDocument, DocRef, LevelDocument, SceneDocument } from "./documents";
import type { Op } from "./ops";
import { sceneMembershipError, isScopedCollection } from "./levelMembership";
import { applyDiff } from "./diff";
import { elevationBandError, inElevationBand } from "./multilevelGeometry";
export const MAX_LEVELS = 32;
const idPattern = /^[A-Za-z0-9_-]{1,128}$/;

export function sceneLevelsError(scene: { levels?: unknown; walls?: unknown; lights?: unknown; tokens?: unknown; tiles?: unknown; regions?: unknown; levelMode?: unknown; drawings?: unknown; templates?: unknown; notes?: unknown }): string | null {
  if (scene.levels === undefined && (scene.levelMode !== undefined || (Array.isArray(scene.regions) && scene.regions.some((r) => r?.stairs !== undefined)))) return "Floor play and stairs require levels";
  if (scene.levels === undefined) return sceneMembershipError({ walls: scene.walls, lights: scene.lights, tokens: scene.tokens, regions: scene.regions, drawings: scene.drawings, templates: scene.templates, notes: scene.notes });
  if (!Array.isArray(scene.levels) || scene.levels.length > MAX_LEVELS) return "Scene needs an array of at most 32 draft levels";
  const ids = new Set<string>();
  for (const raw of scene.levels) {
    const l = raw as LevelDocument | undefined;
    if (!l || l.type !== "level" || typeof l._id !== "string" || !idPattern.test(l._id) || ids.has(l._id)) return "Invalid or duplicate level identity";
    ids.add(l._id);
    if (typeof l.name !== "string" || !l.name.trim() || l.name.length > 128) return "Level name needs 1–128 characters";
    if (l.darkness !== undefined && (typeof l.darkness !== "number" || !Number.isFinite(l.darkness) || l.darkness < 0 || l.darkness > 1)) return "Level darkness must be a finite number from 0 to 1, or absent to inherit";
    if (l.fogEpoch !== undefined && (typeof l.fogEpoch !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(l.fogEpoch))) return "Invalid level fog epoch";
    const bandError = elevationBandError(l);
    if (bandError) return bandError;
    if (!Number.isFinite(l.floorZ) || Math.abs(l.floorZ) > 1_000_000 || !inElevationBand(l, l.floorZ)) return "Level floor must be finite and inside its elevation band";
    if (!Number.isSafeInteger(l.sort) || Math.abs(l.sort) > 1_000_000) return "Level display order must be a bounded integer";
    if (!Array.isArray(l.visibleLevelIds) || l.visibleLevelIds.length > MAX_LEVELS ||
        new Set(l.visibleLevelIds).size !== l.visibleLevelIds.length || !Array.from(l.visibleLevelIds).every((id) => typeof id === "string" && idPattern.test(id))) return "Invalid level visibility references";
    if (!l.ownership || typeof l.ownership !== "object" || Array.isArray(l.ownership) ||
        ![0, 1, 2, 3].includes(l.ownership.default) || !Object.values(l.ownership).every((n) => [0, 1, 2, 3].includes(n)) ||
        !l.flags || typeof l.flags !== "object" || Array.isArray(l.flags) || !l.system || typeof l.system !== "object" || Array.isArray(l.system)) return "Invalid level base fields";
  }
  const levels = scene.levels as LevelDocument[];
  for (const l of levels) if (l.visibleLevelIds.some((id) => !ids.has(id))) return "Level visibility references a missing level";
  const sorted = [...levels].sort((a, b) => (a.bottom ?? -Infinity) - (b.bottom ?? -Infinity));
  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1], next = sorted[i];
    if (prev && next && (prev.top === null || next.bottom === null || prev.top > next.bottom)) return "Draft level elevation bands overlap";
  }
  const playError = levelPlayError(scene); if (playError) return playError;
  return sceneMembershipError({ ...scene, levels });
}

export function draftLevel(id: string, name: string, bottom = 0, top: number | null = 10, sort = 0): LevelDocument {
  return { _id: id, type: "level", name, ownership: { default: 0 }, flags: {}, system: {}, bottom, top, floorZ: bottom, sort, visibleLevelIds: [] };
}
/** Audit only: gaps and unresolved legacy feet elevations are not automatically repaired. */
export function levelDraftAudit(scene: Pick<SceneDocument, "levels" | "tokens"> & Partial<Pick<SceneDocument, "tiles">>): string[] {
  const error = sceneLevelsError(scene);
  if (error) return [error];
  const levels = [...(scene.levels ?? [])].sort((a, b) => (a.bottom ?? -Infinity) - (b.bottom ?? -Infinity));
  if (!levels.length) return ["No draft levels. The scene retains its implicit legacy base."];
  const warnings: string[] = [];
  for (let i = 1; i < levels.length; i++) {
    const a = levels[i - 1], b = levels[i];
    if (a && b && a.top !== null && b.bottom !== null && a.top < b.bottom) warnings.push(`Elevation gap between ${a.name} and ${b.name}.`);
  }
  const outside = scene.tokens.filter((t) => !levels.some((l) => inElevationBand(l, t.elevation ?? 0))).length;
  if (outside) warnings.push(`${outside} token(s) have feet elevations outside every draft band. No tokens were moved.`);
  return warnings;
}

/** Final staged validation makes reference removal and adjacent band edits atomic. */
export function levelTransactionError(ops: readonly Op[], resolve: (ref: DocRef) => BaseDocument | undefined): string | null {
  const scenes = new Map<string, SceneDocument>();
  for (const op of ops) {
    const coll = op.kind === "create" ? op.coll : op.ref.coll;
    if (coll !== "scenes" && coll !== "levels" && coll !== "tokens" && coll !== "tiles" && !isScopedCollection(coll)) continue;
    const ref: DocRef = op.kind === "create" ? { coll, id: op.data._id, ...(op.parent ? { parent: op.parent } : {}) } : op.ref;
    const parent = coll === "scenes" ? ref : ref.parent;
    if (!parent || parent.coll !== "scenes" || parent.parent) return "Levels require a direct scene parent";
    if (coll === "scenes" && op.kind === "delete") { scenes.delete(ref.id); continue; }
    if (coll === "scenes" && op.kind === "create") { scenes.set(ref.id, structuredClone(op.data) as SceneDocument); continue; }
    const source = scenes.get(parent.id) ?? resolve(parent) as SceneDocument | undefined;
    if (!source) continue; // Store preflight rejects missing parents.
    // Presentation kinds (G-06) are validated only when their scope changes, so ordinary
    // drawing/template/note edits cost what they did before floor scopes existed.
    const presentation = coll === "drawings" || coll === "templates" || coll === "notes";
    if ((coll === "tokens" || isScopedCollection(coll)) && (source.levels === undefined || presentation)) {
      const field = coll === "tokens" ? "levelId" : "levelScope";
      const touched = op.kind === "create" ? Object.hasOwn(op.data, field) : op.kind === "update" &&
        Object.keys(op.diff).some((key) => key.replace(/^-=/, "").split(".")[0] === field);
      if (!touched) continue;
    }
    let scene = structuredClone(source);
    if (coll === "scenes" && op.kind === "update") {
      const applied = applyDiff(scene, op.diff); if (!applied.ok) return applied.error;
      scene = applied.value;
    } else if (coll === "levels" || coll === "tokens" || coll === "tiles" || isScopedCollection(coll)) {
      if (scene[coll] !== undefined && !Array.isArray(scene[coll])) return "Scene embedded records must be arrays";
      const rows: BaseDocument[] = [...(scene[coll] ?? [])], index = rows.findIndex((l) => l._id === ref.id);
      if (op.kind === "create") rows.push(structuredClone(op.data));
      else if (index >= 0 && op.kind === "delete") rows.splice(index, 1);
      else if (index >= 0 && op.kind === "update") {
        const row = rows[index]; if (!row) return "Missing draft level";
        const applied = applyDiff(row, op.diff); if (!applied.ok) return applied.error;
        rows[index] = applied.value;
      }
      scene = { ...scene, [coll]: rows };
    }
    scenes.set(parent.id, scene);
  }
  for (const scene of scenes.values()) { const error = sceneLevelsError(scene); if (error) return error; }
  return null;
}

/** Minimal field diffs preserve concurrent unrelated metadata/other levels. */
export function levelDraftOps(sceneId: string, before: readonly LevelDocument[], after: readonly LevelDocument[], tiles: SceneDocument["tiles"] = []): Op[] {
  const error = sceneLevelsError({ levels: after, tiles });
  if (error) throw new Error(error);
  const parent: DocRef = { coll: "scenes", id: sceneId }, ops: Op[] = [];
  const fields = ["name", "bottom", "top", "floorZ", "sort", "visibleLevelIds"] as const;
  for (const previous of before) if (!after.some((l) => l._id === previous._id)) ops.push({ kind: "delete", ref: { coll: "levels", id: previous._id, parent } });
  for (const next of after) {
    const previous = before.find((l) => l._id === next._id);
    if (!previous) { ops.push({ kind: "create", coll: "levels", parent, data: structuredClone(next) }); continue; }
    const diff: Record<string, import("./documents").Json> = {};
    for (const field of fields) if (JSON.stringify(previous[field]) !== JSON.stringify(next[field])) diff[field] = structuredClone(next[field]);
    for (const field of ["tileIds", "useSceneBackground"] as const) if (JSON.stringify(next[field]) !== JSON.stringify(previous[field])) {
      if (next[field] === undefined) diff[`-=${field}`] = null; else diff[field] = next[field];
    }
    if (next.darkness !== previous.darkness) {
      if (next.darkness === undefined) diff["-=darkness"] = null;
      else diff.darkness = next.darkness;
    }
    if (Object.keys(diff).length) ops.push({ kind: "update", ref: { coll: "levels", id: next._id, parent }, diff });
  }
  return ops;
}

/**
 * G-28 (D-436): a ready stack of floors. Ground starts at 0; floors above it, basements below, each
 * `height` tall, plus an optional unbounded roof band. IDs come from the caller; nothing is saved.
 */
export function generateLevels(spec: { floors: number; basements: number; height: number; roof?: boolean; id: () => string }): LevelDocument[] {
  const { floors, basements, height } = spec;
  if (!Number.isInteger(floors) || floors < 1 || floors > 16 || !Number.isInteger(basements) || basements < 0 || basements > 8 ||
      !Number.isFinite(height) || height <= 0 || height > 10_000 || floors + basements + (spec.roof ? 1 : 0) > MAX_LEVELS)
    throw new Error("Choose 1–16 floors, 0–8 basements and a positive floor height");
  const rows: LevelDocument[] = [];
  for (let b = basements; b >= 1; b--) rows.push(draftLevel(spec.id(), basements === 1 ? "Basement" : `Basement ${b}`, -b * height, (1 - b) * height));
  for (let f = 0; f < floors; f++) rows.push(draftLevel(spec.id(), f === 0 ? "Ground" : `Floor ${f + 1}`, f * height, (f + 1) * height));
  if (spec.roof) rows.push(draftLevel(spec.id(), "Roof", floors * height, null));
  return rows.map((l, sort) => ({ ...l, sort }));
}
