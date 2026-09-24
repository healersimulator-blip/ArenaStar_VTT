/**
 * GM-owned, data-only multi-layer prefab placement. The host plans fresh IDs,
 * scene-local Tagger rules and EVERY internal graph reference before committing
 * a single undoable envelope. The template is never sent to player replicas.
 * Saved parent/lock metadata drives host-side atomic token/tile-parent movement
 * and subtree deletion. This is not Token Attacher's full attachment editor.
 */
import type {
  AutomationDocument, BaseDocument, DocRef, DrawingDocument, LightDocument,
  NoteDocument, SceneDocument, SoundDocument, TemplateDocument, TileDocument, TokenDocument,
  WallDocument, WorldCollections,
} from "./documents";
import type { Op } from "./ops";
import { applyDiff } from "./diff";
import { validateAutomation, type AutomationDefinition, type AutomationSelector, type AutomationStep,
  type AutomationTileTarget } from "./automation";
import { normalizeTags, tagsOf, TAGGABLE_COLLECTIONS } from "./tags";

export const PREFAB_COLLECTIONS = ["tokens", "tiles", "walls", "lights", "sounds", "drawings", "templates", "notes"] as const;
export type PrefabCollection = (typeof PREFAB_COLLECTIONS)[number];
export type PrefabPlaceable = TokenDocument | TileDocument | WallDocument | LightDocument |
  SoundDocument | DrawingDocument | TemplateDocument | NoteDocument;
export interface PrefabPart {
  /** Source scene-local ID, not a player-visible or permanent placement ID. */
  id: string;
  coll: PrefabCollection;
  parentId?: string;
  locked?: boolean;
  doc: PrefabPlaceable;
}
export interface PrefabGraph { id: string; doc: AutomationDocument }
export interface PrefabDefinition {
  version: 1;
  sourceSceneId: string;
  gridSize: number;
  origin: { x: number; y: number };
  parts: PrefabPart[];
  graphs: PrefabGraph[];
}
export interface PrefabPlacement {
  at: { x: number; y: number };
  rotation?: number;
  scale?: number;
}
export interface PrefabPlan {
  ops: Op[];
  instanceId: string;
  rootId: string;
  tags: string[];
  /** Source id → fresh scene-local id (GM-only result). */
  ids: Record<string, string>;
}
export type PrefabResult = { ok: true; plan: PrefabPlan } | { ok: false; error: string };

const ID = /^[A-Za-z0-9_-]{1,128}$/;
const HASH = /^[0-9a-f]{64}$/;
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const keys = (v: Record<string, unknown>, allowed: readonly string[]) => Object.keys(v).every((k) => allowed.includes(k));
const finite = (v: unknown, min: number, max: number): v is number => typeof v === "number" && Number.isFinite(v) && v >= min && v <= max;
const point = (v: unknown): v is { x: number; y: number } => object(v) && keys(v, ["x", "y"]) &&
  finite(v.x, -1e6, 1e6) && finite(v.y, -1e6, 1e6);
const label = (v: unknown) => typeof v === "string" && v.length > 0 && v.length <= 256;
const TYPE: Record<PrefabCollection, string> = { tokens: "token", tiles: "tile", walls: "wall",
  lights: "light", sounds: "sound", drawings: "drawing", templates: "template", notes: "note" };

