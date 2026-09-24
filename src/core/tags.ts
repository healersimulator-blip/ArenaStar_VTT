/**
 * Tagger-style document tags and scene queries. The exact/case-sensitive API
 * and the forgiving sidebar search are deliberately different contracts.
 * Queries operate on a client's projected store, or on a host store WITH an
 * explicit viewer; never use the host's unprojected index to answer a player.
 */
import type {
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
  "tokens", "walls", "tiles", "drawings", "templates", "lights", "sounds", "notes", "cells",
] as const;
export type TaggableCollection = (typeof TAGGABLE_COLLECTIONS)[number];
export type TagSearchCollection = TaggableCollection | "scenes";

const MAX_TAG_LENGTH = 128;
const MAX_TAGS = 64;
const MAX_QUERY_LENGTH = 128;

/** Imported Foundry/Tagger flags can be queried without changing the world. */
export function tagsOf(doc: BaseDocument): string[] {
  const source = doc.taggerTags ?? doc.flags?.tagger?.tags;
  if (!Array.isArray(source)) return [];
  return source.filter((tag): tag is string => typeof tag === "string" && tag.length > 0);
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
  sceneId: string;
  collection: TagSearchCollection;
  ref: DocRef;
  doc: BaseDocument;
  tags: readonly string[];
}
export interface TagSearchOptions extends TagMatchOptions {
  /** Omitted: all scenes, including unactivated scenes. */
  sceneId?: string;
  collections?: readonly TagSearchCollection[];
  /** Optional identity filters: full parent refs distinguish same-ID objects across scenes. */
  includeRefs?: readonly DocRef[];
  excludeRefs?: readonly DocRef[];
  /** Required on an unprojected host store for a non-GM query. */
  viewer?: PermissionUser;
}

