/**
 * Tagger-style document tags and scene queries. The exact/case-sensitive API
 * and the forgiving sidebar search are deliberately different contracts.
 * Queries operate on a client's projected store, or on a host store WITH an
 * explicit viewer; never use the host's unprojected index to answer a player.
 */
import type {
  ActorDocument,
  BaseDocument,
  DocRef,
  SceneDocument,
  WorldCollections,
} from "./documents";
import { projectWorld } from "./projection";
import type { PermissionUser } from "./ownership";
import type { DocumentStore } from "./store";
import type { Op } from "./ops";

export const TAGGABLE_COLLECTIONS = [
  "tokens", "walls", "tiles", "regions", "drawings", "templates", "lights", "sounds", "notes", "cells",
] as const;
export type TaggableCollection = (typeof TAGGABLE_COLLECTIONS)[number];
/** World documents have no scene parent, but are meaningful Tagger targets in the global explorer. */
export const WORLD_TAGGABLE_COLLECTIONS = ["actors", "items", "prototypeTokens"] as const;
export type WorldTaggableCollection = (typeof WORLD_TAGGABLE_COLLECTIONS)[number];
export type TagSearchCollection = TaggableCollection | WorldTaggableCollection | "scenes";

/** A prototype token is stored as an actor field rather than a collection document. This
 * explicit ref distinguishes its tags from the parent actor's own tags without inventing an op
 * collection; writes become ordinary undoable actor updates on `prototypeToken.taggerTags`. */
export interface PrototypeTokenTagRef {
  coll: "actors";
  id: string;
  target: "prototypeToken";
  parent?: never;
}
export type TagRef = DocRef | PrototypeTokenTagRef;

const MAX_TAG_LENGTH = 128;
const MAX_TAGS = 64;
const MAX_QUERY_LENGTH = 128;

/** Imported Foundry/Tagger flags can be queried without changing the world. */
export function tagsOf(doc: { taggerTags?: unknown; flags?: unknown }): string[] {
  let source = doc.taggerTags;
  if (source === undefined && doc.flags && typeof doc.flags === "object" && !Array.isArray(doc.flags)) {
    const tagger = (doc.flags as Record<string, unknown>)["tagger"];
    if (tagger && typeof tagger === "object" && !Array.isArray(tagger))
      source = (tagger as Record<string, unknown>)["tags"];
  }
  if (!Array.isArray(source)) return [];
  return source.filter((tag): tag is string => typeof tag === "string" && tag.length > 0);
}

/** Tagger labels on an actor's prototype token, including read-only legacy flags. */
export function prototypeTokenTagsOf(actor: BaseDocument): string[] {
  if (actor.type === "prototypeToken") return tagsOf(actor);
  const prototype = (actor as ActorDocument).prototypeToken;
  return prototype && typeof prototype === "object" ? tagsOf(prototype) : [];
}

/** Preserve case and insertion order, but never save empty/duplicate/oversized tags. */
export function normalizeTags(input: readonly string[]): string[] {
  if (!Array.isArray(input) || input.length > MAX_TAGS) throw new Error(`at most ${MAX_TAGS} tags`);
  const seen = new Set<string>();
  const tags: string[] = [];
  for (const raw of input) {
    if (typeof raw !== "string") throw new Error("tags must be strings");
    const tag = raw.trim();
    if (!tag || tag.length > MAX_TAG_LENGTH || [...tag].some((char) => char.charCodeAt(0) < 32)) {
      throw new Error(`tag must be 1–${MAX_TAG_LENGTH} printable characters`);
    }
    if (!seen.has(tag)) {
      tags.push(tag);
      seen.add(tag);
    }
  }
  return tags;
}

/** Validate the canonical stored field without silently normalizing a hostile host request. */
export function taggerTagsError(value: unknown): string | null {
  if (value === undefined) return null;
  if (!Array.isArray(value)) return "taggerTags must be an array";
  try {
    const normalized = normalizeTags(value as string[]);
    if (normalized.length !== value.length || normalized.some((tag, index) => tag !== value[index])) {
      return "taggerTags must contain unique, trimmed tags";
    }
    return null;
  } catch {
    return "taggerTags contains invalid or oversized values";
  }
}

