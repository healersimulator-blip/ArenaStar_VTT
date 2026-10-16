/**
 * §8 host persistence — write-behind pipeline over the "vtt" IDB:
 *
 *   op applied in memory → oplog entry appended immediately (its own txn)
 *                        → documents store batched every ~500 ms; the batch
 *                          txn also advances worlds.flushedSeq (atomic, D-027)
 *
 * Startup (§8): load documents (current as of flushedSeq), then replay the
 * oplog tail (seq > flushedSeq) into the store — identical world guaranteed by
 * envelope replay; a mid-resolution crash surfaces as a rejected envelope.
 *
 * checkpoint(): rewrite ALL documents + compact the oplog (drop entries ≤
 * flushedSeq) in one transaction, then compact the in-memory log.
 */
import type { IDBPDatabase } from "idb";
import { STORES, getWorld, type DocumentsRecord, type OplogRecord, type WorldsRecord } from "./idb";
import { DocumentStore, type StoreMeta } from "../core/store";
import { OpLog } from "../core/oplog";
import {
  TOP_LEVEL_COLLECTIONS,
  type BaseDocument,
  type CollectionName,
  type WorldCollections,
} from "../core/documents";
import type { Op, OpEnvelope } from "../core/ops";
import type { DocId, WorldId } from "../core/ids";

export interface HostPersisterOptions {
  /** Documents-store batch interval (§8: ~500 ms default). */
  flushMs?: number;
  now?: () => number;
}

const DEFAULT_FLUSH_MS = 500;

export interface PersistenceStatus {
  /** This status concerns local document durability, never a cloud backup. */
  lastSavedAt: number | null;
  error: string | null;
  unsaved: boolean;
}


/**
 * Keys `HostPersister.patchWorld` may change on a world record. `| undefined` is explicit so
 * `exactOptionalPropertyTypes` still allows clearing an optional field (deactivating a package).
 */
export type WorldsRecordPatch = {
  [K in keyof Omit<WorldsRecord, "worldId">]?: Omit<WorldsRecord, "worldId">[K] | undefined;
};

export class HostPersister {
  private readonly db: IDBPDatabase;
  private readonly flushMs: number;
  private record: WorldsRecord;
  private store: DocumentStore | null = null;
  private log: OpLog | null = null;
  private detachStore: (() => void) | null = null;
  private dirty = new Map<CollectionName, Set<DocId>>();
  private timer: ReturnType<typeof setInterval> | null = null;
  /** Failed jobs do not poison the serial executor. Journal records survive failures. */
  private tasks: Promise<unknown> = Promise.resolve();
  private pendingLog: OplogRecord[] = [];
  private journalScheduled = false;
  private readonly now: () => number;
  private error: string | null = null;
  private failures = 0;
  private retryAt = 0;
  private readonly listeners = new Set<(status: PersistenceStatus) => void>();
  private closed = false;

  private constructor(db: IDBPDatabase, record: WorldsRecord, options: HostPersisterOptions = {}) {
    this.db = db;
    this.record = record;
    this.flushMs = options.flushMs ?? DEFAULT_FLUSH_MS;
    this.now = options.now ?? Date.now;
  }

  /** Create a fresh world record (new world flow). */
  static async createWorld(
    db: IDBPDatabase,
    meta: StoreMeta,
    options?: HostPersisterOptions,
  ): Promise<HostPersister> {
    const existing = await getWorld(db, meta.worldId);
    if (existing) throw new Error(`world ${meta.worldId} already exists`);
    const record: WorldsRecord = {
      worldId: meta.worldId,
      name: meta.name,
      system: meta.system,
      version: meta.systemVersion,
      lastOpened: (options?.now ?? Date.now)(),
      flushedSeq: 0,
      oplogBase: 0,
    };
    await db.put(STORES.worlds, record);
    return new HostPersister(db, record, options);
  }

  /** Open an existing world; rejects if unknown. */
  static async open(
    db: IDBPDatabase,
    worldId: WorldId,
    options?: HostPersisterOptions,
  ): Promise<HostPersister> {
    const record = await getWorld(db, worldId);
    if (!record) throw new Error(`unknown world ${worldId}`);
    record.lastOpened = (options?.now ?? Date.now)();
    await db.put(STORES.worlds, record);
    return new HostPersister(db, record, options);
  }

  get worldId(): WorldId {
    return this.record.worldId;
  }

  /**
   * The world record as this persister last wrote it — the authoritative copy while the world is
   * open (every write goes through `patchWorld`/flush). Hot paths that must re-check per request
   * (AIS consent on every module RPC) read this instead of opening an IndexedDB transaction each
   * time: measured 207 ms per `get` of a 462-byte row in the e2e sandbox, against a 2 ms commit.
   */
  get world(): Readonly<WorldsRecord> {
    return this.record;
  }

