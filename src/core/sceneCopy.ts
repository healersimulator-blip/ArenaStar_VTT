/**
 * D-274 (plan §5.6) — **duplicating a scene**, which is what requirement 5d's *linked battle scene*
 * is made of: *"optional linked battle scene (offer on trigger, copy, spread tokens)"*.
 *
 * A scene's children are **embedded arrays on the scene document** (`tokens`, `walls`, `lights`,
 * `sounds`, `tiles`, `drawings`, `templates`, `notes`, `cells` and `regions`), so the copy is one
 * `create` with every child re-keyed. A world-owned trigger graph is a separate document, so bound
 * graphs travel in the same undoable envelope after their scene and are validated against that
 * staged scene before the host publishes either document.
 *
 * Internal references are never allowed to fall through to the source scene: anchors, pinned refs,
 * tag-selector refs, move destinations, self-linked notes, hexcrawl party tokens and attachment
 * parent/root IDs are rebound. Creation-time `{#}`/`{id}` tag rules are expanded transactionally on
 * the copy, and graph selectors using those templates are rebound to one unambiguous copied tag.
 * Missing external world/media dependencies stop the plan before an op is returned.
 *
 * What is deliberately **shared, not copied**: the map image. `SceneDocument.img` is a world asset
 * hash, so the copy points at the same bytes — copying the picture is the one thing a battle scene
 * genuinely must not do.
 *
 * The copy's own `active` flag rides **inside** the create, never in a follow-up `update`. Ordinary
 * updates still resolve against the pre-batch store; the host specially preflights graph creates
 * against a scene create in the same envelope so the whole clone can remain atomic.
 */
import type {
  AutomationDocument,
  BaseDocument,
  CellDocument,
  DocRef,
  DrawingDocument,
  LightDocument,
  NoteDocument,
  RegionDocument,
  SceneDocument,
  SoundDocument,
  TemplateDocument,
  TileDocument,
  TokenDocument,
  WallDocument,
  WorldCollections,
} from "./documents";
import type { DocId } from "./ids";
import type { Op } from "./ops";
import {
  automationImageError,
  pinnedSelectorError,
  validateAutomation,
  type AutomationDefinition,
  type AutomationSelector as Selector,
  type AutomationStep as Step,
  type AutomationTileTarget as TileTarget,
} from "./automation";
import { expandTagTemplate, normalizeTags, TAGGABLE_COLLECTIONS, tagsOf } from "./tags";
import { validateFxSequence } from "./fx";
import { validateScriptMacro } from "./scriptMacros";
import { validateSummon } from "./summons";
import { automationSourceTile } from "./regionGeometry";

export interface DuplicateSceneInput {
  /** The scene to copy. */
  scene: SceneDocument;
  /** The new scene's id (`scene-xxxx`); the caller makes it unique. */
  id: DocId;
  /** Defaults to `"<name> (copy)"` — the tables window's own duplicate convention (D-272). */
  name?: string;
  /** Make the copy active, deactivating `scenes` (usually every other scene). */
  activate?: boolean;
  /** The scenes to deactivate when `activate` is set. */
  scenes?: readonly SceneDocument[];
  /** The live world is used to preflight external references, media and saved trigger graphs. */
  world?: Readonly<WorldCollections>;
  /** Override the graphs copied from `world.automations`; useful to callers with a bounded view. */
  automations?: readonly AutomationDocument[];
  /**
   * Extra tokens for the copy, already positioned — the encounter's own creatures, built by
   * `core/hexcrawl/placement.ts`. They are appended to the copy, never to the original.
   */
  extraTokens?: readonly TokenDocument[];
  /** Re-key one child id at a time; defaults to a counter-based suffix (`t1-1`, …). */
  nextId?: (kind: string, id: DocId) => DocId;
}

export type DuplicateScenePlan =
  | { ok: true; ops: Op[]; copy: SceneDocument; idMap: Readonly<Record<string, string>> }
  | { ok: false; error: string };

type SceneChildCollection = "tokens" | "walls" | "notes" | "cells" | "lights" | "sounds" |
  "tiles" | "regions" | "drawings" | "templates";
type TagCollection = (typeof TAGGABLE_COLLECTIONS)[number] | "scenes";

