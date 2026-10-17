/** Foundry pack storage admission, before text-only package synthesis.
 * A directory of LevelDB files is not a JSON export. Reading arbitrary SST values
 * loses sequence/tombstone/WAL semantics; fail explicitly until a snapshot reader
 * is available. NDJSON files and split JSON exports remain supported.
 */
import { resolveFoundryManifestPath } from "../core/foundryModuleManifest";

export function foundryPackStorageError(
  files: Record<string, string>,
  binaryPaths: readonly string[],
): string | null {
  const paths = [...Object.keys(files), ...binaryPaths];
  const manifestPath = resolveFoundryManifestPath(paths);
  if (!manifestPath) return null;
  let raw: { packs?: unknown };
  try {
    raw = JSON.parse(files[manifestPath] ?? "");
  } catch {
    return null;
  }
  if (!Array.isArray(raw.packs)) return null; // Manifest validation reports malformed declarations.

  // Paths are still archive-relative here. public/system.json belongs to a source
  // distribution whose resource root is above public/, not inside it.
  let root = manifestPath.slice(0, manifestPath.lastIndexOf("/") + 1);
  if (manifestPath.endsWith("public/system.json"))
    root = root.slice(0, -"public/".length);
  for (const pack of raw.packs) {
    if (!pack || typeof pack.path !== "string") continue;
    const path = `${root}${pack.path.replace(/^\/+/, "").replace(/\/$/, "")}`;
    const prefix = `${path}/`;
    const storage = paths.find(
      (candidate) =>
        candidate.startsWith(prefix) &&
        /(?:^|\/)(?:CURRENT|MANIFEST-[^/]+|\d+\.(?:ldb|sst|log))$/.test(
          candidate,
        ),
    );
    if (storage)
      return (
        `Foundry pack ${String(pack.name ?? pack.path)} uses LevelDB storage (${storage}). ` +
        "Export a consistent JSON/NDJSON snapshot first; raw LevelDB archives are not supported safely."
      );
    if (binaryPaths.includes(path))
      return `Foundry pack ${String(pack.name ?? pack.path)} is binary; export it as JSON/NDJSON first.`;
  }
  return null;
}
