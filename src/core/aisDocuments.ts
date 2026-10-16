/**
 * D-485 — AIS generic document service (kernel side, Foundry-agnostic).
 *
 * Any AIS module may read the world documents its device user can see and submit ordinary
 * `Op[]` transactions with that user's authority (`documents.read` / `documents.write`). The
 * kernel never widens authority: the GM device writes as the GM, a player device writes as the
 * player, and the host validation pipeline (rate limit → permissions → schema-lite → invariants)
 * decides every transaction exactly as it does for the shell's own UI.
 *
 * This module holds the pure parts: the exposed collection table, request normalization with
 * kernel defaults, bounded paging, and the derivation of `documents.changed` payloads from
 * committed envelopes. The RPC handlers (`aisModuleHandlers.ts`) and the device runtimes wire it
 * to a `DocumentStore`. The Foundry adapter maps `Actor`/`Item`/… onto this API inside its frame;
 * the kernel knows nothing about Foundry document names or subtypes.
 */
import type { AnyCollectionName, BaseDocument, CollectionName, DocRef, Json } from "./documents";
import type { FlatDiff, Op } from "./ops";

/** Collections an AIS module may address. Scenes/placeables keep their dedicated scene services (slice 2). */
export const AIS_DOCUMENT_COLLECTIONS = {
  actors: { writable: true, embedded: { items: "item", effects: "effect" } },
  items: { writable: true, embedded: { effects: "effect" } },
  journals: { writable: true, embedded: { pages: "page" } },
  rollTables: { writable: true, embedded: {} },
  macros: { writable: true, embedded: {} },
  folders: { writable: true, embedded: {} },
  playlists: { writable: true, embedded: {} },
  combats: { writable: true, embedded: { combatants: "combatant" } },
  /** Assigned by the host only; a module reads them to learn names, roles and ownership targets. */
  users: { writable: false, embedded: {} },
  /** Posted through `chat.post` (host stamps the author); readable for history/hook emulation. */
  messages: { writable: false, embedded: {} },
} as const satisfies Partial<Record<CollectionName, { writable: boolean; embedded: Record<string, string> }>>;

export type AisDocumentCollection = keyof typeof AIS_DOCUMENT_COLLECTIONS;
export const AIS_DOCUMENT_COLLECTION_NAMES = Object.keys(AIS_DOCUMENT_COLLECTIONS) as AisDocumentCollection[];

/** Kind marker (`BaseDocument.type`) the store expects per top-level collection. */
const KIND_BY_COLLECTION: Record<AisDocumentCollection, string> = {
  actors: "actor", items: "item", journals: "journal", rollTables: "rollTable", macros: "macro",
  folders: "folder", playlists: "playlist", combats: "combat", users: "user", messages: "message",
};

/** Required fields a minimal create must carry so the store/host accept it; callers may override. */
const DEFAULTS_BY_KIND: Record<string, Record<string, Json>> = {
  actor: { items: [], effects: [] },
  item: { effects: [] },
  effect: { changes: [], disabled: false },
  journal: { pages: [] },
  page: { text: "", src: null },
  rollTable: { formula: "1d20", results: [] },
  macro: { kind: "chat", command: "" },
  folder: { parent: null, targetType: "actors" },
  playlist: { mode: "sequential", sounds: [] },
  combat: { round: 0, turn: 0, combatants: [] },
  combatant: { tokenId: null, actorId: null, initiative: null, hidden: false, defeated: false },
};

export const AIS_DOCUMENTS_LIMITS = Object.freeze({
  /** Ops per `documents.mutate` transaction (one host transaction, atomic). */
  opsPerMutation: 32,
  /** JSON bytes per mutation request. */
  mutationBytes: 512 * 1024,
  /** Rows per `documents.list` page (default / maximum) and the soft byte budget of one page. */
  listDefault: 100,
  listMax: 500,
  listBytes: 256 * 1024,
  /** Largest single document `documents.get` returns in full. */
  documentBytes: 1024 * 1024,
  /** Change entries per `documents.changed` event and the diff size kept inline. */
  changesPerEvent: 256,
  changeDiffBytes: 16 * 1024,
});

export function isAisDocumentCollection(value: unknown): value is AisDocumentCollection {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(AIS_DOCUMENT_COLLECTIONS, value);
}

/** `{ collection, id, parent? }` as modules address documents (never the store's `coll` spelling). */
export interface AisDocumentRef {
  collection: string;
  id: string;
  parent?: AisDocumentRef;
}

export type AisDocumentMutation =
  | { kind: "create"; collection: string; data: Record<string, Json>; parent?: AisDocumentRef }
  | { kind: "update"; collection: string; id: string; diff: Record<string, Json | null>; parent?: AisDocumentRef }
  | { kind: "delete"; collection: string; id: string; parent?: AisDocumentRef };