/** Validate tags on a created actor and its embedded item records. */
export function tagDataError(value: unknown): string | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const document = value as { type?: unknown; taggerTags?: unknown; items?: unknown; prototypeToken?: unknown };
  const ownError = taggerTagsError(document.taggerTags);
  if (ownError) return ownError;
  if (document.type === "actor") {
    if (document.prototypeToken && typeof document.prototypeToken === "object" && !Array.isArray(document.prototypeToken)) {
      const prototypeError = taggerTagsError((document.prototypeToken as { taggerTags?: unknown }).taggerTags);
      if (prototypeError) return prototypeError;
    }
    if (Array.isArray(document.items)) {
      for (const item of document.items) {
        if (item === null || typeof item !== "object" || Array.isArray(item)) continue;
        const nestedError = taggerTagsError((item as { taggerTags?: unknown }).taggerTags);
        if (nestedError) return nestedError;
      }
    }
  }
  return null;
}

/**
 * Complete the final comma-separated term in the GM explorer from its visible tag vocabulary.
 * Callers must source `available` from the current projected world; this helper never reads host state.
 */
export function tagAutocompleteSuggestions(available: readonly string[], input: string, limit = 8): string[] {
  const prefix = input.slice(input.lastIndexOf(",") + 1).trim();
  if (!prefix || prefix.length > MAX_QUERY_LENGTH || !Number.isSafeInteger(limit) || limit < 1) return [];
  const needle = prefix.toLocaleLowerCase();
  const unique = new Set<string>();
  for (const tag of available) {
    if (typeof tag !== "string" || tag !== tag.trim() || !tag || tag.length > MAX_TAG_LENGTH ||
        [...tag].some((char) => char.charCodeAt(0) < 32)) continue;
    const folded = tag.toLocaleLowerCase();
    if (folded.startsWith(needle) && folded !== needle) unique.add(tag);
  }
  return [...unique].sort((a, b) => {
    const left = a.toLocaleLowerCase(), right = b.toLocaleLowerCase();
    return left < right ? -1 : left > right ? 1 : a < b ? -1 : a > b ? 1 : 0;
  }).slice(0, Math.min(limit, 16));
}

export type TagMatchMode = "all" | "any" | "exactSet";
export type TagPattern = "literal" | "wildcard" | "regex";
export interface TagMatchOptions {
  mode?: TagMatchMode;
  pattern?: TagPattern;
  /** API default: exact whole-tag matching; sidebar uses contains instead. */
  contains?: boolean;
  /** API default: case-sensitive; sidebar uses case-insensitive. */
  caseSensitive?: boolean;
}

function globMatches(pattern: string, tag: string): boolean {
  // Greedy glob with a single backtrack point: O(pattern × tag), no regex DoS.
  let p = 0, t = 0, star = -1, retry = 0;
  while (t < tag.length) {
    if (pattern[p] === "?" || pattern[p] === tag[t]) { p++; t++; }
    else if (pattern[p] === "*") { star = p++; retry = t; }
    else if (star !== -1) { p = star + 1; t = ++retry; }
    else return false;
  }
  while (pattern[p] === "*") p++;
  return p === pattern.length;
}

function safePattern(input: string, caseSensitive: boolean): RegExp {
  if (!input || input.length > MAX_QUERY_LENGTH) throw new Error("tag query is empty or too long");
  // Browser RegExp is synchronous. Reject constructs capable of runaway
  // backtracking (groups, backrefs, alternation, lookaround); permit anchored
  // classes and at most one unbounded repeat, over short document tags.
  const repeats = (input.match(/[*+]/g) ?? []).length;
  const optional = (input.match(/\?/g) ?? []).length;
  if (/[()|\\]/.test(input) || /(?:[*+?]{2}|[{}])/.test(input) || repeats > 1 || optional > 8) {
    throw new Error("unsafe tag regex; use anchors, classes and simple quantifiers only");
  }
  try {
    return new RegExp(input, caseSensitive ? "u" : "iu");
  } catch {
    throw new Error("invalid tag regex");
  }
}

