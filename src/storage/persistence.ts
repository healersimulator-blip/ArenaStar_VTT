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

export class HostPersister {
  private readonly db: IDBPDatabase;
  private readonly flushMs: number;
  private record: WorldsRecord;
  private store: DocumentStore | null = null;
  private log: OpLog | null = null;
  private detachStore: (() => void) | null = null;
  private dirty = new Map<CollectionName, Set<DocId>>();
  private timer: ReturnType<typeof setInterval> | null = null;
  /** Serialized oplog writes; flush() drains this before batching documents. */
  private oplogChain: Promise<void> = Promise.resolve();
  private flushing: Promise<void> = Promise.resolve();
  private closed = false;

  private constructor(db: IDBPDatabase, record: WorldsRecord, options: HostPersisterOptions = {}) {
    this.db = db;
    this.record = record;
    this.flushMs = options.flushMs ?? DEFAULT_FLUSH_MS;
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

  /**
   * Await all queued immediate oplog appends (§6.5 beforeunload guard calls
   * this + flush() before allowing the tab to close).
   */
  drain(): Promise<void> {
    return this.oplogChain;
  }

  /** Start the periodic documents batch (§8 write-behind). */
  start(): void {
    if (this.timer !== null || this.closed) return;
    this.timer = setInterval(() => {
      this.flushing = this.flush().catch((error: unknown) => {
        console.error("vtt: persister flush failed", error);
      });
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
    this.oplogChain = this.oplogChain.then(async () => {
      await this.db.put(STORES.oplog, record);
    });
    for (const change of changes) {
      let set = this.dirty.get(change.root.coll);
      if (!set) {
        set = new Set();
        this.dirty.set(change.root.coll, set);
      }
      set.add(change.root.id);
    }
  }

  /**
   * Drain pending oplog writes, then batch-write every dirty root in one
   * transaction that also advances worlds.flushedSeq (atomic, D-027).
   * Deleted roots (no longer resolvable) are removed from the store.
   */
  async flush(): Promise<void> {
    await this.oplogChain;
    if (!this.store) return;
    const dirty = this.dirty;
    this.dirty = new Map();
    if (dirty.size === 0 && this.record.flushedSeq === this.store.seq) {
      await this.db.put(STORES.worlds, this.record);
      return;
    }
    const seq = this.store.seq;
    const tx = this.db.transaction([STORES.documents, STORES.worlds], "readwrite");
    for (const [coll, ids] of dirty) {
      for (const id of ids) {
        const doc = this.store.get(coll, id);
        const key = [this.record.worldId, coll, id] as IDBValidKey;
        if (doc) {
          void tx
            .objectStore(STORES.documents)
            .put({ worldId: this.record.worldId, coll, id, doc } satisfies DocumentsRecord);
        } else {
          void tx.objectStore(STORES.documents).delete(key);
        }
      }
    }
    this.record = { ...this.record, flushedSeq: seq };
    void tx.objectStore(STORES.worlds).put(this.record);
    await tx.done;
  }

  /**
   * Checkpoint (§8): rewrite all documents + compact the IDB oplog ≤ store.seq
   * + persist the new base — one transaction — then compact the in-memory log.
   */
  async checkpoint(): Promise<void> {
    await this.oplogChain;
    const store = this.store;
    if (!store) return;
    const seq = store.seq;
    const tx = this.db.transaction([STORES.documents, STORES.oplog, STORES.worlds], "readwrite");
    const docStore = tx.objectStore(STORES.documents);
    for (const coll of TOP_LEVEL_COLLECTIONS) {
      for (const doc of store.getAll(coll) as readonly BaseDocument[]) {
        void docStore.put({
          worldId: this.record.worldId,
          coll,
          id: doc._id,
          doc,
        } satisfies DocumentsRecord);
      }
    }
    const oplogStore = tx.objectStore(STORES.oplog);
    const keys = (await oplogStore.getAllKeys(
      IDBKeyRange.bound([this.record.worldId], [this.record.worldId, seq]),
    )) as IDBValidKey[];
    for (const key of keys) void oplogStore.delete(key);
    this.record = { ...this.record, flushedSeq: seq, oplogBase: seq };
    void tx.objectStore(STORES.worlds).put(this.record);
    await tx.done;
    this.log?.compact(seq);
    this.dirty.clear();
  }

  /** Final flush + stop the timer. */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.detachStore?.();
    this.detachStore = null;
    await this.flushing;
    await this.flush();
  }
}
