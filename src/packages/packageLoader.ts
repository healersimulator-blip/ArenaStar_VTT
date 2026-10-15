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
function rootedFiles(rawFiles: Record<string, string>, markerPath: string): Record<string, string> {
  const root = markerPath.includes("/") ? `${markerPath.split("/")[0] ?? ""}/` : "";
  const files: Record<string, string> = {};
  for (const [path, text] of Object.entries(rawFiles))
    if (root === "" || path.startsWith(root)) files[path.slice(root.length)] = text;
  return files;
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
    const root = foundryPath.includes("/") ? `${foundryPath.split("/")[0] ?? ""}/` : "";
    const binaries = binaryPaths.filter((path) => path.startsWith(root)).map((path) => path.slice(root.length));
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
async function unzipFiles(bytes: Uint8Array): Promise<Result<{ files: Record<string, string>; binaries: string[] }>> {
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
  const binaries: string[] = [];
  for (const [path, data] of entries) {
    const text = decodeText(data);
    if (text.ok) files[path] = text.value;
    else if (lenient) binaries.push(path);
    else return err(`package: ${path} — ${text.error}`);
  }
  return okVal({ files, binaries });
}

/** Read + validate a package zip (ArrayBuffer/Uint8Array). */
export async function readZipPackage(bytes: Uint8Array): Promise<Result<LoadedPackage>> {
  const unzipped = await unzipFiles(bytes);
  if (!unzipped.ok) return unzipped;
  return buildPackageFromFiles(unzipped.value.files, unzipped.value.binaries);
}
