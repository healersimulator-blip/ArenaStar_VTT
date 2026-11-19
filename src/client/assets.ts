/**
 * §7 client-side assets: AssetCache (Cache API / IDB by hash) and the fetch
 * orchestrator that speaks asset.get / asset.chunk over ClientSync.
 *
 * - Cache API (`vtt-assets`) or IDB (`vtt-client`, D-038) stores received bytes
 *   by hash. Persistence is best-effort; it never gates playback.
 * - One client fetcher coalesces loads across scene art, FX and other consumers.
 *   Cache hits don't take a wire slot; cache misses respect the host's rate limit.
 */
import { openDB, type IDBPDatabase } from "idb";
import type { AssetChunkMsg, AssetPriority } from "../core/messages";
import type { AssetId } from "../core/ids";
import type { AssetManifest } from "../core/documents";
import { TokenBucket } from "../core/ratelimit";

const CACHE_DB_NAME = "vtt-client";
const CACHE_DB_VERSION = 1;
const CACHE_STORE = "assets";
const CACHE_API_NAME = "vtt-assets";

interface CacheBlobRecord {
  hash: AssetId;
  mime: string;
  bytes: Uint8Array;
}

/** Storage backend used by AssetCache (Cache API or IDB). */
export interface AssetCacheBackend {
  get(hash: AssetId): Promise<{ bytes: Uint8Array; mime: string } | undefined>;
  put(hash: AssetId, bytes: Uint8Array, mime: string): Promise<void>;
  has(hash: AssetId): Promise<boolean>;
  close?(): void;
}

// ─── IDB backend ──────────────────────────────────────────────────────────────

class IdbCacheBackend implements AssetCacheBackend {
  private constructor(private readonly db: IDBPDatabase) {}

  static async open(): Promise<IdbCacheBackend> {
    const db = await openDB(CACHE_DB_NAME, CACHE_DB_VERSION, {
      upgrade(db) {
        if (!db.objectStoreNames.contains(CACHE_STORE)) {
          db.createObjectStore(CACHE_STORE, { keyPath: "hash" });
        }
      },
    });
    return new IdbCacheBackend(db);
  }

  async get(hash: AssetId) {
    const rec = (await this.db.get(CACHE_STORE, hash)) as
      CacheBlobRecord | undefined;
    return rec ? { bytes: rec.bytes, mime: rec.mime } : undefined;
  }

  async put(hash: AssetId, bytes: Uint8Array, mime: string): Promise<void> {
    await this.db.put(CACHE_STORE, {
      hash,
      bytes,
      mime,
    } satisfies CacheBlobRecord);
  }

  async has(hash: AssetId): Promise<boolean> {
    return (await this.db.getKey(CACHE_STORE, hash)) !== undefined;
  }

  close(): void {
    this.db.close();
  }
}

// ─── Cache API backend ────────────────────────────────────────────────────────

/** Synthetic URL keys the Cache API requires (content is what matters). */
function cacheUrl(hash: AssetId): string {
  return `https://vtt.local/assets/${hash}`;
}

class CacheApiBackend implements AssetCacheBackend {
  private constructor(private readonly cache: Cache) {}

  static async open(): Promise<CacheApiBackend | null> {
    try {
      if (typeof globalThis.caches?.open !== "function") return null;
      return new CacheApiBackend(await globalThis.caches.open(CACHE_API_NAME));
    } catch {
      return null;
    }
  }

  async get(hash: AssetId) {
    const hit = await this.cache.match(cacheUrl(hash));
    if (!hit) return undefined;
    const mime = hit.headers.get("content-type") ?? "application/octet-stream";
    return { bytes: new Uint8Array(await hit.arrayBuffer()), mime };
  }

  async put(hash: AssetId, bytes: Uint8Array, mime: string): Promise<void> {
    const body = new Uint8Array(bytes); // copy: cache owns its buffer
    await this.cache.put(
      cacheUrl(hash),
      new Response(body, { headers: { "content-type": mime } }),
    );
  }

  async has(hash: AssetId): Promise<boolean> {
    return this.cache.match(cacheUrl(hash)).then((r) => r !== undefined);
  }
}

// ─── AssetCache ───────────────────────────────────────────────────────────────

export class AssetCache {
  private constructor(private readonly backend: AssetCacheBackend | null) {}

  /** D-038: Cache API, then IndexedDB, then no persistence (blocked storage). */
  static async open(): Promise<AssetCache> {
    const api = await CacheApiBackend.open();
    if (api) return new AssetCache(api);
    try {
      return new AssetCache(await IdbCacheBackend.open());
    } catch {
      return new AssetCache(null);
    }
  }

  /** Test/explicit backend injection. */
  static withBackend(backend: AssetCacheBackend): AssetCache {
    return new AssetCache(backend);
  }

  async get(
    hash: AssetId,
  ): Promise<{ bytes: Uint8Array; mime: string } | undefined> {
    try {
      return await this.backend?.get(hash);
    } catch {
      return undefined;
    } // unavailable/corrupt storage is a cache miss
  }