/** Compile once for a large scene; invalid or unsafe regex fails before scanning. */
export function tagMatcher(
  query: string | readonly string[],
  options: TagMatchOptions = {},
): (tags: readonly string[]) => boolean {
  const terms = (typeof query === "string" ? [query] : query).map((term) => term.trim());
  if (terms.length < 1 || terms.length > MAX_TAGS || terms.some((term) => !term || term.length > MAX_QUERY_LENGTH)) {
    throw new Error("tag query must contain 1–64 nonempty terms of at most 128 characters");
  }
  const mode = options.mode ?? "all";
  const pattern = options.pattern ?? "literal";
  const caseSensitive = options.caseSensitive ?? true;
  if (!(["all", "any", "exactSet"] as string[]).includes(mode) ||
      !(["literal", "wildcard", "regex"] as string[]).includes(pattern)) {
    throw new Error("unknown tag match mode/pattern");
  }
  const tests = terms.map((term): ((tag: string) => boolean) => {
    if (pattern === "wildcard") {
      const glob = caseSensitive ? term : term.toLocaleLowerCase();
      return (tag) => globMatches(glob, caseSensitive ? tag : tag.toLocaleLowerCase());
    }
    if (pattern === "regex") {
      const re = safePattern(term, caseSensitive);
      return (tag) => re.test(tag.slice(0, MAX_TAG_LENGTH));
    }
    const needle = caseSensitive ? term : term.toLocaleLowerCase();
    return (tag) => {
      const haystack = caseSensitive ? tag : tag.toLocaleLowerCase();
      return options.contains ? haystack.includes(needle) : haystack === needle;
    };
  });
  if (mode === "any") return (tags) => tests.some((test) => tags.some(test));
  if (mode === "exactSet") {
    // An exact set is a one-to-one match, not merely mutual coverage: overlapping
    // wildcard/regex terms must not both consume the same single tag.
    return (tags) => {
      if (tags.length !== tests.length) return false;
      const assigned = new Array<number>(tests.length).fill(-1);
      const place = (tag: number, visited: Set<number>): boolean => {
        for (let term = 0; term < tests.length; term++) {
          const matcher = tests[term];
          if (!matcher || visited.has(term) || !matcher(tags[tag] ?? "")) continue;
          visited.add(term);
          const occupied = assigned[term];
          if (occupied === -1 || occupied !== undefined && place(occupied, visited)) {
            assigned[term] = tag;
            return true;
          }
        }
        return false;
      };
      return tags.every((_, index) => place(index, new Set()));
    };
  }
  return (tags) => tests.every((test) => tags.some(test));
}

export interface TagSearchResult {
  /** World records have no scene owner and use an empty sceneId; scope is authoritative. */
  scope: "scene" | "world";
  sceneId: string;
  collection: TagSearchCollection;
  ref: TagRef;
  doc: BaseDocument;
  tags: readonly string[];
}
export interface TagSearchOptions extends TagMatchOptions {
  /** Omitted: all scenes, including unactivated scenes. */
  sceneId?: string;
  collections?: readonly TagSearchCollection[];
  /** Include top-level actors/items, embedded actor items, and actor prototype tokens without a scene filter. */
  includeWorldDocs?: boolean;
  /** Optional identity filters: full parent refs distinguish same-ID objects across scenes. */
  includeRefs?: readonly TagRef[];
  excludeRefs?: readonly TagRef[];
  /** Required on an unprojected host store for a non-GM query. */
  viewer?: PermissionUser;
}

export function isPrototypeTokenTagRef(value: unknown): value is PrototypeTokenTagRef {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const ref = value as Record<string, unknown>;
  return ref.coll === "actors" && ref.target === "prototypeToken" &&
    typeof ref.id === "string" && ref.id.length > 0 && ref.id.length <= 128 &&
    ![...ref.id].some((char) => char.charCodeAt(0) < 32) &&
    Object.keys(ref).every((key) => ["coll", "id", "target"].includes(key));
}

