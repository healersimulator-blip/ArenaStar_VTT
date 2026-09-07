/**
 * §7 client-side assets: AssetCache (Cache API / IDB by hash) and the fetch
 * orchestrator that speaks asset.get / asset.chunk over ClientSync.
 *
 * - Cache API (`cvt-assets`) is preferred where available (secure contexts);
 *   IDB ("vtt-client" DB, separate from the host's "vtt") is the fallback and
 *   the file:// path (D-038).
 * - The fetcher dedups in-flight requests per hash, resumes from the first
 *   received offset on gaps, resolves on `done`, and caches the result —
 *   a rejoin hits the cache and never sends asset.get (§7 acceptance).
 */
import { openDB, type IDBPDatabase } from "idb";
import type { AssetChunkMsg, AssetPriority } from "../core/messages";
import type { AssetId } from "../core/ids";

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
    const rec = (await this.db.get(CACHE_STORE, hash)) as CacheBlobRecord | undefined;
    return rec ? { bytes: rec.bytes, mime: rec.mime } : undefined;
  }

  async put(hash: AssetId, bytes: Uint8Array, mime: string): Promise<void> {
    const tx = this.db.transaction(CACHE_STORE, "readwrite");
    await tx.store.put({ hash, bytes, mime } satisfies CacheBlobRecord);
    await tx.done;
  }

  async has(hash: AssetId): Promise<boolean> {
    return (await this.db.get(CACHE_STORE, hash)) !== undefined;
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
    if (typeof globalThis.caches?.open !== "function") return null;
    try {
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
    await this.cache.put(cacheUrl(hash), new Response(body, { headers: { "content-type": mime } }));
  }

  async has(hash: AssetId): Promise<boolean> {
    return this.cache.match(cacheUrl(hash)).then((r) => r !== undefined);
  }
}

// ─── AssetCache ───────────────────────────────────────────────────────────────

export class AssetCache {
  private constructor(private readonly backend: AssetCacheBackend) {}

  /** Cache API when available, IDB otherwise (D-038). */
  static async open(): Promise<AssetCache> {
    const api = await CacheApiBackend.open();
    return new AssetCache(api ?? (await IdbCacheBackend.open()));
  }

  /** Test/explicit backend injection. */
  static withBackend(backend: AssetCacheBackend): AssetCache {
    return new AssetCache(backend);
  }

  get(hash: AssetId): Promise<{ bytes: Uint8Array; mime: string } | undefined> {
    return this.backend.get(hash);
  }

  async put(hash: AssetId, bytes: Uint8Array, mime: string): Promise<void> {
    await this.backend.put(hash, bytes, mime);
  }

  has(hash: AssetId): Promise<boolean> {
    return this.backend.has(hash);
  }
}

// ─── Fetch orchestrator ───────────────────────────────────────────────────────

interface Inflight {
  mime: string;
  expectedOffset: number;
  parts: Uint8Array[];
  receivedBytes: number;
  resolve: (bytes: Uint8Array) => void;
  reject: (error: Error) => void;
  priority: AssetPriority;
}

export interface AssetFetcherOptions {
  cache: AssetCache;
  /** Wired to ClientSync.requestAsset. */
  request: (assetId: AssetId, priority: AssetPriority, offset: number) => void;
}

export class AssetFetcher {
  private readonly inflight = new Map<AssetId, Inflight>();
  private readonly promises = new Map<AssetId, Promise<Uint8Array>>();

  constructor(private readonly options: AssetFetcherOptions) {}

  /** Fetch an asset by hash — cache hit short-circuits (no wire traffic). */
  request(
    assetId: AssetId,
    priority: AssetPriority = "scene",
    mime = "application/octet-stream",
  ): Promise<Uint8Array> {
    const cached = this.promises.get(assetId);
    if (cached) return cached;
    const promise = (async () => {
      const hit = await this.options.cache.get(assetId);
      if (hit) return hit.bytes;
      return new Promise<Uint8Array>((resolve, reject) => {
        this.inflight.set(assetId, {
          mime,
          expectedOffset: 0,
          parts: [],
          receivedBytes: 0,
          resolve,
          reject,
          priority,
        });
        this.options.request(assetId, priority, 0);
      });
    })();
    this.promises.set(assetId, promise);
    // owned: on failure clear the memo so a later request can retry
    void promise.then(
      () => undefined,
      () => {
        this.promises.delete(assetId);
        this.inflight.delete(assetId);
      },
    );
    return promise;
  }

  /** Feed one asset.chunk (wired to the ClientSync `asset` bus event). */
  onChunk(msg: AssetChunkMsg): void {
    const job = this.inflight.get(msg.assetId);
    if (!job) return;
    if (msg.total === 0) {
      // miss sentinel (D-039)
      this.inflight.delete(msg.assetId);
      job.reject(new Error(`asset not found: ${msg.assetId}`));
      return;
    }
    if (msg.offset !== job.expectedOffset) {
      if (msg.offset < job.expectedOffset) return; // stale duplicate
      // gap → resume from what we hold (§7 resume {assetId, offset})
      this.options.request(msg.assetId, job.priority, job.expectedOffset);
      return;
    }
    job.parts.push(msg.bytes);
    job.receivedBytes += msg.bytes.length;
    job.expectedOffset += msg.bytes.length;
    if (msg.done) {
      this.inflight.delete(msg.assetId);
      const all = new Uint8Array(job.receivedBytes);
      let at = 0;
      for (const part of job.parts) {
        all.set(part, at);
        at += part.length;
      }
      void this.options.cache.put(msg.assetId, all, job.mime); // owned: fire-forget cache fill
      job.resolve(all);
    }
  }

  get pendingCount(): number {
    return this.inflight.size;
  }
}

// ─── Progressive rendering chain (§7: thumbnail → mid → full) ─────────────────

import type { AssetManifest } from "../core/documents";

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
