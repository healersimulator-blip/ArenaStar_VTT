/**
 * Player-facing scene preload ("scene pack") — media a GM can hand out BEFORE a
 * session so a joining browser does not have to stream the whole map set over the
 * live peer connection.
 *
 * A pack is deliberately NOT a world file:
 *   - it carries no users, ownership, journals, GM notes, flags or orders;
 *   - it holds only scene-background / token / tile / audio media that the ordinary
 *     player projection already exposes (see `projectWorldAssetReferences`), and only
 *     when the asset's own publication policy is not GM-private;
 *   - media with `exportRights: "restricted"` is left out — the same consent that
 *     gates redistribution in a world archive;
 *   - a large map's tile *grid* is replaced by the single full-resolution source
 *     image, because packing several thousand individual tile assets is not useful
 *     before the first frame.
 *
 * The archive is inert. It cannot grant control, visibility, or a seat, and the
 * authority for a hosted battle still comes from the live service. Installing a pack
 * only seeds the browser's content-addressed *cache*, so the live manifest still has
 * to authorize every byte before it can be shown.
 */
import { projectWorldAssetReferences } from "./assetAccess";
import type { AssetManifest, WorldCollections } from "./documents";
import type { AssetId } from "./ids";

export const SCENE_PACK_FORMAT = "arenastar-scene-pack-v1";
export const SCENE_PACK_EXTENSION = ".arenastar-scene-pack";
/** Entries per archive; a pack is a cache warmer, not a full world backup. */
export const MAX_PACK_ASSETS = 2048;
/**
 * Total uncompressed budget for a pack. Kept at 128 MiB so a browser importing an
 * untrusted pack never needs to hold hundreds of MiB of inflated bytes at once;
 * larger media sets degrade gracefully at plan time (`overCap`) rather than
 * failing at read time. `readScenePack` preflights this bound before `unzipSync`.
 */
export const MAX_PACK_BYTES = 128 * 1024 * 1024;

export type ScenePackEntry = {
  /** Original bytes were replaced by the full-resolution source (large-map tiles). */
  served?: "source";
};

export type ScenePackManifest = {
  format: typeof SCENE_PACK_FORMAT;
  world: string | null;
  name: string;
  packId: string;
  createdAt: number;
  scenes: Array<{ id: string; name: string }>;
  /** The subset of the host manifest the pack vouches for; drives cache restore only. */
  assets: AssetManifest;
  entries: Record<AssetId, ScenePackEntry>;
  omitted: {
    gmPrivate: number;
    restrictedExport: number;
    missing: number;
    overCap: number;
  };
};

export class ScenePackError extends Error {}

/** Deterministic, collision-resistant id derived from what the pack advertises. */
export function scenePackId(
  world: string | null,
  sceneIds: readonly string[],
  assets: readonly AssetId[],
): string {
  const text = JSON.stringify([
    SCENE_PACK_FORMAT,
    world,
    [...sceneIds].sort(),
    [...assets].sort(),
  ]);
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 16777619) >>> 0;
    h2 = Math.imul(h2 + c, 2654435761) >>> 0;
  }
  return `sp1-${h1.toString(16).padStart(8, "0")}${h2.toString(16).padStart(8, "0")}-${assets.length}`;
}

/** The media a player projection of the selected scenes actually references. */
export function sceneMediaIds(
  collections: Partial<WorldCollections>,
  manifest: AssetManifest,
  scenes: readonly string[],
): { ids: Set<AssetId>; omitted: ScenePackManifest["omitted"] } {
  const selected = new Set(scenes);
  const omitted = { gmPrivate: 0, restrictedExport: 0, missing: 0, overCap: 0 };
  if (!selected.size) return { ids: new Set(), omitted };
  const projected: Partial<WorldCollections> = {
    ...collections,
    scenes: (collections.scenes ?? []).filter((scene) =>
      selected.has(scene._id),
    ),
    messages: [],
    journals: [],
    macros: [],
  };
  const referenced = projectWorldAssetReferences(projected, manifest);
  const ids = new Set<AssetId>();
  for (const hash of referenced) {
    const entry = manifest[hash];
    if (!entry) {
      omitted.missing++;
      continue;
    }
    if (entry.visibility === "gm") {
      omitted.gmPrivate++;
      continue;
    }
    // Legacy export rights are unknown; only a scene image with no known restriction is
    // redistributed, and an explicit "restricted" is always honoured.
    if (entry.exportRights === "restricted") {
      omitted.restrictedExport++;
      continue;
    }
    ids.add(hash);
  }
  return { ids, omitted };
}

