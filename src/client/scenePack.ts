/**
 * Scene-pack archive I/O, shared by the GM tab (write) and a joining browser (read).
 *
 * The archive is a zip with exactly two kinds of entries:
 *   scene-pack.json   the manifest from `core/scenePreload.ts`
 *   assets/<sha256>   original media bytes, named by their own content hash
 *
 * Reading never trusts the manifest for access. Every entry is verified against its
 * path hash, then written into the ordinary content-addressed client cache. A pack
 * cannot widen what the live host publishes: the client still asks the host for the
 * asset manifest and only uses cached bytes the live session names.
 */
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import {
  MAX_PACK_ASSETS,
  MAX_PACK_BYTES,
  parseScenePackManifest,
  ScenePackError,
  type ScenePackManifest,
} from "../core/scenePreload";

export type ScenePackReadResult = {
  manifest: ScenePackManifest;
  accepted: Array<{ hash: string; bytes: Uint8Array; mime: string }>;
  rejected: number;
};

type ZipInspection = {
  entries: number;
  inflated: number;
  /** Declared uncompressed byte count per archive entry, keyed by central-directory name. */
  sizes: Map<string, number>;
};

/**
 * Read classic-ZIP central-directory and local-header sizes before fflate allocates any
 * inflated bytes. Both headers must agree: fflate trusts their declared output size, so a
 * forged small size could otherwise silently truncate a hostile archive.
 */
function inspectZip(bytes: Uint8Array): ZipInspection {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const endSignature = 0x06054b50;
  const centralSignature = 0x02014b50;
  const maxComment = 0xffff;
  const minimum = Math.max(0, bytes.byteLength - 22 - maxComment);
  let end = -1;
  for (let at = bytes.byteLength - 22; at >= minimum; at--) {
    if (view.getUint32(at, true) !== endSignature) continue;
    const comment = view.getUint16(at + 20, true);
    if (at + 22 + comment === bytes.byteLength) {
      end = at;
      break;
    }
  }
  if (end < 0)
    throw new ScenePackError("Scene pack is not a readable archive.");
  const entries = view.getUint16(end + 10, true);
  const centralSize = view.getUint32(end + 12, true);
  const centralOffset = view.getUint32(end + 16, true);
  if (
    entries === 0xffff ||
    centralSize === 0xffffffff ||
    centralOffset === 0xffffffff
  )
    throw new ScenePackError("ZIP64 scene packs are not supported.");
  if (entries > MAX_PACK_ASSETS * 2 + 1)
    throw new ScenePackError("Scene pack has too many entries.");
  if (centralOffset + centralSize > bytes.byteLength)
    throw new ScenePackError("Scene pack has a malformed archive directory.");
  const sizes = new Map<string, number>();
  let at = centralOffset;
  let inflated = 0;
  for (let index = 0; index < entries; index++) {
    if (
      at + 46 > bytes.byteLength ||
      view.getUint32(at, true) !== centralSignature
    )
      throw new ScenePackError("Scene pack has a malformed archive directory.");
    const flags = view.getUint16(at + 8, true);
    const method = view.getUint16(at + 10, true);
    const compressed = view.getUint32(at + 20, true);
    const uncompressed = view.getUint32(at + 24, true);
    const nameLength = view.getUint16(at + 28, true);
    const extraLength = view.getUint16(at + 30, true);
    const commentLength = view.getUint16(at + 32, true);
    const localOffset = view.getUint32(at + 42, true);
    const nameStart = at + 46;
    if (
      compressed === 0xffffffff ||
      uncompressed === 0xffffffff ||
      localOffset === 0xffffffff
    )
      throw new ScenePackError("ZIP64 scene packs are not supported.");
    // Data descriptors put the real sizes after compressed bytes; this writer emits no
    // descriptors, and refusing them keeps every declared size pre-flightable.
    if (
      (flags & 0x08) !== 0 ||
      (method !== 0 && method !== 8) ||
      (method === 0 && compressed !== uncompressed)
    )
      throw new ScenePackError("Scene pack uses an unsupported archive entry.");
    if (nameStart + nameLength + extraLength + commentLength > bytes.byteLength)
      throw new ScenePackError("Scene pack has a malformed archive directory.");
    const name = strFromU8(bytes.subarray(nameStart, nameStart + nameLength));
    if (sizes.has(name))
      throw new ScenePackError("Scene pack has duplicate archive entries.");
    if (uncompressed > MAX_PACK_BYTES)
      throw new ScenePackError("Scene pack expands beyond the byte limit.");
    inflated += uncompressed;
    if (inflated > MAX_PACK_BYTES)
      throw new ScenePackError("Scene pack expands beyond the byte limit.");

    // Verify the matching local header. A central directory that claims a smaller
    // output than the local header must not reach fflate's eager decoder.
    if (
      localOffset + 30 > bytes.byteLength ||
      view.getUint32(localOffset, true) !== 0x04034b50
    )
      throw new ScenePackError("Scene pack has a malformed local header.");
    const localFlags = view.getUint16(localOffset + 6, true);
    const localMethod = view.getUint16(localOffset + 8, true);
    const localCompressed = view.getUint32(localOffset + 18, true);
    const localUncompressed = view.getUint32(localOffset + 22, true);
    const localNameLength = view.getUint16(localOffset + 26, true);
    const localExtraLength = view.getUint16(localOffset + 28, true);
    const localNameStart = localOffset + 30;
    if (localNameStart + localNameLength + localExtraLength > bytes.byteLength)
      throw new ScenePackError("Scene pack has a malformed local header.");
    const localName = strFromU8(
      bytes.subarray(localNameStart, localNameStart + localNameLength),
    );
    if (
      localName !== name ||
      localFlags !== flags ||
      localMethod !== method ||
      localCompressed !== compressed ||
      localUncompressed !== uncompressed ||
      localOffset + 30 + localNameLength + localExtraLength + compressed >
        bytes.byteLength
    )
      throw new ScenePackError(
        "Scene pack archive directory and local header disagree.",
      );
    sizes.set(name, uncompressed);
    at += 46 + nameLength + extraLength + commentLength;
    if (at > bytes.byteLength)
      throw new ScenePackError("Scene pack has a malformed archive directory.");
  }
  return { entries, inflated, sizes };
}

