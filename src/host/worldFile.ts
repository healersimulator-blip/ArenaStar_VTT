/**
 * §8 — Export/Import world.zip via streaming fflate.
 *
 * Layout (format 2):
 *   world.json       { format, worldId, name, system, version, seq, exportedAt,
 *                      rules: { active } }
 *   documents.json   { seq, docs: [{ coll, id, doc }] }   — every documents-store
 *                    row for the world at `seq` (checkpoint semantics: the oplog
 *                    tail is not exported; import restores a compacted world).
 *   assets.json      asset metadata rows (descriptors included) minus blobs
 *   assets/<hash>    raw content-addressed blobs
 *   checkpoints/<sceneId>/<slot>.json + .pool   §8A strategic resume state
 *   reports/<sceneId>/<turn>.json               §8A turn reports (replay)
 *   packages.json    [{ id, name, version, type, importedAt, packCount }]
 *   packages/<id>/…  every file of each §12 package imported into the world,
 *                    verbatim (manifest.json, rules.js, packs/*.json, module.js)
 *
 * Format 2 (D-248) made the archive self-contained: a world's strategic ruleset
 * and content packs are world-scoped records (`packages [worldId, id]`) and the
 * checkpoints above are only meaningful under the exact rules.js that produced
 * them, yet format 1 exported neither the packages nor which one was active —
 * a shared PF1e world silently rebooted on the built-in ruleset. Tactical scenes
 * (heroes only) never touch the package; the ruleset drives the units of the
 * scenes flagged `flags.core.scale = "strategic"`, and both kinds of scene ride
 * in documents.json exactly as before.
 *
 * Import = restore: the world keeps its worldId; every existing row for that
 * world is replaced, so re-importing an earlier export rolls the world back to
 * the export point. Undo history (oplog inverses) resets, exactly as after a
 * §8 checkpoint. Format 1 archives still import; they carry no packages, so the
 * packages already in the local world (and its activation) are left untouched.
 *
 * Import as copy (`mode: "copy"`, D-249) writes the same rows under a NEW
 * worldId and leaves any world the archive names untouched — how a GM opens a
 * shared world beside their own, and how a *starter* archive (`starter: true`,
 * emitted by `scripts/buildStarterWorlds.mjs`: no documents, the ruleset and
 * its content packs pre-installed) becomes a fresh campaign every time it is
 * opened. A copy carries no trust either.
 *
 * Trust is never imported. `WorldsRecord.trustedPackages` is THIS GM's consent
 * to run a module in-page (D-089); it is not exported, and an archive claiming it
 * is ignored. A restore keeps whatever this browser had already granted.
 */
import { strFromU8, strToU8, unzip, Zip, ZipDeflate } from "fflate";
import type { IDBPDatabase } from "idb";
import type { AssetRecord, PackageRecord, WorldsRecord } from "../storage/idb";
import { getWorld, listAssets, listPackages, STORES } from "../storage/idb";
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
import { buildPackageFromFiles } from "../packages/packageLoader";

export const WORLD_FILE_FORMAT = 2;
/** Formats `importWorldZip` accepts (older exports keep importing). */
export const WORLD_FILE_FORMATS_READ: readonly number[] = [1, 2];

/** Id of the built-in strategic ruleset — mirrors `BUILTIN_SYSTEM_ID` in hostBoot. */
const BUILTIN_SYSTEM = "mass-battle-basic";

export interface WorldFileRules {
  /**
   * The active strategic ruleset: a `type: "system"` package id that MUST be present under
   * `packages/`, or null for the built-in mass-battle rules.
   */
  active: string | null;
}

export interface WorldFileMeta {
  format: number;
  worldId: WorldId;
  name: string;
  system: string;
  version: string;
  /** Store seq the documents reflect (becomes flushedSeq+oplogBase on import). */
  seq: number;
  exportedAt: number;
  /** Format ≥ 2. */
  rules?: WorldFileRules;
  /**
   * A template rather than someone's campaign (D-249): the start screen always imports it as
   * a copy under a fresh id, so opening it twice yields two worlds and never a "replace?".
   */
  starter?: boolean;
}