export function tagRefKey(ref: TagRef): string {
  if (isPrototypeTokenTagRef(ref)) return `actors/${encodeURIComponent(ref.id)}/prototypeToken`;
  return `${ref.parent ? `${tagRefKey(ref.parent)}/` : ""}${ref.coll}/${encodeURIComponent(ref.id)}`;
}

/** Typed, scene-local reference accepted by GM graph selectors and script RPCs. */
export function isSceneTagRef(value: unknown, sceneId: string): value is DocRef {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const ref = value as Record<string, unknown>;
  if (typeof ref.id !== "string" || !ref.id || ref.id.length > 128 ||
      Object.keys(ref).some((key) => !["coll", "id", "parent"].includes(key))) return false;
  if (ref.coll === "scenes") return ref.id === sceneId && ref.parent === undefined;
  if (!TAGGABLE_COLLECTIONS.includes(ref.coll as TaggableCollection) ||
      !ref.parent || typeof ref.parent !== "object" || Array.isArray(ref.parent)) return false;
  const parent = ref.parent as Record<string, unknown>;
  return parent.coll === "scenes" && parent.id === sceneId &&
    Object.keys(parent).every((key) => ["coll", "id"].includes(key));
}

export function validSceneTagRefs(value: unknown, sceneId: string): value is DocRef[] | undefined {
  if (value === undefined) return true;
  if (!Array.isArray(value) || value.length > 100 || !value.every((ref) => isSceneTagRef(ref, sceneId))) return false;
  return new Set(value.map((ref: DocRef) => tagRefKey(ref))).size === value.length;
}

/** Strict ref shape for explicit all-scene read filters. The host still looks
 * each one up in the *caller-projected* world before returning anything. */
export function isWorldTagRef(value: unknown): value is DocRef {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const ref = value as Record<string, unknown>;
  const parent = ref.parent;
  const sceneId = ref.coll === "scenes" ? ref.id :
    parent && typeof parent === "object" && !Array.isArray(parent)
      ? (parent as Record<string, unknown>).id : undefined;
  const id = ref.id;
  return typeof sceneId === "string" && sceneId.length > 0 && sceneId.length <= 128 &&
    ![...sceneId].some((char) => char.charCodeAt(0) < 32) &&
    typeof id === "string" && ![...id].some((char) => char.charCodeAt(0) < 32) &&
    isSceneTagRef(value, sceneId);
}

export function validWorldTagRefs(value: unknown): value is DocRef[] | undefined {
  if (value === undefined) return true;
  if (!Array.isArray(value) || value.length > 100 || !value.every(isWorldTagRef)) return false;
  return new Set(value.map((ref: DocRef) => tagRefKey(ref))).size === value.length;
}

/** Top-level actor/item refs, actor-parented embedded items, and actor prototype-token tags. */
export function isWorldDocumentTagRef(value: unknown): value is TagRef {
  if (isPrototypeTokenTagRef(value)) return true;
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const ref = value as Record<string, unknown>;
  if ((ref.coll !== "actors" && ref.coll !== "items") ||
      typeof ref.id !== "string" || !ref.id || ref.id.length > 128 ||
      [...ref.id].some((char) => char.charCodeAt(0) < 32) ||
      Object.keys(ref).some((key) => !["coll", "id", "parent"].includes(key))) return false;
  if (ref.parent === undefined) return true;
  if (ref.coll !== "items" || !ref.parent || typeof ref.parent !== "object" || Array.isArray(ref.parent)) return false;
  const parent = ref.parent as Record<string, unknown>;
  return parent.coll === "actors" && typeof parent.id === "string" && !!parent.id && parent.id.length <= 128 &&
    ![...parent.id].some((char) => char.charCodeAt(0) < 32) &&
    Object.keys(parent).every((key) => ["coll", "id"].includes(key));
}

/** World-wide filters can name either scene-qualified placeables or explicit world documents. */
export function validGlobalTagRefs(value: unknown): value is TagRef[] | undefined {
  if (value === undefined) return true;
  if (!Array.isArray(value) || value.length > 100 ||
      !value.every((ref) => isWorldTagRef(ref) || isWorldDocumentTagRef(ref))) return false;
  return new Set(value.map((ref: TagRef) => tagRefKey(ref))).size === value.length;
}

