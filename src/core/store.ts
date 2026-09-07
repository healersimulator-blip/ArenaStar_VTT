/**
 * §4/§5 DocumentStore: the in-memory world state (host: authoritative;
 * client: replica). ALL mutations flow through applyEnvelope(OpEnvelope) with
 * strict monotonic seq (invariant: every store mutation rides an envelope).
 *
 * Envelopes are transactions (D-016): ops are applied op-by-op with inverses
 * captured first; any failing op rolls the whole envelope back (inverses in
 * reverse). Embedded collections (tokens in scenes, units in armies, …) are
 * addressed by DocRef parent chains (D-012); parent docs are rebuilt
 * immutably up to the root so external references stay stable per change.
 *
 * Reactivity (§10): watch(ref, cb, path?) fires for changes to the addressed
 * document (or any descendant/ancestor overlap), optionally filtered to a
 * dotted path within the watched document.
 */
import {
  TOP_LEVEL_COLLECTIONS,
  type ActorDocument,
  type BaseDocument,
  type CollectionName,
  type CombatDocument,
  type DocRef,
  type EmbeddedCollectionName,
  type ItemDocument,
  type JournalDocument,
  type PlaylistDocument,
  type SceneDocument,
  type WorldCollections,
} from "./documents";
import type { ArmyDocument } from "./strategic";
import type { DocId, WorldId } from "./ids";
import type { Op, OpEnvelope } from "./ops";
import { applyDiff, normalizeDiffKey } from "./diff";
import { computeInverse } from "./oplog";
import { type Result, err, okVal } from "./result";
import type { Unsubscribe } from "./events";

export interface StoreMeta {
  worldId: WorldId;
  name: string;
  system: string;
  systemVersion: string;
}

/** A change to one top-level document, as produced by one envelope. */
export interface DocChange {
  seq: number;
  txId: string;
  root: { coll: CollectionName; id: DocId };
  /** Ops of this envelope that touched this root (synthetic deletes for cap trims). */
  ops: Op[];
}

export interface ApplySuccess {
  /** Inverse ops (op order) — feed to OpLog.append for undo (§8). */
  inverses: Op[];
  changes: DocChange[];
}

export interface DocumentStoreOptions {
  meta: StoreMeta;
  /** Chat history cap (§4 messages "capped"); trims oldest first. Default 100. */
  messagesCap?: number;
}

// ─── Embedded collection plumbing (D-012) ─────────────────────────────────────

const EMBEDDED_COLLECTION_NAMES: readonly EmbeddedCollectionName[] = [
  "tokens",
  "walls",
  "lights",
  "sounds",
  "tiles",
  "drawings",
  "templates",
  "notes",
  "items",
  "effects",
  "pages",
  "combatants",
  "units",
];

function isEmbeddedName(name: string): name is EmbeddedCollectionName {
  return EMBEDDED_COLLECTION_NAMES.includes(name as EmbeddedCollectionName);
}

/** The embedded array `name` inside `doc`, or null if not embeddable there. */
function embeddedArray(doc: BaseDocument, name: EmbeddedCollectionName): BaseDocument[] | null {
  switch (name) {
    case "tokens":
      return doc.type === "scene" ? (doc as SceneDocument).tokens : null;
    case "walls":
      return doc.type === "scene" ? (doc as SceneDocument).walls : null;
    case "lights":
      return doc.type === "scene" ? (doc as SceneDocument).lights : null;
    case "sounds":
      if (doc.type === "scene") return (doc as SceneDocument).sounds;
      if (doc.type === "playlist") return (doc as PlaylistDocument).sounds;
      return null;
    case "tiles":
      return doc.type === "scene" ? (doc as SceneDocument).tiles : null;
    case "drawings":
      return doc.type === "scene" ? (doc as SceneDocument).drawings : null;
    case "templates":
      return doc.type === "scene" ? (doc as SceneDocument).templates : null;
    case "notes":
      return doc.type === "scene" ? (doc as SceneDocument).notes : null;
    case "items":
      return doc.type === "actor" ? (doc as ActorDocument).items : null;
    case "effects":
      if (doc.type === "actor") return (doc as ActorDocument).effects;
      if (doc.type === "item") return (doc as ItemDocument).effects;
      return null;
    case "pages":
      return doc.type === "journal" ? (doc as JournalDocument).pages : null;
    case "combatants":
      return doc.type === "combat" ? (doc as CombatDocument).combatants : null;
    case "units":
      return doc.type === "army" ? (doc as ArmyDocument).units : null;
  }
}