export function writeScenePack(
  manifest: ScenePackManifest,
  blobs: ReadonlyMap<string, Uint8Array>,
): Uint8Array {
  const files: Record<string, Uint8Array> = {
    "scene-pack.json": strToU8(JSON.stringify(manifest)),
  };
  for (const [hash, bytes] of blobs) {
    if (!manifest.assets[hash]) continue;
    files[`assets/${hash}`] = bytes;
  }
  return zipSync(files, { level: 0 });
}

export async function readScenePack(
  bytes: Uint8Array,
): Promise<ScenePackReadResult> {
  if (bytes.byteLength > MAX_PACK_BYTES)
    throw new ScenePackError("Scene pack is too large.");
  // Pre-flight both directory and local headers: an unlisted zip-bomb entry must be
  // rejected before unzipSync eagerly inflates it, not merely skipped after allocation.
  const archive = inspectZip(bytes);
  if (archive.entries > MAX_PACK_ASSETS * 2 + 1)
    throw new ScenePackError("Scene pack has too many entries.");
  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipSync(bytes);
  } catch {
    throw new ScenePackError("Scene pack is not a readable archive.");
  }
  // Defence in depth: the decoder must return exactly the declared entries and sizes.
  // This also catches a size field that lies low and truncates a hostile DEFLATE stream.
  const names = Object.keys(entries);
  if (
    names.length !== archive.sizes.size ||
    names.some((name) => !archive.sizes.has(name))
  )
    throw new ScenePackError("Scene pack archive entries do not match.");
  let inflated = 0;
  for (const [name, expected] of archive.sizes) {
    if (!Object.hasOwn(entries, name))
      throw new ScenePackError("Scene pack archive entries do not match.");
    const data = entries[name];
    if (!data || data.byteLength !== expected)
      throw new ScenePackError("Scene pack entry size does not match.");
    if (data.byteLength > MAX_PACK_BYTES)
      throw new ScenePackError("Scene pack expands beyond the byte limit.");
    inflated += data.byteLength;
    if (inflated > MAX_PACK_BYTES)
      throw new ScenePackError("Scene pack expands beyond the byte limit.");
  }
  if (inflated !== archive.inflated)
    throw new ScenePackError("Scene pack expanded size does not match.");
  const manifestBytes = entries["scene-pack.json"];
  if (!manifestBytes) throw new ScenePackError("Scene pack has no manifest.");
  let raw: unknown;
  try {
    raw = JSON.parse(strFromU8(manifestBytes));
  } catch {
    throw new ScenePackError("Scene pack manifest is not valid JSON.");
  }
  const manifest = parseScenePackManifest(raw);
  const accepted: ScenePackReadResult["accepted"] = [];
  let rejected = 0;
  for (const [path, data] of Object.entries(entries)) {
    if (!path.startsWith("assets/")) continue;
    const hash = path.slice("assets/".length);
    const entry = manifest.assets[hash];
    if (!entry || data.byteLength !== entry.size) {
      rejected++;
      continue;
    }
    // The path is a content hash: verify it instead of trusting the archive or manifest.
    if (bytesToHex(sha256(data)) !== hash) {
      rejected++;
      continue;
    }
    accepted.push({ hash, bytes: data, mime: entry.mime });
  }
  return { manifest, accepted, rejected };
}