/**
 * Build the manifest + entry list for a pack. Byte reading is the caller's job so this
 * half is pure and testable (and runs the same way in the GM tab and in tests).
 */
export function planScenePack(options: {
  world?: string | null;
  name: string;
  scenes: readonly { id: string; name: string }[];
  collections: Partial<WorldCollections>;
  manifest: AssetManifest;
  createdAt: number;
  maxAssets?: number;
  maxBytes?: number;
}): { manifest: ScenePackManifest; hashes: AssetId[] } {
  const sceneIds = options.scenes.map((scene) => scene.id);
  const { ids, omitted } = sceneMediaIds(
    options.collections,
    options.manifest,
    sceneIds,
  );
  const cap = Math.min(options.maxAssets ?? MAX_PACK_ASSETS, MAX_PACK_ASSETS);
  const budget = Math.min(options.maxBytes ?? MAX_PACK_BYTES, MAX_PACK_BYTES);
  const ordered = [...ids].sort();
  const assets: AssetManifest = {};
  const entries: Record<AssetId, ScenePackEntry> = {};
  const hashes: AssetId[] = [];
  let bytes = 0;
  for (const hash of ordered) {
    if (hashes.length >= cap) {
      omitted.overCap++;
      continue;
    }
    const entry = options.manifest[hash];
    if (!entry) continue;
    // Store the metadata the receiving cache needs; never the GM's import provenance.
    const projected = { ...entry };
    delete projected.source;
    delete projected.logicalFiles;
    // A tiled source is restored as its single full image; drop derived tile data so the
    // player cache does not claim bytes it was not given.
    const size = entry.size;
    if (bytes + size > budget) {
      omitted.overCap++;
      continue;
    }
    bytes += size;
    if (entry.tiles) delete projected.tiles;
    assets[hash] = projected;
    entries[hash] = entry.tiles ? { served: "source" } : {};
    hashes.push(hash);
  }
  const manifest: ScenePackManifest = {
    format: SCENE_PACK_FORMAT,
    world: options.world ?? null,
    name: options.name.slice(0, 120),
    packId: scenePackId(options.world ?? null, sceneIds, hashes),
    createdAt: options.createdAt,
    scenes: options.scenes
      .slice(0, 512)
      .map((scene) => ({ id: scene.id, name: scene.name.slice(0, 120) })),
    assets,
    entries,
    omitted,
  };
  return { manifest, hashes };
}