const ID = /^[A-Za-z0-9_-]{1,128}$/;
const HASH = /^[a-f0-9]{64}$/;
const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const refKey = (coll: string, id: string) => `${coll}\u0000${id}`;
const childKind: Record<SceneChildCollection, string> = {
  tokens: "t", walls: "w", notes: "n", cells: "c", lights: "l", sounds: "s",
  tiles: "tl", regions: "rg", drawings: "d", templates: "tp",
};

/** `"Forest road"` → `"Forest road (copy)"`. */
export function copyName(name: string): string {
  return /\s\(copy( \d+)?\)$/.test(name) ? name : `${name} (copy)`;
}

function childDocs(scene: SceneDocument, coll: SceneChildCollection): readonly BaseDocument[] {
  return ((scene[coll] ?? []) as readonly BaseDocument[]);
}

function copyAssetError(value: unknown, world: Readonly<WorldCollections> | undefined, label: string): string | null {
  if (typeof value !== "string" || !HASH.test(value) || !world) return null;
  return world.assetManifest[value] ? null : `${label} references missing media ${value}`;
}

function mapUntypedChildId(
  oldId: string,
  candidates: ReadonlyMap<string, readonly string[]>,
): string | null {
  const hits = candidates.get(oldId) ?? [];
  return hits.length === 1 ? hits[0] ?? null : null;
}

function mapSceneRef(
  ref: DocRef,
  sourceSceneId: string,
  targetSceneId: string,
  ids: ReadonlyMap<string, string>,
): DocRef | null {
  if (ref.coll === "scenes" && !ref.parent)
    return ref.id === sourceSceneId ? { coll: "scenes", id: targetSceneId } : null;
  if (!ref.parent || ref.parent.coll !== "scenes" || ref.parent.id !== sourceSceneId || ref.parent.parent)
    return null;
  const id = ids.get(refKey(ref.coll, ref.id));
  return id ? { coll: ref.coll, id, parent: { coll: "scenes", id: targetSceneId } } : null;
}

function sourceRefExists(scene: SceneDocument, ref: DocRef): boolean {
  if (ref.coll === "scenes" && !ref.parent) return ref.id === scene._id;
  if (!ref.parent || ref.parent.coll !== "scenes" || ref.parent.id !== scene._id || ref.parent.parent)
    return false;
  const collection = ref.coll as SceneChildCollection;
  if (!(TAGGABLE_COLLECTIONS as readonly string[]).includes(collection)) return false;
  return childDocs(scene, collection).some((doc) => doc._id === ref.id);
}

function remapPrefabFlags(
  flags: BaseDocument["flags"],
  id: string,
  untypedIds: ReadonlyMap<string, readonly string[]>,
  instanceIds: Map<string, string>,
  allocate: (kind: string, oldId: string) => string | null,
): { ok: true; flags: BaseDocument["flags"] } | { ok: false; error: string } {
  const out = structuredClone(flags ?? {});
  const raw = out.prefab;
  if (raw === undefined) return { ok: true, flags: out };
  if (!isRecord(raw) || typeof raw.instanceId !== "string" || !ID.test(raw.instanceId) ||
      typeof raw.rootId !== "string" || !ID.test(raw.rootId))
    return { ok: false, error: `attachment metadata on ${id} is invalid` };
  const rootId = mapUntypedChildId(raw.rootId, untypedIds);
  if (!rootId) return { ok: false, error: `attachment root ${raw.rootId} on ${id} is missing or ambiguous` };
  let instanceId = instanceIds.get(raw.instanceId);
  if (!instanceId) {
    instanceId = allocate("pfi", raw.instanceId) ?? undefined;
    if (!instanceId) return { ok: false, error: `could not allocate copied attachment instance for ${id}` };
    instanceIds.set(raw.instanceId, instanceId);
  }
  const parentId = typeof raw.parentId === "string"
    ? mapUntypedChildId(raw.parentId, untypedIds)
    : undefined;
  if (typeof raw.parentId === "string" && !parentId)
    return { ok: false, error: `attachment parent ${raw.parentId} on ${id} is missing or ambiguous` };
  // Keep sourceScene as provenance; runtime parent/root membership is carried by the rebound IDs.
  out.prefab = { ...raw, instanceId, rootId, ...(parentId ? { parentId } : {}) } as BaseDocument["flags"][string];
  return { ok: true, flags: out };
}

