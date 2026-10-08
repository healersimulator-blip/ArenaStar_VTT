/**
 * Zip sniffing for the archives a GM handles. A world file (§8) and a rules/content package
 * (§12) share the `.zip` extension, and until now the *button* decided what a file was: a
 * package dropped on the world importer failed with "missing world.json", a world dropped on
 * the package input with "manifest.json not found". The kind is a property of the FILE —
 * `world.json` at the archive root marks a world, `manifest.json` at the root (or inside one
 * top-level folder, the shape `packageLoader` accepts) marks a package — so every importer
 * asks here first and either routes the file or names the right place for it.
 *
 * Only the marker entries are inflated (fflate's `filter`); the payload stays compressed.
 */
import { strFromU8, Unzip, UnzipInflate, UnzipPassThrough } from "fflate";
import { extractZipEntriesBounded, WORLD_ZIP_LIMITS } from "./worldZip";
import {
  auditCodexArchiveDependencies,
  codexArchiveAuditUnavailable,
  type CodexArchiveDependencyAudit,
} from "../core/campaignCodexArchiveAudit";
import type { PackageManifest } from "../core/packageManifest";
import { validatePackageManifest } from "../core/packageManifest";

/** One embedded package as the world header advertises it (format 2 `packages.json`). */
export interface WorldZipPackage {
  id: string;
  name: string;
  version: string;
  type: PackageManifest["type"];
  packCount: number;
}

export interface WorldZipInfo {
  kind: "world";
  format: number;
  worldId: string;
  name: string;
  /** `world.json.system` — the strategic ruleset id the world was exported under. */
  system: string | null;
  /** Active strategic ruleset package id (format 2), null for built-in / format 1. */
  activeRules: string | null;
  /** Embedded packages (format 2 index; empty for format 1). */
  packages: WorldZipPackage[];
  /** A template archive: always opened as a fresh copy (D-249). */
  starter: boolean;
  /** Read-only full-world Codex dependency diagnostics for the Open-file preview. */
  codexAudit?: CodexArchiveDependencyAudit;
}

export type ZipKind =
  | WorldZipInfo
  | { kind: "package"; manifest: PackageManifest }
  | { kind: "unknown"; reason: string };

const WORLD_MARKER = "world.json";
const WORLD_PACKAGES_INDEX = "packages.json";
const PACKAGE_MARKER = "manifest.json";

/** `manifest.json` at the root or exactly one directory deep (packageLoader's nested root). */
function isPackageMarker(path: string): boolean {
  if (path === PACKAGE_MARKER) return true;
  const parts = path.split("/");
  return parts.length === 2 && parts[0] !== "" && parts[1] === PACKAGE_MARKER;
}

function inflateMarkers(bytes: Uint8Array): Promise<Map<string, Uint8Array>> {
  return extractZipEntriesBounded(bytes, {
    limits: {
      ...WORLD_ZIP_LIMITS,
      maxUncompressedBytes: 16 * 1024 * 1024,
      maxEntryBytes: 8 * 1024 * 1024,
    },
    filter: (file) =>
      file.name === WORLD_MARKER ||
      file.name === WORLD_PACKAGES_INDEX ||
      isPackageMarker(file.name),
  });
}

const MAX_AUDIT_DOCUMENTS_BYTES = 32 * 1024 * 1024;
const MAX_AUDIT_ASSETS_INDEX_BYTES = 8 * 1024 * 1024;
const MAX_AUDIT_ASSET_BLOBS = 100_000;

interface CodexAuditZipEntries {
  entries: Map<string, Uint8Array>;
  assetBlobIds: Set<string>;
  assetBlobIdsTruncated: boolean;
  oversized: Set<string>;
  duplicates: Set<string>;
  error: string | null;
}

