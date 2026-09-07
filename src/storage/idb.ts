/**
 * §8 Persistence — IndexedDB "vtt" schema and typed helpers (via `idb`).
 *
 *   worlds     keyPath worldId                  → WorldsRecord (meta + flush state)
 *   documents  keyPath [worldId, coll, id]      → DocumentsRecord (top-level docs)
 *   oplog      keyPath [worldId, seq]           → OplogRecord (envelope + inverses)
 *   fog        keyPath [worldId, sceneId, userId] → FogRecord (PNG bytes)
 *   settings   keyPath [scope, key]             → SettingsRecord (world/client/module KV)
 *
 * OPFS: /vtt/<worldId>/assets/<hash> (see opfs.ts). Strategic stores (§8A:
 * checkpoints / turnReports / simdeltas) are added in the M2 strategic unit.
 */
import { openDB, type IDBPDatabase } from "idb";

export type { IDBPDatabase } from "idb";
import type { AssetManifestEntry, BaseDocument, CollectionName, Json } from "../core/documents";
import type { PackageManifest } from "../core/packageManifest";
import type { AssetId, DocId } from "../core/ids";
import type { Op, OpEnvelope } from "../core/ops";
import type { DocId as SceneId, UserId, WorldId } from "../core/ids";

export const DB_NAME = "vtt";
export const DB_VERSION = 4;

export const STORES = {
  worlds: "worlds",
  documents: "documents",
  oplog: "oplog",
  fog: "fog",
  settings: "settings",
  /** §7: asset metadata (host); `bytes` is set only when OPFS is unavailable. */
  assets: "assets",
  /** §8A strategic persistence (M2). */
  checkpoints: "checkpoints",
  turnReports: "turnReports",
  simdeltas: "simdeltas",
  /** §12 rules/data packages (M3), world-scoped. */
  packages: "packages",
} as const;

export interface WorldsRecord {
  worldId: WorldId;
  name: string;
  system: string;
  version: string;
  lastOpened: number;
  /**
   * Seq through which the `documents` store is current (written atomically
   * with the document batch, D-027). Oplog entries above it are replayed on
   * startup.
   */
  flushedSeq: number;
  /** Seq below which the oplog has been compacted away (checkpoint base). */
  oplogBase: number;
  /** §12 active system package id (applies at world load; null/absent = built-in). */
  activeRulesPackage?: string;
  /** §12 GM-granted in-page trust per package id (trusted tier opt-in). */
  trustedPackages?: string[];
}

export interface DocumentsRecord {
  worldId: WorldId;
  coll: CollectionName;
  id: DocId;
  doc: BaseDocument;
}

export interface OplogRecord {
  worldId: WorldId;
  seq: number;
  env: OpEnvelope;
  inverses: Op[];
}

export interface FogRecord {
  worldId: WorldId;
  sceneId: SceneId;
  userId: UserId;
  /** Downscaled explored-fog PNG (§9). */
  png: Uint8Array;
}

export interface SettingsRecord {
  /** "world" | "client" | module id. */
  scope: string;
  key: string;
  value: Json;
}

/** Open (and upgrade-create) the "vtt" database. */
export function openVttDb(): Promise<IDBPDatabase> {
  return openDB(DB_NAME, DB_VERSION, {
    upgrade(db) {
      if (!db.objectStoreNames.contains(STORES.worlds)) {
        db.createObjectStore(STORES.worlds, { keyPath: "worldId" });
      }
      if (!db.objectStoreNames.contains(STORES.documents)) {
        db.createObjectStore(STORES.documents, { keyPath: ["worldId", "coll", "id"] });
      }
      if (!db.objectStoreNames.contains(STORES.oplog)) {
        db.createObjectStore(STORES.oplog, { keyPath: ["worldId", "seq"] });
      }
      if (!db.objectStoreNames.contains(STORES.fog)) {
        db.createObjectStore(STORES.fog, { keyPath: ["worldId", "sceneId", "userId"] });
      }
      if (!db.objectStoreNames.contains(STORES.settings)) {
        db.createObjectStore(STORES.settings, { keyPath: ["scope", "key"] });
      }
      if (!db.objectStoreNames.contains(STORES.assets)) {
        db.createObjectStore(STORES.assets, { keyPath: ["worldId", "hash"] });
      }
      if (!db.objectStoreNames.contains(STORES.checkpoints)) {
        // §8A key [worldId, sceneId, slot] — slot = turnNumber (stepwise) | tick (realtime)
        db.createObjectStore(STORES.checkpoints, { keyPath: ["worldId", "sceneId", "slot"] });
      }
      if (!db.objectStoreNames.contains(STORES.turnReports)) {
        db.createObjectStore(STORES.turnReports, { keyPath: ["worldId", "sceneId", "turnNumber"] });
      }
      if (!db.objectStoreNames.contains(STORES.simdeltas)) {
        db.createObjectStore(STORES.simdeltas, { keyPath: ["worldId", "sceneId", "version"] });
      }
      if (!db.objectStoreNames.contains(STORES.packages)) {
        // §12 key [worldId, id]
        db.createObjectStore(STORES.packages, { keyPath: ["worldId", "id"] });
      }
    },
  });
}

// ─── worlds ───────────────────────────────────────────────────────────────────

export async function putWorld(db: IDBPDatabase, record: WorldsRecord): Promise<void> {
  await db.put(STORES.worlds, record);
}

export async function getWorld(
  db: IDBPDatabase,
  worldId: WorldId,
): Promise<WorldsRecord | undefined> {
  return db.get(STORES.worlds, worldId);
}