export interface AisDocumentChange {
  kind: "create" | "update" | "delete";
  collection: string;
  id: string;
  parent?: AisDocumentRef;
  /** Update ops only, when the diff fits `changeDiffBytes`; otherwise re-read the root document. */
  diff?: FlatDiff;
}

export interface AisDocumentsChangedPayload {
  seq: number;
  by: string;
  changes: AisDocumentChange[];
  truncated: boolean;
}

const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const FORBIDDEN_SEGMENTS = new Set(["__proto__", "constructor", "prototype"]);

export function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function isDocId(value: unknown): value is string {
  return typeof value === "string" && ID_PATTERN.test(value);
}

/** Validate a dotted FlatDiff path (optionally `-=`-prefixed) and reject prototype-polluting segments. */
export function aisDiffPathError(path: string): string | null {
  if (path.length === 0 || path.length > 256) return "diff path must be 1–256 characters";
  const body = path.startsWith("-=") ? path.slice(2) : path;
  const segments = body.split(".");
  if (segments.some((segment) => segment.length === 0)) return `diff path "${path}" has an empty segment`;
  if (segments.some((segment) => FORBIDDEN_SEGMENTS.has(segment))) return `diff path "${path}" is not allowed`;
  const head = segments[0];
  if (head === "_id" || head === "type") return `diff path "${path}" is kernel-owned`;
  return null;
}

interface ResolvedRef {
  /** Store spelling of the addressed collection (top-level or embedded). */
  coll: AnyCollectionName;
  /** Store kind marker for creates in this collection. */
  kind: string;
  /** Top-level collection the chain is rooted in. */
  root: AisDocumentCollection;
  parent?: DocRef;
}

/**
 * Resolve a module ref chain against the exposed-collection table: the root must be an exposed
 * top-level collection and every nested level an embedded collection of its parent's kind.
 */
export function resolveAisDocumentRef(
  collection: unknown,
  parent: unknown,
  depth = 0,
): { ok: true; value: ResolvedRef } | { ok: false; error: string } {
  if (typeof collection !== "string") return { ok: false, error: "collection must be a string" };
  if (depth > 2) return { ok: false, error: "document parent chain is too deep" };
  if (parent === undefined) {
    if (!isAisDocumentCollection(collection))
      return { ok: false, error: `collection "${collection}" is not exposed to AIS modules` };
    return { ok: true, value: { coll: collection, kind: KIND_BY_COLLECTION[collection], root: collection } };
  }
  if (!isPlainRecord(parent) || !isDocId(parent.id)) return { ok: false, error: "parent must be { collection, id, parent? }" };
  const above = resolveAisDocumentRef(parent.collection, parent.parent, depth + 1);
  if (!above.ok) return above;
  const parentKind = above.value.kind;
  const embeddedOf = embeddedTable(parentKind);
  const kind = embeddedOf?.[collection];
  if (!kind) return { ok: false, error: `"${collection}" is not an embedded collection of ${parentKind}` };
  const parentRef: DocRef = { coll: above.value.coll, id: parent.id, ...(above.value.parent ? { parent: above.value.parent } : {}) };
  return { ok: true, value: { coll: collection as AnyCollectionName, kind, root: above.value.root, parent: parentRef } };
}

function embeddedTable(kind: string): Record<string, string> | null {
  switch (kind) {
    case "actor": return AIS_DOCUMENT_COLLECTIONS.actors.embedded;
    case "item": return AIS_DOCUMENT_COLLECTIONS.items.embedded;
    case "journal": return AIS_DOCUMENT_COLLECTIONS.journals.embedded;
    case "combat": return AIS_DOCUMENT_COLLECTIONS.combats.embedded;
    default: return null;
  }
}

export interface AisDocumentMutationInput {
  userId: string;
  newId: () => string;
  /** JSON validity + size guard shared with the other handlers. */
  boundedJson: (value: unknown) => value is Json;
}

export interface AisDocumentMutationResult {
  ops: Op[];
  created: AisDocumentRef[];
}

/**
 * Turn a module's mutation list into store ops: exposed/writable collections only, kernel-owned
 * fields enforced (`_id`, `type`), minimal defaults filled, diff paths checked. Authority is NOT
 * decided here — the host validates the resulting transaction with the device user's permissions.
 */