/** Reject imported/GM-authored malformed templates before any placement or write. */
export function validatePrefab(value: unknown): { ok: true; definition: PrefabDefinition } | { ok: false; error: string } {
  const bad = (error: string) => ({ ok: false as const, error });
  if (!object(value) || !keys(value, ["version", "sourceSceneId", "gridSize", "origin", "parts", "graphs"]) ||
      value.version !== 1 || typeof value.sourceSceneId !== "string" || !ID.test(value.sourceSceneId) ||
      !finite(value.gridSize, 1, 1000) || !point(value.origin) || !Array.isArray(value.parts) ||
      value.parts.length < 1 || value.parts.length > 64 || !Array.isArray(value.graphs) || value.graphs.length > 32)
    return bad("prefab needs version 1, source scene/grid/origin, 1–64 parts and ≤32 graphs");
  try { if (JSON.stringify(value).length > 300_000) return bad("prefab exceeds 300 KiB"); }
  catch { return bad("prefab must be serializable"); }
  const parts = value.parts as unknown[];
  const partIds = new Set<string>();
  let roots = 0;
  for (const part of parts) {
    if (!object(part) || !keys(part, ["id", "coll", "parentId", "locked", "doc"]) ||
        typeof part.id !== "string" || !ID.test(part.id) || partIds.has(part.id) ||
        !PREFAB_COLLECTIONS.includes(part.coll as PrefabCollection) ||
        (part.parentId !== undefined && (typeof part.parentId !== "string" || !ID.test(part.parentId))) ||
        (part.locked !== undefined && typeof part.locked !== "boolean") ||
        !object(part.doc) || part.doc._id !== part.id || part.doc.type !== TYPE[part.coll as PrefabCollection] ||
        !label(part.doc.name) || !object(part.doc.ownership) || !object(part.doc.flags) || !object(part.doc.system))
      return bad("prefab part has invalid ID, collection, document or flags");
    if (part.parentId === undefined) roots++;
    partIds.add(part.id);
    const doc = part.doc;
    try { normalizeTags(tagsOf(doc as unknown as BaseDocument)); }
    catch { return bad("prefab has invalid tag template"); }
    if (part.coll === "walls") {
      if (!Array.isArray(doc.c) || doc.c.length !== 4 || !doc.c.every((n: unknown) => finite(n, -1e6, 1e6)))
        return bad("prefab wall endpoints are invalid");
    } else if (part.coll === "drawings") {
      if (!Array.isArray(doc.points) || doc.points.length > 2048 || doc.points.length % 2 !== 0 ||
          doc.points.some((n: unknown) => !finite(n, -1e6, 1e6)) ||
          (doc.box !== null && (!Array.isArray(doc.box) || doc.box.length !== 4 ||
            doc.box.some((n: unknown) => !finite(n, -1e6, 1e6))))) return bad("prefab drawing geometry invalid");
    } else if (!finite(doc.x, -1e6, 1e6) || !finite(doc.y, -1e6, 1e6))
      return bad("prefab part needs finite scene coordinates");
    if ((part.coll === "tiles" || part.coll === "tokens") &&
        (!finite(doc.width, 1, 1e5) || !finite(doc.height, 1, 1e5) ||
         (doc.rotation !== undefined && !finite(doc.rotation, -360, 360))))
      return bad("prefab tile/token size or rotation invalid");
  }
  if (roots !== 1) return bad("prefab must have exactly one root");
  const parents = new Map(parts.map((p) => [(p as PrefabPart).id, (p as PrefabPart).parentId]));
  for (const id of partIds) {
    let at: string | undefined = id;
    const visited = new Set<string>();
    while (at) {
      if (!parents.has(at) || visited.has(at) || visited.size > 8)
        return bad("prefab has an orphan, cycle or nesting deeper than 8");
      visited.add(at);
      at = parents.get(at);
    }
  }
  const graphIds = new Set<string>();
  for (const valueGraph of value.graphs as unknown[]) {
    if (!object(valueGraph) || !keys(valueGraph, ["id", "doc"]) || typeof valueGraph.id !== "string" ||
        !ID.test(valueGraph.id) || graphIds.has(valueGraph.id) || !object(valueGraph.doc) ||
        valueGraph.doc._id !== valueGraph.id || valueGraph.doc.type !== "automation" ||
        !label(valueGraph.doc.name) || valueGraph.doc.state !== undefined) return bad("invalid prefab graph");
    graphIds.add(valueGraph.id);
    const checked = validateAutomation(valueGraph.doc.definition);
    if (!checked.ok || checked.definition.sceneId !== value.sourceSceneId ||
        !parts.some((p) => (p as PrefabPart).id === checked.definition.tileId && (p as PrefabPart).coll === "tiles"))
      return bad("prefab graph needs an included tile from its source scene");
  }
  return { ok: true, definition: value as unknown as PrefabDefinition };
}