function matchesRefFilter(ref: TagRef, options: Pick<TagSearchOptions, "includeRefs" | "excludeRefs">): boolean {
  const key = tagRefKey(ref);
  if (options.excludeRefs?.some((item) => tagRefKey(item) === key)) return false;
  return options.includeRefs === undefined || options.includeRefs.some((item) => tagRefKey(item) === key);
}

function sceneResults(scene: SceneDocument, collections?: readonly TagSearchCollection[]): TagSearchResult[] {
  const out: TagSearchResult[] = [];
  const include = (c: TagSearchCollection) => !collections || collections.includes(c);
  if (include("scenes")) out.push({ scope: "scene", sceneId: scene._id, collection: "scenes", ref: { coll: "scenes", id: scene._id }, doc: scene, tags: tagsOf(scene) });
  for (const coll of TAGGABLE_COLLECTIONS) {
    if (!include(coll)) continue;
    const docs = scene[coll] ?? []; // `cells` is optional on older worlds
    for (const doc of docs) out.push({
      scope: "scene",
      sceneId: scene._id,
      collection: coll,
      ref: { coll, id: doc._id, parent: { coll: "scenes", id: scene._id } },
      doc,
      tags: tagsOf(doc),
    });
  }
  return out;
}

function prototypeTokenTagView(actor: ActorDocument): BaseDocument {
  const view: BaseDocument & { prototypeToken?: ActorDocument["prototypeToken"] } = {
    _id: actor._id,
    type: "prototypeToken",
    name: `${actor.name} (prototype token)`,
    ownership: actor.ownership,
    flags: {},
    system: {},
    taggerTags: prototypeTokenTagsOf(actor),
  };
  if (actor.prototypeToken !== undefined) view.prototypeToken = actor.prototypeToken;
  return view;
}

function worldDocumentResults(
  world: Readonly<Pick<Partial<WorldCollections>, "actors" | "items">>,
  collections?: readonly TagSearchCollection[],
): TagSearchResult[] {
  const out: TagSearchResult[] = [];
  const include = (coll: WorldTaggableCollection) => !collections || collections.includes(coll);
  if (include("actors")) for (const doc of world.actors ?? []) out.push({
    scope: "world", sceneId: "", collection: "actors",
    ref: { coll: "actors", id: doc._id }, doc, tags: tagsOf(doc),
  });
  if (include("prototypeTokens")) for (const actor of world.actors ?? []) {
    const doc = prototypeTokenTagView(actor);
    out.push({
      scope: "world", sceneId: "", collection: "prototypeTokens",
      ref: { coll: "actors", id: actor._id, target: "prototypeToken" }, doc, tags: tagsOf(doc),
    });
  }
  if (include("items")) {
    for (const doc of world.items ?? []) out.push({
      scope: "world", sceneId: "", collection: "items",
      ref: { coll: "items", id: doc._id }, doc, tags: tagsOf(doc),
    });
    for (const actor of world.actors ?? []) for (const doc of actor.items ?? []) out.push({
      scope: "world", sceneId: "", collection: "items",
      ref: { coll: "items", id: doc._id, parent: { coll: "actors", id: actor._id } },
      doc, tags: tagsOf(doc),
    });
  }
  return out;
}

/** List untagged scene placeables plus, on request, world actors/items for a global Tagger view. */
export function listTaggable(
  world: Readonly<WorldCollections>,
  options: Pick<TagSearchOptions, "sceneId" | "collections" | "includeWorldDocs" | "includeRefs" | "excludeRefs" | "viewer"> = {},
): TagSearchResult[] {
  const projected = options.viewer
    ? projectWorld(world as WorldCollections, 0, options.viewer).collections
    : world;
  const scenes = projected.scenes ?? [];
  const sceneRows = scenes.flatMap((scene) => options.sceneId && scene._id !== options.sceneId
    ? []
    : sceneResults(scene, options.collections)).filter((entry) => matchesRefFilter(entry.ref, options));
  const worldCollectionsRequested = options.collections?.some((collection) =>
    WORLD_TAGGABLE_COLLECTIONS.includes(collection as WorldTaggableCollection)) ?? false;
  const includeWorld = !options.sceneId && (options.includeWorldDocs === true || worldCollectionsRequested);
  if (!includeWorld) return sceneRows;
  const worldRows = worldDocumentResults(projected, options.collections)
    .filter((entry) => matchesRefFilter(entry.ref, options));
  return [...sceneRows, ...worldRows];
}