export function normalizeAisDocumentMutations(
  raw: unknown,
  input: AisDocumentMutationInput,
): { ok: true; value: AisDocumentMutationResult } | { ok: false; error: string } {
  if (!Array.isArray(raw) || raw.length === 0) return { ok: false, error: "ops must be a non-empty array" };
  if (raw.length > AIS_DOCUMENTS_LIMITS.opsPerMutation)
    return { ok: false, error: `at most ${AIS_DOCUMENTS_LIMITS.opsPerMutation} ops per mutation` };
  const ops: Op[] = [];
  const created: AisDocumentRef[] = [];
  for (const [index, entry] of raw.entries()) {
    if (!isPlainRecord(entry)) return { ok: false, error: `ops[${index}] must be an object` };
    const resolved = resolveAisDocumentRef(entry.collection, entry.parent);
    if (!resolved.ok) return { ok: false, error: `ops[${index}]: ${resolved.error}` };
    const { coll, kind, root, parent } = resolved.value;
    if (!AIS_DOCUMENT_COLLECTIONS[root].writable) return { ok: false, error: `ops[${index}]: ${root} is read-only for modules` };
    const moduleParent = parent ? toModuleRef(parent) : undefined;
    switch (entry.kind) {
      case "create": {
        if (!isPlainRecord(entry.data) || !input.boundedJson(entry.data))
          return { ok: false, error: `ops[${index}]: data must be a bounded JSON object` };
        const data = entry.data as Record<string, Json>;
        if (data._id !== undefined && !isDocId(data._id)) return { ok: false, error: `ops[${index}]: invalid _id` };
        if (data.name !== undefined && (typeof data.name !== "string" || data.name.length > 256))
          return { ok: false, error: `ops[${index}]: name must be a string of at most 256 characters` };
        if (data.ownership !== undefined && !isOwnership(data.ownership))
          return { ok: false, error: `ops[${index}]: ownership must map user ids to levels 0–3` };
        if (data.flags !== undefined && !isPlainRecord(data.flags)) return { ok: false, error: `ops[${index}]: flags must be an object` };
        if (data.system !== undefined && !isPlainRecord(data.system)) return { ok: false, error: `ops[${index}]: system must be an object` };
        const id = typeof data._id === "string" ? data._id : input.newId();
        const inlineError = completeInlineEmbedded(data, kind, input.newId);
        if (inlineError) return { ok: false, error: `ops[${index}]: ${inlineError}` };
        const document = {
          ...(DEFAULTS_BY_KIND[kind] ?? {}),
          ...data,
          _id: id,
          type: kind,
          name: typeof data.name === "string" ? data.name : "",
          // Foundry semantics: the creator owns what they create unless they say otherwise.
          ownership: data.ownership !== undefined ? data.ownership : parent ? { default: 0 } : { default: 0, [input.userId]: 3 },
          flags: data.flags ?? {},
          system: data.system ?? {},
        } as unknown as BaseDocument;
        ops.push(parent ? { kind: "create", coll, parent, data: document } : { kind: "create", coll, data: document });
        created.push(moduleParent ? { collection: coll, id, parent: moduleParent } : { collection: coll, id });
        break;
      }
      case "update": {
        if (!isDocId(entry.id)) return { ok: false, error: `ops[${index}]: invalid id` };
        if (!isPlainRecord(entry.diff) || !input.boundedJson(entry.diff))
          return { ok: false, error: `ops[${index}]: diff must be a bounded JSON object` };
        const keys = Object.keys(entry.diff);
        if (keys.length === 0) return { ok: false, error: `ops[${index}]: diff is empty` };
        for (const key of keys) {
          const error = aisDiffPathError(key);
          if (error) return { ok: false, error: `ops[${index}]: ${error}` };
        }
        const ref: DocRef = parent ? { coll, id: entry.id, parent } : { coll, id: entry.id };
        ops.push({ kind: "update", ref, diff: entry.diff as FlatDiff });
        break;
      }
      case "delete": {
        if (!isDocId(entry.id)) return { ok: false, error: `ops[${index}]: invalid id` };
        const ref: DocRef = parent ? { coll, id: entry.id, parent } : { coll, id: entry.id };
        ops.push({ kind: "delete", ref });
        break;
      }
      default:
        return { ok: false, error: `ops[${index}]: kind must be create, update or delete` };
    }
  }
  return { ok: true, value: { ops, created } };
}

/**
 * Inline embedded arrays of a create (`actor.items`, `journal.pages`, `item.effects`, …) must be
 * store-shaped documents too: give every row the kernel defaults, an id and its kind marker.
 */