function tagRefKey(ref: DocRef): string {
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

function matchesRefFilter(ref: DocRef, options: Pick<TagSearchOptions, "includeRefs" | "excludeRefs">): boolean {
  const key = tagRefKey(ref);
  if (options.excludeRefs?.some((item) => tagRefKey(item) === key)) return false;
  return options.includeRefs === undefined || options.includeRefs.some((item) => tagRefKey(item) === key);
}

function sceneResults(scene: SceneDocument, collections?: readonly TagSearchCollection[]): TagSearchResult[] {
  const out: TagSearchResult[] = [];
  const include = (c: TagSearchCollection) => !collections || collections.includes(c);
  if (include("scenes")) out.push({ sceneId: scene._id, collection: "scenes", ref: { coll: "scenes", id: scene._id }, doc: scene, tags: tagsOf(scene) });
  for (const coll of TAGGABLE_COLLECTIONS) {
    if (!include(coll)) continue;
    const docs = scene[coll] ?? []; // `cells` is optional on older worlds
    for (const doc of docs) out.push({
      sceneId: scene._id,
      collection: coll,
      ref: { coll, id: doc._id, parent: { coll: "scenes", id: scene._id } },
      doc,
      tags: tagsOf(doc),
    });
  }
  return out;
}

/** List even untagged placeables so a GM can author their first tag. */
export function listTaggable(
  world: Readonly<WorldCollections>,
  options: Pick<TagSearchOptions, "sceneId" | "collections" | "includeRefs" | "excludeRefs" | "viewer"> = {},
): TagSearchResult[] {
  const scenes = options.viewer
    ? projectWorld(world as WorldCollections, 0, options.viewer).collections.scenes ?? []
    : world.scenes;
  return scenes.flatMap((scene) => options.sceneId && scene._id !== options.sceneId
    ? []
    : sceneResults(scene, options.collections).filter((entry) => matchesRefFilter(entry.ref, options)));
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

/** Group already projected query results without flattening or accidentally keying by document ID. */
export function groupTagsByScene(rows: readonly TagSearchResult[]): Record<string, TagSearchResult[]> {
  const grouped: Record<string, TagSearchResult[]> = Object.create(null) as Record<string, TagSearchResult[]>;
  for (const row of rows) (grouped[row.sceneId] ??= []).push(row);
  return grouped;
}

/** One cache per store (including per-viewer projected replicas), invalidated by scene ops. */
export class TagIndex {
  private readonly indexed = new Map<string, { scene: SceneDocument; results: TagSearchResult[] }>();
  private readonly unsubscribe: () => void;
  constructor(private readonly store: DocumentStore) {
    this.unsubscribe = store.onChange((_env, changes) => {
      for (const change of changes) if (change.root.coll === "scenes") this.indexed.delete(change.root.id);
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
    return results;
  }

  dispose(): void {
    this.unsubscribe();
    this.indexed.clear();
  }
}

export type TagEdit = "add" | "remove" | "toggle" | "replace";

/** An atomic bulk edit uses ordinary undoable ops and the existing host permission checks. */
export function tagEditOps(
  docs: readonly { ref: DocRef; doc: BaseDocument }[],
  edit: TagEdit,
  input: readonly string[],
): Op[] {
  const values = normalizeTags(input);
  return docs.flatMap(({ ref, doc }): Op[] => {
    const old = normalizeTags(tagsOf(doc));
    const next = edit === "replace" ? values : edit === "add"
      ? normalizeTags([...old, ...values])
      : edit === "remove" ? old.filter((tag) => !values.includes(tag))
      : normalizeTags([...old.filter((tag) => !values.includes(tag)), ...values.filter((tag) => !old.includes(tag))]);
    return JSON.stringify(old) === JSON.stringify(next) ? [] : [{ kind: "update", ref, diff: { taggerTags: next } }];
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
  docs: readonly { ref: DocRef; sceneId: string; doc: BaseDocument }[],
): Op[] {
  if (docs.length > 32) throw new Error("tag rules allow at most 32 placeables per transaction");
  const occupied = new Map<string, Set<string>>();
  const seen = new Set<string>();
  const ops: Op[] = [];
  for (const { ref, sceneId, doc } of docs) {
    if (!isSceneTagRef(ref, sceneId) || ref.id !== doc._id || seen.has(tagRefKey(ref)))
      throw new Error("invalid or duplicate tag-rule target");
    seen.add(tagRefKey(ref));
    const source = normalizeTags(tagsOf(doc));
    if (!source.some((tag) => tag.includes("{#}") || tag.includes("{id}"))) continue;
    let used = occupied.get(sceneId);
    if (!used) {
      if (!world.scenes.some((scene) => scene._id === sceneId)) throw new Error("tag-rule scene unavailable");
      used = new Set(listTaggable(world, { sceneId }).flatMap((row) => row.tags));
      occupied.set(sceneId, used);
    }
    const numbered = source.some((tag) => tag.includes("{#}"));
    let next: string[] | undefined;
    for (let number = 1; number <= (numbered ? 100_000 : 1); number++) {
      const candidate = source.map((tag) => expandTagTemplate(tag, number, doc._id));
      // An impossible expansion (bad ID, >128 chars, duplicate templates) must
      // fail the ENTIRE batch. Normalize before writing, never silently drop a tag.
      const normalized = normalizeTags(candidate);
      if (normalized.length !== candidate.length) {
        if (!numbered) throw new Error("tag-rule expansion produced duplicate tags on one placeable");
        continue;
      }
      const generated = candidate.filter((_, index) => source[index]?.includes("{#}") || source[index]?.includes("{id}"));
      if (generated.every((tag) => !used.has(tag))) { next = normalized; break; }
    }
    if (!next) throw new Error("no scene-unique Tagger rule allocation available");
    for (let index = 0; index < source.length; index++) {
      if (source[index]?.includes("{#}") || source[index]?.includes("{id}")) used.add(next[index] ?? "");
    }
    if (JSON.stringify(source) !== JSON.stringify(next))
      ops.push({ kind: "update", ref, diff: { taggerTags: next } });
  }
  return ops;
}

/** Sidebar `tag:` accepts several quoted/unquoted terms. It does not change API defaults. */
export function sidebarTagTerms(input: string): string[] {
  return [...input.matchAll(/(?:^|\s)tag:(?:"([^"]{1,128})"|([^\s"]{1,128}))(?=\s|$)/gi)]
    .map((match) => match[1] ?? match[2] ?? "");
}

export function sidebarTagTerm(input: string): string | null {
  return sidebarTagTerms(input)[0] ?? null;
}

export function sidebarTagMatch(doc: BaseDocument, input: string): boolean {
  const terms = sidebarTagTerms(input);
  if (!terms.length) return false;
  const tags = tagsOf(doc);
  return terms.every((term) => /[*?]/.test(term)
    ? tagMatcher(`*${term}*`, { pattern: "wildcard", caseSensitive: false })(tags)
    : tagMatcher(term, { contains: true, caseSensitive: false })(tags));
}