export async function listWorlds(db: IDBPDatabase): Promise<WorldsRecord[]> {
  const all = (await db.getAll(STORES.worlds)) as WorldsRecord[];
  return all.sort((a, b) => b.lastOpened - a.lastOpened);
}

export async function deleteWorldData(db: IDBPDatabase, worldId: WorldId): Promise<void> {
  await Promise.all([
    db.delete(STORES.worlds, worldId),
    deleteRange(db, STORES.documents, IDBKeyRange.bound([worldId], [worldId, []])),
    deleteRange(db, STORES.oplog, IDBKeyRange.bound([worldId], [worldId, []])),
    deleteRange(db, STORES.fog, IDBKeyRange.bound([worldId], [worldId, []])),
  ]);
}

// ─── documents (§12 migrations batch access) ──────────────────────────────────

export async function getAllDocumentRecords(
  db: IDBPDatabase,
  worldId: WorldId,
): Promise<DocumentsRecord[]> {
  const range = IDBKeyRange.bound([worldId], [worldId, []]);
  return (await db.getAll(STORES.documents, range)) as DocumentsRecord[];
}

/** Write a migrated doc back PRESERVING its record key (coll/id). */
export async function putDocumentRecord(db: IDBPDatabase, rec: DocumentsRecord): Promise<void> {
  await db.put(STORES.documents, rec);
}

// ─── fog / settings ───────────────────────────────────────────────────────────

export async function putFog(db: IDBPDatabase, rec: FogRecord): Promise<void> {
  await db.put(STORES.fog, rec);
}

export async function getFog(
  db: IDBPDatabase,
  worldId: WorldId,
  sceneId: SceneId,
  userId: UserId,
): Promise<FogRecord | undefined> {
  return db.get(STORES.fog, [worldId, sceneId, userId]);
}

export async function putSetting(db: IDBPDatabase, rec: SettingsRecord): Promise<void> {
  await db.put(STORES.settings, rec);
}

export async function getSetting(
  db: IDBPDatabase,
  scope: string,
  key: string,
): Promise<SettingsRecord | undefined> {
  return db.get(STORES.settings, [scope, key]);
}

export async function getAllSettings(db: IDBPDatabase, scope: string): Promise<SettingsRecord[]> {
  const all = (await db.getAll(STORES.settings)) as SettingsRecord[];
  return all.filter((r) => r.scope === scope);
}

// ─── packages (§12: world-scoped rule/data packages) ──────────────────────────

/** One imported package: validated manifest + text file contents. */
export interface PackageRecord {
  worldId: WorldId;
  id: string;
  name: string;
  version: string;
  type: "system" | "data";
  importedAt: number;
  manifest: PackageManifest;
  files: Record<string, string>;
}

export async function putPackage(db: IDBPDatabase, record: PackageRecord): Promise<void> {
  await db.put(STORES.packages, record);
}

export async function getPackage(
  db: IDBPDatabase,
  worldId: WorldId,
  id: string,
): Promise<PackageRecord | undefined> {
  return db.get(STORES.packages, [worldId, id]);
}

export async function deletePackage(db: IDBPDatabase, worldId: WorldId, id: string): Promise<void> {
  await db.delete(STORES.packages, [worldId, id]);
}

export async function listPackages(db: IDBPDatabase, worldId: WorldId): Promise<PackageRecord[]> {
  const range = IDBKeyRange.bound([worldId, ""], [worldId, "\uffff"]);
  const all = (await db.getAll(STORES.packages, range)) as PackageRecord[];
  return all.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

// ─── shared ───────────────────────────────────────────────────────────────────

async function deleteRange(db: IDBPDatabase, store: string, range: IDBKeyRange): Promise<void> {
  const keys = (await db.getAllKeys(store, range)) as IDBValidKey[];
  const tx = db.transaction(store, "readwrite");
  const os = tx.store;
  await Promise.all(keys.map((k) => os.delete(k)));
  await tx.done;
}

// ─── assets (§7: metadata in IDB; blobs in OPFS, inline fallback) ─────────────

/** One content-addressed asset: hash → metadata (+ blob bytes when no OPFS). */
export interface AssetRecord {
  worldId: WorldId;
  hash: AssetId;
  name: string;
  mime: string;
  size: number;
  /** Transfer chunk count (AssetServer chunkSize basis). */
  chunks: number;
  /** Present only when OPFS is unavailable (D-037). */
  bytes?: Uint8Array;
  /** §7 image descriptors (set via AssetServer.describe; absent on plain blobs). */
  width?: number;
  height?: number;
  thumb?: AssetManifestEntry["thumb"];
  mid?: AssetManifestEntry["mid"];
  tiles?: AssetManifestEntry["tiles"];
}

export async function putAsset(db: IDBPDatabase, record: AssetRecord): Promise<void> {
  const tx = db.transaction(STORES.assets, "readwrite");
  await tx.store.put(record);
  await tx.done;
}

export async function getAsset(
  db: IDBPDatabase,
  worldId: WorldId,
  hash: AssetId,
): Promise<AssetRecord | undefined> {
  return db.get(STORES.assets, [worldId, hash]);
}

export async function deleteAsset(
  db: IDBPDatabase,
  worldId: WorldId,
  hash: AssetId,
): Promise<void> {
  const tx = db.transaction(STORES.assets, "readwrite");
  await tx.store.delete([worldId, hash]);
  await tx.done;
}

export async function listAssets(db: IDBPDatabase, worldId: WorldId): Promise<AssetRecord[]> {
  const range = IDBKeyRange.bound([worldId, ""], [worldId, "\uffff"]);
  return db.getAll(STORES.assets, range);
}