  get flushedSeq(): number {
    return this.record.flushedSeq;
  }

  /**
   * Load persisted state into `store` and `log` (documents at flushedSeq +
   * oplog tail replay), then subscribe: every applied envelope is appended to
   * the IDB oplog immediately and its touched roots queued for the next
   * documents batch.
   */
  async attach(store: DocumentStore, log: OpLog): Promise<void> {
    const flushedSeq = this.record.flushedSeq;

    const collections: Partial<WorldCollections> = {};
    const tx = this.db.transaction(STORES.documents, "readonly");
    let cursor = await tx.store.openCursor(
      IDBKeyRange.bound([this.record.worldId], [this.record.worldId, []]),
    );
    while (cursor) {
      const rec = cursor.value as DocumentsRecord;
      const existing = collections[rec.coll] as BaseDocument[] | undefined;
      if (existing) existing.push(rec.doc);
      else (collections as Record<CollectionName, BaseDocument[]>)[rec.coll] = [rec.doc];
      cursor = await cursor.continue();
    }
    await tx.done;
    store.hydrate(collections, flushedSeq);

    // Rebuild the in-memory log and replay the tail into the store.
    const entries = ((await this.db.getAll(
      STORES.oplog,
      IDBKeyRange.bound([this.record.worldId, flushedSeq + 1], [this.record.worldId, Infinity]),
    )) ?? []) as OplogRecord[];
    entries.sort((a, b) => a.seq - b.seq);
    const baseSeq = entries.length > 0 ? (entries[0] as OplogRecord).seq - 1 : flushedSeq;
    log.compact(baseSeq);
    for (const entry of entries) {
      const applied = store.applyEnvelope(entry.env);
      if (!applied.ok) {
        throw new Error(`persistence: oplog tail corrupt at seq ${entry.seq}: ${applied.error}`);
      }
      for (const change of applied.value.changes) {
        const ids = this.dirty.get(change.root.coll) ?? new Set<DocId>();
        ids.add(change.root.id);
        this.dirty.set(change.root.coll, ids);
      }
      const appended = log.append(entry.env, entry.inverses);
      if (!appended.ok) throw new Error(`persistence: ${appended.error}`);
    }
    if (store.seq !== flushedSeq + entries.length) {
      throw new Error(`persistence: seq mismatch after replay (${store.seq})`);
    }

    this.store = store;
    this.log = log;
    this.detachStore = store.onChange((env, changes, inverses) =>
      this.onEnvelope(env, changes, inverses),
    );
  }

  get status(): PersistenceStatus {
    return {
      lastSavedAt: this.record.lastSavedAt ?? null,
      error: this.error,
      unsaved: this.pendingLog.length > 0 || this.dirty.size > 0 ||
        (this.store !== null && this.record.flushedSeq !== this.store.seq),
    };
  }

  subscribe(listener: (status: PersistenceStatus) => void): () => void {
    this.listeners.add(listener);
    listener(this.status);
    return () => { this.listeners.delete(listener); };
  }

  private publish(): void {
    for (const listener of this.listeners) {
      try { listener(this.status); } catch { /* UI observers cannot break storage. */ }
    }
  }

  private run<T>(job: () => Promise<T>): Promise<T> {
    const result = this.tasks.then(job);
    this.tasks = result.catch((error: unknown) => {
      this.error = error instanceof Error ? error.message : String(error);
      this.retryAt = this.now() + Math.min(30_000, 500 * 2 ** Math.min(this.failures++, 6));
      this.publish();
    });
    return result;
  }

  /** Retry every retained record in order. Never advance past a failed sequence. */
  private async writeJournal(): Promise<void> {
    while (this.pendingLog.length) {
      const record = this.pendingLog[0];
      await this.db.put(STORES.oplog, record);
      this.pendingLog.shift();
    }
  }

  drain(): Promise<void> {
    return this.run(() => this.writeJournal());
  }

  /** Quiet background autosave, with bounded retry frequency while storage is unavailable. */
  start(): void {
    if (this.timer !== null || this.closed) return;
    let ticking = false;
    this.timer = setInterval(() => {
      if (ticking || this.now() < this.retryAt || (!this.status.unsaved && !this.error)) return;
      ticking = true;
      void this.flush().catch(() => undefined).finally(() => { ticking = false; });
    }, this.flushMs);
  }

