/** Deterministic package files/hashes shared by the PR51 world builders.
 * The length-prefixed SHA-256 format matches src/packages/packageHash.ts.
 */
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

export function packageFilesFromDir(dir) {
  const files = {};
  const visit = (current, prefix = "") => {
    for (const entry of readdirSync(current, { withFileTypes: true }).sort(
      (a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0),
    )) {
      const path = `${prefix}${entry.name}`;
      if (entry.isDirectory()) visit(join(current, entry.name), `${path}/`);
      else if (entry.isFile())
        files[path] = readFileSync(join(current, entry.name), "utf8");
    }
  };
  visit(dir);
  return files;
}

export function packageContentHashFromMap(files) {
  const entries = Object.entries(files).sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  );
  const hash = createHash("sha256");
  const uint32 = (value) => {
    const bytes = Buffer.alloc(4);
    bytes.writeUInt32BE(value);
    return bytes;
  };
  hash.update(uint32(entries.length));
  for (const [path, text] of entries) {
    const name = Buffer.from(path, "utf8"),
      body = Buffer.from(text, "utf8");
    hash
      .update(uint32(name.length))
      .update(uint32(body.length))
      .update(name)
      .update(body);
  }
  return hash.digest("hex");
}

export function packageDirectoryHash(dir) {
  return packageContentHashFromMap(packageFilesFromDir(dir));
}

/** Strip only common outer archive folders, never a system's public/ resource tree. */
export function archiveOuterRoot(paths, manifestPath) {
  let root = "";
  for (;;) {
    const segment = paths[0]?.slice(root.length).split("/")[0];
    if (!segment || segment === "public") return root;
    const next = `${root}${segment}/`;
    if (
      !manifestPath.startsWith(next) ||
      !paths.every((path) => path.startsWith(next))
    )
      return root;
    root = next;
  }
}

export function foundryManifestPath(paths) {
  const candidates = paths.filter((path) =>
    /^(?:.*\/)?(?:module|system)\.json$/.test(path),
  );
  return (
    candidates.sort((a, b) => {
      const rank = (path) =>
        path === "system.json" || path === "module.json"
          ? 0
          : path.endsWith("public/system.json")
            ? 1
            : path.endsWith("system.json")
              ? 2
              : 3;
      return rank(a) - rank(b) || a.length - b.length || a.localeCompare(b);
    })[0] ?? null
  );
}