/** Defensive reader for an untrusted pack manifest (an invite peer or a shared file). */
export function parseScenePackManifest(raw: unknown): ScenePackManifest {
  if (!raw || typeof raw !== "object" || Array.isArray(raw))
    throw new ScenePackError("Scene pack has no manifest.");
  const m = raw as Record<string, unknown>;
  if (m.format !== SCENE_PACK_FORMAT)
    throw new ScenePackError("Not an Arena Star scene pack.");
  if (typeof m.name !== "string" || !m.name.trim())
    throw new ScenePackError("Scene pack has no name.");
  if (typeof m.packId !== "string" || !/^sp1-[0-9a-f]{16}-\d+$/.test(m.packId))
    throw new ScenePackError("Scene pack ID is malformed.");
  if (!Number.isSafeInteger(m.createdAt) || (m.createdAt as number) <= 0)
    throw new ScenePackError("Scene pack has no creation time.");
  if (typeof m.world !== "string" && m.world !== null)
    throw new ScenePackError("Scene pack world is malformed.");
  if (!Array.isArray(m.scenes) || m.scenes.length > 512)
    throw new ScenePackError("Scene pack scene list is malformed.");
  const scenes = m.scenes.map((row) => {
    if (!row || typeof row !== "object")
      throw new ScenePackError("Scene pack scene is malformed.");
    const { id, name } = row as Record<string, unknown>;
    if (typeof id !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(id))
      throw new ScenePackError("Scene pack scene ID is malformed.");
    if (typeof name !== "string" || !name.trim())
      throw new ScenePackError("Scene pack scene name is malformed.");
    return { id, name: name.slice(0, 120) };
  });
  if (!m.assets || typeof m.assets !== "object" || Array.isArray(m.assets))
    throw new ScenePackError("Scene pack asset table is malformed.");
  const assets: AssetManifest = {};
  let files = 0;
  for (const [hash, entry] of Object.entries(
    m.assets as Record<string, unknown>,
  )) {
    if (!/^[0-9a-f]{64}$/.test(hash))
      throw new ScenePackError("Scene pack asset hash is malformed.");
    if (files++ >= MAX_PACK_ASSETS)
      throw new ScenePackError("Scene pack lists too many assets.");
    if (!entry || typeof entry !== "object" || Array.isArray(entry))
      throw new ScenePackError("Scene pack asset entry is malformed.");
    const e = entry as Record<string, unknown>;
    if (typeof e.name !== "string" || typeof e.mime !== "string")
      throw new ScenePackError("Scene pack asset metadata is incomplete.");
    if (
      !Number.isSafeInteger(e.size) ||
      (e.size as number) < 0 ||
      (e.size as number) > MAX_PACK_BYTES
    )
      throw new ScenePackError("Scene pack asset size is malformed.");
    // Bytes from a pack are only ever a *cache* seed; strip anything the reader would treat as
    // a grant or as GM bookkeeping.
    const visible: AssetManifest[string] = {
      name: e.name.slice(0, 200),
      mime: e.mime,
      size: e.size as number,
      chunks: 1,
    };
    if (e.visibility === "referenced" || e.visibility === "world")
      visible.visibility = e.visibility;
    if (typeof e.width === "number" && e.width > 0 && e.width <= 100_000)
      visible.width = e.width;
    if (typeof e.height === "number" && e.height > 0 && e.height <= 100_000)
      visible.height = e.height;
    if (
      !visible.mime.startsWith("image/") &&
      !visible.mime.startsWith("audio/") &&
      !visible.mime.startsWith("video/")
    )
      throw new ScenePackError(
        "Scene pack may only carry image, audio or video media.",
      );
    assets[hash] = visible;
  }
  const omittedRaw =
    m.omitted && typeof m.omitted === "object"
      ? (m.omitted as Record<string, unknown>)
      : {};
  const count = (v: unknown) =>
    Number.isSafeInteger(v) && (v as number) >= 0 ? (v as number) : 0;
  const entries: Record<AssetId, ScenePackEntry> = {};
  const rawEntries =
    m.entries && typeof m.entries === "object" && !Array.isArray(m.entries)
      ? (m.entries as Record<string, unknown>)
      : {};
  for (const [hash, entry] of Object.entries(rawEntries)) {
    if (!assets[hash]) continue;
    const served =
      entry &&
      typeof entry === "object" &&
      (entry as Record<string, unknown>).served === "source"
        ? { served: "source" as const }
        : {};
    entries[hash] = served;
  }
  return {
    format: SCENE_PACK_FORMAT,
    world: m.world === null ? null : (m.world as string),
    name: m.name.slice(0, 120),
    packId: m.packId,
    createdAt: m.createdAt as number,
    scenes,
    assets,
    entries,
    omitted: {
      gmPrivate: count(omittedRaw.gmPrivate),
      restrictedExport: count(omittedRaw.restrictedExport),
      missing: count(omittedRaw.missing),
      overCap: count(omittedRaw.overCap),
    },
  };
}

/** Content-addressed entry path; the receiver verifies the bytes against it. */
export function packAssetPath(hash: AssetId): string {
  return `assets/${hash}`;
}