function expandCopyTags(
  entries: Array<{ coll: TagCollection; source: BaseDocument; clone: BaseDocument; internal: boolean }>,
  untypedIds: ReadonlyMap<string, readonly string[]>,
): { ok: true; bindings: Map<string, Array<{ coll: TagCollection; tag: string }>> } | { ok: false; error: string } {
  const staticTags = new Set<string>();
  for (const { source } of entries) {
    try {
      for (const tag of normalizeTags(tagsOf(source)))
        if (!tag.includes("{#}") && !tag.includes("{id}")) staticTags.add(tag);
    } catch {
      return { ok: false, error: `invalid Tagger tags on ${source.type}/${source._id}` };
    }
  }
  const occupied = new Set(staticTags);
  const bindings = new Map<string, Array<{ coll: TagCollection; tag: string }>>();
  for (const { coll, source, clone, internal } of entries) {
    const raw = tagsOf(source);
    if (raw.length === 0) continue;
    let normalized: string[];
    try { normalized = normalizeTags(raw); }
    catch { return { ok: false, error: `invalid Tagger tags on ${source.type}/${source._id}` }; }
    if (normalized.length !== raw.length)
      return { ok: false, error: `duplicate Tagger tags on ${source.type}/${source._id}` };
    const needsId = raw.some((tag) => tag.includes("{id}"));
    const needsNumber = raw.some((tag) => tag.includes("{#}"));
    if (!needsId && !needsNumber) continue;
    const newId = clone._id;
    let chosen: string[] | null = null;
    const max = needsNumber ? 100_000 : 1;
    for (let number = 1; number <= max; number++) {
      let candidate: string[];
      try { candidate = raw.map((tag) => expandTagTemplate(tag, number, newId)); }
      catch { return { ok: false, error: `Tagger template on ${source.type}/${source._id} cannot be expanded` }; }
      let unique: string[];
      try { unique = normalizeTags(candidate); }
      catch {
        if (needsNumber) continue;
        return { ok: false, error: `Tagger template on ${source.type}/${source._id} exceeds tag bounds` };
      }
      if (unique.length !== candidate.length) {
        if (needsNumber) continue;
        return { ok: false, error: `Tagger template on ${source.type}/${source._id} expands to duplicate tags` };
      }
      const generated = candidate.filter((_, index) => raw[index]?.includes("{#}") || raw[index]?.includes("{id}"));
      if (generated.some((tag) => occupied.has(tag))) {
        if (needsNumber) continue;
        return { ok: false, error: `Tagger ID template on ${source.type}/${source._id} is not unique` };
      }
      chosen = candidate;
      for (const tag of generated) occupied.add(tag);
      break;
    }
    if (!chosen) return { ok: false, error: `no scene-unique Tagger number is available for ${source.type}/${source._id}` };
    clone.taggerTags = chosen;
    if (!internal) continue;
    for (let index = 0; index < raw.length; index++) {
      const template = raw[index];
      const tag = chosen[index];
      if (!template || !tag || (!template.includes("{#}") && !template.includes("{id}"))) continue;
      const rows = bindings.get(template) ?? [];
      rows.push({ coll, tag });
      bindings.set(template, rows);
    }
  }
  // Keep this read here: an ambiguous untyped parent cannot be repaired later by automation code.
  for (const [oldId, ids] of untypedIds) {
    if (ids.length > 1 && entries.some(({ source }) => source._id === oldId &&
      isRecord(source.flags?.prefab)))
      return { ok: false, error: `attachment ID ${oldId} is ambiguous across copied collections` };
  }
  return { ok: true, bindings };
}