/** Bounded streaming extraction of the two JSON indexes; asset blobs stay compressed. */
function inflateCodexAuditEntries(bytes: Uint8Array): CodexAuditZipEntries {
  const entries = new Map<string, Uint8Array>();
  const assetBlobIds = new Set<string>();
  let assetBlobIdsTruncated = false;
  const oversized = new Set<string>();
  const duplicates = new Set<string>();
  let error: string | null = null;
  const limits = new Map([
    ["documents.json", MAX_AUDIT_DOCUMENTS_BYTES],
    ["assets.json", MAX_AUDIT_ASSETS_INDEX_BYTES],
  ]);
  const decoder = new Unzip((file) => {
    const assetPrefix = "assets/";
    if (file.name.startsWith(assetPrefix)) {
      const hash = file.name.slice(assetPrefix.length);
      if (/^[a-f0-9]{64}$/i.test(hash)) {
        if (assetBlobIds.has(hash)) duplicates.add(file.name);
        else if (assetBlobIds.size >= MAX_AUDIT_ASSET_BLOBS)
          assetBlobIdsTruncated = true;
        else assetBlobIds.add(hash);
      }
    }
    const limit = limits.get(file.name);
    if (limit === undefined) return;
    if (entries.has(file.name) || oversized.has(file.name)) {
      duplicates.add(file.name);
      return;
    }
    if (typeof file.originalSize === "number" && file.originalSize > limit) {
      oversized.add(file.name);
      return;
    }
    const chunks: Uint8Array[] = [];
    let total = 0;
    file.ondata = (cause, chunk, final) => {
      if (cause) {
        error = `could not read ${file.name}`;
        return;
      }
      total += chunk.length;
      if (total > limit) {
        oversized.add(file.name);
        chunks.length = 0;
        void file.terminate();
        return;
      }
      chunks.push(chunk.slice());
      if (final) {
        if (entries.has(file.name)) duplicates.add(file.name);
        else {
          const output = new Uint8Array(total);
          let offset = 0;
          for (const part of chunks) {
            output.set(part, offset);
            offset += part.length;
          }
          entries.set(file.name, output);
        }
      }
    };
    try {
      file.start();
    } catch {
      error = `could not read ${file.name}`;
    }
  });
  decoder.register(UnzipInflate);
  decoder.register(UnzipPassThrough);
  try {
    decoder.push(bytes, true);
  } catch {
    error = "could not scan World ZIP dependencies";
  }
  return {
    entries,
    assetBlobIds,
    assetBlobIdsTruncated,
    oversized,
    duplicates,
    error,
  };
}

function auditWorldZipCodex(bytes: Uint8Array): CodexArchiveDependencyAudit {
  const extracted = inflateCodexAuditEntries(bytes);
  if (extracted.error) return codexArchiveAuditUnavailable(extracted.error);
  if (extracted.duplicates.size > 0)
    return codexArchiveAuditUnavailable(
      "The archive contains duplicate Codex indexes or asset blobs.",
    );
  if (extracted.assetBlobIdsTruncated)
    return codexArchiveAuditUnavailable(
      "The archive contains too many asset blobs for the bounded Codex audit.",
    );
  if (extracted.oversized.has("documents.json"))
    return codexArchiveAuditUnavailable(
      "The document index is too large for the bounded Codex audit.",
    );
  if (extracted.oversized.has("assets.json"))
    return codexArchiveAuditUnavailable(
      "The asset index is too large for the bounded Codex audit.",
    );
  const documentsBytes = extracted.entries.get("documents.json");
  const assetsBytes = extracted.entries.get("assets.json");
  if (!documentsBytes || !assetsBytes)
    return codexArchiveAuditUnavailable(
      "The archive is missing a dependency index.",
    );
  const documents = parseJson(documentsBytes);
  const assets = parseJson(assetsBytes);
  return auditCodexArchiveDependencies(
    documents,
    assets,
    extracted.assetBlobIds,
  );
}

function safeAuditWorldZipCodex(
  bytes: Uint8Array,
): CodexArchiveDependencyAudit {
  try {
    return auditWorldZipCodex(bytes);
  } catch {
    return codexArchiveAuditUnavailable(
      "The Codex dependency audit could not be completed.",
    );
  }
}

const asRecord = (v: unknown): Record<string, unknown> | null =>
  typeof v === "object" && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;

function parseJson(bytes: Uint8Array): unknown {
  try {
    return JSON.parse(strFromU8(bytes));
  } catch {
    return undefined;
  }
}

