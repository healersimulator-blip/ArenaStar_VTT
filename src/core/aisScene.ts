/** Narrow AIS scene-tag views and guarded proposals. No foreign API names or executable callbacks. */
import type { BaseDocument, DocRef, Json, SceneDocument } from "./documents";
import type { Op } from "./ops";
import { normalizeTags, tagsOf } from "./tags";

export const AIS_TAG_COLLECTIONS = ["tokens", "lights", "sounds", "templates", "tiles", "walls", "drawings", "notes", "regions"] as const;
export type AisTagCollection = (typeof AIS_TAG_COLLECTIONS)[number];
export interface AisTagView {
  ref: DocRef;
  id: string;
  name: string;
  tags: string[];
  x?: number;
  y?: number;
}
export interface AisTagSnapshot {
  seq: number;
  scene: { id: string; name: string; grid: { size: number; distance: number; units: string } };
  collections: Record<AisTagCollection, AisTagView[]>;
}
export interface AisTagUpdate {
  sceneId: string;
  collection: AisTagCollection;
  id: string;
  expectedSeq: number;
  tags: string[];
}

function visible(doc: BaseDocument): boolean {
  return (doc as BaseDocument & { hidden?: boolean }).hidden !== true;
}

/** GM-local non-hidden placeables, not a player/FOV projection. Only explicit fields,
 * never raw flags, journal contents, inventories or actor data. */
export function aisTagSnapshot(scene: SceneDocument, seq: number): AisTagSnapshot {
  const collections = Object.fromEntries(AIS_TAG_COLLECTIONS.map((coll) => [coll, []])) as unknown as AisTagSnapshot["collections"];
  let count = 0;
  for (const collection of AIS_TAG_COLLECTIONS) {
    for (const doc of scene[collection] ?? []) {
      if (!visible(doc)) continue;
      if (++count > 256) throw new Error("AIS scene-tag profile supports at most 256 visible placeables; narrow the scene");
      const located = doc as BaseDocument & { x?: number; y?: number };
      collections[collection].push({
        ref: { coll: collection, id: doc._id, parent: { coll: "scenes", id: scene._id } },
        id: doc._id, name: doc.name,
        tags: normalizeTags(tagsOf(doc)),
        ...(Number.isFinite(located.x) ? { x: located.x as number } : {}),
        ...(Number.isFinite(located.y) ? { y: located.y as number } : {}),
      });
    }
  }
  return { seq, scene: { id: scene._id, name: scene.name,
    grid: { size: scene.grid.size, distance: scene.grid.distance, units: scene.grid.units } }, collections };
}

export function parseAisTagUpdate(args: Record<string, unknown>): AisTagUpdate {
  if (Object.keys(args).some((key) => !["sceneId", "collection", "id", "expectedSeq", "tags"].includes(key)) ||
      typeof args.sceneId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(args.sceneId) ||
      typeof args.id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(args.id) ||
      !(AIS_TAG_COLLECTIONS as readonly unknown[]).includes(args.collection) ||
      !Number.isSafeInteger(args.expectedSeq) || Number(args.expectedSeq) < 0 || !Array.isArray(args.tags))
    throw new Error("Invalid AIS scene-tag proposal");
  const tags = normalizeTags(args.tags as string[]);
  if (tags.length !== args.tags.length || tags.some((tag, i) => tag !== (args.tags as unknown[])[i]))
    throw new Error("AIS tags must already be unique and trimmed");
  return { sceneId: args.sceneId, id: args.id, collection: args.collection as AisTagCollection,
    expectedSeq: Number(args.expectedSeq), tags };
}

/** Must run synchronously with the host commit. Global seq also protects query/absence reads. */
export function aisTagProposal(scene: SceneDocument | undefined, seq: number, request: AisTagUpdate): Op[] {
  if (!scene || scene._id !== request.sceneId) throw new Error("AIS scene is unavailable");
  if (seq !== request.expectedSeq) throw new Error("AIS scene snapshot is stale; refresh and retry explicitly");
  const doc = (scene[request.collection] as readonly BaseDocument[] | undefined)?.find((row) => row._id === request.id && visible(row));
  if (!doc) throw new Error("AIS tag target is not visible in this scene");
  return [{ kind: "update", ref: { coll: request.collection, id: doc._id, parent: { coll: "scenes", id: scene._id } },
    diff: { taggerTags: request.tags as Json } }];
}
