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
 *   fog.json         [{ sceneId, userId, file }]   §9 explored fog per user + scene (D-250;
 *   fog/<n>.png      optional — archives without it simply carry no explored maps)
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
 * Reviewed-script approvals are also local consent: copies AND restores of world
 * archives keep source/policy for inspection but must be re-approved on this host.
 */
import { strFromU8, strToU8, Zip, ZipDeflate } from "fflate";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import {
  assertWorldZipEntriesWithinLimits,
  extractZipEntriesBounded,
  WORLD_ZIP_LIMITS,
} from "./worldZip";
import type { IDBPDatabase } from "idb";
import type {
  AssetRecord,
  FogRecord,
  PackageRecord,
  WorldsRecord,
} from "../storage/idb";
import {
  encodeReport,
  type CheckpointRecord,
  type TurnReportRecord,
} from "../storage/strategicStore";
import {
  getWorld,
  listAssets,
  listFogForWorld,
  listPackages,
  STORES,
} from "../storage/idb";
import {
  decodeReport,
  listCheckpointsForWorld,
  listReportsForWorld,
} from "../storage/strategicStore";
import type { TurnReport } from "../core/sim";
import { OpfsAssetStore, type DirHandleLike } from "../storage/opfs";
import {
  TOP_LEVEL_COLLECTIONS,
  type BaseDocument,
  type CollectionName,
  type JournalDocument,
  type MacroDocument,
} from "../core/documents";
import { codexArchiveJournalError } from "../core/campaignCodex";
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

/** fog.json entry (D-250): one user's explored map of one scene, stored at `file`. */
export interface WorldFileFog {
  sceneId: DocId;
  userId: string;
  /** Archive path of the PNG, e.g. `fog/3.png` (ids are not filesystem-safe). */
  file: string;
}

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
  /** Explored-fog maps restored (user × scene), D-250. */
  fogRecords: number;
}

// ─── helpers ──────────────────────────────────────────────────────────────────

function jsonBytes(value: unknown): Uint8Array {
  return strToU8(JSON.stringify(value));
}

