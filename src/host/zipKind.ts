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

export type ZipKind =
  | { kind: "world"; format: number; worldId: string; name: string }
  | { kind: "package"; manifest: PackageManifest }
  | { kind: "unknown"; reason: string };

const WORLD_MARKER = "world.json";
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
      { filter: (file) => file.name === WORLD_MARKER || isPackageMarker(file.name) },
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
      return {
        kind: "world",
        format: meta.format,
        worldId: meta.worldId,
        name: typeof meta.name === "string" ? meta.name : meta.worldId,
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