/** Top-level document at the end of a ref's parent chain. */
function refRoot(ref: DocRef): { coll: CollectionName; id: DocId } {
  let r: DocRef = ref;
  while (r.parent) r = r.parent;
  return { coll: r.coll as CollectionName, id: r.id };
}

/** Canonical chain segments root→target: ["scenes","s1","tokens","t1"]. */
function chainSegs(ref: DocRef): string[] {
  const base = ref.parent ? chainSegs(ref.parent) : [];
  return [...base, ref.coll, encodeURIComponent(ref.id)];
}

function opChainSegs(op: Op): string[] {
  if (op.kind === "create") {
    const ref: DocRef = op.parent
      ? { coll: op.coll, id: op.data._id, parent: op.parent }
      : { coll: op.coll, id: op.data._id };
    return chainSegs(ref);
  }
  return chainSegs(op.ref);
}

function diffKeySegs(key: string): string[] {
  return normalizeDiffKey(key).split(".");
}

function prefixEitherWay(a: string[], b: string[]): boolean {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

interface Watcher {
  segs: string[];
  pathSegs: string[] | null;
  cb: (change: DocChange) => void;
}

function emptyCollections(): WorldCollections {
  return {
    users: [],
    folders: [],
    scenes: [],
    actors: [],
    items: [],
    journals: [],
    rollTables: [],
    playlists: [],
    macros: [],
    cards: [],
    combats: [],
    messages: [],
    settings: [],
    compendia: [],
    factions: [],
    armies: [],
    turns: [],
    assetManifest: {},
  };
}

export class DocumentStore {
  readonly meta: StoreMeta;
  seq = 0;

  private collections: WorldCollections = emptyCollections();
  private byId = new Map<CollectionName, Map<DocId, BaseDocument>>();
  private watchers = new Set<Watcher>();
  private changeListeners = new Set<
    (env: OpEnvelope, changes: DocChange[], inverses: Op[]) => void
  >();
  private readonly messagesCap: number;

  constructor(options: DocumentStoreOptions) {
    this.meta = options.meta;
    this.messagesCap = options.messagesCap ?? 100;
    this.reindex();
  }

  // ─── Reads ──────────────────────────────────────────────────────────────────

  /** Read-only view over the world (projection iterates this). */
  get world(): Readonly<WorldCollections> {
    return this.collections;
  }

  get<C extends CollectionName>(coll: C, id: DocId): WorldCollections[C][number] | undefined {
    const doc = this.byId.get(coll)?.get(id);
    return doc as WorldCollections[C][number] | undefined;
  }

  getAll<C extends CollectionName>(coll: C): readonly WorldCollections[C][number][] {
    return this.collections[coll] as readonly WorldCollections[C][number][];
  }

  /** Resolve a (possibly embedded) reference to its current document. */
  resolve(ref: DocRef): BaseDocument | undefined {
    if (!ref.parent) {
      if (!TOP_LEVEL_COLLECTIONS.includes(ref.coll as CollectionName)) return undefined;
      return this.byId.get(ref.coll as CollectionName)?.get(ref.id);
    }
    const parentDoc = this.resolve(ref.parent);
    if (!parentDoc) return undefined;
    if (!isEmbeddedName(ref.coll)) return undefined;
    const arr = embeddedArray(parentDoc, ref.coll);
    if (!arr) return undefined;
    return arr.find((d) => d._id === ref.id);
  }

  // ─── Mutation (envelopes only — invariant §6) ───────────────────────────────

  applyEnvelope(env: OpEnvelope): Result<ApplySuccess> {
    if (env.seq !== this.seq + 1) {
      return err(`store: expected seq ${this.seq + 1}, got ${env.seq}`);
    }
    const inverses: Op[] = [];
    const touched: Array<{ root: { coll: CollectionName; id: DocId }; op: Op }> = [];
    for (const op of env.ops) {
      const inverse = computeInverse(this, op);
      const res = this.applyOne(op);
      if (!res.ok) {
        this.rollback(inverses);
        return err(`envelope txId=${env.txId} rejected: ${res.error}`);
      }
      if (inverse) inverses.push(inverse);
      touched.push({ root: res.value.root, op });
    }
    this.seq = env.seq;

    const byRoot = new Map<string, DocChange>();
    for (const t of touched) {
      const key = `${t.root.coll}/${t.root.id}`;
      let change = byRoot.get(key);
      if (!change) {
        change = { seq: env.seq, txId: env.txId, root: t.root, ops: [] };
        byRoot.set(key, change);
      }
      change.ops.push(t.op);
    }
    // Deterministic message cap trim (D-018) — synthetic delete ops.
    for (const op of this.trimMessages()) {
      const key = "messages/" + (op.kind === "delete" ? op.ref.id : "");
      let change = byRoot.get(key);
      if (!change) {
        change = {
          seq: env.seq,
          txId: env.txId,
          root: { coll: "messages", id: op.kind === "delete" ? op.ref.id : "" },
          ops: [],
        };
        byRoot.set(key, change);
      }
      change.ops.push(op);
    }

    const changes = [...byRoot.values()];
    this.notify(env, changes, inverses);
    return okVal({ inverses, changes });
  }

  private rollback(inverses: Op[]): void {
    for (let i = inverses.length - 1; i >= 0; i--) {
      const inverse = inverses[i];
      if (!inverse) continue;
      const res = this.applyOne(inverse);
      if (!res.ok) {
        throw new Error(`store: FATAL rollback failed: ${res.error}`);
      }
    }
  }

  private applyOne(op: Op): Result<{ root: { coll: CollectionName; id: DocId } }> {
    switch (op.kind) {
      case "create":
        return this.applyCreate(op);
      case "update":
        return this.applyUpdate(op);
      case "delete":
        return this.applyDelete(op);
    }
  }

  private applyCreate(
    op: Extract<Op, { kind: "create" }>,
  ): Result<{ root: { coll: CollectionName; id: DocId } }> {
    const data = structuredClone(op.data) as BaseDocument;
    if (typeof data._id !== "string" || data._id.length === 0)
      return err("create: data._id required");
    if (typeof data.name !== "string") return err("create: data.name required");
    if (typeof data.type !== "string" || data.type.length === 0)
      return err("create: data.type required");
    // Lenient defaults for optional common fields (D-019).
    if (!data.flags) data.flags = {};
    if (!data.system) data.system = {};
    if (!data.ownership) data.ownership = { default: 0 };

    if (op.parent) {
      const parentDoc = this.resolve(op.parent);
      if (!parentDoc) return err(`create: parent ${JSON.stringify(op.parent)} not found`);
      if (!isEmbeddedName(op.coll))
        return err(`create: '${op.coll}' is not an embedded collection`);
      const arr = embeddedArray(parentDoc, op.coll);
      if (!arr)
        return err(`create: '${op.coll}' not embeddable in parent type '${parentDoc.type}'`);
      if (arr.some((d) => d._id === data._id)) {
        return err(`create: duplicate _id '${data._id}' in ${op.coll}`);
      }
      const newParent = withEmbedded(parentDoc, op.coll, [...arr, data]);
      this.replaceDoc(op.parent, newParent);
      return okVal({ root: refRoot(op.parent) });
    }

    if (!TOP_LEVEL_COLLECTIONS.includes(op.coll as CollectionName)) {
      return err(`create: '${op.coll}' requires a parent (embedded collection)`);
    }
    const coll = op.coll as CollectionName;
    if (this.byId.get(coll)?.has(data._id))
      return err(`create: duplicate _id '${data._id}' in ${coll}`);
    (this.collections[coll] as unknown as BaseDocument[]).push(data);
    this.byId.get(coll)?.set(data._id, data);
    return okVal({ root: { coll, id: data._id } });
  }

  private applyUpdate(
    op: Extract<Op, { kind: "update" }>,
  ): Result<{ root: { coll: CollectionName; id: DocId } }> {
    const doc = this.resolve(op.ref);
    if (!doc) return err(`update: ${JSON.stringify(op.ref)} not found`);
    const res = applyDiff<BaseDocument>(doc, op.diff);
    if (!res.ok) return err(`update: ${res.error}`);
    this.replaceDoc(op.ref, res.value);
    return okVal({ root: refRoot(op.ref) });
  }

  private applyDelete(
    op: Extract<Op, { kind: "delete" }>,
  ): Result<{ root: { coll: CollectionName; id: DocId } }> {
    const doc = this.resolve(op.ref);
    if (!doc) return err(`delete: ${JSON.stringify(op.ref)} not found`);
    if (!op.ref.parent) {
      const coll = op.ref.coll as CollectionName;
      const arr = this.collections[coll] as unknown as BaseDocument[];
      const idx = arr.findIndex((d) => d._id === op.ref.id);
      if (idx >= 0) arr.splice(idx, 1);
      this.byId.get(coll)?.delete(op.ref.id);
    } else {
      const parentDoc = this.resolve(op.ref.parent);
      if (!parentDoc) return err(`delete: parent not found`);
      if (!isEmbeddedName(op.ref.coll))
        return err(`delete: '${op.ref.coll}' is not an embedded collection`);
      const arr = embeddedArray(parentDoc, op.ref.coll);
      if (!arr) return err(`delete: '${op.ref.coll}' not embeddable in parent`);
      const newParent = withEmbedded(
        parentDoc,
        op.ref.coll,
        arr.filter((d) => d._id !== op.ref.id),
      );
      this.replaceDoc(op.ref.parent, newParent);
    }
    return okVal({ root: refRoot(op.ref) });
  }

  /** Replace the document at `ref` with `newDoc`, rebuilding ancestors immutably. */
  private replaceDoc(ref: DocRef, newDoc: BaseDocument): void {
    if (!ref.parent) {
      const coll = ref.coll as CollectionName;
      const arr = this.collections[coll] as unknown as BaseDocument[];
      const idx = arr.findIndex((d) => d._id === ref.id);
      if (idx < 0) throw new Error(`replaceDoc: ${coll}/${ref.id} missing`);
      arr[idx] = newDoc;
      this.byId.get(coll)?.set(ref.id, newDoc);
      return;
    }
    const parentDoc = this.resolve(ref.parent);
    if (!parentDoc) throw new Error(`replaceDoc: parent missing`);
    if (!isEmbeddedName(ref.coll)) throw new Error(`replaceDoc: '${ref.coll}' is not embedded`);
    const arr = embeddedArray(parentDoc, ref.coll);
    if (!arr) throw new Error(`replaceDoc: '${ref.coll}' not embeddable in parent`);
    const newParent = withEmbedded(
      parentDoc,
      ref.coll,
      arr.map((d) => (d._id === ref.id ? newDoc : d)),
    );
    this.replaceDoc(ref.parent, newParent);
  }

  private trimMessages(): Op[] {
    const msgs = this.collections.messages;
    const over = msgs.length - this.messagesCap;
    if (over <= 0) return [];
    const removed = msgs.splice(0, over);
    for (const m of removed) this.byId.get("messages")?.delete(m._id);
    return removed.map((m) => ({
      kind: "delete" as const,
      ref: { coll: "messages" as const, id: m._id },
    }));
  }

  // ─── Reactivity (§10) ────────────────────────────────────────────────────────

  /**
   * Watch a document (embedded refs welcome). Fires when a change overlaps the
   * watched chain; with `path` (dotted, relative to the watched document) only
   * when one of the applied diff paths intersects it (segment-aware).
   */
  watch(ref: DocRef, cb: (change: DocChange) => void, path?: string): Unsubscribe {
    const watcher: Watcher = {
      segs: chainSegs(ref),
      pathSegs: path ? path.split(".") : null,
      cb,
    };
    this.watchers.add(watcher);
    return () => this.watchers.delete(watcher);
  }

  /** Fires after every successfully applied envelope (sync layers attach here). */
  onChange(cb: (env: OpEnvelope, changes: DocChange[], inverses: Op[]) => void): Unsubscribe {
    this.changeListeners.add(cb);
    return () => this.changeListeners.delete(cb);
  }

  private notify(env: OpEnvelope, changes: DocChange[], inverses: Op[]): void {
    for (const watcher of [...this.watchers]) {
      const change = changes.find((c) => this.watcherMatches(watcher, c));
      if (change) watcher.cb(change);
    }
    for (const listener of [...this.changeListeners]) listener(env, changes, inverses);
  }

  private watcherMatches(watcher: Watcher, change: DocChange): boolean {
    for (const op of change.ops) {
      const opSegs = opChainSegs(op);
      if (!prefixEitherWay(watcher.segs, opSegs)) continue;
      if (!watcher.pathSegs) return true;
      if (op.kind !== "update") return true; // create/delete → document-level change
      for (const key of Object.keys(op.diff)) {
        const watchPath = [...watcher.segs.slice(opSegs.length), ...watcher.pathSegs];
        const opPath = [...opSegs.slice(watcher.segs.length), ...diffKeySegs(key)];
        if (prefixEitherWay(opPath, watchPath)) return true;
      }
    }
    return false;
  }

  // ─── Hydration / serialization ──────────────────────────────────────────────

  serialize(): { meta: StoreMeta; seq: number; collections: WorldCollections } {
    return {
      meta: { ...this.meta },
      seq: this.seq,
      collections: structuredClone(this.collections),
    };
  }

  /** Hydrate from a full or partial world (host IDB load / client snapshot). */
  static load(
    input: { meta: StoreMeta; seq: number; collections: Partial<WorldCollections> },
    options: Omit<DocumentStoreOptions, "meta"> = {},
  ): DocumentStore {
    const store = new DocumentStore({ ...options, meta: input.meta });
    store.hydrate(input.collections, input.seq);
    return store;
  }

  /**
   * Merge collections into this store and set seq (host startup: documents
   * store contents at flushedSeq, before oplog-tail replay). Replaces the
   * store's documents per collection.
   */
  hydrate(collections: Partial<WorldCollections>, seq: number): void {
    for (const coll of TOP_LEVEL_COLLECTIONS) {
      const incoming = collections[coll];
      if (incoming) {
        const target = this.collections[coll] as unknown as BaseDocument[];
        target.length = 0;
        target.push(...(incoming as BaseDocument[]));
      }
    }
    this.collections.assetManifest = { ...(collections.assetManifest ?? {}) };
    this.seq = seq;
    this.reindex();
  }

  private reindex(): void {
    this.byId = new Map();
    for (const coll of TOP_LEVEL_COLLECTIONS) {
      const map = new Map<DocId, BaseDocument>();
      for (const doc of this.collections[coll] as BaseDocument[]) map.set(doc._id, doc);
      this.byId.set(coll, map);
    }
  }
}

/** Shallow-clone `doc` with its embedded array `name` replaced (D-012 cast contained here). */
function withEmbedded(
  doc: BaseDocument,
  name: EmbeddedCollectionName,
  arr: BaseDocument[],
): BaseDocument {
  return { ...doc, [name]: arr } as BaseDocument;
}
