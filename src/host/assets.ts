/**
 * §7 AssetServer (host) — content-addressed asset store.
 *
 * - assetId = sha256(bytes) (hex); blobs in OPFS /vtt/<worldId>/assets/<hash>,
 *   metadata in the IDB `assets` store; when OPFS is unavailable the blob is
 *   inlined in the IDB record (D-037).
 * - The world's assetManifest is maintained here — never via Ops (D-015) —
 *   through `wireManifestToStore`, which updates store.world.assetManifest so
 *   snapshots carry the manifest (§5: manifest only, lazy fetch).
 * - Chunked serving is delegated to AssetTransfer (net/transfer.ts); this
 *   module implements the AssetChunkSource read interface.
 */
import type { AssetId, WorldId } from "../core/ids";
import type { AssetManifest, AssetManifestEntry } from "../core/documents";
import type { DocumentStore } from "../core/store";
import type { WorldCollections } from "../core/documents";
import type { DirHandleLike } from "../storage/opfs";
import { OpfsAssetStore } from "../storage/opfs";
import {
  getAsset,
  listAssets,
  openVttDb,
  putAsset,
  deleteAsset,
  type AssetRecord,
  type IDBPDatabase,
} from "../storage/idb";

export interface ImportedAsset {
  hash: AssetId;
  entry: AssetManifestEntry;
}

export interface AssetServerOptions {
  worldId: WorldId;
  /** Open "vtt" DB (or an already-open handle for tests). */
  db?: IDBPDatabase;
  /** OPFS root; null/omitted → IDB blob fallback (D-037). */
  root?: DirHandleLike | null;
  chunkSize?: number;
  /** Manifest change hook (wireManifestToStore installs this). */
  onManifest?: ((manifest: AssetManifest) => void) | undefined;
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", toArrayBuffer(bytes));
  return bufferToHex(new Uint8Array(digest));
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

function bufferToHex(bytes: Uint8Array): string {
  let hex = "";
  for (const b of bytes) hex += b.toString(16).padStart(2, "0");
  return hex;
}

export class AssetServer {
  private readonly db: IDBPDatabase;
  private readonly opfs: OpfsAssetStore | null;
  private readonly chunkSize: number;
  private readonly _worldId: WorldId;
  private onManifest: ((manifest: AssetManifest) => void) | undefined;
  private ownsDb = false;

  private constructor(options: AssetServerOptions, db: IDBPDatabase, opfs: OpfsAssetStore | null) {
    this.db = db;
    this.opfs = opfs;
    this.chunkSize = options.chunkSize ?? 32 * 1024;
    this.onManifest = options.onManifest;
    this._worldId = options.worldId;
  }

  static async open(options: AssetServerOptions): Promise<AssetServer> {
    const db = options.db ?? (await openVttDb());
    const server = new AssetServer(
      options,
      db,
      await OpfsAssetStore.open(options.worldId, options.root ?? null),
    );
    server.ownsDb = options.db === undefined;
    // rehydrate the manifest from metadata (startup path)
    options.onManifest?.(await server.manifest());
    return server;
  }

  /** Import bytes under their content hash; idempotent per content. */
  async import(bytes: Uint8Array, name: string, mime: string): Promise<ImportedAsset> {
    const hash = await sha256Hex(bytes);
    const existing = await getAsset(this.db, this.worldId, hash);
    if (existing) {
      return { hash, entry: manifestEntry(existing) };
    }
    const size = bytes.length;
    const chunks = Math.max(1, Math.ceil(size / this.chunkSize));
    if (this.opfs) {
      await this.opfs.put(hash, bytes);
      await putAsset(this.db, {
        worldId: this.worldId,
        hash,
        name,
        mime,
        size,
        chunks,
      });
    } else {
      await putAsset(this.db, {
        worldId: this.worldId,
        hash,
        name,
        mime,
        size,
        chunks,
        bytes: new Uint8Array(bytes),
      });
    }
    this.onManifest?.(await this.manifest());
    return { hash, entry: { name, mime, size, chunks } };
  }