/** documents.json body. */
export interface WorldFileDocuments {
  seq: number;
  docs: Array<{ coll: CollectionName; id: DocId; doc: BaseDocument }>;
}

/** assets.json entry: an AssetRecord minus { worldId, bytes }. */
export type WorldFileAsset = Omit<AssetRecord, "worldId" | "bytes">;

/** packages.json entry — an index; the folder under packages/<id>/ is the source of truth. */
export interface WorldFilePackage {
  id: string;
  name: string;
  version: string;
  type: PackageRecord["type"];
  importedAt: number;
  packCount: number;
}

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
  /**
   * `replace` (default) restores the archive's own worldId; `copy` imports under a fresh id
   * (or `worldId` when given) and never touches the world the archive names.
   */
  mode?: "replace" | "copy";
  /** Copy mode only: the id to import under (default `w-<random>`). */
  worldId?: WorldId;
  /** Rename on import (starters and copies usually want one). */
  name?: string;
  /** OPFS root for blob storage; null/omitted → blobs inline in IDB (D-037). */
  root?: DirHandleLike | null;
  now?: () => number;
}

export interface ImportedWorld {
  worldId: WorldId;
  name: string;
  seq: number;
  /** How the archive was written into the database. */
  mode: "replace" | "copy";
  /** The worldId the archive itself names (differs from `worldId` for a copy). */
  sourceWorldId: WorldId;
  /** Archive format that was read. */
  format: number;
  /** Package ids restored from the archive (format 2) — empty for format 1. */
  packages: string[];
  /** The strategic ruleset the world will boot with (null = built-in). */
  activeRulesPackage: string | null;
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
      | { doc: BaseDocument }
      | undefined;
    if (rec) docs.push({ coll, id, doc: rec.doc });
  }
  return docs;
}

// ─── archive collection (shared by the zip and the folder exporters) ──────────

export interface WorldArchiveEntry {
  /** Archive-relative path, `/`-separated. */
  path: string;
  bytes: Uint8Array;
}

export interface WorldArchive {
  meta: WorldFileMeta;
  entries: WorldArchiveEntry[];
}

/**
 * Gather everything a world export contains, in archive order. One collector feeds both
 * writers so "save to folder" and "download zip" cannot drift apart (they were two copies).
 */