  async put(hash: AssetId, bytes: Uint8Array, mime: string): Promise<void> {
    try {
      await this.backend?.put(hash, bytes, mime);
    } catch {
      /* Quota may be full; the current load already has the bytes. */
    }
  }

  async has(hash: AssetId): Promise<boolean> {
    try {
      return (await this.backend?.has(hash)) ?? false;
    } catch {
      return false;
    }
  }

  close(): void {
    this.backend?.close?.();
  }
}

// ─── Fetch orchestrator ───────────────────────────────────────────────────────

const PRIORITIES = [
  "scene",
  "ui",
  "audio",
  "preload",
] as const satisfies readonly AssetPriority[];
// Compressed hot bytes only. Decoded token/tile artwork and playing FX are owned by their views.
const HOT_MAX_ENTRIES = 128;
const HOT_MAX_BYTES = 16 * 1024 * 1024;

interface AssetLoad {
  id: AssetId;
  priority: AssetPriority;
  mime: string;
  promise: Promise<Uint8Array>;
  resolve: (bytes: Uint8Array) => void;
  reject: (error: unknown) => void;
  sent: boolean;
  total: number;
  offset: number;
  parts: Uint8Array[];
}

export interface AssetFetcherOptions {
  cache: AssetCache;
  /** Wired to ClientSync.requestAsset. */
  request: (assetId: AssetId, priority: AssetPriority, offset: number) => void;
  /** GM boot only: read the GM's own imported blobs without chunking over loopback. */
  readLocal?: (assetId: AssetId) => Promise<Uint8Array | undefined>;
}

export class AssetFetcher {
  private readonly loads = new Map<AssetId, AssetLoad>();
  private readonly queue = PRIORITIES.map(() => new Map<AssetId, AssetLoad>());
  // Stay below the host's burst 20 / 10 per second, including gap/reconnect resumes.
  private readonly budget = new TokenBucket(16, 8);
  private sendTimer: ReturnType<typeof setTimeout> | null = null;
  private paused = false;
  private closed = false;
  private readonly hot = new Map<AssetId, Uint8Array>();
  private hotBytes = 0;

  constructor(private readonly options: AssetFetcherOptions) {}

  /** Owned media and cache hits short-circuit. All simultaneous consumers share the same work. */
  request(
    assetId: AssetId,
    priority: AssetPriority = "scene",
    mime = "application/octet-stream",
  ): Promise<Uint8Array> {
    if (this.closed) return Promise.reject(new Error("asset fetcher closed"));
    const active = this.loads.get(assetId);
    if (active) {
      const oldRank = PRIORITIES.indexOf(active.priority);
      if (PRIORITIES.indexOf(priority) < oldRank) {
        if (this.queue[oldRank]?.delete(assetId))
          this.queue[PRIORITIES.indexOf(priority)]?.set(assetId, active);
        active.priority = priority;
      }
      return active.promise;
    }
    const hot = this.hot.get(assetId);
    if (hot) {
      this.hot.delete(assetId);
      this.hot.set(assetId, hot);
      return Promise.resolve(hot);
    }
    let resolve!: AssetLoad["resolve"], reject!: AssetLoad["reject"];
    const promise = new Promise<Uint8Array>((done, fail) => {
      resolve = done;
      reject = fail;
    });
    const load: AssetLoad = {
      id: assetId,
      priority,
      mime,
      promise,
      resolve,
      reject,
      sent: false,
      total: 0,
      offset: 0,
      parts: [],
    };
    this.loads.set(assetId, load);
    void this.lookup(load).catch((error: unknown) => this.fail(load, error));
    return promise;
  }

  private async lookup(load: AssetLoad): Promise<void> {
    const local = await this.options.readLocal?.(load.id);
    if (this.closed) return;
    const bytes = local ?? (await this.options.cache.get(load.id))?.bytes;
    if (this.closed) return;
    if (bytes) this.complete(load, bytes, false);
    else this.enqueue(load);
  }

  private enqueue(load: AssetLoad): void {
    this.queue[PRIORITIES.indexOf(load.priority)]?.set(load.id, load);
    this.drain();
  }

  private drain(): void {
    if (this.paused || this.closed || this.sendTimer !== null) return;
    for (;;) {
      const bucket = this.queue.find((q) => q.size > 0);
      const load = bucket?.values().next().value;
      if (!load) return;
      if (!this.budget.tryRemove()) {
        const wait = Math.ceil(
          ((1 - this.budget.available()) * 1000) / this.budget.refillPerSecond,
        );
        this.sendTimer = setTimeout(
          () => {
            this.sendTimer = null;
            this.drain();
          },
          Math.max(1, wait),
        );
        return;
      }
      bucket?.delete(load.id);
      load.sent = true;
      try {
        this.options.request(load.id, load.priority, load.offset);
      } catch (error) {
        this.fail(load, error);
      }
    }
  }