function remapTagSelector<T extends Extract<Selector | TileTarget, { kind: "tag" }>>(
  raw: T,
  tileOnly: boolean,
  bindings: ReadonlyMap<string, Array<{ coll: TagCollection; tag: string }>>,
  sourceSceneId: string,
  targetSceneId: string,
  ids: ReadonlyMap<string, string>,
): { ok: true; selector: T } | { ok: false; error: string } {
  const selector = structuredClone(raw);
  const allowed = tileOnly
    ? new Set<TagCollection>(["tiles"])
    : "collections" in selector && selector.collections
      ? new Set(selector.collections as TagCollection[])
      : new Set<TagCollection>(["scenes", ...(TAGGABLE_COLLECTIONS as readonly TagCollection[])]);
  const mapTerm = (query: string): string | null => {
    if (!query.includes("{#}") && !query.includes("{id}")) return query;
    if (selector.pattern !== undefined && selector.pattern !== "literal") return null;
    const candidates = [...new Set((bindings.get(query) ?? [])
      .filter((row) => allowed.has(row.coll)).map((row) => row.tag))];
    return candidates.length === 1 ? candidates[0] ?? null : null;
  };
  const converted = typeof selector.query === "string"
    ? mapTerm(selector.query)
    : selector.query.map(mapTerm);
  if (converted === null || Array.isArray(converted) && converted.some((term) => term === null))
    return { ok: false, error: "tag expression is missing, ambiguous, or uses a non-literal pattern" };
  selector.query = converted as string | string[];
  for (const key of ["includeRefs", "excludeRefs"] as const) {
    const refs = selector[key];
    if (!refs) continue;
    const mapped = refs.map((ref) => mapSceneRef(ref, sourceSceneId, targetSceneId, ids));
    if (mapped.some((ref) => !ref))
      return { ok: false, error: `${key} contains a missing or external scene reference` };
    selector[key] = mapped as DocRef[];
  }
  return { ok: true, selector: selector as T };
}

function graphExternalError(
  graph: AutomationDocument,
  definition: AutomationDefinition,
  sourceSceneId: string,
  targetSceneId: string,
  world: Readonly<WorldCollections> | undefined,
): string | null {
  for (const step of definition.steps) {
    if (step.kind === "rollTable" && (!world || !world.rollTables.some((table) => table._id === step.tableId)))
      return `graph ${graph.name} references missing roll table ${step.tableId}`;
    if (step.kind === "sequence" || step.kind === "script" || step.kind === "summon") {
      const macro = world?.macros.find((doc) => doc._id === (step.kind === "summon" ? step.presetId : step.macroId));
      if (!macro) return `graph ${graph.name} references a missing ${step.kind} macro`;
      if (step.kind === "sequence" && (macro.kind !== "sequence" || !validateFxSequence(macro.sequence).ok))
        return `graph ${graph.name} references an invalid sequence macro ${macro._id}`;
      if (step.kind === "script") {
        const checked = validateScriptMacro(macro);
        if (!checked.ok || checked.policy.sceneId !== targetSceneId)
          return `graph ${graph.name} uses scene-bound script ${macro.name}; republish it for the copied scene before cloning`;
      }
      if (step.kind === "summon") {
        const checked = macro.kind === "summon" ? validateSummon(macro.summon) : null;
        if (!checked?.ok || checked.definition.sceneId !== targetSceneId)
          return `graph ${graph.name} uses a summon preset that is not published for the copied scene`;
      }
    }
    if (step.kind === "sceneBackground") {
      if (step.image) {
        if (!world) return `graph ${graph.name} image dependency cannot be checked without the world manifest`;
        const error = automationImageError(step.image, world.assetManifest);
        if (error) return `graph ${graph.name}: ${error}`;
      }
      if (step.targetSceneId && step.targetSceneId !== sourceSceneId &&
          !world?.scenes.some((scene) => scene._id === step.targetSceneId))
        return `graph ${graph.name} references missing scene ${step.targetSceneId}`;
    }
    if (step.kind === "tileImage") {
      const images = step.images ? step.images : step.image ? [step.image] : [];
      if (images.length && !world) return `graph ${graph.name} image dependency cannot be checked without the world manifest`;
      for (const image of images) {
        const error = automationImageError(image, world?.assetManifest ?? {});
        if (error) return `graph ${graph.name}: ${error}`;
      }
    }
  }
  return null;
}

