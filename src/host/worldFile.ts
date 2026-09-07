/**
 * §8 — Export/Import world.zip via streaming fflate.
 *
 * Layout (format 1, M1):
 *   world.json       { format, worldId, name, system, version, seq, exportedAt }
 *   documents.json   { seq, docs: [{ coll, id, doc }] }   — every documents-store
 *                    row for the world at `seq` (checkpoint semantics: the oplog
 *                    tail is not exported; import restores a compacted world).
 *   assets.json      asset metadata rows (descriptors included) minus blobs
 *   assets/<hash>    raw content-addressed blobs
 *
 * Not yet in the archive (absent by design, see ROADMAP): fog/ (M2 vision),
 * checkpoints/ + reports/ (§8A strategic, M2), world-scope settings (M2 §10).
 *
 * Import = restore: the world keeps its worldId; every existing row for that
 * world is replaced, so re-importing an earlier export rolls the world back to
 * the export point. Undo history (oplog inverses) resets, exactly as after a
 * §8 checkpoint.
 */
import { strFromU8, strToU8, unzip, Zip, ZipDeflate } from "fflate";
import type { IDBPDatabase } from "idb";
import type { AssetRecord } from "../storage/idb";
import { getWorld, listAssets, STORES } from "../storage/idb";
import {
  decodeReport,
  listCheckpointsForWorld,
  listReportsForWorld,
  putCheckpoint,
  putReport,
  type CheckpointRecord,
} from "../storage/strategicStore";
import type { TurnReport } from "../core/sim";
import { OpfsAssetStore, type DirHandleLike } from "../storage/opfs";
import type { BaseDocument, CollectionName } from "../core/documents";
import type { AssetId, DocId, WorldId } from "../core/ids";
import type { HostPersister } from "../storage/persistence";

export const WORLD_FILE_FORMAT = 1;

export interface WorldFileMeta {
  format: number;
  worldId: WorldId;
  name: string;
  system: string;
  version: string;
  /** Store seq the documents reflect (becomes flushedSeq+oplogBase on import). */
  seq: number;
  exportedAt: number;
}

/** documents.json body. */
export interface WorldFileDocuments {
  seq: number;
  docs: Array<{ coll: CollectionName; id: DocId; doc: BaseDocument }>;
}

/** assets.json entry: an AssetRecord minus { worldId, bytes }. */
export type WorldFileAsset = Omit<AssetRecord, "worldId" | "bytes">;

export interface ExportWorldOptions {
  db: IDBPDatabase;
  worldId: WorldId;
  /** OPFS root (same one AssetServer uses); null → blobs come from IDB rows. */
  root?: DirHandleLike | null;
  /** Live persister to flush first so the archive matches the in-memory seq. */
  persister?: HostPersister;
  now?: () => number;
}

export interface ImportWorldOptions {
  db: IDBPDatabase;
  file: Blob | Uint8Array;
  /** OPFS root for blob storage; null/omitted → blobs inline in IDB (D-037). */
  root?: DirHandleLike | null;
  now?: () => number;
}

export interface ImportedWorld {
  worldId: WorldId;
  name: string;
  seq: number;
}

// ─── helpers ──────────────────────────────────────────────────────────────────

function jsonBytes(value: unknown): Uint8Array {
  return strToU8(JSON.stringify(value));
}

function parseJson<T>(bytes: Uint8Array, what: string): T {
  try {
    return JSON.parse(strFromU8(bytes)) as T;
  } catch (error) {
    throw new Error(`world file: corrupt ${what} (${String(error)})`, { cause: error });
  }
}

/** Read every documents-store row for a world, ordered by key. */
async function readDocuments(
  db: IDBPDatabase,
  worldId: WorldId,
): Promise<WorldFileDocuments["docs"]> {
  const docs: WorldFileDocuments["docs"] = [];
  const range = IDBKeyRange.bound([worldId], [worldId, []]);
  const keys = (await db.getAllKeys(STORES.documents, range)) as unknown as Array<
    [WorldId, CollectionName, DocId]
  >;
  for (const [, coll, id] of keys) {
    const rec = (await db.get(STORES.documents, [worldId, coll, id])) as
      { doc: BaseDocument } | undefined;
    if (rec) docs.push({ coll, id, doc: rec.doc });
  }
  return docs;
}