export async function collectWorldArchive(options: ExportWorldOptions): Promise<WorldArchive> {
  await options.persister?.flush(); // archive the live state, not the last batch
  const world = await getWorld(options.db, options.worldId);
  if (!world) throw new Error(`world file: unknown world ${options.worldId}`);

  const docs = await readDocuments(options.db, options.worldId);
  const assets = await listAssets(options.db, options.worldId);
  const opfs = await OpfsAssetStore.open(options.worldId, options.root ?? null);
  const packages = await listPackages(options.db, options.worldId);

  // The archive only claims a ruleset it actually carries: an activation whose record is gone
  // (rulesBoot.error at boot) exports as built-in rather than as a dangling reference.
  const active =
    world.activeRulesPackage !== undefined &&
    packages.some((p) => p.id === world.activeRulesPackage && p.type === "system")
      ? world.activeRulesPackage
      : null;

  const meta: WorldFileMeta = {
    format: WORLD_FILE_FORMAT,
    worldId: world.worldId,
    name: world.name,
    system: active ?? BUILTIN_SYSTEM,
    version: world.version,
    seq: world.flushedSeq,
    exportedAt: (options.now ?? Date.now)(),
    rules: { active },
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

  const entries: WorldArchiveEntry[] = [];
  const add = (path: string, bytes: Uint8Array): void => {
    entries.push({ path, bytes });
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
  const index: WorldFilePackage[] = packages.map((p) => ({
    id: p.id,
    name: p.name,
    version: p.version,
    type: p.type,
    importedAt: p.importedAt,
    packCount: p.manifest.packs?.length ?? 0,
  }));
  add("packages.json", jsonBytes(index));
  for (const p of packages) {
    for (const [path, text] of Object.entries(p.files)) {
      add(`packages/${p.id}/${path}`, strToU8(text));
    }
  }
  return { meta, entries };
}

// ─── export (streaming Zip, §8 "streaming fflate") ────────────────────────────

export async function exportWorldZip(options: ExportWorldOptions): Promise<Blob> {
  const { entries } = await collectWorldArchive(options);
  const parts: BlobPart[] = [];
  const done = new Promise<void>((resolve, reject) => {
    const zip = new Zip((error, chunk, final) => {
      if (error) reject(new Error(`world file: zip failed (${error.message})`));
      else if (chunk) parts.push(chunk as BlobPart);
      if (final) resolve();
    });
    for (const { path, bytes } of entries) {
      const entry = new ZipDeflate(path);
      zip.add(entry);
      entry.push(bytes, true);
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

/**
 * Rebuild the §12 package records an archive carries. Each folder goes through the SAME
 * validation as a package zip (`buildPackageFromFiles`): packages.json is an index, never
 * trusted for content, and a folder that would not import as a zip does not import here.
 */
function readArchivePackages(
  files: Map<string, Uint8Array>,
  worldId: WorldId,
  now: () => number,
): PackageRecord[] {
  const index = parseJson<WorldFilePackage[]>(requireFile(files, "packages.json"), "packages.json");
  if (!Array.isArray(index)) throw new Error("world file: packages.json must be an array");
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const records: PackageRecord[] = [];
  for (const entry of index) {
    if (typeof entry?.id !== "string" || entry.id.length === 0) {
      throw new Error("world file: packages.json entry without an id");
    }
    const prefix = `packages/${entry.id}/`;
    const texts: Record<string, string> = {};
    for (const [path, bytes] of files) {
      if (!path.startsWith(prefix) || path.endsWith("/")) continue;
      try {
        texts[path.slice(prefix.length)] = decoder.decode(bytes);
      } catch {
        throw new Error(`world file: package ${entry.id}: ${path} is not UTF-8 text`);
      }
    }
    if (Object.keys(texts).length === 0) {
      throw new Error(`world file: packages.json lists ${entry.id} but packages/${entry.id}/ is empty`);
    }
    const loaded = buildPackageFromFiles(texts);
    if (!loaded.ok) throw new Error(`world file: package ${entry.id}: ${loaded.error}`);
    if (loaded.value.manifest.id !== entry.id) {
      throw new Error(
        `world file: packages/${entry.id}/ holds package ${loaded.value.manifest.id}`,
      );
    }
    const { manifest } = loaded.value;
    records.push({
      worldId,
      id: manifest.id,
      name: manifest.name,
      version: manifest.version,
      type: manifest.type,
      importedAt:
        typeof entry.importedAt === "number" && Number.isFinite(entry.importedAt)
          ? entry.importedAt
          : now(),
      manifest,
      files: loaded.value.files,
    });
  }
  return records;
}

export async function importWorldZip(options: ImportWorldOptions): Promise<ImportedWorld> {
  const now = options.now ?? Date.now;
  const buffer =
    options.file instanceof Uint8Array
      ? options.file
      : new Uint8Array(await options.file.arrayBuffer());
  const files = await unzipAll(buffer);

  const meta = parseJson<WorldFileMeta>(requireFile(files, "world.json"), "world.json");
  if (!WORLD_FILE_FORMATS_READ.includes(meta.format)) {
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
  const mode = options.mode ?? "replace";
  if (mode === "replace" && options.worldId !== undefined && options.worldId !== meta.worldId) {
    throw new Error("world file: a replace import restores the archive's own worldId");
  }
  const worldId: WorldId =
    mode === "copy"
      ? (options.worldId ?? `w-${globalThis.crypto.randomUUID().slice(0, 8)}`)
      : meta.worldId;
  if (mode === "copy" && (await getWorld(options.db, worldId))) {
    throw new Error(`world file: cannot copy onto existing world ${worldId}`);
  }
  const name =
    options.name !== undefined && options.name.trim().length > 0
      ? options.name.trim()
      : meta.name;

  // ── §12 packages + the ruleset pin (format 2) ──────────────────────────────
  const carriesPackages = meta.format >= 2;
  const packageRecords = carriesPackages ? readArchivePackages(files, worldId, now) : [];
  let archiveActive: string | null = null;
  if (carriesPackages) {
    const active = meta.rules?.active ?? null;
    if (active !== null) {
      if (typeof active !== "string") throw new Error("world file: rules.active must be an id");
      const rec = packageRecords.find((p) => p.id === active);
      if (!rec) {
        throw new Error(`world file: rules.active names ${active}, which is not in the archive`);
      }
      if (rec.type !== "system" || !rec.manifest.rules) {
        throw new Error(`world file: rules.active ${active} is a content pack, not a ruleset`);
      }
    }
    archiveActive = active;
  }

  // What this browser already knows about the world (nothing, for a copy — it is a new id).
  // Trust is local consent and always carried; the activation is carried only when the
  // archive has no say (format 1).
  const existing = mode === "copy" ? undefined : await getWorld(options.db, worldId);
  const activeRulesPackage = carriesPackages ? archiveActive : (existing?.activeRulesPackage ?? null);
  const trustedPackages = existing?.trustedPackages ?? [];

  // Blob writes first (content-addressed → idempotent): an OPFS failure leaves
  // orphan files but never a half-imported database.
  const opfs = await OpfsAssetStore.open(worldId, options.root ?? null);
  for (const entry of assetEntries) {
    const bytes = files.get(`assets/${entry.hash}`);
    if (!bytes) throw new Error(`world file: archive lacks blob for asset ${entry.hash}`);
    if (opfs) await opfs.put(entry.hash, bytes);
  }

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

  type StoreName = (typeof STORES)[keyof typeof STORES];
  const replaced: StoreName[] = [STORES.documents, STORES.oplog, STORES.fog, STORES.assets];
  if (carriesPackages) replaced.push(STORES.packages);
  const tx = options.db.transaction([STORES.worlds, ...replaced], "readwrite");
  // Replace any existing world data (restore semantics) in one transaction.
  for (const store of replaced) {
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
  if (carriesPackages) {
    const pkgStore = tx.objectStore(STORES.packages);
    for (const rec of packageRecords) void pkgStore.put(rec);
  }
  const world: WorldsRecord = {
    worldId,
    name,
    // `system` names the ruleset the world boots with (D-248); older archives wrote the
    // built-in id regardless, so it is derived from the pin rather than copied.
    system: activeRulesPackage ?? (carriesPackages ? BUILTIN_SYSTEM : meta.system),
    version: meta.version,
    lastOpened: now(),
    flushedSeq: meta.seq,
    oplogBase: meta.seq,
  };
  if (activeRulesPackage !== null) world.activeRulesPackage = activeRulesPackage;
  if (trustedPackages.length > 0) world.trustedPackages = trustedPackages;
  void tx.objectStore(STORES.worlds).put(world);
  await tx.done;

  return {
    worldId,
    name,
    seq: meta.seq,
    mode,
    sourceWorldId: meta.worldId,
    format: meta.format,
    packages: packageRecords.map((p) => p.id),
    activeRulesPackage,
  };
}

// ─── export to folder handle (File System Access API, §8) ────────────────────

export async function exportWorldToFolder(
  options: ExportWorldOptions,
  dirHandle: DirHandleLike,
): Promise<{ filesCount: number }> {
  const { entries } = await collectWorldArchive(options);
  const dirs = new Map<string, DirHandleLike>([["", dirHandle]]);
  const dirFor = async (path: string): Promise<DirHandleLike> => {
    const cached = dirs.get(path);
    if (cached) return cached;
    const cut = path.lastIndexOf("/");
    const parent = await dirFor(cut === -1 ? "" : path.slice(0, cut));
    const handle = await parent.getDirectoryHandle(path.slice(cut + 1), { create: true });
    dirs.set(path, handle);
    return handle;
  };
  let filesCount = 0;
  for (const { path, bytes } of entries) {
    const cut = path.lastIndexOf("/");
    const parent = await dirFor(cut === -1 ? "" : path.slice(0, cut));
    const handle = await parent.getFileHandle(path.slice(cut + 1), { create: true });
    const writable = await handle.createWritable();
    await writable.write(bytes);
    await writable.close();
    filesCount++;
  }
  return { filesCount };
}