/**
 * Allocation is scene-wide across ALL placeable collections, never per type.
 * A shared ordinal covers all `{#}` tags of this instance. Source tags remain
 * unchanged; the next placement reads the newly committed scene and picks n+1.
 */
function allocateTags(scene: SceneDocument, parts: PrefabPart[], ids: Record<string, string>):
  | { ok: true; tagsByPart: Map<string, string[]>; bindings: Map<string, Array<{ coll: PrefabCollection; tag: string }>>; tags: string[] }
  | { ok: false; error: string } {
  const existing = new Set(TAGGABLE_COLLECTIONS.flatMap((coll) => (scene[coll] ?? []).flatMap((doc) => tagsOf(doc))));
  const raw = parts.map((part) => ({ part, tags: tagsOf(part.doc) }));
  const expand = (tag: string, id: string, number: number) => tag.replaceAll("{#}", String(number)).replaceAll("{id}", id);
  let number = 1;
  const needsNumber = raw.some(({ tags }) => tags.some((tag) => tag.includes("{#}")));
  if (needsNumber) {
    for (; number <= 100_000; number++) {
      const numbered = raw.flatMap(({ part, tags }) => tags.filter((tag) => tag.includes("{#}"))
        .map((tag) => expand(tag, ids[part.id] ?? "", number)));
      if (numbered.length === new Set(numbered).size && numbered.every((tag) => !existing.has(tag))) break;
    }
    if (number > 100_000) return { ok: false, error: "no scene-unique {#} allocation available" };
  }
  const tagsByPart = new Map<string, string[]>();
  const bindings = new Map<string, Array<{ coll: PrefabCollection; tag: string }>>();
  for (const { part, tags } of raw) {
    const expanded = tags.map((tag) => expand(tag, ids[part.id] ?? "", number));
    let normalized: string[];
    try { normalized = normalizeTags(expanded); }
    catch { return { ok: false, error: "expanded prefab tags exceed Tagger bounds" }; }
    tagsByPart.set(part.id, normalized);
    tags.forEach((tag, at) => {
      const list = bindings.get(tag) ?? [];
      list.push({ coll: part.coll, tag: normalized[at] ?? "" });
      bindings.set(tag, list);
    });
  }
  return { ok: true, tagsByPart, bindings, tags: [...tagsByPart.values()].flat() };
}

function transform(doc: PrefabPlaceable, coll: PrefabCollection, origin: { x: number; y: number },
  at: { x: number; y: number }, scale: number, degrees: number): PrefabPlaceable {
  const r = degrees * Math.PI / 180, cos = Math.cos(r), sin = Math.sin(r);
  const xy = (x: number, y: number) => ({ x: at.x + ((x - origin.x) * cos - (y - origin.y) * sin) * scale,
    y: at.y + ((x - origin.x) * sin + (y - origin.y) * cos) * scale });
  if (coll === "walls") {
    const wall = doc as WallDocument;
    const a = xy(wall.c[0], wall.c[1]), b = xy(wall.c[2], wall.c[3]);
    return { ...wall, c: [a.x, a.y, b.x, b.y] };
  }
  if (coll === "drawings") {
    const drawing = doc as DrawingDocument;
    const points: number[] = [];
    for (let i = 0; i < drawing.points.length; i += 2) {
      const p = xy(drawing.points[i] ?? 0, drawing.points[i + 1] ?? 0);
      points.push(p.x, p.y);
    }
    const box = drawing.box;
    const rect = box ? xy(box[0], box[1]) : null;
    return { ...drawing, points, box: box && rect ? [rect.x, rect.y, box[2] * scale, box[3] * scale] : null,
      strokeWidth: drawing.strokeWidth * scale };
  }
  if (coll === "tokens" || coll === "tiles") {
    const placeable = doc as TokenDocument | TileDocument;
    const center = xy(placeable.x + placeable.width / 2, placeable.y + placeable.height / 2);
    const width = placeable.width * scale, height = placeable.height * scale;
    return { ...placeable, x: center.x - width / 2, y: center.y - height / 2,
      width, height, rotation: (((placeable.rotation ?? 0) + degrees) % 360 + 360) % 360 };
  }
  const located = doc as LightDocument | SoundDocument | TemplateDocument | NoteDocument;
  const p = xy(located.x, located.y);
  if (coll === "lights") {
    const light = located as LightDocument;
    return { ...light, ...p, dim: light.dim * scale, bright: light.bright * scale };
  }
  if (coll === "sounds") return { ...located, ...p, radius: (located as SoundDocument).radius * scale } as SoundDocument;
  if (coll === "templates") {
    const shape = located as TemplateDocument;
    return { ...shape, ...p, distance: shape.distance * scale, width: shape.width * scale,
      direction: (((shape.direction + degrees) % 360) + 360) % 360 };
  }
  return { ...located, ...p } as NoteDocument;
}

