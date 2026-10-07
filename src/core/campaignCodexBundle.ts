/* eslint-disable @typescript-eslint/no-unused-vars, @typescript-eslint/no-dynamic-delete, no-useless-assignment */
/**
 * Permission-filtered Campaign Codex selected-content bundles.
 *
 * This archive is intentionally separate from World ZIP: it contains only an explicit root's
 * readable dependency closure, and never a world id or an unfiltered collection snapshot.
 */
import { strFromU8, strToU8, unzipSync, zipSync, type UnzipFileInfo } from "fflate";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import type {
  ActorDocument,
  AssetManifest,
  AssetManifestEntry,
  BaseDocument,
  CodexWidgetInstance,
  DocRef,
  ItemDocument,
  JournalDocument,
  RollTableDocument,
  SceneDocument,
  WorldCollections,
} from "./documents";
import type { PermissionUser } from "./ownership";
import type { Op } from "./ops";
import { canReadCodexRef, codexArchiveJournalError, type CodexResolver } from "./campaignCodex";
import { codexWidgetDocumentRefs } from "./campaignCodexWidgets";
import { diffFlat, asRecord } from "./diff";
import { projectAssetManifest, projectWorldAssetReferences } from "./assetAccess";
import { projectWorld } from "./projection";

export const CODEX_BUNDLE_FORMAT = "arenastar-codex-bundle" as const;
export const CODEX_BUNDLE_VERSION = 1 as const;
export const CODEX_BUNDLE_INDEX_PATH = "campaign-codex.json";
export const CODEX_BUNDLE_MAX_ARCHIVE_BYTES = 64 * 1024 * 1024;
export const CODEX_BUNDLE_MAX_UNCOMPRESSED_BYTES = 96 * 1024 * 1024;
export const CODEX_BUNDLE_MAX_ASSET_BYTES = 32 * 1024 * 1024;
export const CODEX_BUNDLE_MAX_DOCUMENTS = 96;
export const CODEX_BUNDLE_MAX_ROOTS = 16;
export const CODEX_BUNDLE_MAX_OP_BYTES = 2 * 1024 * 1024;

const ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
const HASH_RE = /^[a-f0-9]{64}$/i;
const MEDIA_KEYS = new Set(["img", "src", "icon", "audio", "assetId", "packAsset"]);
const TOP_LEVEL_COLLECTIONS = ["journals", "actors", "items", "scenes", "rollTables"] as const;
type BundleCollection = (typeof TOP_LEVEL_COLLECTIONS)[number];

export interface CodexBundleDocuments {
  journals: JournalDocument[];
  actors: ActorDocument[];
  items: ItemDocument[];
  scenes: SceneDocument[];
  rollTables: RollTableDocument[];
}

export interface CodexBundleReport {
  included: Record<BundleCollection, number>;
  /** Count is limited to refs in the already-projected dependency closure. */
  omittedMedia: number;
  /** One generic notice only; never exposes hidden target names, ids, or counts. */
  hasUnavailableDependencies: boolean;
  /** User ids are world-scoped; imported per-user grants are never retained. */
  hasPortablePermissionResets: boolean;
}

/** The public index contains no source world id and no private dependency list. */
export interface CodexContentBundle {
  format: typeof CODEX_BUNDLE_FORMAT;
  version: typeof CODEX_BUNDLE_VERSION;
  roots: DocRef[];
  documents: CodexBundleDocuments;
  assets: AssetManifest;
  report: CodexBundleReport;
}

export interface ExportedCodexBundle {
  bytes: Uint8Array;
  report: CodexBundleReport;
}

export interface ParsedCodexBundle {
  bundle: CodexContentBundle;
  assetBytes: Map<string, Uint8Array>;
}

export interface CodexBundleBuildOptions {
  world: Readonly<WorldCollections>;
  manifest: AssetManifest;
  viewer: PermissionUser;
  /** Journal ids are validated against the caller's projected world. */
  rootJournalIds: readonly string[];
  loadAsset: (assetId: string) => Promise<Uint8Array | undefined>;
}