function rebindGraph(
  graph: AutomationDocument,
  scene: SceneDocument,
  copy: SceneDocument,
  ids: ReadonlyMap<string, string>,
  bindings: ReadonlyMap<string, Array<{ coll: TagCollection; tag: string }>>,
  nextId: (kind: string, oldId: string) => string | null,
  untypedIds: ReadonlyMap<string, readonly string[]>,
  instanceIds: Map<string, string>,
  world: Readonly<WorldCollections> | undefined,
): { ok: true; graph: AutomationDocument } | { ok: false; error: string } {
  const checked = validateAutomation(graph.definition);
  if (!checked.ok) return { ok: false, error: `graph ${graph.name} is invalid: ${checked.error}` };
  const original = checked.definition;
  if (original.sceneId !== scene._id || !automationSourceTile(scene, original.tileId, original.sourceKind))
    return { ok: false, error: `graph ${graph.name} has a missing source anchor` };
  for (const step of original.steps) {
    if ((step.kind === "select" || step.kind === "collection") && step.selector?.kind === "ids") {
      const error = pinnedSelectorError(scene, step.selector);
      if (error) return { ok: false, error: `graph ${graph.name}: ${error}` };
    }
    if ((step.kind === "select" || step.kind === "collection") && step.selector?.kind === "tag") {
      for (const ref of [...(step.selector.includeRefs ?? []), ...(step.selector.excludeRefs ?? [])])
        if (!sourceRefExists(scene, ref)) return { ok: false, error: `graph ${graph.name} has a missing tag-selector ref` };
    }
    if (step.kind === "move" && step.destination &&
        !scene[step.destination.coll].some((doc) => doc._id === step.destination?.id))
      return { ok: false, error: `graph ${graph.name} has a missing Move destination` };
    if (step.kind === "triggerTile" || step.kind === "setActive" || step.kind === "set" || step.kind === "checkVariable") {
      const target = step.target;
      if (target?.kind === "id" && !scene.tiles.some((tile) => tile._id === target.tileId))
        return { ok: false, error: `graph ${graph.name} has a missing tile target` };
      if (target?.kind === "tag")
        for (const ref of [...(target.includeRefs ?? []), ...(target.excludeRefs ?? [])])
          if (!sourceRefExists(scene, ref) || ref.coll !== "tiles")
            return { ok: false, error: `graph ${graph.name} has a missing or non-tile target ref` };
    }
  }
  const external = graphExternalError(graph, original, scene._id, copy._id, world);
  if (external) return { ok: false, error: external };

  const anchorCollection = original.sourceKind === "region" ? "regions" : "tiles";
  const tileId = ids.get(refKey(anchorCollection, original.tileId));
  if (!tileId) return { ok: false, error: `graph ${graph.name} lost its copied ${anchorCollection} anchor` };
  const steps: Step[] = [];
  for (const step of original.steps) {
    if ((step.kind === "select" || step.kind === "collection") && step.selector?.kind === "ids") {
      const refs = step.selector.refs.map((ref) => mapSceneRef(ref, scene._id, copy._id, ids));
      if (refs.some((ref) => !ref)) return { ok: false, error: `graph ${graph.name} has a dangling pinned entity ref` };
      steps.push({ ...structuredClone(step), selector: { kind: "ids", refs: refs as DocRef[] } });
    } else if ((step.kind === "select" || step.kind === "collection") && step.selector?.kind === "tag") {
      const rebound = remapTagSelector(step.selector, false, bindings, scene._id, copy._id, ids);
      if (!rebound.ok) return { ok: false, error: `graph ${graph.name}: ${rebound.error}` };
      steps.push({ ...structuredClone(step), selector: rebound.selector });
    } else if ((step.kind === "triggerTile" || step.kind === "setActive" || step.kind === "set" ||
                step.kind === "checkVariable") && step.target) {
      const target = step.target;
      if (target.kind === "id") {
        const mapped = ids.get(refKey("tiles", target.tileId));
        if (!mapped) return { ok: false, error: `graph ${graph.name} has a dangling tile target` };
        steps.push({ ...structuredClone(step), target: { kind: "id", tileId: mapped } });
      } else if (target.kind === "tag") {
        const rebound = remapTagSelector(target, true, bindings, scene._id, copy._id, ids);
        if (!rebound.ok) return { ok: false, error: `graph ${graph.name}: ${rebound.error}` };
        steps.push({ ...structuredClone(step), target: rebound.selector as TileTarget });
      } else steps.push(structuredClone(step));
    } else if (step.kind === "move" && step.destinationTag) {
      const rebound = remapTagSelector({ ...step.destinationTag,
        collections: step.destinationTag.collections ?? ["tokens", "tiles"] }, false,
      bindings, scene._id, copy._id, ids);
      if (!rebound.ok) return { ok: false, error: `graph ${graph.name}: ${rebound.error}` };
      steps.push({ ...structuredClone(step), destinationTag: rebound.selector as Extract<Selector, { kind: "tag" }> });
    } else if (step.kind === "move" && step.destination) {
      const mapped = ids.get(refKey(step.destination.coll, step.destination.id));
      if (!mapped) return { ok: false, error: `graph ${graph.name} has a dangling Move destination` };
      steps.push({ ...structuredClone(step), destination: { coll: step.destination.coll, id: mapped } });
    } else if (step.kind === "sceneBackground" && step.targetSceneId === scene._id) {
      steps.push({ ...structuredClone(step), targetSceneId: copy._id });
    } else if (step.kind === "tags" && step.tags.some((tag) => tag.includes("{#}") || tag.includes("{id}"))) {
      const tags = step.tags.map((tag) => {
        if (!tag.includes("{#}") && !tag.includes("{id}")) return tag;
        const matches = [...new Set((bindings.get(tag) ?? []).map((row) => row.tag))];
        return matches.length === 1 ? matches[0] ?? tag : null;
      });
      if (tags.some((tag) => tag === null))
        return { ok: false, error: `graph ${graph.name} has an ambiguous Tagger edit template` };
      steps.push({ ...structuredClone(step), tags: tags as string[] });
    } else steps.push(structuredClone(step));
  }
  const definition: AutomationDefinition = { ...original, sceneId: copy._id, tileId, steps };
  const valid = validateAutomation(definition);
  if (!valid.ok) return { ok: false, error: `copied graph ${graph.name} is invalid: ${valid.error}` };
  const freshId = nextId("a", graph._id);
  if (!freshId || !ID.test(freshId) || world?.automations.some((doc) => doc._id === freshId))
    return { ok: false, error: `could not allocate a unique graph ID for ${graph.name}` };
  const flags = remapPrefabFlags(graph.flags, graph._id, untypedIds, instanceIds, nextId);
  if (!flags.ok) return flags;
  const clone = { ...structuredClone(graph), _id: freshId, name: `${graph.name} (copy)`,
    definition, flags: flags.flags };
  delete clone.state; // run history, cooldowns and per-token keys belong to the original graph only
  return { ok: true, graph: clone };
}