function parseJson<T>(bytes: Uint8Array, what: string): T {
  try {
    return JSON.parse(strFromU8(bytes)) as T;
  } catch (error) {
    throw new Error(`world file: corrupt ${what} (${String(error)})`, {
      cause: error,
    });
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const HASH_RE = /^[a-f0-9]{64}$/;
const WORLD_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
const MAX_ARCHIVE_DOCUMENTS = 100_000;
const MAX_ARCHIVE_ASSETS = 100_000;
const MAX_ARCHIVE_PACKAGES = 10_000;
const ARCHIVE_DOCUMENT_TYPE_BY_COLLECTION: Record<CollectionName, string> = {
  users: "user",
  folders: "folder",
  scenes: "scene",
  actors: "actor",
  items: "item",
  journals: "journal",
  rollTables: "rollTable",
  encounterTables: "encounterTable",
  playlists: "playlist",
  macros: "macro",
  automations: "automation",
  actionReceipts: "actionReceipt",
  prefabs: "prefab",
  fxInstances: "fxInstance",
  cards: "cards",
  combats: "combat",
  messages: "message",
  settings: "settings",
  compendia: "compendium",
  factions: "faction",
  armies: "army",
  turns: "turn",
  depots: "depot",
  routes: "route",
  reinforcements: "reinforcement",
};

function validateWorldMeta(value: unknown): WorldFileMeta {
  if (!isRecord(value))
    throw new Error("world file: world.json must be an object");
  if (!Number.isSafeInteger(value.format) || typeof value.format !== "number")
    throw new Error("world file: world.json has an invalid format");
  if (typeof value.worldId !== "string" || !WORLD_ID_RE.test(value.worldId))
    throw new Error("world file: world.json has an invalid worldId");
  if (typeof value.name !== "string" || value.name.length > 256)
    throw new Error("world file: world.json has an invalid name");
  if (typeof value.system !== "string" || value.system.length > 128)
    throw new Error("world file: world.json has an invalid system id");
  if (typeof value.version !== "string" || value.version.length > 128)
    throw new Error("world file: world.json has an invalid version");
  if (
    !Number.isSafeInteger(value.seq) ||
    typeof value.seq !== "number" ||
    value.seq < 0
  )
    throw new Error("world file: world.json has an invalid seq");
  if (
    value.exportedAt !== undefined &&
    (typeof value.exportedAt !== "number" ||
      !Number.isFinite(value.exportedAt) ||
      value.exportedAt < 0)
  )
    throw new Error("world file: world.json has an invalid exportedAt");
  if (value.starter !== undefined && typeof value.starter !== "boolean")
    throw new Error("world file: world.json has an invalid starter flag");
  if (value.rules !== undefined) {
    if (!isRecord(value.rules))
      throw new Error("world file: world.json rules must be an object");
    const active = value.rules.active;
    if (
      active !== undefined &&
      active !== null &&
      (typeof active !== "string" || !/^[a-z0-9][a-z0-9-]{1,63}$/.test(active))
    )
      throw new Error(
        "world file: world.json rules.active must be a package id or null",
      );
  }
  return value as unknown as WorldFileMeta;
}

function validateWorldDocuments(
  value: unknown,
  expectedSeq: number,
): WorldFileDocuments {
  if (
    !isRecord(value) ||
    !Number.isSafeInteger(value.seq) ||
    value.seq !== expectedSeq
  )
    throw new Error(
      "world file: documents.json has an invalid or mismatched seq",
    );
  if (!Array.isArray(value.docs))
    throw new Error("world file: documents.json docs must be an array");
  if (value.docs.length > MAX_ARCHIVE_DOCUMENTS)
    throw new Error(
      `world file: documents.json exceeds the ${MAX_ARCHIVE_DOCUMENTS}-document limit`,
    );
  const seen = new Set<string>();
  for (const raw of value.docs) {
    if (
      !isRecord(raw) ||
      typeof raw.coll !== "string" ||
      !TOP_LEVEL_COLLECTIONS.includes(raw.coll as CollectionName)
    )
      throw new Error(
        "world file: documents.json contains an unknown collection",
      );
    if (
      typeof raw.id !== "string" ||
      raw.id.length === 0 ||
      raw.id.length > 128 ||
      raw.id.includes("\0")
    )
      throw new Error(
        "world file: documents.json contains an invalid document id",
      );
    const doc = raw.doc;
    if (
      !isRecord(doc) ||
      doc._id !== raw.id ||
      typeof doc.type !== "string" ||
      doc.type.length === 0 ||
      doc.type.length > 128 ||
      typeof doc.name !== "string" ||
      doc.name.length > 4096 ||
      !isRecord(doc.ownership) ||
      !isRecord(doc.flags) ||
      !isRecord(doc.system)
    )
      throw new Error(`world file: document ${raw.id} has invalid base fields`);
    const expectedType =
      ARCHIVE_DOCUMENT_TYPE_BY_COLLECTION[raw.coll as CollectionName];
    if (doc.type !== expectedType)
      throw new Error(
        `world file: document ${raw.id} has type ${doc.type} in collection ${raw.coll}; expected ${expectedType}`,
      );
    const ownership = doc.ownership;
    for (const [userId, level] of Object.entries(ownership)) {
      if (
        !userId ||
        userId.length > 128 ||
        ![0, 1, 2, 3].includes(level as number)
      )
        throw new Error(`world file: document ${raw.id} has invalid ownership`);
    }
    if (![0, 1, 2, 3].includes(ownership.default as number))
      throw new Error(
        `world file: document ${raw.id} has invalid default ownership`,
      );
    const key = `${raw.coll}\0${raw.id}`;
    if (seen.has(key))
      throw new Error(
        `world file: documents.json repeats ${raw.coll}:${raw.id}`,
      );
    seen.add(key);
    if (raw.coll === "journals" && doc.type === "journal") {
      const error = codexArchiveJournalError(doc as unknown as JournalDocument);
      if (error) throw new Error(`world file: journal ${raw.id}: ${error}`);
    }
  }
  return value as unknown as WorldFileDocuments;
}

function validateAssetVariant(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return (
    HASH_RE.test(String(value.assetId ?? "")) &&
    Number.isSafeInteger(value.width) &&
    Number(value.width) > 0 &&
    Number.isSafeInteger(value.height) &&
    Number(value.height) > 0
  );
}

function readArchiveAssets(
  files: Map<string, Uint8Array>,
  value: unknown,
): WorldFileAsset[] {
  if (!Array.isArray(value))
    throw new Error("world file: assets.json must be an array");
  if (value.length > MAX_ARCHIVE_ASSETS)
    throw new Error(
      `world file: assets.json exceeds the ${MAX_ARCHIVE_ASSETS}-asset limit`,
    );
  const seen = new Set<string>();
  const entries: WorldFileAsset[] = [];
  for (const raw of value) {
    if (
      !isRecord(raw) ||
      typeof raw.hash !== "string" ||
      !HASH_RE.test(raw.hash) ||
      seen.has(raw.hash)
    )
      throw new Error(
        "world file: assets.json contains an invalid or duplicate asset hash",
      );
    if (
      typeof raw.name !== "string" ||
      raw.name.length > 1024 ||
      typeof raw.mime !== "string" ||
      raw.mime.length === 0 ||
      raw.mime.length > 256 ||
      !Number.isSafeInteger(raw.size) ||
      Number(raw.size) < 0 ||
      Number(raw.size) > WORLD_ZIP_LIMITS.maxEntryBytes ||
      !Number.isSafeInteger(raw.chunks) ||
      Number(raw.chunks) < 1 ||
      Number(raw.chunks) > Math.max(1, Number(raw.size))
    )
      throw new Error(`world file: asset ${raw.hash} has invalid metadata`);
    if (
      raw.visibility !== undefined &&
      !["world", "referenced", "gm"].includes(String(raw.visibility))
    )
      throw new Error(`world file: asset ${raw.hash} has invalid visibility`);
    if (
      raw.exportRights !== undefined &&
      !["restricted", "granted"].includes(String(raw.exportRights))
    )
      throw new Error(
        `world file: asset ${raw.hash} has invalid export rights`,
      );
    for (const key of ["thumb", "mid"] as const) {
      if (raw[key] !== undefined && !validateAssetVariant(raw[key]))
        throw new Error(
          `world file: asset ${raw.hash} has invalid ${key} descriptor`,
        );
    }
    if (raw.tiles !== undefined) {
      const tiles = raw.tiles;
      if (
        !isRecord(tiles) ||
        !Number.isSafeInteger(tiles.size) ||
        Number(tiles.size) < 1 ||
        !Number.isSafeInteger(tiles.cols) ||
        Number(tiles.cols) < 1 ||
        !Number.isSafeInteger(tiles.rows) ||
        Number(tiles.rows) < 1 ||
        !Array.isArray(tiles.ids) ||
        Number(tiles.cols) * Number(tiles.rows) !== tiles.ids.length ||
        tiles.ids.length > MAX_ARCHIVE_ASSETS ||
        !tiles.ids.every((id) => typeof id === "string" && HASH_RE.test(id))
      )
        throw new Error(
          `world file: asset ${raw.hash} has invalid tile metadata`,
        );
    }
    const bytes = files.get(`assets/${raw.hash}`);
    if (!bytes)
      throw new Error(`world file: archive lacks blob for asset ${raw.hash}`);
    if (bytes.byteLength !== raw.size)
      throw new Error(
        `world file: asset ${raw.hash} has a mismatched byte length`,
      );
    if (bytesToHex(sha256(bytes)) !== raw.hash)
      throw new Error(
        `world file: asset ${raw.hash} failed its content hash check`,
      );
    seen.add(raw.hash);
    entries.push(raw as unknown as WorldFileAsset);
  }
  for (const path of files.keys()) {
    if (!path.startsWith("assets/")) continue;
    const hash = path.slice("assets/".length);
    if (!HASH_RE.test(hash) || !seen.has(hash))
      throw new Error(
        `world file: archive contains an unindexed asset blob ${path.slice(0, 160)}`,
      );
  }
  return entries;
}

/** Read every documents-store row for a world, ordered by key. */
async function readDocuments(
  db: IDBPDatabase,
  worldId: WorldId,
): Promise<WorldFileDocuments["docs"]> {
  const docs: WorldFileDocuments["docs"] = [];
  const range = IDBKeyRange.bound([worldId], [worldId, []]);
  const keys = (await db.getAllKeys(
    STORES.documents,
    range,
  )) as unknown as Array<[WorldId, CollectionName, DocId]>;
  for (const [, coll, id] of keys) {
    const rec = (await db.get(STORES.documents, [worldId, coll, id])) as
      { doc: BaseDocument } | undefined;
    if (rec) docs.push({ coll, id, doc: rec.doc });
  }
  return docs;
}

/** Media hashes referenced by saved FX definitions, including non-runnable presets. */
function fxMediaReferences(docs: WorldFileDocuments["docs"]): Set<AssetId> {
  const hashes = new Set<AssetId>();
  for (const row of docs) {
    if (row.coll !== "macros" || row.doc.type !== "macro") continue;
    const macro = row.doc as MacroDocument;
    const sections: unknown =
      macro.kind === "sequence"
        ? macro.sequence?.sections
        : macro.kind === "fxPreset"
          ? macro.preset?.sections
          : undefined;
    if (!Array.isArray(sections)) continue;
    for (const raw of sections) {
      if (!raw || typeof raw !== "object") continue;
      const section = raw as { kind?: unknown; assetId?: unknown };
      if (
        (section.kind === "image" || section.kind === "sound") &&
        typeof section.assetId === "string" &&
        section.assetId.length > 0
      )
        hashes.add(section.assetId as AssetId);
    }
  }
  return hashes;
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
export async function collectWorldArchive(
  options: ExportWorldOptions,
): Promise<WorldArchive> {
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
    packages.some(
      (p) => p.id === world.activeRulesPackage && p.type === "system",
    )
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
  // Playback/importing licensed media does not grant permission to distribute
  // its bytes in a downloadable world ZIP or folder. Refuse the entire export
  // before emitting even one archive entry. New FX imports carry an explicit
  // decision; a legacy FX reference with no decision is *unreviewed*, not granted.
  // Non-FX legacy art remains compatible with older worlds.
  const fxRefs = fxMediaReferences(docs);
  const blocked = new Map<
    AssetId,
    { asset: (typeof assets)[number]; reason: string }
  >();
  for (const asset of assets) {
    if (asset.exportRights === "restricted") {
      blocked.set(asset.hash, { asset, reason: "restricted" });
    } else if (fxRefs.has(asset.hash) && asset.exportRights !== "granted") {
      blocked.set(asset.hash, {
        asset,
        reason:
          asset.exportRights === undefined
            ? "unreviewed legacy FX media"
            : "not explicitly granted for FX",
      });
    }
  }
  if (blocked.size) {
    const entries = [...blocked.values()];
    const detail = entries
      .slice(0, 3)
      .map(({ asset, reason }) => `${asset.name} (${reason})`)
      .join(", ");
    throw new Error(
      `world file: ${blocked.size} media file(s) need explicit world-export rights (${detail}); ` +
        "export cancelled — review existing media permissions and separately confirm redistribution rights",
    );
  }
  for (const record of assets) {
    const bytes = record.bytes ?? (await opfs?.get(record.hash));
    if (!bytes)
      throw new Error(`world file: missing blob for asset ${record.hash}`);
    const entry: WorldFileAsset = {
      hash: record.hash,
      name: record.name,
      mime: record.mime,
      size: record.size,
      chunks: record.chunks,
    };
    if (record.visibility !== undefined) entry.visibility = record.visibility;
    if (record.exportRights !== undefined)
      entry.exportRights = record.exportRights;
    if (record.width !== undefined) entry.width = record.width;
    if (record.height !== undefined) entry.height = record.height;
    if (record.thumb !== undefined) entry.thumb = record.thumb;
    if (record.mid !== undefined) entry.mid = record.mid;
    if (record.tiles !== undefined) entry.tiles = record.tiles;
    assetEntries.push(entry);
    blobs.push({ hash: record.hash, bytes });
  }

  // §8A: checkpoints/ + reports/ ride in the world file (resume + replay)
  const checkpoints = await listCheckpointsForWorld(
    options.db,
    options.worldId,
  );
  const reportRecords = await listReportsForWorld(options.db, options.worldId);
  // §9 explored fog per user + scene (D-250)
  const fogRows = await listFogForWorld(options.db, options.worldId);

  const entries: WorldArchiveEntry[] = [];
  const add = (path: string, bytes: Uint8Array): void => {
    entries.push({ path, bytes });
  };
  add("world.json", jsonBytes(meta));
  add(
    "documents.json",
    jsonBytes({ seq: meta.seq, docs } satisfies WorldFileDocuments),
  );
  add("assets.json", jsonBytes(assetEntries));
  for (const blob of blobs) add(`assets/${blob.hash}`, blob.bytes);
  for (const cp of checkpoints) {
    const { pool, ...cpMeta } = cp;
    add(`checkpoints/${cp.sceneId}/${cp.slot}.json`, jsonBytes(cpMeta));
    add(`checkpoints/${cp.sceneId}/${cp.slot}.pool`, pool);
  }
  for (const rep of reportRecords) {
    add(
      `reports/${rep.sceneId}/${rep.turnNumber}.json`,
      jsonBytes(decodeReport(rep.bytes)),
    );
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
  const fogIndex: WorldFileFog[] = fogRows.map((row, i) => ({
    sceneId: row.sceneId,
    userId: row.userId,
    file: `fog/${i}.png`,
  }));
  add("fog.json", jsonBytes(fogIndex));
  fogRows.forEach((row, i) => add(`fog/${i}.png`, row.png));
  assertWorldZipEntriesWithinLimits(entries);
  return { meta, entries };
}

// ─── export (streaming Zip, §8 "streaming fflate") ────────────────────────────

export async function exportWorldZip(
  options: ExportWorldOptions,
): Promise<Blob> {
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
  const archive = new Blob(parts, { type: "application/zip" });
  if (archive.size > WORLD_ZIP_LIMITS.maxArchiveBytes)
    throw new Error(
      `world file: compressed archive exceeds the ${Math.ceil(WORLD_ZIP_LIMITS.maxArchiveBytes / (1024 * 1024))} MiB import limit`,
    );
  return archive;
}

// ─── import (restore) ─────────────────────────────────────────────────────────

async function unzipWorldFile(
  bytes: Uint8Array,
): Promise<Map<string, Uint8Array>> {
  try {
    return await extractZipEntriesBounded(bytes);
  } catch (error) {
    throw new Error(
      `world file: ${error instanceof Error ? error.message : String(error)}`,
      {
        cause: error,
      },
    );
  }
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
  const index = parseJson<WorldFilePackage[]>(
    requireFile(files, "packages.json"),
    "packages.json",
  );
  if (!Array.isArray(index))
    throw new Error("world file: packages.json must be an array");
  if (index.length > MAX_ARCHIVE_PACKAGES)
    throw new Error(
      `world file: packages.json exceeds the ${MAX_ARCHIVE_PACKAGES}-package limit`,
    );

  // Index package payloads once. Scanning every archive entry once per package would let a
  // bounded 100k-entry archive with many packages trigger billions of prefix checks.
  const packageFiles = new Map<
    string,
    Array<{ path: string; bytes: Uint8Array }>
  >();
  for (const [path, bytes] of files) {
    if (!path.startsWith("packages/")) continue;
    const relative = path.slice("packages/".length);
    const separator = relative.indexOf("/");
    const id = separator < 0 ? "" : relative.slice(0, separator);
    const innerPath = separator < 0 ? "" : relative.slice(separator + 1);
    if (!/^[a-z0-9][a-z0-9-]{1,63}$/.test(id) || innerPath.length === 0)
      throw new Error(
        `world file: invalid package payload path ${path.slice(0, 160)}`,
      );
    const entries = packageFiles.get(id) ?? [];
    entries.push({ path, bytes });
    packageFiles.set(id, entries);
  }

  const decoder = new TextDecoder("utf-8", { fatal: true });
  const records: PackageRecord[] = [];
  const seenIds = new Set<string>();
  for (const entry of index) {
    if (
      !isRecord(entry) ||
      typeof entry.id !== "string" ||
      !/^[a-z0-9][a-z0-9-]{1,63}$/.test(entry.id)
    ) {
      throw new Error("world file: packages.json entry has an invalid id");
    }
    if (seenIds.has(entry.id))
      throw new Error(`world file: packages.json repeats package ${entry.id}`);
    seenIds.add(entry.id);
    const payload = packageFiles.get(entry.id);
    if (!payload || payload.length === 0) {
      throw new Error(
        `world file: packages.json lists ${entry.id} but packages/${entry.id}/ is empty`,
      );
    }
    packageFiles.delete(entry.id);
    const texts: Record<string, string> = Object.create(null) as Record<
      string,
      string
    >;
    for (const { path, bytes } of payload) {
      const innerPath = path.slice(`packages/${entry.id}/`.length);
      try {
        texts[innerPath] = decoder.decode(bytes);
      } catch {
        throw new Error(
          `world file: package ${entry.id}: ${path} is not UTF-8 text`,
        );
      }
    }
    const loaded = buildPackageFromFiles(texts);
    if (!loaded.ok)
      throw new Error(`world file: package ${entry.id}: ${loaded.error}`);
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
        typeof entry.importedAt === "number" &&
        Number.isFinite(entry.importedAt)
          ? entry.importedAt
          : now(),
      manifest,
      files: loaded.value.files,
    });
  }
  if (packageFiles.size > 0) {
    const [id] = packageFiles.keys();
    throw new Error(
      `world file: package ${id} has payload files but is not listed in packages.json`,
    );
  }
  return records;
}

/** The explored-fog rows an archive carries (none for archives written before D-250). */
function readArchiveFog(
  files: Map<string, Uint8Array>,
  worldId: WorldId,
): FogRecord[] {
  const indexBytes = files.get("fog.json");
  if (!indexBytes) return [];
  const index = parseJson<unknown>(indexBytes, "fog.json");
  if (!Array.isArray(index) || index.length > MAX_ARCHIVE_DOCUMENTS)
    throw new Error("world file: fog.json must be a bounded array");
  const records: FogRecord[] = [];
  const seen = new Set<string>();
  const seenFiles = new Set<string>();
  for (const raw of index) {
    if (
      !isRecord(raw) ||
      typeof raw.sceneId !== "string" ||
      raw.sceneId.length === 0 ||
      raw.sceneId.length > 128 ||
      typeof raw.userId !== "string" ||
      raw.userId.length === 0 ||
      raw.userId.length > 128 ||
      typeof raw.file !== "string" ||
      !/^fog\/[A-Za-z0-9_-]{1,128}\.png$/.test(raw.file)
    )
      throw new Error(
        "world file: fog.json entry needs valid sceneId, userId, and fog/<id>.png",
      );
    const key = `${raw.sceneId}/${raw.userId}`;
    if (seen.has(key))
      throw new Error(
        `world file: fog.json lists ${raw.sceneId}/${raw.userId} twice`,
      );
    if (seenFiles.has(raw.file))
      throw new Error(`world file: fog.json reuses ${raw.file}`);
    seen.add(key);
    seenFiles.add(raw.file);
    const png = files.get(raw.file);
    if (!png) throw new Error(`world file: fog.json names missing ${raw.file}`);
    if (png.length === 0) continue; // an empty map is no map
    records.push({ worldId, sceneId: raw.sceneId, userId: raw.userId, png });
  }
  return records;
}

function readArchiveCheckpoints(
  files: Map<string, Uint8Array>,
  sourceWorldId: WorldId,
  targetWorldId: WorldId,
): CheckpointRecord[] {
  const prefix = "checkpoints/";
  const paths = [...files.keys()].filter((path) => path.startsWith(prefix));
  if (paths.length > MAX_ARCHIVE_DOCUMENTS * 2)
    throw new Error("world file: too many checkpoint files");
  const groups = new Map<
    string,
    { sceneId: string; slot: number; json?: Uint8Array; pool?: Uint8Array }
  >();
  for (const path of paths) {
    const match = /^checkpoints\/([^/]+)\/(0|[1-9][0-9]*)\.(json|pool)$/.exec(
      path,
    );
    if (!match)
      throw new Error(
        `world file: invalid checkpoint path ${path.slice(0, 160)}`,
      );
    const sceneId = match[1];
    const slotText = match[2];
    const extension = match[3];
    if (!sceneId || !slotText || !extension)
      throw new Error(
        `world file: invalid checkpoint path ${path.slice(0, 160)}`,
      );
    const slot = Number(slotText);
    if (sceneId.length > 128 || !Number.isSafeInteger(slot))
      throw new Error(
        `world file: invalid checkpoint path ${path.slice(0, 160)}`,
      );
    const key = `${sceneId}/${slot}`;
    const row = groups.get(key) ?? { sceneId, slot };
    const bytes = requireFile(files, path);
    if (extension === "json") row.json = bytes;
    else row.pool = bytes;
    groups.set(key, row);
  }
  const records: CheckpointRecord[] = [];
  for (const row of groups.values()) {
    if (!row.json || !row.pool)
      throw new Error(
        `world file: checkpoint ${row.sceneId}/${row.slot} needs both metadata and pool`,
      );
    const value = parseJson<unknown>(
      row.json,
      `checkpoints/${row.sceneId}/${row.slot}.json`,
    );
    if (
      !isRecord(value) ||
      value.worldId !== sourceWorldId ||
      value.sceneId !== row.sceneId ||
      value.slot !== row.slot ||
      !Number.isSafeInteger(value.turnNumber) ||
      Number(value.turnNumber) < 0 ||
      !(
        value.tick === null ||
        (Number.isSafeInteger(value.tick) && Number(value.tick) >= 0)
      ) ||
      typeof value.maxHpMax !== "number" ||
      !Number.isFinite(value.maxHpMax) ||
      value.maxHpMax < 0 ||
      !Number.isSafeInteger(value.version) ||
      Number(value.version) < 0 ||
      !isRecord(value.unitStats) ||
      !Number.isSafeInteger(value.seed) ||
      typeof value.rulesVersion !== "string" ||
      value.rulesVersion.length > 128 ||
      typeof value.hash !== "string" ||
      !HASH_RE.test(value.hash)
    )
      throw new Error(
        `world file: checkpoint ${row.sceneId}/${row.slot} has invalid metadata`,
      );
    records.push({
      ...(value as unknown as Omit<CheckpointRecord, "worldId" | "pool">),
      worldId: targetWorldId,
      sceneId: row.sceneId,
      slot: row.slot,
      pool: row.pool,
    });
  }
  return records;
}

function readArchiveReports(
  files: Map<string, Uint8Array>,
  worldId: WorldId,
): TurnReportRecord[] {
  const prefix = "reports/";
  const paths = [...files.keys()].filter((path) => path.startsWith(prefix));
  if (paths.length > MAX_ARCHIVE_DOCUMENTS)
    throw new Error("world file: too many report files");
  const records: TurnReportRecord[] = [];
  for (const path of paths) {
    const match = /^reports\/([^/]+)\/(0|[1-9][0-9]*)\.json$/.exec(path);
    if (!match)
      throw new Error(`world file: invalid report path ${path.slice(0, 160)}`);
    const sceneId = match[1];
    const turnText = match[2];
    if (!sceneId || !turnText)
      throw new Error(`world file: invalid report path ${path.slice(0, 160)}`);
    const turnNumber = Number(turnText);
    if (sceneId.length > 128 || !Number.isSafeInteger(turnNumber))
      throw new Error(`world file: invalid report path ${path.slice(0, 160)}`);
    const report = parseJson<TurnReport>(requireFile(files, path), path);
    if (
      !isRecord(report) ||
      report.turn !== turnNumber ||
      !(report.sceneId === null || report.sceneId === sceneId) ||
      !Array.isArray(report.subPhases) ||
      !report.subPhases.every((phase) => typeof phase === "string") ||
      !Array.isArray(report.events) ||
      !isRecord(report.summary) ||
      typeof report.rulesVersion !== "string"
    )
      throw new Error(
        `world file: report ${sceneId}/${turnNumber} has invalid data`,
      );
    records.push({ worldId, sceneId, turnNumber, bytes: encodeReport(report) });
  }
  return records;
}

export async function importWorldZip(
  options: ImportWorldOptions,
): Promise<ImportedWorld> {
  const now = options.now ?? Date.now;
  const compressedSize =
    options.file instanceof Uint8Array
      ? options.file.byteLength
      : options.file.size;
  if (compressedSize > WORLD_ZIP_LIMITS.maxArchiveBytes)
    throw new Error(
      `world file: archive exceeds the ${Math.ceil(WORLD_ZIP_LIMITS.maxArchiveBytes / (1024 * 1024))} MiB compressed-size limit`,
    );
  const buffer =
    options.file instanceof Uint8Array
      ? options.file
      : new Uint8Array(await options.file.arrayBuffer());
  const files = await unzipWorldFile(buffer);

  const rawMeta = parseJson<unknown>(
    requireFile(files, "world.json"),
    "world.json",
  );
  if (!isRecord(rawMeta) || !Number.isSafeInteger(rawMeta.format))
    throw new Error("world file: world.json has an invalid format");
  if (!WORLD_FILE_FORMATS_READ.includes(rawMeta.format as number))
    throw new Error(`world file: unsupported format ${String(rawMeta.format)}`);
  const meta = validateWorldMeta(rawMeta);
  if (typeof meta.worldId !== "string" || meta.worldId.length === 0) {
    throw new Error("world file: world.json has no worldId");
  }
  if (
    typeof meta.seq !== "number" ||
    !Number.isInteger(meta.seq) ||
    meta.seq < 0
  ) {
    throw new Error("world file: world.json has an invalid seq");
  }
  const documents = validateWorldDocuments(
    parseJson<unknown>(requireFile(files, "documents.json"), "documents.json"),
    meta.seq,
  );
  const assetEntries = readArchiveAssets(
    files,
    parseJson<unknown>(requireFile(files, "assets.json"), "assets.json"),
  );
  const mode = options.mode ?? "replace";
  if (
    mode === "replace" &&
    options.worldId !== undefined &&
    options.worldId !== meta.worldId
  ) {
    throw new Error(
      "world file: a replace import restores the archive's own worldId",
    );
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
  const packageRecords = carriesPackages
    ? readArchivePackages(files, worldId, now)
    : [];
  let archiveActive: string | null = null;
  if (carriesPackages) {
    const active = meta.rules?.active ?? null;
    if (active !== null) {
      if (typeof active !== "string")
        throw new Error("world file: rules.active must be an id");
      const rec = packageRecords.find((p) => p.id === active);
      if (!rec) {
        throw new Error(
          `world file: rules.active names ${active}, which is not in the archive`,
        );
      }
      if (rec.type !== "system" || !rec.manifest.rules) {
        throw new Error(
          `world file: rules.active ${active} is a content pack, not a ruleset`,
        );
      }
    }
    archiveActive = active;
  }

  // What this browser already knows about the world (nothing, for a copy — it is a new id).
  // Trust is local consent and always carried; the activation is carried only when the
  // archive has no say (format 1).
  const existing =
    mode === "copy" ? undefined : await getWorld(options.db, worldId);
  const activeRulesPackage = carriesPackages
    ? archiveActive
    : (existing?.activeRulesPackage ?? null);
  const trustedPackages = existing?.trustedPackages ?? [];
  const checkpointRecords = readArchiveCheckpoints(
    files,
    meta.worldId,
    worldId,
  );
  const reportRecords = readArchiveReports(files, worldId);
  const fogRecords = readArchiveFog(files, worldId);

  // Blob writes first (content-addressed → idempotent): an OPFS failure leaves
  // orphan files but never a half-imported database.
  const opfs = await OpfsAssetStore.open(worldId, options.root ?? null);
  for (const entry of assetEntries) {
    const bytes = files.get(`assets/${entry.hash}`);
    if (!bytes)
      throw new Error(`world file: archive lacks blob for asset ${entry.hash}`);
    if (opfs) await opfs.put(entry.hash, bytes);
  }

  type StoreName = (typeof STORES)[keyof typeof STORES];
  const replaced: StoreName[] = [
    STORES.documents,
    STORES.oplog,
    STORES.fog,
    STORES.assets,
    STORES.checkpoints,
    STORES.turnReports,
    STORES.simdeltas,
  ];
  if (carriesPackages) replaced.push(STORES.packages);
  const tx = options.db.transaction([STORES.worlds, ...replaced], "readwrite");
  // Replace any existing world data (restore semantics) in one transaction.
  for (const store of replaced) {
    void tx
      .objectStore(store)
      .delete(IDBKeyRange.bound([worldId], [worldId, []]));
  }
  const assetStore = tx.objectStore(STORES.assets);
  for (const entry of assetEntries) {
    // A claim inside somebody else's archive does not transfer their media
    // license to the receiving GM. Even a formerly exportable FX file must be
    // reapproved for both serving to players and repackaging in a new ZIP.
    const rights =
      entry.exportRights === undefined
        ? {}
        : {
            visibility: "gm" as const,
            exportRights: "restricted" as const,
          };
    const record: AssetRecord = opfs
      ? { ...entry, worldId, ...rights }
      : {
          ...entry,
          worldId,
          bytes: files.get(`assets/${entry.hash}`) as Uint8Array,
          ...rights,
        };
    void assetStore.put(record);
  }
  const docStore = tx.objectStore(STORES.documents);
  for (const row of documents.docs) {
    let doc = row.doc;
    if (
      row.coll === "macros" &&
      doc.type === "macro" &&
      (doc as MacroDocument).kind === "script"
    ) {
      const macro = doc as MacroDocument;
      // An archive can be supplied by anyone, including a former GM. A hash matching
      // the bundled source/policy proves integrity, NOT this host's review/consent.
      // Invalidate the approval and hide the player entry until this GM republishes.
      doc = {
        ...macro,
        ownership: { ...macro.ownership, default: 0 },
        script: macro.script
          ? {
              ...macro.script,
              approvedHash: "0".repeat(64),
              playerCallable: false,
            }
          : undefined,
        flags: {
          ...macro.flags,
          core: {
            ...(typeof macro.flags.core === "object" &&
            macro.flags.core &&
            !Array.isArray(macro.flags.core)
              ? macro.flags.core
              : {}),
            playerCallable: false,
          },
        },
        scriptState: { recent: [] },
      } as MacroDocument;
    }
    void docStore.put({ worldId, coll: row.coll, id: row.id, doc });
  }
  if (carriesPackages) {
    const pkgStore = tx.objectStore(STORES.packages);
    for (const rec of packageRecords) void pkgStore.put(rec);
  }
  const fogStore = tx.objectStore(STORES.fog);
  for (const rec of fogRecords) void fogStore.put(rec);
  const checkpointStore = tx.objectStore(STORES.checkpoints);
  for (const rec of checkpointRecords) void checkpointStore.put(rec);
  const reportStore = tx.objectStore(STORES.turnReports);
  for (const rec of reportRecords) void reportStore.put(rec);
  const world: WorldsRecord = {
    worldId,
    name,
    // `system` names the ruleset the world boots with (D-248); older archives wrote the
    // built-in id regardless, so it is derived from the pin rather than copied.
    system:
      activeRulesPackage ?? (carriesPackages ? BUILTIN_SYSTEM : meta.system),
    version: meta.version,
    lastOpened: now(),
    flushedSeq: meta.seq,
    oplogBase: meta.seq,
  };
  if (activeRulesPackage !== null)
    world.activeRulesPackage = activeRulesPackage;
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
    fogRecords: fogRecords.length,
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
    const handle = await parent.getDirectoryHandle(path.slice(cut + 1), {
      create: true,
    });
    dirs.set(path, handle);
    return handle;
  };
  let filesCount = 0;
  for (const { path, bytes } of entries) {
    const cut = path.lastIndexOf("/");
    const parent = await dirFor(cut === -1 ? "" : path.slice(0, cut));
    const handle = await parent.getFileHandle(path.slice(cut + 1), {
      create: true,
    });
    const writable = await handle.createWritable();
    await writable.write(bytes);
    await writable.close();
    filesCount++;
  }
  return { filesCount };
}