function inside(scene: SceneDocument, part: PrefabPlaceable, coll: PrefabCollection): boolean {
  const inBounds = (x: number, y: number) => finite(x, 0, scene.width) && finite(y, 0, scene.height);
  if (coll === "walls") {
    const c = (part as WallDocument).c;
    return inBounds(c[0], c[1]) && inBounds(c[2], c[3]);
  }
  if (coll === "drawings") {
    const d = part as DrawingDocument;
    const pts = d.points;
    return pts.every((n, i) => i % 2 === 0 ? inBounds(n, pts[i + 1] ?? NaN) : true) &&
      (!d.box || inBounds(d.box[0], d.box[1]) && inBounds(d.box[0] + d.box[2], d.box[1] + d.box[3]));
  }
  const d = part as TokenDocument | TileDocument | LightDocument;
  if (!inBounds(d.x, d.y)) return false;
  if (coll === "tiles" || coll === "tokens") {
    const sized = d as TileDocument | TokenDocument;
    return inBounds(d.x + sized.width, d.y + sized.height);
  }
  return true;
}

function reboundRef(ref: DocRef, source: string, target: string,
  mapping: Map<string, { coll: PrefabCollection; id: string }>): DocRef | null {
  if (ref.coll === "scenes" && !ref.parent) return ref.id === source ? { coll: "scenes", id: target } : null;
  if (!ref.parent || ref.parent.coll !== "scenes" || ref.parent.id !== source || ref.parent.parent) return null;
  const mapped = mapping.get(ref.id);
  if (!mapped || mapped.coll !== ref.coll) return null;
  return { coll: mapped.coll, id: mapped.id, parent: { coll: "scenes", id: target } };
}

