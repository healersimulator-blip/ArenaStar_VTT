import type {
  BaseDocument,
  DocRef,
  RegionDocument,
  SceneDocument,
} from "./documents";
import type { Op } from "./ops";
import { applyDiff } from "./diff";
import { regionGeometryError } from "./regionGeometry";
import { RAISED_MAX_AREAS } from "./raisedAreas";

/** Bound native-cover work before allocating GPU masks; legacy scenes remain optional. */
export function sceneRegionsError(scene: { regions?: unknown }): string | null {
  if (scene.regions === undefined) return null;
  if (!Array.isArray(scene.regions)) return "scene regions must be an array";
  let covers = 0,
    vertices = 0,
    raised = 0;
  for (const raw of scene.regions) {
    const error = regionGeometryError(raw);
    if (error) return error;
    const region = raw as RegionDocument;
    if (region.raised && ++raised > RAISED_MAX_AREAS) return `scene raised-area budget is ${RAISED_MAX_AREAS} regions`;
    if (!region.fauxOverhead) continue;
    covers++;
    vertices +=
      region.fauxOverhead.footprint?.components.reduce(
        (n, c) =>
          n + c.outer.length + c.holes.reduce((sum, h) => sum + h.length, 0),
        0,
      ) ?? region.shape.points.length;
    if (covers > 128 || vertices > 4096)
      return "scene Faux Overhead budget is 128 regions / 4096 vertices";
  }
  return null;
}

/** Validate the FINAL staged region state, including dotted edits and whole-scene replacement.
 * Existing host permissions/store preflight still validate every individual operation.
 */
export function regionTransactionError(
  ops: readonly Op[],
  resolve: (ref: DocRef) => BaseDocument | undefined,
): string | null {
  const scenes = new Map<string, SceneDocument>();
  for (const op of ops) {
    const coll = op.kind === "create" ? op.coll : op.ref.coll;
    if (coll !== "scenes" && coll !== "regions") continue;
    const ref =
      op.kind === "create"
        ? {
            coll: op.coll,
            id: op.data._id,
            ...(op.parent ? { parent: op.parent } : {}),
          }
        : op.ref;
    const sceneRef = coll === "scenes" ? ref : ref.parent;
    if (!sceneRef || sceneRef.coll !== "scenes") continue;
    if (coll === "scenes" && op.kind === "create") {
      scenes.set(ref.id, structuredClone(op.data) as SceneDocument);
      continue;
    }
    const source =
      scenes.get(sceneRef.id) ??
      (resolve(sceneRef) as SceneDocument | undefined);
    if (!source) continue; // Missing parent is rejected by the store, not fabricated here.
    let scene = structuredClone(source);
    if (coll === "scenes") {
      if (op.kind === "delete") {
        scenes.delete(sceneRef.id);
        continue;
      }
      if (op.kind === "update") {
        const applied = applyDiff(scene, op.diff);
        if (!applied.ok) return applied.error;
        scene = applied.value;
      }
    } else {
      if (scene.regions !== undefined && !Array.isArray(scene.regions))
        return "scene regions must be an array";
      const rows = scene.regions ?? [];
      const index = rows.findIndex((r) => r._id === ref.id);
      if (op.kind === "create")
        rows.push(structuredClone(op.data) as RegionDocument);
      else if (index >= 0 && op.kind === "delete") rows.splice(index, 1);
      else if (index >= 0 && op.kind === "update") {
        const row = rows[index];
        if (!row) return "missing region";
        const applied = applyDiff(row, op.diff);
        if (!applied.ok) return applied.error;
        rows[index] = applied.value;
      }
      scene.regions = rows;
    }
    scenes.set(sceneRef.id, scene);
  }
  for (const scene of scenes.values()) {
    const error = sceneRegionsError(scene);
    if (error) return error;
  }
  return null;
}