  /** Keep partial bytes during transport replacement; only send on an authorized session. */
  pause(): void {
    this.paused = true;
    if (this.sendTimer !== null) clearTimeout(this.sendTimer);
    this.sendTimer = null;
  }

  resume(): void {
    if (!this.paused || this.closed) return;
    for (const load of this.loads.values()) if (load.sent) this.enqueue(load);
    this.paused = false;
    this.drain();
  }

  /** Feed one asset.chunk (wired to the ClientSync `asset` bus event). */
  onChunk(msg: AssetChunkMsg): void {
    const load = this.loads.get(msg.assetId);
    if (!load?.sent) return;
    if (msg.total === 0) {
      this.fail(load, new Error(`asset not found: ${msg.assetId}`)); // D-039 miss sentinel
      return;
    }
    if (msg.offset < load.offset) return; // stale duplicate
    if (msg.offset > load.offset) {
      this.enqueue(load);
      return;
    } // resume at the missing offset
    const end = load.offset + msg.bytes.length;
    if (
      (load.total && msg.total !== load.total) ||
      end > msg.total ||
      (msg.done ? end !== msg.total : msg.bytes.length === 0)
    ) {
      this.fail(load, new Error(`incomplete asset: ${msg.assetId}`));
      return;
    }
    this.queue[PRIORITIES.indexOf(load.priority)]?.delete(load.id); // progress supersedes a queued resume
    load.total = msg.total;
    load.offset = end;
    load.parts.push(msg.bytes);
    if (msg.done) {
      const bytes = new Uint8Array(end);
      let at = 0;
      for (const part of load.parts) {
        bytes.set(part, at);
        at += part.length;
      }
      this.complete(load, bytes, true);
    }
  }

  private complete(load: AssetLoad, bytes: Uint8Array, persist: boolean): void {
    load.sent = false;
    load.parts = [];
    this.remember(load.id, bytes);
    if (persist) {
      // Keep the shared answer until durable storage settles (even if evicted from hot memory).
      // A slow/full cache must not delay rendering or cause a second transfer during the write.
      void this.options.cache
        .put(load.id, bytes, load.mime)
        .then(() => this.loads.delete(load.id));
    } else this.loads.delete(load.id);
    load.resolve(bytes);
  }

  private fail(load: AssetLoad, error: unknown): void {
    this.queue[PRIORITIES.indexOf(load.priority)]?.delete(load.id);
    this.loads.delete(load.id);
    load.reject(error);
  }

  private remember(id: AssetId, bytes: Uint8Array): void {
    if (bytes.byteLength > HOT_MAX_BYTES) return;
    this.hot.set(id, bytes);
    this.hotBytes += bytes.byteLength;
    for (const [oldest, held] of this.hot) {
      if (this.hot.size <= HOT_MAX_ENTRIES && this.hotBytes <= HOT_MAX_BYTES)
        break;
      this.hot.delete(oldest);
      this.hotBytes -= held.byteLength;
    }
  }

  get pendingCount(): number {
    return this.loads.size;
  }

  close(): void {
    this.closed = true;
    this.pause();
    const error = new Error("asset fetcher closed");
    for (const load of this.loads.values()) this.fail(load, error);
    this.hot.clear();
    this.hotBytes = 0;
  }
}

// ─── Progressive rendering chain (§7: thumbnail → mid → full) ─────────────────

export interface RenderStage {
  assetId: AssetId;
  mime: string;
  bytes: Uint8Array;
}

/**
 * Ordered variant chain for an asset: [thumb?, mid?, full] — duplicates
 * removed (a 200 px image's thumbnail IS the full asset).
 */
export function renderChain(manifest: AssetManifest, hash: AssetId): AssetId[] {
  const entry = manifest[hash];
  const chain: AssetId[] = [];
  const candidates = [entry?.thumb?.assetId, entry?.mid?.assetId, hash];
  for (const id of candidates) {
    if (id !== undefined && !chain.includes(id)) chain.push(id);
  }
  return chain;
}

/**
 * Load an asset progressively: each stage (thumbnail first) is handed to
 * onStage as it arrives; resolves with the full-res bytes.
 */
export async function loadProgressive(options: {
  fetcher: { request(assetId: AssetId, priority: AssetPriority): Promise<Uint8Array> };
  manifest: AssetManifest;
  hash: AssetId;
  onStage: (stage: RenderStage) => void;
}): Promise<Uint8Array> {
  const chain = renderChain(options.manifest, options.hash);
  let bytes: Uint8Array<ArrayBufferLike> = new Uint8Array(0);
  for (const assetId of chain) {
    // thumbnail/mid stream at scene priority; the full asset rides at preload
    // so a huge map never blocks first paint (§7 priority ladder)
    const priority: AssetPriority = assetId === options.hash ? "preload" : "scene";
    const stage = await options.fetcher.request(assetId, priority);
    const mime = options.manifest[assetId]?.mime ?? "application/octet-stream";
    bytes = stage;
    options.onStage({ assetId, mime, bytes: stage });
  }
  return bytes;
}