/** Direct query over an already projected world (or supply a viewer). */
export function getByTag(
  world: Readonly<WorldCollections>,
  query: string | readonly string[],
  options: TagSearchOptions = {},
): TagSearchResult[] {
  const match = tagMatcher(query, options);
  return listTaggable(world, options).filter((entry) => match(entry.tags));
}

/** Group projected query results by scene; the empty-string group contains explicitly included world docs. */
export function groupTagsByScene(rows: readonly TagSearchResult[]): Record<string, TagSearchResult[]> {
  const grouped: Record<string, TagSearchResult[]> = Object.create(null) as Record<string, TagSearchResult[]>;
  for (const row of rows) (grouped[row.scope === "world" ? "" : row.sceneId] ??= []).push(row);
  return grouped;
}

/** One cache per store (including per-viewer projected replicas), invalidated by scene/world-document ops. */
export class TagIndex {
  private readonly indexed = new Map<string, { scene: SceneDocument; results: TagSearchResult[] }>();
  private indexedWorldDocs: TagSearchResult[] | null = null;
  private readonly unsubscribe: () => void;
  constructor(private readonly store: DocumentStore) {
    this.unsubscribe = store.onChange((_env, changes) => {
      for (const change of changes) {
        if (change.root.coll === "scenes") this.indexed.delete(change.root.id);
        else if (change.root.coll === "actors" || change.root.coll === "items") this.indexedWorldDocs = null;
      }
    });
  }

  query(query: string | readonly string[], options: TagSearchOptions = {}): TagSearchResult[] {
    if (options.viewer) return getByTag(this.store.world, query, options); // do not cache unprojected results by viewer
    const match = tagMatcher(query, options);
    const results: TagSearchResult[] = [];
    for (const scene of this.store.getAll("scenes")) {
      if (options.sceneId && scene._id !== options.sceneId) continue;
      let indexed = this.indexed.get(scene._id);
      if (!indexed || indexed.scene !== scene) {
        indexed = { scene, results: sceneResults(scene) };
        this.indexed.set(scene._id, indexed);
      }
      for (const entry of indexed.results) {
        if (options.collections && !options.collections.includes(entry.collection)) continue;
        if (!matchesRefFilter(entry.ref, options)) continue;
        if (match(entry.tags)) results.push(entry);
      }
    }
    const worldCollectionsRequested = options.collections?.some((collection) =>
      WORLD_TAGGABLE_COLLECTIONS.includes(collection as WorldTaggableCollection)) ?? false;
    if (!options.sceneId && (options.includeWorldDocs === true || worldCollectionsRequested)) {
      this.indexedWorldDocs ??= worldDocumentResults(this.store.world);
      for (const entry of this.indexedWorldDocs) {
        if (options.collections && !options.collections.includes(entry.collection)) continue;
        if (!matchesRefFilter(entry.ref, options)) continue;
        if (match(entry.tags)) results.push(entry);
      }
    }
    return results;
  }

  dispose(): void {
    this.unsubscribe();
    this.indexed.clear();
    this.indexedWorldDocs = null;
  }
}

export type TagEdit = "add" | "remove" | "toggle" | "replace";

