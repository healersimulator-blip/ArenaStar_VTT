/**
 * §12 package loader — turns a package zip (or folder file list) into a
 * validated record: manifest.json parsed + contract-checked, every referenced
 * file present, text-only contents. Pure fflate + TextDecoder; runs in Node
 * tests and in the browser host alike. Script entries are NOT executed here —
 * activation/import into the SimWorker goes through D-086's blob-URL loader.
 */
import type { Json } from "../core/documents";
import { extractZipEntriesBounded } from "../host/worldZip";
import type { PackageManifest } from "../core/packageManifest";
import { validatePackageManifest } from "../core/packageManifest";
import type { Result } from "../core/result";
import { aisOwnSource, aisRuntimeConfiguration, aisRuntimeResources } from "./aisRuntimePackage";
import { err, okVal } from "../core/result";
import {
  resolveFoundryManifestPath,
  synthesizeFoundryModulePackage,
  type FoundryModuleManifest,
} from "../core/foundryModuleManifest";

/** Validated package contents (world-scoped fields added by the store). */
export interface LoadedPackage {
  manifest: PackageManifest;
  /** UTF-8 decoded file texts keyed by package-relative path. */
  files: Record<string, string>;
  /** D-482: set when the archive was a Foundry `module.json` distribution (manifest synthesized). */
  foundry?: FoundryModuleManifest & { binaryFiles: number };
}

