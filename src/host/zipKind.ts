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
import { strFromU8, unzip } from "fflate";
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
  return new Promise((resolve, reject) => {
    unzip(
      bytes,
      {
        filter: (file) =>
          file.name === WORLD_MARKER ||
          file.name === WORLD_PACKAGES_INDEX ||
          isPackageMarker(file.name),
      },
      (error, files) => {
        if (error) reject(new Error(`not a readable zip — ${error.message}`));
        else resolve(new Map(Object.entries(files)));
      },
    );
  });
}

const asRecord = (v: unknown): Record<string, unknown> | null =>
  typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;

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
    return { kind: "unknown", reason: error instanceof Error ? error.message : String(error) };
  }

  const worldBytes = markers.get(WORLD_MARKER);
  if (worldBytes) {
    const meta = asRecord(parseJson(worldBytes));
    if (meta && typeof meta.worldId === "string" && typeof meta.format === "number") {
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
      };
    }
    return { kind: "unknown", reason: "world.json is present but not a valid world header" };
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
      return { kind: "unknown", reason: "manifest.json is present but is not valid JSON" };
    }
    const manifest = validatePackageManifest(parsed);
    if (!manifest.ok) return { kind: "unknown", reason: manifest.error };
    return { kind: "package", manifest: manifest.value };
  }

  return {
    kind: "unknown",
    reason: "neither a world file (no world.json) nor a package (no manifest.json)",
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
  const ruleset = info.packages.find((p) => p.id === info.activeRules && p.type === "system");
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
