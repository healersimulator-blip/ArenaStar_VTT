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
  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipSync(bytes);
  } catch {
    throw new ScenePackError("Scene pack is not a readable archive.");
  }
  const manifestBytes = entries["scene-pack.json"];
  if (!manifestBytes) throw new ScenePackError("Scene pack has no manifest.");
  let raw: unknown;
  try {
    raw = JSON.parse(strFromU8(manifestBytes));
  } catch {
    throw new ScenePackError("Scene pack manifest is not valid JSON.");
  }
  const manifest = parseScenePackManifest(raw);
  const names = Object.keys(entries);
  if (names.length > MAX_PACK_ASSETS * 2 + 1)
    throw new ScenePackError("Scene pack has too many entries.");
  const accepted: ScenePackReadResult["accepted"] = [];
  let rejected = 0;
  let total = 0;
  for (const [path, data] of Object.entries(entries)) {
    if (!path.startsWith("assets/")) continue;
    const hash = path.slice("assets/".length);
    const entry = manifest.assets[hash];
    if (!entry) {
      rejected++;
      continue;
    }
    total += data.byteLength;
    if (total > MAX_PACK_BYTES)
      throw new ScenePackError("Scene pack expands beyond the byte limit.");
    // The path is a content hash: verify it instead of trusting the archive or manifest.
    if (bytesToHex(sha256(data)) !== hash) {
      rejected++;
      continue;
    }
    accepted.push({ hash, bytes: data, mime: entry.mime });
  }
  return { manifest, accepted, rejected };
}