/** An atomic bulk edit uses ordinary undoable ops and the existing host permission checks. */
export function tagEditOps(
  docs: readonly { ref: TagRef; doc: BaseDocument }[],
  edit: TagEdit,
  input: readonly string[],
): Op[] {
  const values = normalizeTags(input);
  return docs.flatMap(({ ref, doc }): Op[] => {
    const old = normalizeTags(isPrototypeTokenTagRef(ref) ? prototypeTokenTagsOf(doc) : tagsOf(doc));
    const next = edit === "replace" ? values : edit === "add"
      ? normalizeTags([...old, ...values])
      : edit === "remove" ? old.filter((tag) => !values.includes(tag))
      : normalizeTags([...old.filter((tag) => !values.includes(tag)), ...values.filter((tag) => !old.includes(tag))]);
    if (JSON.stringify(old) === JSON.stringify(next)) return [];
    if (isPrototypeTokenTagRef(ref)) {
      const prototype = doc.type === "prototypeToken"
        ? (doc as BaseDocument & { prototypeToken?: unknown }).prototypeToken
        : (doc as ActorDocument).prototypeToken;
      const existingPrototype = prototype !== null && typeof prototype === "object" && !Array.isArray(prototype);
      const diff = existingPrototype ? { "prototypeToken.taggerTags": next }
        : { prototypeToken: { taggerTags: next } };
      return [{ kind: "update", ref: { coll: "actors", id: ref.id }, diff }];
    }
    return [{ kind: "update", ref, diff: { taggerTags: next } }];
  });
}

/** Replace literal creation-time Tagger placeholders; never interpret them in queries. */
export function expandTagTemplate(tag: string, number: number, id: string): string {
  if (!Number.isSafeInteger(number) || number < 0 || !id) throw new Error("invalid clone identity");
  return tag.replaceAll("{#}", String(number)).replaceAll("{id}", id);
}

/**
 * Tagger.applyTagRules for already-authored placeables (including legacy flags).
 * Allocate against the CURRENT committed scene and earlier items in this batch,
 * with one ordinal shared by a document's related tags. Host callers must
 * re-resolve and authorize every explicit ref immediately before invoking this.
 * The returned ops must commit in ONE envelope; no client preview is authority.
 */
export function tagRuleOps(
  world: Readonly<WorldCollections>,
  docs: readonly { ref: TagRef; sceneId: string; doc: BaseDocument }[],
): Op[] {
  if (docs.length > 32) throw new Error("tag rules allow at most 32 targets per transaction");
  const occupied = new Map<string, Set<string>>();
  const seen = new Set<string>();
  const ops: Op[] = [];
  for (const { ref, sceneId, doc } of docs) {
    const sceneTarget = sceneId !== "" && isWorldTagRef(ref) && ref.id === doc._id &&
      (ref.coll === "scenes" ? ref.id === sceneId : ref.parent?.id === sceneId);
    const worldTarget = sceneId === "" && isWorldDocumentTagRef(ref) && ref.id === doc._id;
    const identity = tagRefKey(ref);
    if ((!sceneTarget && !worldTarget) || seen.has(identity))
      throw new Error("invalid or duplicate tag-rule target");
    seen.add(identity);
    const source = normalizeTags(isPrototypeTokenTagRef(ref) ? prototypeTokenTagsOf(doc) : tagsOf(doc));
    if (!source.some((tag) => tag.includes("{#}") || tag.includes("{id}"))) continue;
    const scope = sceneTarget ? `scene:${sceneId}` : "world";
    let used = occupied.get(scope);
    if (!used) {
      if (sceneTarget) {
        if (!world.scenes.some((scene) => scene._id === sceneId)) throw new Error("tag-rule scene unavailable");
        used = new Set(listTaggable(world, { sceneId }).flatMap((row) => row.tags));
      } else {
        used = new Set(worldDocumentResults(world).flatMap((row) => row.tags));
      }
      occupied.set(scope, used);
    }
    const numbered = source.some((tag) => tag.includes("{#}"));
    const stableGenerated = source.filter((tag) => tag.includes("{id}") && !tag.includes("{#}"))
      .map((tag) => expandTagTemplate(tag, 1, doc._id));
    if (normalizeTags(stableGenerated).length !== stableGenerated.length)
      throw new Error("tag-rule expansion produced duplicate tags on one target");
    if (stableGenerated.some((tag) => used.has(tag)))
      throw new Error("no unique Tagger rule allocation available");
    let next: string[] | undefined;
    for (let number = 1; number <= (numbered ? 100_000 : 1); number++) {
      const candidate = source.map((tag) => expandTagTemplate(tag, number, doc._id));
      // An impossible expansion (bad ID, >128 chars, duplicate templates) must
      // fail the ENTIRE batch. Normalize before writing, never silently drop a tag.
      const normalized = normalizeTags(candidate);
      if (normalized.length !== candidate.length) {
        if (!numbered) throw new Error("tag-rule expansion produced duplicate tags on one target");
        continue;
      }
      const generated = candidate.filter((_, index) => source[index]?.includes("{#}") || source[index]?.includes("{id}"));
      if (generated.every((tag) => !used.has(tag))) { next = normalized; break; }
    }
    if (!next) throw new Error("no unique Tagger rule allocation available");
    for (let index = 0; index < source.length; index++) {
      if (source[index]?.includes("{#}") || source[index]?.includes("{id}")) used.add(next[index] ?? "");
    }
    ops.push(...tagEditOps([{ ref, doc }], "replace", next));
  }
  return ops;
}

