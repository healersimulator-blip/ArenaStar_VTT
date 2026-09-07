/**
 * §12 package loader — turns a package zip (or folder file list) into a
 * validated record: manifest.json parsed + contract-checked, every referenced
 * file present, text-only contents. Pure fflate + TextDecoder; runs in Node
 * tests and in the browser host alike. Script entries are NOT executed here —
 * activation/import into the SimWorker goes through D-086's blob-URL loader.
 */
import { unzip } from "fflate";
import type { Json } from "../core/documents";
import type { PackageManifest } from "../core/packageManifest";
import { validatePackageManifest } from "../core/packageManifest";
import type { Result } from "../core/result";
import { err, okVal } from "../core/result";

/** Validated package contents (world-scoped fields added by the store). */
export interface LoadedPackage {
  manifest: PackageManifest;
  /** UTF-8 decoded file texts keyed by package-relative path. */
  files: Record<string, string>;
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

/** Shared validation over a path → text map (folder import path). */
export function buildPackageFromFiles(rawFiles: Record<string, string>): Result<LoadedPackage> {
  const paths = Object.keys(rawFiles);
  const manifestPath = resolveManifestPath(paths);
  if (!manifestPath.ok) return manifestPath;
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
  if (manifest.value.module) {
    const modEntry = files[manifest.value.module.entry];
    if (modEntry === undefined) {
      return err(
        `package ${manifest.value.id}: module entry ${manifest.value.module.entry} is missing`,
      );
    }
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

/** Promisified fflate unzip (same streaming API worldFile.ts uses). */
function unzipFiles(bytes: Uint8Array): Promise<Result<Record<string, string>>> {
  return new Promise((resolve) => {
    unzip(bytes, (error, unzipped) => {
      if (error) {
        resolve(err(`package: not a readable zip — ${error.message}`));
        return;
      }
      const rawFiles: Record<string, string> = {};
      for (const [path, data] of Object.entries(unzipped)) {
        // zip directory entries end with "/" and carry no bytes
        if (path.endsWith("/")) continue;
        const text = decodeText(data);
        if (!text.ok) {
          resolve(err(`package: ${path} — ${text.error}`));
          return;
        }
        rawFiles[path] = text.value;
      }
      resolve(okVal(rawFiles));
    });
  });
}

/** Read + validate a package zip (ArrayBuffer/Uint8Array). */
export async function readZipPackage(bytes: Uint8Array): Promise<Result<LoadedPackage>> {
  const rawFiles = await unzipFiles(bytes);
  if (!rawFiles.ok) return rawFiles;
  return buildPackageFromFiles(rawFiles.value);
}