/** Host-authoritative transaction planner. Does not mutate the world or its template. */
export function planPrefabPlacement(
  world: Readonly<WorldCollections>, prefab: unknown, sceneId: string, placement: unknown,
  makeId: () => string = () => globalThis.crypto.randomUUID(),
): PrefabResult {
  const checked = validatePrefab(prefab);
  if (!checked.ok) return checked;
  const def = checked.definition;
  const scene = world.scenes.find((s) => s._id === sceneId);
  if (!scene) return { ok: false, error: "destination scene missing" };
  if (!object(placement) || !keys(placement, ["at", "rotation", "scale"]) || !point(placement.at) ||
      (placement.rotation !== undefined && !finite(placement.rotation, -360, 360)) ||
      (placement.scale !== undefined && !finite(placement.scale, 0.25, 4)))
    return { ok: false, error: "invalid prefab position, rotation or scale" };
  const at = placement.at;
  if (!finite(at.x, 0, scene.width) || !finite(at.y, 0, scene.height))
    return { ok: false, error: "prefab anchor is outside the scene" };
  const degrees = (placement.rotation ?? 0) as number;
  if (degrees !== 0 && def.parts.some((p) => p.coll === "drawings" && (p.doc as DrawingDocument).box !== null))
    return { ok: false, error: "rotated rectangular drawings need polygon conversion before placement" };
  const ratio = scene.grid.size / def.gridSize * ((placement.scale ?? 1) as number);
  if (!finite(ratio, 0.05, 20)) return { ok: false, error: "scene grid-scale mismatch" };
  const instanceId = makeId();
  const ids: Record<string, string> = {};
  const seen = new Set<string>([instanceId]);
  for (const part of def.parts) {
    const id = makeId();
    if (!ID.test(id) || seen.has(id) || scene[part.coll].some((doc) => doc._id === id))
      return { ok: false, error: "prefab ID allocator returned a duplicate/invalid ID" };
    ids[part.id] = id; seen.add(id);
  }
  const root = def.parts.find((part) => !part.parentId);
  if (!root) return { ok: false, error: "prefab root missing" };
  const rootId = ids[root.id] ?? "";
  const allocated = allocateTags(scene, def.parts, ids);
  if (!allocated.ok) return allocated;
  const mapping = new Map(def.parts.map((part) => [part.id,
    { coll: part.coll, id: ids[part.id] ?? "" }] as const));
  const ops: Op[] = [];
  for (const part of def.parts) {
    const rewritten = transform(part.doc, part.coll, def.origin, at, ratio, degrees);
    const id = ids[part.id] ?? "";
    const parentId = part.parentId ? ids[part.parentId] : undefined;
    const tags = allocated.tagsByPart.get(part.id) ?? [];
    const clone = { ...rewritten, _id: id, taggerTags: tags,
      flags: { ...rewritten.flags, prefab: { instanceId, rootId, ...(parentId ? { parentId } : {}),
        sourceScene: def.sourceSceneId, locked: part.locked ?? false } } } as PrefabPlaceable;
    if (!inside(scene, clone, part.coll)) return { ok: false, error: `prefab part ${part.id} lies outside scene bounds` };
    const asset = part.coll === "sounds" ? (clone as SoundDocument).audio :
      part.coll === "notes" ? (clone as NoteDocument).icon :
        part.coll === "tokens" || part.coll === "tiles" ? (clone as TokenDocument | TileDocument).img : "";
    if (HASH.test(asset) && !world.assetManifest[asset])
      return { ok: false, error: `prefab part ${part.id} references missing media ${asset}` };
    ops.push({ kind: "create", coll: part.coll, parent: { coll: "scenes", id: sceneId }, data: clone });
  }
  for (const graph of def.graphs) {
    const freshId = makeId();
    if (!ID.test(freshId) || seen.has(freshId) || world.automations.some((a) => a._id === freshId))
      return { ok: false, error: "prefab graph ID allocator returned duplicate/invalid ID" };
    seen.add(freshId);
    const original = graph.doc.definition;
    const tileId = ids[original.tileId];
    if (!tileId) return { ok: false, error: "prefab graph lost its tile binding" };
    type TagSelector = Extract<AutomationSelector, { kind: "tag" }> |
      Extract<AutomationTileTarget, { kind: "tag" }>;
    const rebindTag = <T extends TagSelector>(rawSelector: T, onlyTiles: boolean): T | null => {
      const selector = structuredClone(rawSelector);
      const match = (query: string): string | null => {
        const candidates = (allocated.bindings.get(query) ?? []).filter((b) =>
          onlyTiles ? b.coll === "tiles" :
            !("collections" in selector) || !selector.collections || selector.collections.includes(b.coll));
        if (!query.includes("{#}") && !query.includes("{id}")) {
          // Static terms remain global only when they were NOT the tag of a
          // template child. Otherwise a copy would operate on its source/all copies.
          if (candidates.length) return null;
          return query;
        }
        return selector.pattern && selector.pattern !== "literal" || candidates.length !== 1
          ? null : candidates[0]?.tag ?? null;
      };
      const raw = selector.query;
      const converted = typeof raw === "string" ? match(raw) : raw.map(match);
      if (converted === null || Array.isArray(converted) && converted.some((v) => v === null)) return null;
      selector.query = converted as string | string[];
      for (const kind of ["includeRefs", "excludeRefs"] as const) {
        const refs = selector[kind];
        if (!refs) continue;
        const mapped = refs.map((ref) => reboundRef(ref, def.sourceSceneId, sceneId, mapping));
        if (mapped.some((ref) => !ref)) return null;
        selector[kind] = mapped as DocRef[];
      }
      return selector;
    };
    const steps: AutomationStep[] = [];
    for (const step of original.steps) {
      // Every tile-targeting action/read must bind to this *clone's* tiles. A
      // variable/gate action or Check Variable aimed at a source or previous
      // instance would otherwise read/edit an unrelated graph after placement.
      if ((step.kind === "triggerTile" || step.kind === "setActive" || step.kind === "set" ||
          step.kind === "checkVariable") && step.target) {
        const target = step.target;
        const label = step.kind === "triggerTile" ? "Trigger Tile" : step.kind === "setActive" ? "Set Active"
          : step.kind === "checkVariable" ? "Check Variable" : "Set Variable";
        if (target.kind === "id") {
          const mapped = mapping.get(target.tileId);
          if (mapped?.coll !== "tiles")
            return { ok: false, error: `prefab graph ${graph.id} has a dangling ${label} target` };
          steps.push({ ...structuredClone(step), target: { kind: "id", tileId: mapped.id } });
        } else if (target.kind === "tag") {
          const rebound = rebindTag(target, true);
          if (!rebound) return { ok: false, error: `prefab graph ${graph.id} has an ambiguous or external ${label} tag` };
          steps.push({ ...structuredClone(step), target: rebound });
        } else steps.push(structuredClone(step));
      } else if ((step.kind === "select" || step.kind === "collection") && step.selector?.kind === "tag") {
        const selector = rebindTag(step.selector, false);
        if (!selector) return { ok: false, error: `prefab graph ${graph.id} has ambiguous or unbound tag selector / dangling external reference` };
        steps.push({ ...step, selector });
      } else steps.push(structuredClone(step));
    }
    const definition: AutomationDefinition = { ...original, sceneId, tileId, steps };
    const validated = validateAutomation(definition);
    if (!validated.ok) return { ok: false, error: `prefab graph ${graph.id}: ${validated.error}` };
    const clone: AutomationDocument = { ...graph.doc, _id: freshId,
      name: `${graph.doc.name} · ${instanceId.slice(0, 8)}`, definition,
      flags: { ...graph.doc.flags, prefab: { instanceId, rootId } } };
    delete clone.state; // clone history must never inherit once/cooldown counters
    ops.push({ kind: "create", coll: "automations", data: clone });
  }
  return { ok: true, plan: { ops, instanceId, rootId, tags: allocated.tags, ids } };
}