function preflightCopiedScene(
  source: SceneDocument,
  copy: SceneDocument,
  ids: ReadonlyMap<string, string>,
  world: Readonly<WorldCollections> | undefined,
): string | null {
  const sceneAsset = copyAssetError(copy.img, world, `scene ${source.name}`);
  if (sceneAsset) return sceneAsset;
  for (const token of copy.tokens) {
    const original = source.tokens.find((row) => ids.get(refKey("tokens", row._id)) === token._id);
    if (!original) continue; // Encounter additions may reference actors created in this same envelope.
    if (original.actorId && world && !world.actors.some((actor) => actor._id === original.actorId))
      return `token ${original.name} references missing actor ${original.actorId}`;
    const image = copyAssetError(token.img, world, `token ${original.name}`);
    if (image) return image;
  }
  for (const tile of copy.tiles) {
    const image = copyAssetError(tile.img, world, `tile ${tile.name}`);
    if (image) return image;
  }
  for (const sound of copy.sounds) {
    const image = copyAssetError(sound.audio, world, `sound ${sound.name}`);
    if (image) return image;
  }
  for (const note of copy.notes) {
    const image = copyAssetError(note.icon, world, `note ${note.name}`);
    if (image) return image;
    if (note.linkedSceneId && world && !world.scenes.some((scene) => scene._id === note.linkedSceneId) &&
        note.linkedSceneId !== copy._id)
      return `note ${note.name} references missing linked scene ${note.linkedSceneId}`;
    if (note.journalId && world && !world.journals.some((journal) => journal._id === note.journalId))
      return `note ${note.name} references missing journal ${note.journalId}`;
  }
  for (const cell of copy.cells ?? []) {
    if (world && (cell.tables ?? []).some((tableId) => !world.encounterTables.some((table) => table._id === tableId)))
      return `cell ${cell.key} references a missing encounter table`;
    for (const feature of cell.features ?? []) {
      const image = copyAssetError(feature.img, world, `cell feature ${feature.name}`);
      if (image) return image;
    }
  }
  return null;
}