export function codexBundleDocumentCount(documents: CodexBundleDocuments): number {
  return TOP_LEVEL_COLLECTIONS.reduce((total, coll) => total + documents[coll].length, 0);
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isGm(user: PermissionUser): boolean {
  return user.role === "GM" || user.role === "ASSISTANT";
}

function docKey(coll: string, id: string): string {
  return `${coll}:${id}`;
}

function refKey(ref: DocRef): string {
  return ref.parent ? `${refKey(ref.parent)}/${ref.coll}:${ref.id}` : docKey(ref.coll, ref.id);
}

function topRef(ref: DocRef): DocRef {
  let current = ref;
  while (current.parent) current = current.parent;
  return current;
}

function resolveProjectedRef(world: Partial<WorldCollections>, ref: DocRef): BaseDocument | undefined {
  if (ref.parent) {
    const parent = resolveProjectedRef(world, ref.parent);
    if (ref.coll === "pages" && parent?.type === "journal")
      return (parent as JournalDocument).pages.find((page) => page._id === ref.id);
    if (ref.coll === "items" && parent?.type === "actor")
      return (parent as ActorDocument).items.find((item) => item._id === ref.id);
    return undefined;
  }
  switch (ref.coll) {
    case "journals": return world.journals?.find((doc) => doc._id === ref.id);
    case "actors": return world.actors?.find((doc) => doc._id === ref.id);
    case "items": return world.items?.find((doc) => doc._id === ref.id);
    case "scenes": return world.scenes?.find((doc) => doc._id === ref.id);
    case "rollTables": return world.rollTables?.find((doc) => doc._id === ref.id);
    default: return undefined;
  }
}

function emptyDocuments(): CodexBundleDocuments {
  return { journals: [], actors: [], items: [], scenes: [], rollTables: [] };
}

function filteredActor(actor: ActorDocument, viewer: PermissionUser, resolver: CodexResolver,
  includeItems: "all" | Set<string>): ActorDocument {
  if (isGm(viewer) && includeItems === "all") return clone(actor);
  const visibleItems = actor.items.filter((item) => {
    const ref: DocRef = { coll: "items", id: item._id, parent: { coll: "actors", id: actor._id } };
    return canReadCodexRef(viewer, ref, resolver) &&
      (includeItems === "all" || includeItems.has(item._id));
  });
  return { ...clone(actor), items: visibleItems.map(clone) };
}

function docDependencies(doc: BaseDocument): DocRef[] {
  const refs: DocRef[] = [];
  if (doc.type === "journal") {
    const journal = doc as JournalDocument;
    for (const link of journal.codex?.links ?? []) refs.push(link.target);
    for (const row of journal.codex?.shop?.stock ?? []) refs.push(row.item);
    for (const widget of journal.codex?.widgets ?? [])
      refs.push(...codexWidgetDocumentRefs(widget));
  } else if (doc.type === "scene") {
    const scene = doc as SceneDocument;
    for (const token of scene.tokens) if (token.actorId) refs.push({ coll: "actors", id: token.actorId });
    for (const note of scene.notes) {
      if (note.journalId) refs.push({ coll: "journals", id: note.journalId });
      if (note.linkedSceneId) refs.push({ coll: "scenes", id: note.linkedSceneId });
    }
  } else if (doc.type === "rollTable") {
    for (const result of (doc as RollTableDocument).results)
      if (result.documentRef) refs.push(result.documentRef);
  }
  return refs;
}

function sanitizeBundleScene(scene: SceneDocument, included: CodexBundleDocuments): SceneDocument {
  const actorIds = new Set(included.actors.map((actor) => actor._id));
  const journalIds = new Set(included.journals.map((journal) => journal._id));
  const sceneIds = new Set(included.scenes.map((entry) => entry._id));
  const copy = clone(scene);
  copy.tokens = copy.tokens.map((token) => {
    if (token.actorId && !actorIds.has(token.actorId)) {
      const safe = { ...token };
      delete safe.actorId;
      return safe;
    }
    return token;
  });
  copy.notes = copy.notes.map((note) => {
    const safe = { ...note };
    if (safe.journalId && !journalIds.has(safe.journalId)) delete safe.journalId;
    if (safe.linkedSceneId && !sceneIds.has(safe.linkedSceneId)) delete safe.linkedSceneId;
    return safe;
  });
  return copy;
}

function sanitizeJournalReferences(journal: JournalDocument, included: CodexBundleDocuments,
  allowedAssets: ReadonlySet<string>): JournalDocument {
  const copy = clone(journal);
  const docIds = new Set<string>();
  for (const collection of TOP_LEVEL_COLLECTIONS)
    for (const doc of included[collection]) docIds.add(docKey(collection, doc._id));
  const pageIds = new Set(included.journals.flatMap((entry) => entry.pages.map((page) => `${entry._id}:${page._id}`)));
  const actorItemIds = new Set(included.actors.flatMap((actor) => actor.items.map((item) => `${actor._id}:${item._id}`)));
  const mapsRef = (ref: DocRef): boolean => {
    if (ref.coll === "pages" && ref.parent?.coll === "journals")
      return pageIds.has(`${ref.parent.id}:${ref.id}`);
    if (ref.coll === "items" && ref.parent?.coll === "actors")
      return actorItemIds.has(`${ref.parent.id}:${ref.id}`);
    return docIds.has(docKey(ref.coll, ref.id));
  };
  if (copy.codex) {
    if (copy.codex.cover && !allowedAssets.has(copy.codex.cover)) delete copy.codex.cover;
    copy.codex.links = copy.codex.links.filter((link) => mapsRef(link.target));
    if (copy.codex.shop)
      copy.codex.shop.stock = copy.codex.shop.stock.filter((row) => mapsRef(row.item));
    copy.codex.widgets = copy.codex.widgets.map((widget) => {
      if (widget.type === "roll-table" && widget.version === 1 && isRecord(widget.config) &&
          typeof widget.config.tableId === "string" && !docIds.has(docKey("rollTables", widget.config.tableId))) {
        const config = { ...widget.config };
        delete config.tableId;
        return { ...widget, config } as CodexWidgetInstance;
      }
      if (widget.type === "image-gallery" && widget.version === 1 && isRecord(widget.config) &&
          Array.isArray(widget.config.images)) {
        const images = widget.config.images.filter((image) => isRecord(image) &&
          typeof image.assetId === "string" && allowedAssets.has(image.assetId));
        return { ...widget, config: { ...widget.config, images } } as CodexWidgetInstance;
      }
      return widget;
    });
  }
  return copy;
}

function scrubMedia(value: unknown, allowedAssets: ReadonlySet<string>, key = ""): unknown {
  if (Array.isArray(value)) {
    return value.flatMap((child) => {
      if (isRecord(child) && (child.kind === "image" || child.kind === "sound") &&
          typeof child.assetId === "string" && !allowedAssets.has(child.assetId)) return [];
      return [scrubMedia(child, allowedAssets)];
    });
  }
  if (!isRecord(value)) {
    if (MEDIA_KEYS.has(key) && typeof value === "string" &&
        (HASH_RE.test(value) && !allowedAssets.has(value) || /^https?:\/\//i.test(value)))
      return key === "src" ? null : "";
    return value;
  }
  const result: Record<string, unknown> = {};
  for (const [childKey, child] of Object.entries(value)) {
    const safe = scrubMedia(child, allowedAssets, childKey);
    if (childKey === "assetId" && safe === undefined) continue;
    result[childKey] = safe;
  }
  return result;
}

function cleanDocumentMedia(documents: CodexBundleDocuments, allowedAssets: ReadonlySet<string>): CodexBundleDocuments {
  const clean = <T extends BaseDocument>(doc: T): T => scrubMedia(doc, allowedAssets) as T;
  const docIds = new Set<string>();
  for (const collection of TOP_LEVEL_COLLECTIONS)
    for (const doc of documents[collection]) docIds.add(docKey(collection, doc._id));
  const pageIds = new Set(documents.journals.flatMap((journal) => journal.pages.map((page) => `${journal._id}:${page._id}`)));
  const actorItemIds = new Set(documents.actors.flatMap((actor) => actor.items.map((item) => `${actor._id}:${item._id}`)));
  const hasRef = (ref: DocRef): boolean => ref.coll === "pages" && ref.parent?.coll === "journals"
    ? pageIds.has(`${ref.parent.id}:${ref.id}`)
    : ref.coll === "items" && ref.parent?.coll === "actors"
      ? actorItemIds.has(`${ref.parent.id}:${ref.id}`)
      : docIds.has(docKey(ref.coll, ref.id));
  return {
    journals: documents.journals.map((doc) => sanitizeJournalReferences(clean(doc), documents, allowedAssets)),
    actors: documents.actors.map(clean),
    items: documents.items.map(clean),
    scenes: documents.scenes.map((doc) => sanitizeBundleScene(clean(doc), documents)),
    rollTables: documents.rollTables.map((doc) => ({
      ...clean(doc),
      results: doc.results.map((result) => ({
        ...result,
        documentRef: result.documentRef && hasRef(result.documentRef) ? result.documentRef : null,
      })),
    })),
  };
}

function journalConfigValid(journal: JournalDocument): void {
  const error = codexArchiveJournalError(journal);
  if (error) throw new Error(`Invalid Codex journal: ${error}`);
}

function scrubPortablePermissions(value: unknown): { value: unknown; reset: boolean } {
  let reset = false;
  const visit = (current: unknown): unknown => {
    if (Array.isArray(current)) return current.map(visit);
    if (!isRecord(current)) return current;
    const safe: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(current)) {
      if (key === "ownership" && isRecord(child)) {
        const defaultLevel = child.default;
        if (Object.keys(child).some((ownerId) => ownerId !== "default")) reset = true;
        if (defaultLevel !== 0 && defaultLevel !== 1 && defaultLevel !== 2 && defaultLevel !== 3) reset = true;
        safe.ownership = { default: defaultLevel === 1 || defaultLevel === 2 || defaultLevel === 3 ? defaultLevel : 0 };
      } else if (key === "audience" && isRecord(child) && child.kind === "selectedUsers") {
        // Account ids are local to the source world. Fail closed rather than accidentally granting
        // a destination account with the same opaque id; the imported author can republish locally.
        safe.audience = { kind: "gmOnly" };
        reset = true;
      } else {
        safe[key] = visit(child);
      }
    }
    return safe;
  };
  return { value: visit(value), reset };
}

/**
 * Build a visible dependency closure. Hidden/unreadable targets are neither serialized nor
 * named in reports; the return value contains only an anonymous availability flag.
 */
export function buildCodexBundleModel(
  world: Readonly<WorldCollections>,
  manifest: AssetManifest,
  viewer: PermissionUser,
  rootJournalIds: readonly string[],
): { bundle: CodexContentBundle; assetIds: string[] } {
  if (rootJournalIds.length === 0 || rootJournalIds.length > CODEX_BUNDLE_MAX_ROOTS)
    throw new Error(`Select between 1 and ${CODEX_BUNDLE_MAX_ROOTS} Codex sheets.`);
  if (new Set(rootJournalIds).size !== rootJournalIds.length)
    throw new Error("The selected Codex roots contain duplicates.");
  const worldWithManifest = { ...world, assetManifest: manifest } as WorldCollections;
  const projected = projectWorld(worldWithManifest, 0, viewer).collections;
  const visibleManifest = projectAssetManifest(worldWithManifest, manifest, viewer);
  const resolver: CodexResolver = {
    resolve: (ref) => resolveProjectedRef(projected, ref),
    canReadAsset: (assetId) => Object.prototype.hasOwnProperty.call(visibleManifest, assetId),
  };
  const roots = rootJournalIds.map((id) => projected.journals?.find((journal) => journal._id === id && journal.codex));
  if (roots.some((journal) => !journal || !journal.codex))
    throw new Error("Every selected root must be a readable Campaign Codex sheet.");
  for (const journal of roots as JournalDocument[]) {
    if (journal.codex?.version !== 1) throw new Error("A selected Codex sheet uses an unsupported schema version.");
    journalConfigValid(journal);
  }

  const included = emptyDocuments();
  const added = new Set<string>();
  const actorAllItems = new Set<string>();
  const actorSelectedItems = new Map<string, Set<string>>();
  const queue: DocRef[] = [];
  let unavailable = false;

  const addRootJournal = (journal: JournalDocument): void => {
    const key = docKey("journals", journal._id);
    if (added.has(key)) return;
    added.add(key);
    included.journals.push(clone(journal));
    queue.push(...docDependencies(journal));
  };
  for (const journal of roots as JournalDocument[]) addRootJournal(journal);

  const addReference = (ref: DocRef): void => {
    const doc = resolveProjectedRef(projected, ref);
    if (!doc || !canReadCodexRef(viewer, ref, resolver)) {
      unavailable = true;
      return;
    }
    if (ref.coll === "pages" && ref.parent?.coll === "journals") {
      const parent = projected.journals?.find((journal) => journal._id === ref.parent?.id);
      if (!parent) { unavailable = true; return; }
      addRootJournal(parent);
      return;
    }
    if (ref.coll === "items" && ref.parent?.coll === "actors") {
      const parentId = ref.parent.id;
      const actor = projected.actors?.find((candidate) => candidate._id === parentId);
      if (!actor) { unavailable = true; return; }
      const ids = actorSelectedItems.get(parentId) ?? new Set<string>();
      ids.add(doc._id);
      actorSelectedItems.set(parentId, ids);
      const key = docKey("actors", parentId);
      if (!added.has(key)) {
        added.add(key);
        included.actors.push(filteredActor(actor, viewer, resolver, ids));
        queue.push(...docDependencies(actor));
      }
      return;
    }
    const root = topRef(ref);
    const key = docKey(root.coll, root.id);
    if (added.has(key)) {
      if (root.coll === "actors" && ref.coll === "actors") actorAllItems.add(root.id);
      return;
    }
    added.add(key);
    switch (root.coll) {
      case "journals": {
        const journal = doc as JournalDocument;
        included.journals.push(clone(journal));
        queue.push(...docDependencies(journal));
        break;
      }
      case "actors": {
        const actor = doc as ActorDocument;
        actorAllItems.add(actor._id);
        included.actors.push(filteredActor(actor, viewer, resolver, "all"));
        queue.push(...docDependencies(actor));
        break;
      }
      case "items": included.items.push(clone(doc as ItemDocument)); break;
      case "scenes": {
        const scene = doc as SceneDocument;
        included.scenes.push(clone(scene));
        queue.push(...docDependencies(scene));
        break;
      }
      case "rollTables": {
        const table = doc as RollTableDocument;
        included.rollTables.push(clone(table));
        queue.push(...docDependencies(table));
        break;
      }
      default: unavailable = true;
    }
  };

  while (queue.length > 0) {
    const ref = queue.shift();
    if (ref) addReference(ref);
    if (codexBundleDocumentCount(included) > CODEX_BUNDLE_MAX_DOCUMENTS)
      throw new Error(`The selected dependency closure exceeds ${CODEX_BUNDLE_MAX_DOCUMENTS} documents.`);
  }
  // If a later actor reference widens an earlier embedded-item subset, refresh its copy.
  for (const actor of included.actors) {
    const source = projected.actors?.find((candidate) => candidate._id === actor._id);
    const selected = actorAllItems.has(actor._id)
      ? "all"
      : actorSelectedItems.get(actor._id) ?? new Set<string>();
    if (source) Object.assign(actor, filteredActor(source, viewer, resolver, selected));
  }
  for (const journal of included.journals) journalConfigValid(journal);
  const portable = scrubPortablePermissions(included);
  const portableDocuments = portable.value as CodexBundleDocuments;

  const collections: Partial<WorldCollections> = {
    journals: portableDocuments.journals,
    actors: portableDocuments.actors,
    items: portableDocuments.items,
    scenes: portableDocuments.scenes,
    rollTables: portableDocuments.rollTables,
  };
  const referencedAssets = projectWorldAssetReferences(collections, visibleManifest);
  const eligibleAssets: AssetManifest = {};
  let omittedMedia = 0;
  for (const assetId of referencedAssets) {
    const entry = visibleManifest[assetId];
    if (!entry || entry.exportRights !== "granted" || !HASH_RE.test(assetId)) {
      omittedMedia++;
      continue;
    }
    const { thumb: _thumb, mid: _mid, tiles: _tiles, ...direct } = entry;
    eligibleAssets[assetId] = { ...direct, visibility: "referenced" };
  }
  const sanitized = cleanDocumentMedia(portableDocuments, new Set(Object.keys(eligibleAssets)));
  const counts = Object.fromEntries(TOP_LEVEL_COLLECTIONS.map((coll) => [coll, sanitized[coll].length])) as Record<BundleCollection, number>;
  const bundle: CodexContentBundle = {
    format: CODEX_BUNDLE_FORMAT,
    version: CODEX_BUNDLE_VERSION,
    roots: rootJournalIds.map((id) => ({ coll: "journals", id })),
    documents: sanitized,
    assets: eligibleAssets,
    report: {
      included: counts,
      omittedMedia,
      hasUnavailableDependencies: unavailable,
      hasPortablePermissionResets: portable.reset,
    },
  };
  return { bundle, assetIds: Object.keys(eligibleAssets) };
}

/** Build ZIP bytes only for locally available, hash-verified assets with explicit export rights. */
export async function exportCodexBundle(options: CodexBundleBuildOptions): Promise<ExportedCodexBundle> {
  const built = buildCodexBundleModel(options.world, options.manifest, options.viewer, options.rootJournalIds);
  const bytesById = new Map<string, Uint8Array>();
  const assets = { ...built.bundle.assets };
  let omittedMedia = built.bundle.report.omittedMedia;
  let totalAssetBytes = 0;
  for (const assetId of built.assetIds) {
    const entry = assets[assetId];
    if (!entry) continue;
    let bytes: Uint8Array | undefined;
    try { bytes = await options.loadAsset(assetId); } catch { bytes = undefined; }
    if (!bytes || bytes.length !== entry.size || bytes.length > CODEX_BUNDLE_MAX_ASSET_BYTES ||
        bytesToHex(sha256(bytes)) !== assetId || totalAssetBytes + bytes.length > CODEX_BUNDLE_MAX_UNCOMPRESSED_BYTES) {
      delete assets[assetId];
      omittedMedia++;
      continue;
    }
    bytesById.set(assetId, new Uint8Array(bytes));
    totalAssetBytes += bytes.length;
  }
  const documents = cleanDocumentMedia(built.bundle.documents, new Set(Object.keys(assets)));
  const bundle: CodexContentBundle = {
    ...built.bundle,
    documents,
    assets,
    report: { ...built.bundle.report, omittedMedia },
  };
  const serialized = strToU8(JSON.stringify(bundle));
  if (serialized.length > 16 * 1024 * 1024) throw new Error("The selected Codex bundle metadata is too large.");
  const files: Record<string, Uint8Array> = { [CODEX_BUNDLE_INDEX_PATH]: serialized };
  for (const [assetId, bytes] of bytesById)
    if (assets[assetId]) files[`assets/${assetId}`] = bytes;
  const zipped = zipSync(files, { level: 6 });
  if (zipped.length > CODEX_BUNDLE_MAX_ARCHIVE_BYTES)
    throw new Error("The selected Codex bundle exceeds the 64 MiB download limit.");
  return { bytes: zipped, report: bundle.report };
}

function validateBundleDocuments(value: unknown): asserts value is CodexBundleDocuments {
  if (!isRecord(value)) throw new Error("Bundle documents are missing.");
  for (const coll of TOP_LEVEL_COLLECTIONS) {
    const docs = value[coll];
    if (!Array.isArray(docs)) throw new Error(`Bundle collection '${coll}' is invalid.`);
    const seen = new Set<string>();
    for (const doc of docs) {
      if (!isRecord(doc) || typeof doc._id !== "string" || !ID_RE.test(doc._id))
        throw new Error(`Bundle collection '${coll}' contains an invalid document id.`);
      if (typeof doc.name !== "string" || doc.name.length > 256 || !isRecord(doc.ownership) ||
          doc.ownership.default !== 0 && doc.ownership.default !== 1 && doc.ownership.default !== 2 && doc.ownership.default !== 3 ||
          !isRecord(doc.flags) || !isRecord(doc.system))
        throw new Error(`Bundle document '${doc._id}' has invalid base fields.`);
      if (seen.has(doc._id)) throw new Error(`Bundle collection '${coll}' contains duplicate ids.`);
      seen.add(doc._id);
      const expected = coll === "rollTables" ? "rollTable" : coll.slice(0, -1);
      if (doc.type !== expected) throw new Error(`Bundle document in '${coll}' has the wrong type.`);
      if (coll === "journals") journalConfigValid(doc as unknown as JournalDocument);
      if (coll === "actors" && !Array.isArray(doc.items)) throw new Error("Bundle actor items are invalid.");
      if (coll === "scenes" && (!Array.isArray(doc.tokens) || !Array.isArray(doc.notes)))
        throw new Error("Bundle scene embedded records are invalid.");
      if (coll === "rollTables" && !Array.isArray(doc.results)) throw new Error("Bundle roll table results are invalid.");
    }
  }
  if (codexBundleDocumentCount(value as unknown as CodexBundleDocuments) > CODEX_BUNDLE_MAX_DOCUMENTS)
    throw new Error(`Bundle exceeds the ${CODEX_BUNDLE_MAX_DOCUMENTS}-document limit.`);
}

/** Parse and validate a selected-content ZIP, including paths, sizes, schemas, and content hashes. */
export function parseCodexBundleZip(input: Uint8Array): ParsedCodexBundle {
  if (input.length === 0 || input.length > CODEX_BUNDLE_MAX_ARCHIVE_BYTES)
    throw new Error("The selected Codex bundle is empty or exceeds 64 MiB.");
  let total = 0;
  let fileCount = 0;
  let invalid = "";
  const seen = new Set<string>();
  const filter = (file: UnzipFileInfo): boolean => {
    fileCount++;
    if (fileCount > 257) { invalid = "The bundle contains too many files."; return false; }
    if (seen.has(file.name)) { invalid = "The bundle contains duplicate file paths."; return false; }
    seen.add(file.name);
    if (file.name !== CODEX_BUNDLE_INDEX_PATH && !/^assets\/[a-f0-9]{64}$/i.test(file.name)) {
      invalid = "The bundle contains an unsupported file path.";
      return false;
    }
    if (!Number.isSafeInteger(file.originalSize) || file.originalSize < 0 ||
        file.originalSize > CODEX_BUNDLE_MAX_UNCOMPRESSED_BYTES) {
      invalid = "The bundle contains an oversized entry.";
      return false;
    }
    total += file.originalSize;
    if (total > CODEX_BUNDLE_MAX_UNCOMPRESSED_BYTES) {
      invalid = "The uncompressed bundle exceeds 96 MiB.";
      return false;
    }
    if (file.name.startsWith("assets/") && file.originalSize > CODEX_BUNDLE_MAX_ASSET_BYTES) {
      invalid = "A bundled asset exceeds 32 MiB.";
      return false;
    }
    if (file.name === CODEX_BUNDLE_INDEX_PATH && file.originalSize > 16 * 1024 * 1024) {
      invalid = "The bundle index exceeds 16 MiB.";
      return false;
    }
    if (file.compression !== 0 && file.compression !== 8) {
      invalid = "The bundle uses an unsupported compression method.";
      return false;
    }
    return true;
  };
  let extracted: Record<string, Uint8Array>;
  try { extracted = unzipSync(input, { filter }); }
  catch { throw new Error("The selected file is not a valid supported Codex ZIP."); }
  if (invalid) throw new Error(invalid);
  const indexBytes = extracted[CODEX_BUNDLE_INDEX_PATH];
  if (!indexBytes) throw new Error("The Codex bundle index is missing.");
  let raw: unknown;
  try { raw = JSON.parse(strFromU8(indexBytes)); }
  catch { throw new Error("The Codex bundle index is not valid JSON."); }
  if (!isRecord(raw) || raw.format !== CODEX_BUNDLE_FORMAT || raw.version !== CODEX_BUNDLE_VERSION)
    throw new Error("This Codex bundle format or version is not supported.");
  validateBundleDocuments(raw.documents);
  if (!Array.isArray(raw.roots) || raw.roots.length === 0 || raw.roots.length > CODEX_BUNDLE_MAX_ROOTS)
    throw new Error("The bundle root list is invalid.");
  const journalById = new Map(raw.documents.journals.map((journal) => [journal._id, journal]));
  const rootKeys = new Set<string>();
  for (const root of raw.roots) {
    if (!isRecord(root) || root.coll !== "journals" || typeof root.id !== "string" ||
        !journalById.get(root.id)?.codex || rootKeys.has(root.id))
      throw new Error("The bundle has an invalid, duplicate, or missing Codex root.");
    rootKeys.add(root.id);
  }
  if (!isRecord(raw.assets)) throw new Error("The bundle asset index is invalid.");
  const assetBytes = new Map<string, Uint8Array>();
  const parsedAssets: AssetManifest = {};
  for (const [assetId, entry] of Object.entries(raw.assets)) {
    if (!HASH_RE.test(assetId) || !isRecord(entry) || typeof entry.name !== "string" || entry.name.length > 255 ||
        typeof entry.mime !== "string" || entry.mime.length > 128 || !Number.isSafeInteger(entry.size) ||
        Number(entry.size) < 0 || Number(entry.size) > CODEX_BUNDLE_MAX_ASSET_BYTES ||
        !Number.isSafeInteger(entry.chunks) || Number(entry.chunks) < 1 ||
        entry.visibility !== "referenced" || entry.exportRights !== "granted")
      throw new Error("The bundle asset metadata is invalid.");
    const bytes = extracted[`assets/${assetId}`];
    if (!bytes || bytes.length !== entry.size || bytesToHex(sha256(bytes)) !== assetId)
      throw new Error(`Bundled asset '${entry.name}' failed its content hash check.`);
    parsedAssets[assetId] = entry as unknown as AssetManifestEntry;
    assetBytes.set(assetId, new Uint8Array(bytes));
  }
  for (const path of Object.keys(extracted)) {
    if (path.startsWith("assets/") && !Object.hasOwn(parsedAssets, path.slice(7)))
      throw new Error("The bundle includes an asset that is not declared in its index.");
  }
  const report = raw.report;
  if (!isRecord(report) || !isRecord(report.included) || !Number.isSafeInteger(report.omittedMedia) ||
      Number(report.omittedMedia) < 0 || typeof report.hasUnavailableDependencies !== "boolean" ||
      typeof report.hasPortablePermissionResets !== "boolean")
    throw new Error("The bundle dependency report is invalid.");
  const includedCounts = report.included;
  if (TOP_LEVEL_COLLECTIONS.some((coll) => !Number.isSafeInteger(includedCounts[coll]) ||
      Number(includedCounts[coll]) < 0 || Number(includedCounts[coll]) > CODEX_BUNDLE_MAX_DOCUMENTS))
    throw new Error("The bundle dependency report is invalid.");
  const bundle: CodexContentBundle = {
    format: CODEX_BUNDLE_FORMAT,
    version: CODEX_BUNDLE_VERSION,
    roots: clone(raw.roots) as DocRef[],
    documents: raw.documents,
    assets: parsedAssets,
    report: clone(report) as unknown as CodexBundleReport,
  };
  return { bundle, assetBytes };
}

export type CodexBundleConflictAction = "skip" | "link" | "replace";
export interface CodexBundleConflictCandidate { id: string; name: string; }
export interface CodexBundleConflict {
  key: string;
  collection: BundleCollection;
  sourceId: string;
  sourceName: string;
  candidates: CodexBundleConflictCandidate[];
}
export interface CodexBundleConflictChoice {
  action: CodexBundleConflictAction;
  targetId?: string;
}
export type CodexBundleChoices = Readonly<Record<string, CodexBundleConflictChoice | undefined>>;
export interface CodexBundleImportPlan {
  conflicts: CodexBundleConflict[];
  pendingConflicts: string[];
  ops: Op[];
  warnings: string[];
  ready: boolean;
  operationBytes: number;
}

interface SourceNode {
  collection: BundleCollection;
  doc: BaseDocument;
  key: string;
}

function nodesOf(bundle: CodexContentBundle): SourceNode[] {
  return TOP_LEVEL_COLLECTIONS.flatMap((collection) => bundle.documents[collection].map((doc) => ({
    collection,
    doc: doc as BaseDocument,
    key: docKey(collection, doc._id),
  })));
}

function sameName(a: string, b: string): boolean {
  return a.trim().normalize("NFKC").toLocaleLowerCase() === b.trim().normalize("NFKC").toLocaleLowerCase();
}

function destinationDocs(world: Readonly<WorldCollections>, collection: BundleCollection): readonly BaseDocument[] {
  return world[collection] as readonly BaseDocument[];
}

function randomDocumentId(): string {
  return globalThis.crypto.randomUUID();
}

function mapInternalRef(ref: DocRef, ids: ReadonlyMap<string, string | null>): DocRef | null {
  const sourceKey = ref.parent ? `${refKey(ref.parent)}/${ref.coll}:${ref.id}` : docKey(ref.coll, ref.id);
  const parent = ref.parent ? mapInternalRef(ref.parent, ids) : undefined;
  if (ref.parent && !parent) return null;
  const mappedId = ids.get(sourceKey);
  if (mappedId === undefined || mappedId === null) return null;
  return { coll: ref.coll, id: mappedId, ...(parent ? { parent } : {}) };
}

function findDestinationJournal(world: Readonly<WorldCollections>, id: string): JournalDocument | undefined {
  return world.journals.find((journal) => journal._id === id);
}
function findDestinationActor(world: Readonly<WorldCollections>, id: string): ActorDocument | undefined {
  return world.actors.find((actor) => actor._id === id);
}

function rewriteBundleDocument(
  node: SourceNode,
  world: Readonly<WorldCollections>,
  mappedIds: ReadonlyMap<string, string | null>,
  action: "create" | "link" | "replace" | "skip",
  selectedTargetId?: string,
  availableAssets: ReadonlySet<string> = new Set(),
): BaseDocument | null {
  if (action === "skip" || action === "link") return null;
  const targetId = selectedTargetId ?? mappedIds.get(node.key);
  if (!targetId) return null;
  const copy = clone(node.doc) as BaseDocument;
  copy._id = targetId;
  if (copy.type === "journal") {
    const journal = copy as JournalDocument;
    const sourceJournal = node.doc as JournalDocument;
    journal.pages = sourceJournal.pages.map((page) => {
      const pageId = mappedIds.get(`${docKey("journals", sourceJournal._id)}/pages:${page._id}`);
      return { ...clone(page), _id: pageId ?? page._id };
    });
    if (journal.codex) {
      const sourceLinks = journal.codex.links;
      journal.codex.links = sourceLinks.flatMap((link) => {
        const target = mapInternalRef(link.target, mappedIds);
        return target ? [{ ...link, target }] : [];
      });
      if (journal.codex.shop) {
        journal.codex.shop.stock = journal.codex.shop.stock.flatMap((row) => {
          const item = mapInternalRef(row.item, mappedIds);
          return item ? [{ ...row, item }] : [];
        });
      }
      journal.codex.widgets = journal.codex.widgets.map((widget) => {
        if (widget.type !== "roll-table" || widget.version !== 1 || !isRecord(widget.config) ||
            typeof widget.config.tableId !== "string") return widget;
        const tableId = mappedIds.get(docKey("rollTables", widget.config.tableId));
        if (tableId) return { ...widget, config: { ...widget.config, tableId } };
        const config = { ...widget.config };
        delete config.tableId;
        return { ...widget, config };
      });
      if (journal.codex.cover && !availableAssets.has(journal.codex.cover)) delete journal.codex.cover;
      journal.codex.widgets = journal.codex.widgets.map((widget) => {
        if (widget.type !== "image-gallery" || widget.version !== 1 || !isRecord(widget.config) ||
            !Array.isArray(widget.config.images)) return widget;
        return { ...widget, config: { ...widget.config, images: widget.config.images.filter((image) =>
          isRecord(image) && typeof image.assetId === "string" && availableAssets.has(image.assetId)) } };
      });
    }
    if (action === "replace") {
      const existing = findDestinationJournal(world, targetId);
      if (existing) {
        const newPageIds = new Set(journal.pages.map((page) => page._id));
        const preserved = existing.pages.filter((page) => !newPageIds.has(page._id)).map((page) => {
          const safe = clone(page);
          if (safe.codex?.tabKey && !journal.codex?.tabs?.some((tab) => tab.key === safe.codex?.tabKey)) {
            const metadata = { ...safe.codex };
            delete metadata.tabKey;
            safe.codex = metadata;
          }
          return safe;
        });
        journal.pages.push(...preserved);
      }
    }
  } else if (copy.type === "actor") {
    const actor = copy as ActorDocument;
    const sourceActor = node.doc as ActorDocument;
    actor.items = sourceActor.items.map((item) => ({
      ...clone(item),
      _id: mappedIds.get(`${docKey("actors", sourceActor._id)}/items:${item._id}`) ?? item._id,
    }));
    if (action === "replace") {
      const existing = findDestinationActor(world, targetId);
      if (existing) {
        const importedItemIds = new Set(actor.items.map((item) => item._id));
        actor.items.push(...existing.items.filter((item) => !importedItemIds.has(item._id)).map(clone));
      }
    }
  } else if (copy.type === "scene") {
    const scene = copy as SceneDocument;
    scene.tokens = scene.tokens.map((token) => {
      if (!token.actorId) return token;
      const actorId = mappedIds.get(docKey("actors", token.actorId));
      if (actorId) return { ...token, actorId };
      const safe = { ...token };
      delete safe.actorId;
      return safe;
    });
    scene.notes = scene.notes.map((note) => {
      const safe = { ...note };
      if (safe.journalId) {
        const journalId = mappedIds.get(docKey("journals", safe.journalId));
        if (journalId) safe.journalId = journalId;
        else delete safe.journalId;
      }
      if (safe.linkedSceneId) {
        const sceneId = mappedIds.get(docKey("scenes", safe.linkedSceneId));
        if (sceneId) safe.linkedSceneId = sceneId;
        else delete safe.linkedSceneId;
      }
      return safe;
    });
  } else if (copy.type === "rollTable") {
    const table = copy as RollTableDocument;
    table.results = table.results.map((result) => ({
      ...result,
      documentRef: result.documentRef ? mapInternalRef(result.documentRef, mappedIds) : null,
    }));
  }
  const mediaSafe = scrubMedia(copy, availableAssets);
  return scrubPortablePermissions(mediaSafe).value as BaseDocument;
}

/**
 * Prepare one atomic import transaction. Any name/id match requires an explicit skip/link/replace
 * choice; new docs are remapped, and all internal references follow the same complete ID table.
 */
export function planCodexBundleImport(
  bundle: CodexContentBundle,
  world: Readonly<WorldCollections>,
  choices: CodexBundleChoices = {},
  idFactory: () => string = randomDocumentId,
): CodexBundleImportPlan {
  const policySafe = scrubPortablePermissions(bundle.documents);
  bundle = {
    ...bundle,
    documents: policySafe.value as CodexBundleDocuments,
    report: {
      ...bundle.report,
      hasPortablePermissionResets: bundle.report.hasPortablePermissionResets || policySafe.reset,
    },
  };
  const nodes = nodesOf(bundle);
  const conflicts: CodexBundleConflict[] = [];
  const decisions = new Map<string, { action: "create" | CodexBundleConflictAction; targetId?: string }>();
  const pendingConflicts: string[] = [];
  const mappedIds = new Map<string, string | null>();
  let invalidChoice = false;

  for (const node of nodes) {
    const doc = node.doc;
    const candidates = destinationDocs(world, node.collection).filter((existing) =>
      existing._id === doc._id || sameName(existing.name, doc.name));
    const unique = [...new Map(candidates.map((candidate) => [candidate._id, candidate])).values()];
    if (unique.length === 0) {
      const id = idFactory();
      if (!ID_RE.test(id)) throw new Error("The ID generator returned an invalid document id.");
      mappedIds.set(node.key, id);
      decisions.set(node.key, { action: "create" });
      continue;
    }
    const conflict: CodexBundleConflict = {
      key: node.key,
      collection: node.collection,
      sourceId: doc._id,
      sourceName: doc.name,
      candidates: unique.map((candidate) => ({ id: candidate._id, name: candidate.name })),
    };
    conflicts.push(conflict);
    const choice = choices[node.key];
    if (!choice) {
      pendingConflicts.push(node.key);
      mappedIds.set(node.key, null);
      continue;
    }
    if (choice.action === "skip") {
      decisions.set(node.key, { action: "skip" });
      mappedIds.set(node.key, null);
      continue;
    }
    const target = unique.find((candidate) => candidate._id === choice.targetId);
    if (!target || (choice.action !== "link" && choice.action !== "replace")) {
      invalidChoice = true;
      mappedIds.set(node.key, null);
      continue;
    }
    decisions.set(node.key, { action: choice.action, targetId: target._id });
    mappedIds.set(node.key, target._id);
  }

  // Embedded page/item ids are part of the same mapping table as top-level documents.
  for (const journal of bundle.documents.journals) {
    const key = docKey("journals", journal._id);
    const mappedJournalId = mappedIds.get(key);
    const decision = decisions.get(key);
    const existing = mappedJournalId ? findDestinationJournal(world, mappedJournalId) : undefined;
    for (const page of journal.pages) {
      let mappedPage: string | null = null;
      if (decision?.action === "link")
        mappedPage = existing?.pages.find((candidate) => candidate._id === page._id)?._id ?? null;
      else if (decision?.action === "skip") mappedPage = null;
      else {
        const same = decision?.action === "replace" ? existing?.pages.find((candidate) => candidate._id === page._id) : undefined;
        mappedPage = same?._id ?? idFactory();
        if (!ID_RE.test(mappedPage)) throw new Error("The ID generator returned an invalid page id.");
      }
      mappedIds.set(`${key}/pages:${page._id}`, mappedPage);
    }
  }
  for (const actor of bundle.documents.actors) {
    const key = docKey("actors", actor._id);
    const mappedActorId = mappedIds.get(key);
    const decision = decisions.get(key);
    const existing = mappedActorId ? findDestinationActor(world, mappedActorId) : undefined;
    for (const item of actor.items) {
      let mappedItem: string | null = null;
      if (decision?.action === "link")
        mappedItem = existing?.items.find((candidate) => candidate._id === item._id)?._id ?? null;
      else if (decision?.action === "skip") mappedItem = null;
      else {
        const same = decision?.action === "replace" ? existing?.items.find((candidate) => candidate._id === item._id) : undefined;
        mappedItem = same?._id ?? idFactory();
        if (!ID_RE.test(mappedItem)) throw new Error("The ID generator returned an invalid item id.");
      }
      mappedIds.set(`${key}/items:${item._id}`, mappedItem);
    }
  }
  // Direct top-level item IDs already have a document entry, while embedded item refs have a parent path.
  for (const item of bundle.documents.items) if (!mappedIds.has(docKey("items", item._id))) {
    const key = docKey("items", item._id);
    if (decisions.get(key)?.action === "link") mappedIds.set(key, decisions.get(key)?.targetId ?? null);
  }

  const needsDecision = pendingConflicts.length > 0 || invalidChoice;
  const ops: Op[] = [];
  const availableAssets = new Set(Object.entries(bundle.assets)
    .filter(([, entry]) => entry.exportRights === "granted")
    .map(([assetId]) => assetId));
  const unreviewedAssets = Object.keys(bundle.assets).length - availableAssets.size;
  if (!needsDecision) {
    for (const node of nodes) {
      const decision = decisions.get(node.key);
      if (!decision || decision.action === "skip" || decision.action === "link") continue;
      const targetId = decision.targetId ?? mappedIds.get(node.key) ?? undefined;
      if (!targetId) continue;
      const rewritten = rewriteBundleDocument(node, world, mappedIds, decision.action, targetId, availableAssets);
      if (!rewritten) continue;
      if (decision.action === "create") {
        ops.push({ kind: "create", coll: node.collection, data: rewritten });
      } else {
        const existing = destinationDocs(world, node.collection).find((candidate) => candidate._id === targetId);
        if (!existing) { invalidChoice = true; continue; }
        const diff = diffFlat(asRecord(existing), asRecord(rewritten));
        if (Object.keys(diff).length > 0) ops.push({ kind: "update", ref: { coll: node.collection, id: targetId }, diff });
      }
    }
  }
  // A root can reference a skipped or linked doc; rewriteBundleDocument removes unresolved refs.
  // The bundle importer reports only a generic warning, never the hidden target id/name.
  const genericWarnings: string[] = [];
  if (bundle.report.hasUnavailableDependencies)
    genericWarnings.push("Some dependencies were unavailable to the exporter and are not included.");
  if (bundle.report.hasPortablePermissionResets)
    genericWarnings.push("World-specific user permissions were removed or made GM-only; review local access before publishing.");
  if (bundle.report.omittedMedia > 0 || unreviewedAssets > 0)
    genericWarnings.push("Some media was omitted or remains restricted; review local asset rights before sharing again.");
  if (needsDecision) genericWarnings.push("Choose skip, link, or replace for every matched document before importing.");
  if (invalidChoice) genericWarnings.push("One or more conflict choices no longer match the current destination world.");
  if (ops.length > CODEX_BUNDLE_MAX_DOCUMENTS)
    genericWarnings.push("The import transaction exceeds the document-operation limit.");
  const operationBytes = new TextEncoder().encode(JSON.stringify(ops)).length;
  if (operationBytes > CODEX_BUNDLE_MAX_OP_BYTES)
    genericWarnings.push("The import transaction is too large for one atomic commit.");
  return {
    conflicts,
    pendingConflicts,
    ops,
    warnings: genericWarnings,
    ready: !needsDecision && !invalidChoice && ops.length > 0 && ops.length <= CODEX_BUNDLE_MAX_DOCUMENTS && operationBytes <= CODEX_BUNDLE_MAX_OP_BYTES,
    operationBytes,
  };
}