  private onEnvelope(
    env: OpEnvelope,
    changes: ReadonlyArray<{ root: { coll: CollectionName; id: DocId } }>,
    inverses: readonly Op[],
  ): void {
    if (this.closed) return;
    // Immediate durable append (§8): serialized to preserve order. Inverses
    // come from the store's transaction capture (pre-images, §8 undo).
    const record: OplogRecord = {
      worldId: this.record.worldId,
      seq: env.seq,
      env,
      inverses: [...inverses],
    };
    this.pendingLog.push(structuredClone(record));
    if (!this.journalScheduled && this.now() >= this.retryAt) {
      this.journalScheduled = true;
      void this.drain().catch(() => undefined).finally(() => { this.journalScheduled = false; });
    }
    for (const change of changes) {
      let set = this.dirty.get(change.root.coll);
      if (!set) {
        set = new Set();
        this.dirty.set(change.root.coll, set);
      }
      set.add(change.root.id);
    }
  }

  private restoreDirty(dirty: Map<CollectionName, Set<DocId>>): void {
    for (const [coll, ids] of dirty) {
      const current = this.dirty.get(coll) ?? new Set<DocId>();
      for (const id of ids) current.add(id);
      this.dirty.set(coll, current);
    }
  }

  /** Snapshot synchronously, then atomically commit docs + watermark. New edits stay dirty. */
  private async writeDocuments(checkpoint: boolean): Promise<void> {
    await this.writeJournal();
    const store = this.store;
    if (!store) return;
    const seq = store.seq;
    const dirty = this.dirty;
    this.dirty = new Map();
    const next: WorldsRecord = { ...this.record, flushedSeq: seq, lastSavedAt: this.now(),
      ...(checkpoint ? { oplogBase: seq } : {}) };
    let abort: (() => void) | null = null;
    let settled: Promise<unknown> | null = null;
    try {
      const tx = this.db.transaction([STORES.documents, STORES.oplog, STORES.worlds], "readwrite");
      abort = () => tx.abort();
      settled = tx.done;
      const requests: Promise<unknown>[] = [];
      const add = (request: Promise<unknown>): void => {
        void request.catch(() => undefined);
        requests.push(request);
      };
      add(tx.done);
      const docs = tx.objectStore(STORES.documents);
      if (checkpoint) {
        // Delete stale roots too: otherwise a checkpoint can resurrect deleted documents.
        add(docs.delete(IDBKeyRange.bound([this.worldId], [this.worldId, []])));
        for (const coll of TOP_LEVEL_COLLECTIONS) {
          for (const doc of store.getAll(coll) as readonly BaseDocument[]) {
            add(docs.put({ worldId: this.worldId, coll, id: doc._id, doc } satisfies DocumentsRecord));
          }
        }
        add(tx.objectStore(STORES.oplog).delete(
          IDBKeyRange.bound([this.worldId], [this.worldId, seq]),
        ));
      } else {
        for (const [coll, ids] of dirty) {
          for (const id of ids) {
            const doc = store.get(coll, id);
            add(doc
              ? docs.put({ worldId: this.worldId, coll, id, doc } satisfies DocumentsRecord)
              : docs.delete([this.worldId, coll, id]));
          }
        }
      }
      add(tx.objectStore(STORES.worlds).put(next));
      await Promise.all(requests);
      this.record = next;
      if (checkpoint) this.log?.compact(seq);
      this.error = null;
      this.failures = 0;
      this.retryAt = 0;
      this.publish();
    } catch (error) {
      try { abort?.(); } catch { /* Already aborted or finished. */ }
      await settled?.catch(() => undefined);
      this.restoreDirty(dirty);
      throw error;
    }
  }

  flush(): Promise<void> {
    return this.run(() => this.writeDocuments(false));
  }

  checkpoint(): Promise<void> {
    return this.run(() => this.writeDocuments(true));
  }

  /**
   * Patch the world record THROUGH the persister (§12 package activation, GM trust grant,
   * migration version). The persister owns a cached copy and rewrites it on every flush, so a
   * direct `putWorld` is silently reverted by the next write-behind tick (500 ms) or by the
   * final flush on close — which is how "activate a system package, reload" lost the activation.
   * A key set to `undefined` is deleted from the record rather than stored as undefined.
   */
  patchWorld(patch: WorldsRecordPatch): Promise<WorldsRecord> {
    const copy = structuredClone(patch);
    return this.run(async () => {
      const next = Object.fromEntries(
        Object.entries({ ...this.record, ...copy }).filter(([, value]) => value !== undefined),
      ) as unknown as WorldsRecord;
      await this.db.put(STORES.worlds, next);
      this.record = next;
      return next;
    });
  }

  /** Final flush + stop the timer. */
  async close(): Promise<void> {
    if (this.closed) return;
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    // A failed close remains retryable; keep observing edits until the flush succeeds.
    try {
      do { await this.flush(); } while (this.status.unsaved);
    } catch (error) {
      this.start();
      throw error;
    }
    this.closed = true;
    this.detachStore?.();
    this.detachStore = null;
    this.listeners.clear();
  }
}