const decodeText = (bytes: Uint8Array): Result<string> => {
  try {
    return okVal(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    return err("package: binary files are not supported yet (text packages only)");
  }
};

/** manifest.json location: zip root, or a single nested root directory. */
function resolveManifestPath(paths: string[]): Result<string> {
  if (paths.includes("manifest.json")) return okVal("manifest.json");
  const roots = new Set(
    paths.filter((p) => p.endsWith("/manifest.json")).map((p) => p.split("/")[0] ?? ""),
  );
  if (roots.size === 1) {
    const root = [...roots][0] ?? "";
    if (root !== "") return okVal(`${root}/manifest.json`);
  }
  return err("package: manifest.json not found at the package root");
}

/** D-482: strip the single nested root (if any) off every path. */
function outerRootOf(paths: readonly string[]): string {
  if (!paths.length) return "";
  const firstSegments = paths.map((p) => (p.includes("/") ? p.split("/")[0] ?? "" : ""));
  const first = firstSegments[0] ?? "";
  if (!first) return "";
  if (firstSegments.every((seg) => seg === first)) return `${first}/`;
  return "";
}
function rootedFiles(rawFiles: Record<string, string>, markerPath: string): Record<string, string> {
  const allPaths = Object.keys(rawFiles);
  // If all files share a single top-level folder (GitHub zip), strip it; otherwise keep as-is.
  // This handles both `foundryvtt-.../public/system.json` and `public/system.json` + `pf1.js` at root.
  const outer = outerRootOf(allPaths);
  if (outer && markerPath.startsWith(outer)) {
    const files: Record<string, string> = {};
    for (const [path, text] of Object.entries(rawFiles))
      if (path.startsWith(outer)) files[path.slice(outer.length)] = text;
    return files;
  }
  // No outer root, or marker is already at package root (e.g. public/system.json) — keep all files
  return { ...rawFiles };
}

/**
 * Shared validation over a path → text map (folder import path). An archive without
 * `manifest.json` but with a Foundry `module.json` is synthesized into an ArenaStar module
 * bound to the Foundry adapter (D-482); `binaryPaths` names the entries the zip reader skipped.
 */
export function buildPackageFromFiles(rawFiles: Record<string, string>, binaryPaths: readonly string[] = []): Result<LoadedPackage> {
  const paths = Object.keys(rawFiles);
  const manifestPath = resolveManifestPath(paths);
  if (!manifestPath.ok) {
    const foundryPath = resolveFoundryManifestPath([...paths, ...binaryPaths]);
    if (foundryPath === null) return manifestPath;
    const outer = outerRootOf([...paths, ...binaryPaths]);
    const binaries = outer ? binaryPaths.filter((path) => path.startsWith(outer)).map((path) => path.slice(outer.length)) : [...binaryPaths];
    const synthesized = synthesizeFoundryModulePackage(rootedFiles(rawFiles, foundryPath), binaries);
    if (!synthesized.ok) return synthesized;
    const built = buildPackageFromFiles(synthesized.value.files);
    if (!built.ok) return built;
    return okVal({ ...built.value, foundry: { ...synthesized.value.foundry, binaryFiles: binaries.length } });
  }
  const manifestText = rawFiles[manifestPath.value];
  if (manifestText === undefined) return err("package: manifest.json is empty");

  let parsed: unknown;
  try {
    parsed = JSON.parse(manifestText);
  } catch (e) {
    return err(
      `package: manifest.json is not valid JSON — ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  const manifest = validatePackageManifest(parsed);
  if (!manifest.ok) return manifest;

  const strip = (p: string): string =>
    manifestPath.value === "manifest.json"
      ? p
      : p.slice((manifestPath.value.split("/")[0]?.length ?? 0) + 1);
  const files: Record<string, string> = {};
  for (const [path, text] of Object.entries(rawFiles)) {
    files[strip(path)] = text;
  }

  if (manifest.value.type === "system" && manifest.value.rules) {
    const entry = files[manifest.value.rules.entry];
    if (entry === undefined) {
      return err(
        `package ${manifest.value.id}: rules entry ${manifest.value.rules.entry} is missing`,
      );
    }
    if (entry.trim().length === 0) {
      return err(`package ${manifest.value.id}: rules entry is empty`);
    }
  }
  if (manifest.value.ui) {
    const uiEntry = files[manifest.value.ui.entry];
    if (uiEntry === undefined) {
      return err(`package ${manifest.value.id}: ui entry ${manifest.value.ui.entry} is missing`);
    }
    if (uiEntry.trim().length === 0) {
      return err(`package ${manifest.value.id}: ui entry is empty`);
    }
  }
  if (manifest.value.module) {
    const modEntry = files[manifest.value.module.entry];
    if (modEntry === undefined) {
      return err(
        `package ${manifest.value.id}: module entry ${manifest.value.module.entry} is missing`,
      );
    }
  }
  if (manifest.value.interconnect) {
    const entry = files[manifest.value.interconnect.entry];
    if (entry === undefined) {
      return err(
        `package ${manifest.value.id}: AIS entry ${manifest.value.interconnect.entry} is missing`,
      );
    }
    if (entry.trim().length === 0) {
      return err(`package ${manifest.value.id}: AIS entry is empty`);
    }
  }
  if (manifest.value.interconnect) {
    try {
      const pkg = { id: manifest.value.id, version: manifest.value.version, manifest: manifest.value, files };
      aisOwnSource(pkg);
      aisRuntimeConfiguration(pkg);
      aisRuntimeResources(pkg);
    } catch (error) { return err(error instanceof Error ? error.message : String(error)); }
  }
  for (const pack of manifest.value.packs ?? []) {
    const text = files[pack.file];
    if (text === undefined)
      return err(`package ${manifest.value.id}: pack file ${pack.file} is missing`);
    try {
      JSON.parse(text) as Json;
    } catch (e) {
      return err(
        `package ${manifest.value.id}: pack file ${pack.file} is not valid JSON — ${
          e instanceof Error ? e.message : String(e)
        }`,
      );
    }
  }
  return okVal({ manifest: manifest.value, files });
}

/** Bounded ZIP extraction also rejects traversal paths, duplicates, and unsupported compression. */
async function unzipFiles(bytes: Uint8Array): Promise<Result<{ files: Record<string, string>; binaries: Map<string, Uint8Array> }>> {
  let entries: Map<string, Uint8Array>;
  try {
    entries = await extractZipEntriesBounded(bytes);
  } catch (error) {
    return err(`package: not a readable zip — ${error instanceof Error ? error.message : String(error)}`);
  }
  const paths = [...entries.keys()];
  // D-482: a Foundry distribution carries icons/fonts/LevelDB packs — skipped, not fatal.
  const lenient = !resolveManifestPath(paths).ok && resolveFoundryManifestPath(paths) !== null;
  const files: Record<string, string> = {};
  const binaries = new Map<string, Uint8Array>();
  for (const [path, data] of entries) {
    const text = decodeText(data);
    if (text.ok) files[path] = text.value;
    else if (lenient) binaries.set(path, data);
    else return err(`package: ${path} — ${text.error}`);
  }
  return okVal({ files, binaries });
}

// ── LevelDB → JSON pack importer (R-10) ──
// Minimal SSTable reader for Foundry v11 LevelDB packs: parses footer, index block, data blocks,
// Snappy-decompresses when needed, and extracts JSON document values.
// Falls back to text scanning when SSTable parsing fails.

function decodeVarint(buf: Uint8Array, offset: number): { value: number; next: number } | null {
  let result = 0;
  let shift = 0;
  let pos = offset;
  while (pos < buf.length) {
    const byte = buf[pos] ?? 0;
    result |= (byte & 0x7f) << shift;
    pos++;
    if ((byte & 0x80) === 0) return { value: result >>> 0, next: pos };
    shift += 7;
    if (shift > 35) return null;
  }
  return null;
}

function snappyDecompress(input: Uint8Array): Uint8Array | null {
  try {
    const lenRes = decodeVarint(input, 0);
    if (!lenRes) return null;
    const uncompressedLen = lenRes.value;
    if (uncompressedLen > 50_000_000) return null;
    const output = new Uint8Array(uncompressedLen);
    let ip = lenRes.next;
    let op = 0;
    while (ip < input.length && op < uncompressedLen) {
      const tag = input[ip++] ?? 0;
      const type = tag & 0x03;
      if (type === 0) {
        let len = tag >>> 2;
        if (len < 60) {
          len += 1;
        } else {
          const extra = len - 59;
          if (ip + extra > input.length) return null;
          if (extra === 1) len = input[ip++] ?? 0;
          else if (extra === 2) { len = (input[ip] ?? 0) | ((input[ip + 1] ?? 0) << 8); ip += 2; }
          else if (extra === 3) { len = (input[ip] ?? 0) | ((input[ip + 1] ?? 0) << 8) | ((input[ip + 2] ?? 0) << 16); ip += 3; }
          else { len = (input[ip] ?? 0) | ((input[ip + 1] ?? 0) << 8) | ((input[ip + 2] ?? 0) << 16) | ((input[ip + 3] ?? 0) << 24); ip += 4; }
          len += 1;
        }
        if (ip + len > input.length || op + len > uncompressedLen) return null;
        output.set(input.subarray(ip, ip + len), op);
        ip += len;
        op += len;
      } else {
        let len: number;
        let offset: number;
        if (type === 1) {
          len = ((tag >>> 2) & 0x7) + 4;
          if (ip >= input.length) return null;
          offset = ((tag >>> 5) << 8) | (input[ip++] ?? 0);
        } else if (type === 2) {
          len = (tag >>> 2) + 1;
          if (ip + 1 >= input.length) return null;
          offset = (input[ip] ?? 0) | ((input[ip + 1] ?? 0) << 8);
          ip += 2;
        } else {
          len = (tag >>> 2) + 1;
          if (ip + 3 >= input.length) return null;
          offset = (input[ip] ?? 0) | ((input[ip + 1] ?? 0) << 8) | ((input[ip + 2] ?? 0) << 16) | ((input[ip + 3] ?? 0) << 24);
          ip += 4;
        }
        if (offset === 0 || offset > op) return null;
        if (op + len > uncompressedLen) return null;
        // Copy with possible overlap
        for (let i = 0; i < len; i++) {
          output[op] = output[op - offset] ?? 0;
          op++;
        }
      }
    }
    if (op !== uncompressedLen) return null;
    return output;
  } catch { return null; }
}

function extractJsonObjectsFromBytes(data: Uint8Array): string[] {
  // Try UTF-8 decode then balanced-brace scan for objects containing _id
  try {
    const text = new TextDecoder("utf-8", { fatal: false }).decode(data);
    const out: string[] = [];
    let i = 0;
    while (i < text.length) {
      const start = text.indexOf("{", i);
      if (start === -1) break;
      let depth = 0;
      let inString = false;
      let escape = false;
      let end = -1;
      for (let j = start; j < text.length; j++) {
        const ch = text[j] ?? "";
        if (escape) { escape = false; continue; }
        if (ch === "\\" && inString) { escape = true; continue; }
        if (ch === "\"") { inString = !inString; continue; }
        if (inString) continue;
        if (ch === "{") depth++;
        else if (ch === "}") {
          depth--;
          if (depth === 0) { end = j; break; }
        }
        // Prevent runaway
        if (j - start > 200_000) break;
      }
      if (end !== -1) {
        const candidate = text.slice(start, end + 1);
        if (candidate.includes("\"_id\"")) {
          try { const parsed = JSON.parse(candidate); if (parsed && typeof parsed._id === "string") out.push(candidate); } catch {}
        }
        i = end + 1;
      } else {
        i = start + 1;
      }
      if (out.length > 5000) break;
    }
    return out;
  } catch { return []; }
}

function readSstFile(data: Uint8Array): string[] {
  // Try full SSTable parse, fallback to raw scan
  try {
    if (data.length < 48) return extractJsonObjectsFromBytes(data);
    const footerOffset = data.length - 48;
    const footer = data.subarray(footerOffset);
    // Decode metaindex handle (2 varints) and index handle (2 varints)
    let pos = 0;
    const metaOff = decodeVarint(footer, pos);
    if (!metaOff) return extractJsonObjectsFromBytes(data);
    pos = metaOff.next;
    const metaSize = decodeVarint(footer, pos);
    if (!metaSize) return extractJsonObjectsFromBytes(data);
    pos = metaSize.next;
    const indexOff = decodeVarint(footer, pos);
    if (!indexOff) return extractJsonObjectsFromBytes(data);
    pos = indexOff.next;
    const indexSize = decodeVarint(footer, pos);
    if (!indexSize) return extractJsonObjectsFromBytes(data);
    // Check magic (last 8 bytes) - optional
    // const magic = footer.subarray(40);
    // expected magic 0x57fb80e8524d4c9e -> bytes little-endian: 9e 4c 4d 52 e8 80 fb 57
    // const expected = new Uint8Array([0x57, 0xfb, 0x80, 0xe8, 0x52, 0x4d, 0x4c, 0x9e]); // big-endian version seen in some docs
    // We don't strictly validate magic; if handles look sane, proceed.

    const indexOffset = indexOff.value;
    const idxSize = indexSize.value;
    if (indexOffset + idxSize + 5 > data.length) return extractJsonObjectsFromBytes(data);
    let indexBlock = data.subarray(indexOffset, indexOffset + idxSize);
    const indexCompType = data[indexOffset + idxSize] ?? 0;
    if (indexCompType === 1) {
      const dec = snappyDecompress(indexBlock);
      if (dec) indexBlock = dec;
    }
    // Parse index block to get data block handles
    const dataHandles: Array<{ offset: number; size: number }> = [];
    let p = 0;
    let prevKey = new Uint8Array(0);
    while (p < indexBlock.length) {
      const shared = decodeVarint(indexBlock, p);
      if (!shared) break;
      p = shared.next;
      const nonShared = decodeVarint(indexBlock, p);
      if (!nonShared) break;
      p = nonShared.next;
      const valueLen = decodeVarint(indexBlock, p);
      if (!valueLen) break;
      p = valueLen.next;
      if (p + nonShared.value + valueLen.value > indexBlock.length) break;
      const keyDelta = indexBlock.subarray(p, p + nonShared.value);
      p += nonShared.value;
      // Reconstruct key
      const key = new Uint8Array(shared.value + nonShared.value);
      key.set(prevKey.subarray(0, shared.value), 0);
      key.set(keyDelta, shared.value);
      prevKey = key;
      const value = indexBlock.subarray(p, p + valueLen.value);
      p += valueLen.value;
      // Value is block handle: offset varint + size varint
      let vp = 0;
      const off = decodeVarint(value, vp);
      if (!off) continue;
      vp = off.next;
      const sz = decodeVarint(value, vp);
      if (!sz) continue;
      dataHandles.push({ offset: off.value, size: sz.value });
    }
    if (dataHandles.length === 0) return extractJsonObjectsFromBytes(data);

    const jsonValues: string[] = [];
    for (const handle of dataHandles) {
      if (handle.offset + handle.size + 5 > data.length) continue;
      let block = data.subarray(handle.offset, handle.offset + handle.size);
      const compType = data[handle.offset + handle.size] ?? 0;
      if (compType === 1) {
        const dec = snappyDecompress(block);
        if (dec) block = dec;
      }
      // Parse data block entries: values are JSON documents
      let bp = 0;
      let prev = new Uint8Array(0);
      while (bp < block.length) {
        const shared = decodeVarint(block, bp);
        if (!shared) break;
        bp = shared.next;
        const nonShared = decodeVarint(block, bp);
        if (!nonShared) break;
        bp = nonShared.next;
        const vlen = decodeVarint(block, bp);
        if (!vlen) break;
        bp = vlen.next;
        if (bp + nonShared.value + vlen.value > block.length) break;
        const kd = block.subarray(bp, bp + nonShared.value);
        bp += nonShared.value;
        const key = new Uint8Array(shared.value + nonShared.value);
        key.set(prev.subarray(0, shared.value), 0);
        key.set(kd, shared.value);
        prev = key;
        const val = block.subarray(bp, bp + vlen.value);
        bp += vlen.value;
        try {
          const txt = new TextDecoder("utf-8", { fatal: false }).decode(val);
          if (txt.includes("\"_id\"")) {
            try { const parsed = JSON.parse(txt); if (parsed && typeof parsed._id === "string") jsonValues.push(txt); } catch {
              // Value may be JSON string without outer braces? Try as is
              const trimmed = txt.trim();
              if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
                try { const parsed = JSON.parse(trimmed); if (parsed && typeof parsed._id === "string") jsonValues.push(trimmed); } catch {}
              }
            }
          }
        } catch {}
        if (jsonValues.length > 10000) break;
      }
      if (jsonValues.length > 10000) break;
    }
    if (jsonValues.length > 0) return jsonValues;
    // Fallback to raw scan of all data blocks concatenated
    return extractJsonObjectsFromBytes(data);
  } catch {
    return extractJsonObjectsFromBytes(data);
  }
}

function convertLevelDbPacks(
  files: Record<string, string>,
  binaries: Map<string, Uint8Array>,
): Record<string, string> {
  // Find module.json or system.json
  const moduleJsonPath = Object.keys(files).find((p) => p === "module.json" || p.endsWith("/module.json") || p === "system.json" || p.endsWith("/system.json"));
  if (!moduleJsonPath) return files;
  let manifest: { packs?: Array<{ name: string; path: string; type: string }> } | null = null;
  try { manifest = JSON.parse(files[moduleJsonPath] ?? ""); } catch { return files; }
  if (!manifest?.packs?.length) return files;
  const out = { ...files };
  for (const pack of manifest.packs) {
    const packPath = pack.path;
    if (!packPath) continue;
    // If pack path already has a text file, skip (NDJSON case)
    if (out[packPath] !== undefined) continue;
    // Collect binary files under packPath/
    const prefix = packPath.endsWith("/") ? packPath : `${packPath}/`;
    const matching: Array<[string, Uint8Array]> = [];
    for (const [bPath, bData] of binaries) {
      if (bPath.startsWith(prefix) || bPath === packPath) matching.push([bPath, bData]);
    }
    if (matching.length === 0) continue;
    // Only process if files look like LevelDB (.ldb, .log, MANIFEST, CURRENT)
    const isLevelDb = matching.some(([p]) => p.endsWith(".ldb") || p.endsWith(".log") || p.includes("MANIFEST") || p.endsWith("CURRENT"));
    if (!isLevelDb) continue;
    const allJson: string[] = [];
    for (const [, bData] of matching) {
      if (bData.length > 1024 * 1024 * 20) continue; // skip huge files
      const extracted = readSstFile(bData);
      allJson.push(...extracted);
      if (allJson.length > 10000) break;
    }
    if (allJson.length === 0) {
      // Fallback: try raw scan of all matching files concatenated
      for (const [, bData] of matching) {
        const scanned = extractJsonObjectsFromBytes(bData);
        allJson.push(...scanned);
        if (allJson.length > 10000) break;
      }
    }
    if (allJson.length > 0) {
      // Deduplicate by _id
      const seen = new Set<string>();
      const deduped: string[] = [];
      for (const jsonStr of allJson) {
        try {
          const obj = JSON.parse(jsonStr);
          const id = obj._id;
          if (typeof id === "string" && !seen.has(id)) { seen.add(id); deduped.push(jsonStr); }
        } catch {}
      }
      // Create synthetic NDJSON file at packPath (or packPath + ".db" if directory)
      const syntheticPath = packPath.endsWith("/") ? `${packPath}_converted.db` : packPath;
      // If packPath is directory, we need to create file inside it; use packPath + "/_leveldb_converted.db"
      const finalPath = matching.some(([p]) => p === packPath) ? `${packPath}.converted.db` : `${prefix}_leveldb_converted.db`;
      // Actually, adapter expects file at packMeta.path; if packMeta.path is directory, our improved hydratePacks will look for files under prefix.
      // So we can create file at prefix + "_converted.db"
      const targetPath = `${prefix}_converted.db`;
      out[targetPath] = deduped.join("\n");
      // Also create a JSON array file for validation (ArenaStar pack validation expects JSON, but Foundry packs are handled separately)
      // For Foundry module, the adapter will find files under prefix, so this synthetic file will be picked up.
    }
  }
  return out;
}

/** Read + validate a package zip (ArrayBuffer/Uint8Array). */
export async function readZipPackage(bytes: Uint8Array): Promise<Result<LoadedPackage>> {
  const unzipped = await unzipFiles(bytes);
  if (!unzipped.ok) return unzipped;
  const withConverted = convertLevelDbPacks(unzipped.value.files, unzipped.value.binaries);
  const binaryPaths = [...unzipped.value.binaries.keys()];
  return buildPackageFromFiles(withConverted, binaryPaths);
}