  async get(hash: AssetId): Promise<Uint8Array | undefined> {
    const record = await getAsset(this.db, this.worldId, hash);
    if (!record) return undefined;
    if (record.bytes) return record.bytes;
    return this.opfs?.get(hash);
  }

  async meta(hash: AssetId): Promise<AssetManifestEntry | undefined> {
    const record = await getAsset(this.db, this.worldId, hash);
    return record ? manifestEntry(record) : undefined;
  }

  async has(hash: AssetId): Promise<boolean> {
    return (await getAsset(this.db, this.worldId, hash)) !== undefined;
  }

  async remove(hash: AssetId): Promise<void> {
    await deleteAsset(this.db, this.worldId, hash);
    await this.opfs?.remove(hash);
    this.onManifest?.(await this.manifest());
  }

  /**
   * Enrich an existing asset's manifest entry (width/height/thumb/mid/tiles).
   * Rewrites the IDB record and fires the manifest hook. Descriptors persist,
   * so restarts need no re-derivation.
   */
  async describe(hash: AssetId, patch: Partial<AssetManifestEntry>): Promise<AssetManifestEntry> {
    const record = await getAsset(this.db, this.worldId, hash);
    if (!record) throw new Error(`describe: unknown asset ${hash}`);
    const entry: AssetManifestEntry = { ...manifestEntry(record), ...patch };
    const updated: AssetRecord = { ...record, name: entry.name, mime: entry.mime };
    if (entry.width !== undefined) updated.width = entry.width;
    if (entry.height !== undefined) updated.height = entry.height;
    if (entry.thumb !== undefined) updated.thumb = entry.thumb;
    if (entry.mid !== undefined) updated.mid = entry.mid;
    if (entry.tiles !== undefined) updated.tiles = entry.tiles;
    await putAsset(this.db, updated);
    this.onManifest?.(await this.manifest());
    return entry;
  }

  /** Replace the manifest hook (wireManifestToStore). */
  installManifestSink(sink: (manifest: AssetManifest) => void): void {
    this.onManifest = sink;
  }

  /** Full manifest for this world (from IDB metadata). */
  async manifest(): Promise<AssetManifest> {
    const manifest: AssetManifest = {};
    for (const record of await listAssets(this.db, this.worldId)) {
      manifest[record.hash] = manifestEntry(record);
    }
    return manifest;
  }

  /**
   * AssetChunkSource for AssetTransfer: a ranged read.
   * Returns undefined for unknown assets (transfer sends the miss sentinel).
   */
  readonly read = async (
    assetId: AssetId,
    offset: number,
    length: number,
  ): Promise<{ bytes: Uint8Array; total: number } | undefined> => {
    const bytes = await this.get(assetId);
    if (bytes === undefined) return undefined;
    return { bytes: bytes.slice(offset, offset + length), total: bytes.length };
  };

  get worldId(): WorldId {
    return this._worldId;
  }

  close(): void {
    if (this.ownsDb) this.db.close();
  }
}

function manifestEntry(record: AssetRecord): AssetManifestEntry {
  const entry: AssetManifestEntry = {
    name: record.name,
    mime: record.mime,
    size: record.size,
    chunks: record.chunks,
  };
  if (record.width !== undefined) entry.width = record.width;
  if (record.height !== undefined) entry.height = record.height;
  if (record.thumb !== undefined) entry.thumb = record.thumb;
  if (record.mid !== undefined) entry.mid = record.mid;
  if (record.tiles !== undefined) entry.tiles = record.tiles;
  return entry;
}

/**
 * Wire the server's manifest into the host DocumentStore's world
 * (D-015: assetManifest is maintained by the AssetServer, never via Ops).
 */
export function wireManifestToStore(server: AssetServer, store: DocumentStore): void {
  const sink = (manifest: AssetManifest): void => {
    (store.world as WorldCollections).assetManifest = manifest;
  };
  // re-route the server's hook through the store + rehydrate at startup
  server.installManifestSink(sink);
  void server.manifest().then(sink); // owned promise: startup rehydration
}