// ─── export (streaming Zip, §8 "streaming fflate") ────────────────────────────

export async function exportWorldZip(options: ExportWorldOptions): Promise<Blob> {
  await options.persister?.flush(); // archive the live state, not the last batch
  const world = await getWorld(options.db, options.worldId);
  if (!world) throw new Error(`world file: unknown world ${options.worldId}`);

  const docs = await readDocuments(options.db, options.worldId);
  const assets = await listAssets(options.db, options.worldId);
  const opfs = await OpfsAssetStore.open(options.worldId, options.root ?? null);

  const meta: WorldFileMeta = {
    format: WORLD_FILE_FORMAT,
    worldId: world.worldId,
    name: world.name,
    system: world.system,
    version: world.version,
    seq: world.flushedSeq,
    exportedAt: (options.now ?? Date.now)(),
  };
  const assetEntries: WorldFileAsset[] = [];
  const blobs: Array<{ hash: AssetId; bytes: Uint8Array }> = [];
  for (const record of assets) {
    const bytes = record.bytes ?? (await opfs?.get(record.hash));
    if (!bytes) throw new Error(`world file: missing blob for asset ${record.hash}`);
    const entry: WorldFileAsset = {
      hash: record.hash,
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
    assetEntries.push(entry);
    blobs.push({ hash: record.hash, bytes });
  }

  // §8A: checkpoints/ + reports/ ride in the world file (resume + replay)
  const checkpoints = await listCheckpointsForWorld(options.db, options.worldId);
  const reportRecords = await listReportsForWorld(options.db, options.worldId);

  const parts: BlobPart[] = [];
  const done = new Promise<void>((resolve, reject) => {
    const zip = new Zip((error, chunk, final) => {
      if (error) reject(new Error(`world file: zip failed (${error.message})`));
      else if (chunk) parts.push(chunk as BlobPart);
      if (final) resolve();
    });
    const add = (filename: string, bytes: Uint8Array): void => {
      const entry = new ZipDeflate(filename);
      zip.add(entry);
      entry.push(bytes, true);
    };
    add("world.json", jsonBytes(meta));
    add("documents.json", jsonBytes({ seq: meta.seq, docs } satisfies WorldFileDocuments));
    add("assets.json", jsonBytes(assetEntries));
    for (const blob of blobs) add(`assets/${blob.hash}`, blob.bytes);
    for (const cp of checkpoints) {
      const { pool, ...cpMeta } = cp;
      add(`checkpoints/${cp.sceneId}/${cp.slot}.json`, jsonBytes(cpMeta));
      add(`checkpoints/${cp.sceneId}/${cp.slot}.pool`, pool);
    }
    for (const rep of reportRecords) {
      add(`reports/${rep.sceneId}/${rep.turnNumber}.json`, jsonBytes(decodeReport(rep.bytes)));
    }
    zip.end();
  });
  await done;
  return new Blob(parts, { type: "application/zip" });
}

// ─── import (restore) ─────────────────────────────────────────────────────────

function unzipAll(bytes: Uint8Array): Promise<Map<string, Uint8Array>> {
  return new Promise((resolve, reject) => {
    unzip(bytes, (error, files) => {
      if (error) reject(new Error(`world file: unzip failed (${error.message})`));
      else resolve(new Map(Object.entries(files)));
    });
  });
}

function requireFile(files: Map<string, Uint8Array>, name: string): Uint8Array {
  const bytes = files.get(name);
  if (!bytes) throw new Error(`world file: missing ${name}`);
  return bytes;
}

export async function importWorldZip(options: ImportWorldOptions): Promise<ImportedWorld> {
  const buffer =
    options.file instanceof Uint8Array
      ? options.file
      : new Uint8Array(await options.file.arrayBuffer());
  const files = await unzipAll(buffer);

  const meta = parseJson<WorldFileMeta>(requireFile(files, "world.json"), "world.json");
  if (meta.format !== WORLD_FILE_FORMAT) {
    throw new Error(`world file: unsupported format ${String(meta.format)}`);
  }
  if (typeof meta.worldId !== "string" || meta.worldId.length === 0) {
    throw new Error("world file: world.json has no worldId");
  }
  if (typeof meta.seq !== "number" || !Number.isInteger(meta.seq) || meta.seq < 0) {
    throw new Error("world file: world.json has an invalid seq");
  }
  const documents = parseJson<WorldFileDocuments>(
    requireFile(files, "documents.json"),
    "documents.json",
  );
  if (documents.seq !== meta.seq) {
    throw new Error(`world file: seq mismatch (world ${meta.seq}, documents ${documents.seq})`);
  }
  const assetEntries = parseJson<WorldFileAsset[]>(
    requireFile(files, "assets.json"),
    "assets.json",
  );

  // Blob writes first (content-addressed → idempotent): an OPFS failure leaves
  // orphan files but never a half-imported database.
  const opfs = await OpfsAssetStore.open(meta.worldId, options.root ?? null);
  for (const entry of assetEntries) {
    const bytes = files.get(`assets/${entry.hash}`);
    if (!bytes) throw new Error(`world file: archive lacks blob for asset ${entry.hash}`);
    if (opfs) await opfs.put(entry.hash, bytes);
  }

  const worldId: WorldId = meta.worldId;

  // §8A strategic state (optional in older archives): checkpoints/ + reports/
  const checkpointFiles = [...files.keys()].filter(
    (k) => k.startsWith("checkpoints/") && k.endsWith(".pool"),
  );
  for (const poolPath of checkpointFiles) {
    const jsonPath = poolPath.replace(/\.pool$/, ".json");
    const cpMeta = parseJson<CheckpointRecord>(requireFile(files, jsonPath), jsonPath);
    await putCheckpoint(options.db, {
      ...cpMeta,
      worldId,
      pool: requireFile(files, poolPath),
    });
  }
  const reportFiles = [...files.keys()].filter(
    (k) => k.startsWith("reports/") && k.endsWith(".json"),
  );
  for (const reportPath of reportFiles) {
    const turn = parseJson<TurnReport>(requireFile(files, reportPath), reportPath);
    await putReport(options.db, worldId, turn.sceneId ?? "", turn);
  }
  const tx = options.db.transaction(
    [STORES.worlds, STORES.documents, STORES.oplog, STORES.fog, STORES.assets],
    "readwrite",
  );
  // Replace any existing world data (restore semantics) in one transaction.
  for (const store of [STORES.documents, STORES.oplog, STORES.fog, STORES.assets]) {
    void tx.objectStore(store).delete(IDBKeyRange.bound([worldId], [worldId, []]));
  }
  const assetStore = tx.objectStore(STORES.assets);
  for (const entry of assetEntries) {
    const record: AssetRecord = opfs
      ? { ...entry, worldId }
      : { ...entry, worldId, bytes: files.get(`assets/${entry.hash}`) as Uint8Array };
    void assetStore.put(record);
  }
  const docStore = tx.objectStore(STORES.documents);
  for (const doc of documents.docs) {
    void docStore.put({ worldId, coll: doc.coll, id: doc.id, doc: doc.doc });
  }
  void tx.objectStore(STORES.worlds).put({
    worldId,
    name: meta.name,
    system: meta.system,
    version: meta.version,
    lastOpened: (options.now ?? Date.now)(),
    flushedSeq: meta.seq,
    oplogBase: meta.seq,
  });
  await tx.done;

  return { worldId, name: meta.name, seq: meta.seq };
}