function completeInlineEmbedded(data: Record<string, Json>, kind: string, newId: () => string): string | null {
  const table = embeddedTable(kind);
  if (!table) return null;
  for (const [key, embeddedKind] of Object.entries(table)) {
    const rows = data[key];
    if (rows === undefined) continue;
    if (!Array.isArray(rows)) return `${key} must be an array`;
    const completed: Json[] = [];
    for (const row of rows) {
      if (!isPlainRecord(row)) return `${key} rows must be objects`;
      const record = row as Record<string, Json>;
      if (record._id !== undefined && !isDocId(record._id)) return `${key} row has an invalid _id`;
      if (record.ownership !== undefined && !isOwnership(record.ownership)) return `${key} row has invalid ownership`;
      const nested = completeInlineEmbedded(record, embeddedKind, newId);
      if (nested) return nested;
      completed.push({
        ...(DEFAULTS_BY_KIND[embeddedKind] ?? {}),
        ...record,
        _id: typeof record._id === "string" ? record._id : newId(),
        type: embeddedKind,
        name: typeof record.name === "string" ? record.name.slice(0, 256) : "",
        ownership: record.ownership ?? { default: 0 },
        flags: isPlainRecord(record.flags) ? record.flags : {},
        system: isPlainRecord(record.system) ? record.system : {},
      });
    }
    data[key] = completed;
  }
  return null;
}

function isOwnership(value: unknown): boolean {
  return isPlainRecord(value) && Object.values(value).every((level) => level === 0 || level === 1 || level === 2 || level === 3);
}

function toModuleRef(ref: DocRef): AisDocumentRef {
  return ref.parent ? { collection: ref.coll, id: ref.id, parent: toModuleRef(ref.parent) } : { collection: ref.coll, id: ref.id };
}

/** Root top-level collection of a store op, walking the parent chain. */
function rootCollectionOf(op: Op): AnyCollectionName {
  let coll: AnyCollectionName = op.kind === "create" ? op.coll : op.ref.coll;
  let parent: DocRef | undefined = op.kind === "create" ? op.parent : op.ref.parent;
  while (parent) {
    coll = parent.coll;
    parent = parent.parent;
  }
  return coll;
}

/**
 * `documents.changed` payload for one committed envelope, restricted to the exposed collections.
 * Null when nothing a module may observe changed.
 */
export function aisDocumentChanges(
  seq: number,
  by: string,
  ops: readonly Op[],
  byteLength: (value: unknown) => number | null,
): AisDocumentsChangedPayload | null {
  const changes: AisDocumentChange[] = [];
  let truncated = false;
  for (const op of ops) {
    if (!isAisDocumentCollection(rootCollectionOf(op))) continue;
    if (changes.length >= AIS_DOCUMENTS_LIMITS.changesPerEvent) { truncated = true; break; }
    if (op.kind === "create") {
      const parent = op.parent ? toModuleRef(op.parent) : undefined;
      changes.push(parent ? { kind: "create", collection: op.coll, id: op.data._id, parent } : { kind: "create", collection: op.coll, id: op.data._id });
      continue;
    }
    const parent = op.ref.parent ? toModuleRef(op.ref.parent) : undefined;
    const base: AisDocumentChange = parent
      ? { kind: op.kind, collection: op.ref.coll, id: op.ref.id, parent }
      : { kind: op.kind, collection: op.ref.coll, id: op.ref.id };
    if (op.kind === "update" && (byteLength(op.diff) ?? Infinity) <= AIS_DOCUMENTS_LIMITS.changeDiffBytes) base.diff = op.diff;
    changes.push(base);
  }
  return changes.length === 0 ? null : { seq, by, changes, truncated };
}

export interface AisDocumentPage {
  collection: AisDocumentCollection;
  total: number;
  offset: number;
  rows: BaseDocument[];
  /** Offset of the next page, or null when this page ends the collection. */
  next: number | null;
}

/** Bounded page of a collection: at most `limit` rows and roughly `listBytes` of JSON (always ≥ 1 row). */
export function pageAisDocuments(
  collection: AisDocumentCollection,
  all: readonly BaseDocument[],
  offsetRaw: unknown,
  limitRaw: unknown,
  byteLength: (value: unknown) => number | null,
): AisDocumentPage {
  const offset = typeof offsetRaw === "number" && Number.isInteger(offsetRaw) && offsetRaw > 0 ? Math.min(offsetRaw, all.length) : 0;
  const limit = typeof limitRaw === "number" && Number.isInteger(limitRaw) && limitRaw > 0
    ? Math.min(limitRaw, AIS_DOCUMENTS_LIMITS.listMax)
    : AIS_DOCUMENTS_LIMITS.listDefault;
  const rows: BaseDocument[] = [];
  let bytes = 0;
  let cursor = offset;
  while (cursor < all.length && rows.length < limit) {
    const doc = all[cursor];
    if (!doc) break;
    const size = byteLength(doc) ?? AIS_DOCUMENTS_LIMITS.documentBytes;
    if (rows.length > 0 && bytes + size > AIS_DOCUMENTS_LIMITS.listBytes) break;
    rows.push(doc);
    bytes += size;
    cursor += 1;
  }
  return { collection, total: all.length, offset, rows, next: cursor < all.length ? cursor : null };
}