/** Untrusted document flags are never an authority source. Only the host calls
 * this for a verified, host-placed instance after validating caller permissions.
 * A parent's committed translation/uniform resize/rotation carries all of its
 * descendants in the SAME envelope; undo already contains the child pre-images.
 * Direct independent edits of child geometry are allowed for a GM unless locked.
 */
export function attachedMovementOps(
  world: Readonly<WorldCollections>, proposed: readonly Op[],
): { ok: true; ops: Op[] } | { ok: false; error: string } {
  const updates = new Map<string, { scene: SceneDocument; coll: PrefabCollection;
    before: PrefabPlaceable; after: PrefabPlaceable }>();
  const key = (sceneId: string, coll: string, id: string) => `${sceneId}\u0000${coll}\u0000${id}`;
  const movementKeys = ["x", "y", "rotation", "width", "height", "c", "points", "box",
    "direction", "dim", "bright", "distance", "radius"];
  for (const op of proposed) {
    if (op.kind !== "update" || op.ref.parent?.coll !== "scenes" ||
        !PREFAB_COLLECTIONS.includes(op.ref.coll as PrefabCollection) ||
        !Object.keys(op.diff).some((field) => movementKeys.includes(field))) continue;
    const scene = world.scenes.find((s) => s._id === op.ref.parent?.id);
    const coll = op.ref.coll as PrefabCollection;
    const before = scene?.[coll].find((d) => d._id === op.ref.id) as PrefabPlaceable | undefined;
    if (!scene || !before) continue; // DocumentStore will reject the original op.
    const id = key(scene._id, coll, before._id);
    const previous = updates.get(id)?.after ?? before;
    const applied = applyDiff(previous, op.diff);
    if (!applied.ok) return { ok: false, error: applied.error };
    updates.set(id, { scene, coll, before, after: applied.value });
  }
  if (!updates.size) return { ok: true, ops: [...proposed] };
  const extra: Op[] = [];
  for (const update of updates.values()) {
    const { scene, before, after, coll } = update;
    const marker = before.flags?.prefab as Record<string, unknown> | undefined;
    if (!marker || typeof marker.instanceId !== "string" || typeof marker.rootId !== "string") continue;
    const members = PREFAB_COLLECTIONS.flatMap((collection) => scene[collection].map((doc) => ({
      coll: collection, doc: doc as PrefabPlaceable,
    }))).filter(({ doc }) => (doc.flags?.prefab as Record<string, unknown> | undefined)?.instanceId === marker.instanceId);
    const byId = new Map(members.map((m) => [m.doc._id, m] as const));
    const descendants: typeof members = [];
    for (const member of members) {
      if (member.doc._id === before._id) continue;
      let at = (member.doc.flags.prefab as Record<string, unknown> | undefined)?.parentId;
      const visited = new Set<string>([member.doc._id]);
      let isChild = false;
      while (typeof at === "string") {
        if (visited.has(at) || visited.size > 8 || !byId.has(at))
          return { ok: false, error: "prefab attachment cycle or orphan" };
        if (at === before._id) { isChild = true; break; }
        visited.add(at);
        at = (byId.get(at)?.doc.flags.prefab as Record<string, unknown> | undefined)?.parentId;
      }
      if (isChild) descendants.push(member);
    }
    if (!descendants.length) continue;
    if (coll !== "tokens" && coll !== "tiles")
      return { ok: false, error: "moving this prefab parent type is not supported yet" };
    const was = before as TokenDocument | TileDocument;
    const now = after as TokenDocument | TileDocument;
    const sx = now.width / was.width, sy = now.height / was.height;
    if (!finite(sx, 0.05, 20) || !finite(sy, 0.05, 20) || Math.abs(sx - sy) > 1e-5 ||
        !finite(now.x, 0, scene.width) || !finite(now.y, 0, scene.height) ||
        !finite(now.rotation ?? 0, -360, 360))
      return { ok: false, error: "prefab parent needs a finite uniform resize within scene bounds" };
    const origin = { x: was.x + was.width / 2, y: was.y + was.height / 2 };
    const destination = { x: now.x + now.width / 2, y: now.y + now.height / 2 };
    const angle = (now.rotation ?? 0) - (was.rotation ?? 0);
    if (origin.x === destination.x && origin.y === destination.y && sx === 1 && angle === 0) continue;
    for (const { coll: childColl, doc } of descendants) {
      if (updates.has(key(scene._id, childColl, doc._id)) ||
          proposed.some((op) => op.kind === "delete" && op.ref.coll === childColl &&
            op.ref.id === doc._id && op.ref.parent?.id === scene._id))
        return { ok: false, error: "cannot move/delete a prefab child in the same transaction as its parent" };
      const rotated = transform(doc, childColl, origin, destination, sx, angle);
      if (!inside(scene, rotated, childColl))
        return { ok: false, error: `attached ${childColl}/${doc._id} lies outside scene bounds` };
      const geometry = childColl === "walls" ? ["c"] : childColl === "drawings" ? ["points", "box", "strokeWidth"] :
        childColl === "tokens" || childColl === "tiles" ? ["x", "y", "width", "height", "rotation"] :
        childColl === "lights" ? ["x", "y", "dim", "bright"] :
        childColl === "sounds" ? ["x", "y", "radius"] :
        childColl === "templates" ? ["x", "y", "distance", "width", "direction"] : ["x", "y"];
      const diff: Record<string, number | number[] | null> = {};
      for (const field of geometry) {
        const value = (rotated as unknown as Record<string, number | number[] | null>)[field];
        if (value !== undefined) diff[field] = value;
      }
      extra.push({ kind: "update", ref: { coll: childColl, id: doc._id,
        parent: { coll: "scenes", id: scene._id } }, diff });
    }
  }
  return { ok: true, ops: [...proposed, ...extra] };
}