/** The format-2 package index, tolerantly: a malformed index is the importer's error to raise. */
function readPackagesIndex(bytes: Uint8Array | undefined): WorldZipPackage[] {
  if (!bytes) return [];
  const parsed = parseJson(bytes);
  if (!Array.isArray(parsed)) return [];
  const out: WorldZipPackage[] = [];
  for (const raw of parsed) {
    const entry = asRecord(raw);
    if (!entry || typeof entry.id !== "string") continue;
    out.push({
      id: entry.id,
      name: typeof entry.name === "string" ? entry.name : entry.id,
      version: typeof entry.version === "string" ? entry.version : "",
      type: entry.type === "system" ? "system" : "data",
      packCount: typeof entry.packCount === "number" ? entry.packCount : 0,
    });
  }
  return out;
}

/** Decide what a zip is by its marker files (never by its name or by which input it hit). */
export async function classifyZip(bytes: Uint8Array): Promise<ZipKind> {
  let markers: Map<string, Uint8Array>;
  try {
    markers = await inflateMarkers(bytes);
  } catch (error) {
    return {
      kind: "unknown",
      reason: error instanceof Error ? error.message : String(error),
    };
  }

  const worldBytes = markers.get(WORLD_MARKER);
  if (worldBytes) {
    const meta = asRecord(parseJson(worldBytes));
    if (
      meta &&
      typeof meta.worldId === "string" &&
      typeof meta.format === "number"
    ) {
      const rules = asRecord(meta.rules);
      return {
        kind: "world",
        format: meta.format,
        worldId: meta.worldId,
        name: typeof meta.name === "string" ? meta.name : meta.worldId,
        system: typeof meta.system === "string" ? meta.system : null,
        activeRules: typeof rules?.active === "string" ? rules.active : null,
        packages: readPackagesIndex(markers.get(WORLD_PACKAGES_INDEX)),
        starter: meta.starter === true,
        codexAudit: safeAuditWorldZipCodex(bytes),
      };
    }
    return {
      kind: "unknown",
      reason: "world.json is present but not a valid world header",
    };
  }

  const manifestPaths = [...markers.keys()].filter(isPackageMarker);
  // Root wins; otherwise exactly one nested root is acceptable (two folders = not a package).
  const manifestPath = manifestPaths.includes(PACKAGE_MARKER)
    ? PACKAGE_MARKER
    : manifestPaths.length === 1
      ? manifestPaths[0]
      : undefined;
  if (manifestPath !== undefined) {
    const parsed = parseJson(markers.get(manifestPath) as Uint8Array);
    if (parsed === undefined) {
      return {
        kind: "unknown",
        reason: "manifest.json is present but is not valid JSON",
      };
    }
    const manifest = validatePackageManifest(parsed);
    if (!manifest.ok) return { kind: "unknown", reason: manifest.error };
    return { kind: "package", manifest: manifest.value };
  }

  return {
    kind: "unknown",
    reason:
      "neither a world file (no world.json) nor a package (no manifest.json)",
  };
}

/** Human label for a package kind — the words the UI uses everywhere (never `system`/`data`). */
export function packageKindLabel(type: PackageManifest["type"]): string {
  return type === "system" ? "strategic ruleset" : "content pack";
}

/** One line naming a sniffed package, for import messages. */
export function describePackage(manifest: PackageManifest): string {
  return `${manifest.name} v${manifest.version} (${packageKindLabel(manifest.type)})`;
}

/**
 * One line saying what a world archive brings along, for the Open-file dialog:
 * "strategic ruleset PF1e Mass Battles v1.0.0 · 1 content pack" / "built-in strategic rules".
 */
export function describeWorldContents(info: WorldZipInfo): string {
  const ruleset = info.packages.find(
    (p) => p.id === info.activeRules && p.type === "system",
  );
  const content = info.packages.filter((p) => p.type === "data");
  const parts: string[] = [];
  parts.push(
    ruleset
      ? `strategic ruleset ${ruleset.name} v${ruleset.version}`
      : "built-in strategic rules",
  );
  if (content.length > 0) {
    parts.push(
      content.length === 1
        ? `content pack ${content[0]?.name ?? ""}`.trim()
        : `${content.length} content packs`,
    );
  }
  return parts.join(" · ");
}