/**
 * Plan a fully rebound scene clone. Failure returns no ops; callers should surface `error` before
 * submitting anything. In particular, stale automation refs must never be left aimed at the source.
 */
export function planDuplicateSceneOps(input: DuplicateSceneInput): DuplicateScenePlan {
  const { scene, id } = input;
  const fail = (error: string): DuplicateScenePlan => ({ ok: false, error: `scene copy: ${error}` });
  const world = input.world;
  const next = input.nextId ?? ((kind: string, old: string) => `${kind}-${id.slice(-4)}-${String(old).slice(-6)}`);
  const nextId = (kind: string, oldId: string): string | null => {
    const value = next(kind, oldId);
    if (typeof value !== "string" || !ID.test(value) || reservedIds.has(value)) return null;
    reservedIds.add(value);
    return value;
  };
  if (!ID.test(id)) return fail("new scene ID is invalid");
  if (world?.scenes.some((existing) => existing._id === id)) return fail(`scene ID ${id} already exists`);
  if (world && !world.scenes.some((existing) => existing._id === scene._id))
    return fail(`source scene ${scene._id} is unavailable in the live world`);
  const sceneGraphs = input.automations ?? world?.automations.filter((graph) =>
    graph.definition?.sceneId === scene._id) ?? [];
  if (sceneGraphs.some((graph) => graph.definition?.sceneId !== scene._id))
    return fail("automation list contains a graph from another scene");
  if (sceneGraphs.length && !world)
    return fail("world context is required to validate copied trigger dependencies");

  const reservedIds = new Set<string>([id]);
  const ids = new Map<string, string>();
  const untypedIds = new Map<string, string[]>();
  const cloneRows = new Map<SceneChildCollection, BaseDocument[]>();
  const sourceIds = new Set<string>();
  for (const coll of ["tokens", "walls", "notes", "cells", "lights", "sounds", "tiles", "regions", "drawings", "templates"] as const) {
    const rows: BaseDocument[] = [];
    for (const sourceDoc of childDocs(scene, coll)) {
      const sourceKey = refKey(coll, sourceDoc._id);
      if (ids.has(sourceKey) || sourceIds.has(sourceDoc._id))
        return fail(`duplicate child ID ${sourceDoc._id} makes reference rebinding ambiguous`);
      sourceIds.add(sourceDoc._id);
      const freshId = nextId(childKind[coll], sourceDoc._id);
      if (!freshId) return fail(`could not allocate a unique ${coll} ID for ${sourceDoc._id}`);
      ids.set(sourceKey, freshId);
      const sameId = untypedIds.get(sourceDoc._id) ?? [];
      sameId.push(freshId);
      untypedIds.set(sourceDoc._id, sameId);
      rows.push({ ...structuredClone(sourceDoc), _id: freshId });
    }
    cloneRows.set(coll, rows);
  }
  const getRows = <T extends BaseDocument>(coll: SceneChildCollection) =>
    (cloneRows.get(coll) ?? []) as T[];
  const extraTokens = (input.extraTokens ?? []).map((token) => structuredClone(token));
  for (const token of extraTokens) {
    if (!ID.test(token._id) || reservedIds.has(token._id) || sourceIds.has(token._id))
      return fail(`extra token ID ${token._id} is invalid or collides with a copied child`);
    reservedIds.add(token._id);
  }
  const copy: SceneDocument = {
    ...structuredClone(scene),
    _id: id,
    name: input.name ?? copyName(scene.name ?? "Scene"),
    active: input.activate === true,
    tokens: [...getRows<TokenDocument>("tokens"), ...extraTokens],
    walls: getRows<WallDocument>("walls"),
    notes: getRows<NoteDocument>("notes"),
    cells: getRows<CellDocument>("cells"),
    lights: getRows<LightDocument>("lights"),
    sounds: getRows<SoundDocument>("sounds"),
    tiles: getRows<TileDocument>("tiles"),
    ...(scene.regions ? { regions: getRows<RegionDocument>("regions") } : {}),
    drawings: getRows<DrawingDocument>("drawings"),
    templates: getRows<TemplateDocument>("templates"),
  };

  const instanceIds = new Map<string, string>();
  for (const coll of ["tokens", "walls", "notes", "cells", "lights", "sounds", "tiles", "regions", "drawings", "templates"] as const) {
    const originals = childDocs(scene, coll);
    const clones = cloneRows.get(coll) ?? [];
    for (let index = 0; index < originals.length; index++) {
      const sourceDoc = originals[index];
      const clone = clones[index];
      if (!sourceDoc || !clone) continue;
      const flags = remapPrefabFlags(sourceDoc.flags, sourceDoc._id, untypedIds, instanceIds, nextId);
      if (!flags.ok) return fail(flags.error);
      clone.flags = flags.flags;
    }
  }

  // The party-token ref is embedded in the profile flag rather than an automation DocRef.
  const core = copy.flags.core;
  const hexcrawl = isRecord(core) ? core.hexcrawl : undefined;
  if (isRecord(hexcrawl) && typeof hexcrawl.partyTokenId === "string" && hexcrawl.partyTokenId) {
    const mapped = ids.get(refKey("tokens", hexcrawl.partyTokenId));
    if (!mapped) return fail(`hexcrawl profile references missing party token ${hexcrawl.partyTokenId}`);
    hexcrawl.partyTokenId = mapped;
  }

  // Self-linked notes become links to the copy. Existing external links remain external and are
  // checked against the supplied world before any create op is returned.
  for (let index = 0; index < scene.notes.length; index++) {
    const original = scene.notes[index];
    const note = copy.notes[index];
    if (!original || !note) continue;
    if (original.linkedSceneId === scene._id) note.linkedSceneId = copy._id;
    else if (original.linkedSceneId && world && !world.scenes.some((row) => row._id === original.linkedSceneId))
      return fail(`note ${original.name} references missing linked scene ${original.linkedSceneId}`);
  }
  const copiedSceneError = preflightCopiedScene(scene, copy, ids, world);
  if (copiedSceneError) return fail(copiedSceneError);

  const tagEntries: Array<{ coll: TagCollection; source: BaseDocument; clone: BaseDocument; internal: boolean }> = [
    { coll: "scenes", source: scene, clone: copy, internal: true },
  ];
  for (const coll of TAGGABLE_COLLECTIONS) {
    const cloneColl = coll as SceneChildCollection;
    const originals = childDocs(scene, cloneColl);
    const clones = cloneRows.get(cloneColl) ?? [];
    for (let index = 0; index < originals.length; index++) {
      const sourceDoc = originals[index];
      const clone = clones[index];
      if (sourceDoc && clone) tagEntries.push({ coll, source: sourceDoc, clone, internal: true });
    }
  }
  for (const token of extraTokens) tagEntries.push({ coll: "tokens", source: token, clone: token, internal: false });
  const tags = expandCopyTags(tagEntries, untypedIds);
  if (!tags.ok) return fail(tags.error);

  const graphOps: Op[] = [];
  for (const graph of sceneGraphs) {
    const planned = rebindGraph(graph, scene, copy, ids, tags.bindings, nextId,
      untypedIds, instanceIds, world);
    if (!planned.ok) return fail(planned.error);
    graphOps.push({ kind: "create", coll: "automations", data: planned.graph });
  }
  const ops: Op[] = [
    { kind: "create", coll: "scenes", data: copy },
    ...graphOps,
  ];
  if (input.activate) {
    for (const other of input.scenes ?? world?.scenes ?? []) {
      if (other._id === scene._id || other._id === id || !other.active) continue;
      ops.push({ kind: "update", ref: { coll: "scenes", id: other._id }, diff: { active: false } });
    }
  }
  return { ok: true, ops, copy, idMap: Object.fromEntries(ids) };
}

/**
 * Backwards-compatible op builder. New UI flows should use `planDuplicateSceneOps` so they can
 * display dependency failures before publishing; this wrapper throws rather than returning a
 * partial clone if validation fails.
 */
export function duplicateSceneOps(input: DuplicateSceneInput): Op[] {
  const planned = planDuplicateSceneOps(input);
  if (!planned.ok) throw new Error(planned.error);
  return planned.ops;
}