/** Deleting any prefab member also deletes its descendants and graphs bound to
 * deleted tiles. Other instances and the saved template remain untouched.
 * Missing links fail closed; an explicit whole-instance despawn is idempotent
 * with the automatic expansion. All deletes are part of the original undo.
 */
export function attachedDeletionOps(
  world: Readonly<WorldCollections>, proposed: readonly Op[],
): { ok: true; ops: Op[] } | { ok: false; error: string } {
  const operations = [...proposed];
  const unique = (coll: string, id: string, sceneId = "") => `${sceneId}\u0000${coll}\u0000${id}`;
  const deleting = new Set(proposed.filter((op) => op.kind === "delete").map((op) =>
    unique(op.ref.coll, op.ref.id, op.ref.parent?.coll === "scenes" ? op.ref.parent.id : "")));
  for (const op of proposed) {
    if (op.kind !== "delete" || op.ref.parent?.coll !== "scenes" ||
        !PREFAB_COLLECTIONS.includes(op.ref.coll as PrefabCollection)) continue;
    const scene = world.scenes.find((s) => s._id === op.ref.parent?.id);
    const doc = scene?.[op.ref.coll as PrefabCollection].find((item) => item._id === op.ref.id);
    const marker = doc?.flags.prefab as { instanceId?: string } | undefined;
    if (!scene || !marker?.instanceId) continue;
    const members = PREFAB_COLLECTIONS.flatMap((coll) => scene[coll].map((member) => ({ coll, doc: member })))
      .filter((row) => (row.doc.flags.prefab as { instanceId?: string } | undefined)?.instanceId === marker.instanceId);
    const byId = new Map(members.map((m) => [m.doc._id, m] as const));
    const removedTiles = new Set<string>(op.ref.coll === "tiles" ? [op.ref.id] : []);
    for (const member of members) {
      if (member.doc._id === op.ref.id) continue;
      let at = (member.doc.flags.prefab as { parentId?: string } | undefined)?.parentId;
      const visited = new Set<string>([member.doc._id]);
      while (at) {
        if (visited.has(at) || visited.size > 8 || !byId.has(at))
          return { ok: false, error: "prefab attachment cycle or orphan" };
        if (at === op.ref.id) {
          const ref = unique(member.coll, member.doc._id, scene._id);
          if (!deleting.has(ref)) {
            operations.push({ kind: "delete", ref: { coll: member.coll, id: member.doc._id,
              parent: { coll: "scenes", id: scene._id } } });
            deleting.add(ref);
          }
          if (member.coll === "tiles") removedTiles.add(member.doc._id);
          break;
        }
        visited.add(at);
        at = (byId.get(at)?.doc.flags.prefab as { parentId?: string } | undefined)?.parentId;
      }
    }
    for (const graph of world.automations) {
      if ((graph.flags.prefab as { instanceId?: string } | undefined)?.instanceId !== marker.instanceId ||
          graph.definition.sceneId !== scene._id || !removedTiles.has(graph.definition.tileId)) continue;
      const ref = unique("automations", graph._id);
      if (deleting.has(ref)) continue;
      operations.push({ kind: "delete", ref: { coll: "automations", id: graph._id } });
      deleting.add(ref);
    }
  }
  return { ok: true, ops: operations };
}