/** Sidebar `tag:` accepts quoted phrases and multiple ANDed terms without changing API defaults. */
const MAX_SIDEBAR_QUERY_LENGTH = 512;
const MAX_SIDEBAR_TERMS = 32;

function sidebarTagClausePattern(): RegExp {
  return /(?:^|\s)tag:(?:"([^"\r\n]{1,128})"|([^\s"]{1,128}))(?=\s|$)/gi;
}

export function sidebarTagTerms(input: string): string[] {
  if (input.length > MAX_SIDEBAR_QUERY_LENGTH) throw new Error("sidebar query is too long");
  const terms = [...input.matchAll(sidebarTagClausePattern())]
    .map((match) => match[1] ?? match[2] ?? "");
  if (terms.length > MAX_SIDEBAR_TERMS) throw new Error("sidebar query has too many tag terms");
  return terms;
}

export function sidebarTagTerm(input: string): string | null {
  return sidebarTagTerms(input)[0] ?? null;
}

function sidebarTagMatchers(terms: readonly string[]): Array<(tags: readonly string[]) => boolean> {
  return terms.map((term) => {
    const match = /[*?]/.test(term)
      ? tagMatcher(`*${term}*`, { pattern: "wildcard", caseSensitive: false })
      : tagMatcher(term, { contains: true, caseSensitive: false });
    return match;
  });
}

export function sidebarTagMatch(doc: BaseDocument, input: string): boolean {
  const matchers = sidebarTagMatchers(sidebarTagTerms(input));
  return matchers.length > 0 && matchers.every((match) => match(tagsOf(doc)));
}

/**
 * Compile the combined sidebar name/tag query once before scanning a projected
 * result list. Plain name words and each `tag:` clause are ANDed; tag clauses
 * use the intentionally lenient, case-insensitive substring default.
 */
export function sidebarSearchMatcher(input: string): (doc: BaseDocument) => boolean {
  const tagTerms = sidebarTagTerms(input);
  const nameQuery = input.replace(sidebarTagClausePattern(), " ");
  const nameTerms = [...nameQuery.matchAll(/"([^"\r\n]{1,128})"|(\S+)/g)]
    .map((match) => (match[1] ?? match[2] ?? "").trim())
    .filter(Boolean);
  if (nameTerms.length > MAX_SIDEBAR_TERMS || nameTerms.some((term) => term.length > 128)) {
    throw new Error("sidebar query has too many or oversized name terms");
  }
  const normalizedNames = nameTerms.map((term) => term.toLocaleLowerCase());
  const tagMatchers = sidebarTagMatchers(tagTerms);
  return (doc) => {
    const name = doc.name.toLocaleLowerCase();
    if (!normalizedNames.every((term) => name.includes(term))) return false;
    if (!tagMatchers.length) return true;
    const tags = tagsOf(doc);
    return tagMatchers.every((match) => match(tags));
  };
}
