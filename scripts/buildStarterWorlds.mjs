#!/usr/bin/env node
/**
 * D-249 starter worlds: one importable world file per strategic ruleset package —
 * `dist/worlds/<id>-starter-<version>.zip`. A starter is a format-2 world archive
 * (`src/host/worldFile.ts`) with NO documents (seq 0 — the host seeds the default scene on first
 * boot, exactly like a brand-new world), the ruleset installed and active, and every content
 * pack it declares as a dependency installed beside it. `world.json.starter = true` makes the
 * start screen open it as a fresh copy every time, so a starter never asks "replace?".
 *
 * Why a world file and not a package: the tester's complaint was three zips to load in the
 * right order. A GM now downloads one file, opens it, and is in a PF1e strategic world — the
 * same file the New-world wizard would have produced from the two packages.
 *
 * Package folders are read from `systems/<id>/` and must already contain their built entries
 * (`pnpm build:systems` first — `rules.js` is a build product). The writer is deliberately a
 * few lines of plain JS rather than a bundle of the TS exporter; `tests/scripts/
 * buildStarterWorlds.test.ts` imports the result through the real `importWorldZip`, which is the
 * parity check that matters.
 *
 * Usage:  node scripts/buildStarterWorlds.mjs [--only <packageId>] [--systems-dir <dir>]
 *         [--out <dir>] [--dry-run]
 */
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { strToU8, zipSync } from "fflate";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Must match `WORLD_FILE_FORMAT` in src/host/worldFile.ts. */
export const STARTER_WORLD_FORMAT = 2;

/**
 * Starter recipes. Keyed by the strategic ruleset (`type: "system"`) package; `content` lists
 * the data packages installed with it — by default the ruleset's declared `dependencies` that
 * exist under systems/. A ruleset without an entry here still gets a starter from its manifest.
 */
const STARTERS = {
  "pf1e-mass-battles": { name: "Pathfinder 1e Mass Battles — starter" },
};

function listPackageDirs(systemsDir) {
  return readdirSync(systemsDir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
}

/** Every file in a package folder, package-relative and deterministically sorted. */
function listPackageFiles(dir) {
  const out = [];
  const walk = (current, prefix) => {
    for (const entry of readdirSync(current, { withFileTypes: true }).sort((a, b) =>
      a.name < b.name ? -1 : 1,
    )) {
      const rel = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory()) walk(join(current, entry.name), rel);
      else if (entry.isFile()) out.push(rel);
    }
  };
  walk(dir, "");
  return out;
}

function readManifest(systemsDir, id) {
  const path = join(systemsDir, id, "manifest.json");
  if (!statSync(path, { throwIfNoEntry: false })?.isFile()) return null;
  const manifest = JSON.parse(readFileSync(path, "utf8"));
  if (manifest.id !== id) {
    throw new Error(`${id}: manifest.id "${manifest.id}" must equal the folder name`);
  }
  return manifest;
}

/** A package folder as `packages/<id>/…` archive entries, verifying the manifest's declared files. */
function packageEntries(systemsDir, manifest) {
  const dir = join(systemsDir, manifest.id);
  const files = listPackageFiles(dir);
  for (const [label, path] of [
    ["rules.entry", manifest.rules?.entry],
    ["module.entry", manifest.module?.entry],
    ...[...(manifest.packs ?? [])].map((pack) => [`pack ${pack.name}`, pack.file]),
  ]) {
    if (path === undefined) continue;
    if (!files.includes(path)) {
      throw new Error(
        `${manifest.id}: manifest declares ${label} "${path}" — missing from ${dir}` +
          (label === "rules.entry" ? " (run `pnpm build:systems` first)" : ""),
      );
    }
  }
  const entries = {};
  for (const rel of files) {
    entries[`packages/${manifest.id}/${rel}`] = strToU8(readFileSync(join(dir, rel), "utf8"));
  }
  return { files, entries };
}

/**
 * Assemble the archive entries for one starter (pure; no I/O beyond reading package folders).
 * Returns { id, worldId, name, version, files: string[], zip: Uint8Array, packages: string[] }.
 */
export function buildStarterArchive(systemsDir, rulesetId, opts = {}) {
  const now = opts.now ?? 0; // deterministic bytes: a starter has no meaningful timestamps
  const ruleset = readManifest(systemsDir, rulesetId);
  if (!ruleset) throw new Error(`${rulesetId}: no manifest.json`);
  if (ruleset.type !== "system" || !ruleset.rules?.entry) {
    throw new Error(`${rulesetId}: a starter needs a strategic ruleset (type "system" with rules.entry)`);
  }
  const recipe = STARTERS[rulesetId] ?? {};
  const contentIds =
    recipe.content ??
    [...(ruleset.dependencies ?? [])].filter((dep) => readManifest(systemsDir, dep) !== null);
  const manifests = [ruleset];
  for (const dep of contentIds) {
    const m = readManifest(systemsDir, dep);
    if (!m) throw new Error(`${rulesetId}: starter content ${dep} has no manifest.json`);
    if (m.type !== "data") {
      throw new Error(`${rulesetId}: starter content ${dep} is a ${m.type} package, not a content pack`);
    }
    manifests.push(m);
  }

  const worldId = `starter-${rulesetId}`;
  const name = recipe.name ?? `${ruleset.name} — starter`;
  const entries = {};
  const json = (value) => strToU8(JSON.stringify(value, null, 2));
  entries["world.json"] = json({
    format: STARTER_WORLD_FORMAT,
    worldId,
    name,
    system: ruleset.id,
    version: ruleset.version,
    seq: 0,
    exportedAt: now,
    rules: { active: ruleset.id },
    starter: true,
  });
  entries["documents.json"] = json({ seq: 0, docs: [] });
  entries["assets.json"] = json([]);
  entries["packages.json"] = json(
    manifests.map((m) => ({
      id: m.id,
      name: m.name,
      version: m.version,
      type: m.type,
      importedAt: now,
      packCount: m.packs?.length ?? 0,
    })),
  );
  const files = [];
  for (const m of manifests) {
    const pkg = packageEntries(systemsDir, m);
    Object.assign(entries, pkg.entries);
    files.push(...pkg.files.map((f) => `packages/${m.id}/${f}`));
  }
  const zip = zipSync(entries, { level: 6, mtime: new Date("2020-01-01T00:00:00Z") });
  return {
    id: rulesetId,
    worldId,
    name,
    version: ruleset.version,
    files: ["world.json", "documents.json", "assets.json", "packages.json", ...files],
    packages: manifests.map((m) => m.id),
    zip,
  };
}

/**
 * Build every starter (one per strategic ruleset under systems/).
 * Returns one record per starter: { id, worldId, name, version, packages, files, zip: path|null }.
 */
export async function buildStarterWorlds(opts = {}) {
  const {
    dryRun = false,
    only = null,
    systemsDir = join(repoRoot, "systems"),
    outDir = join(repoRoot, "dist/worlds"),
  } = opts;
  const results = [];
  for (const id of listPackageDirs(systemsDir)) {
    if (only !== null && only !== id) continue;
    const manifest = readManifest(systemsDir, id);
    if (!manifest || manifest.type !== "system" || !manifest.rules?.entry) continue;
    const built = buildStarterArchive(systemsDir, id);
    let zipPath = null;
    if (!dryRun) {
      zipPath = join(outDir, `${id}-starter-${built.version}.zip`);
      mkdirSync(dirname(zipPath), { recursive: true });
      writeFileSync(zipPath, built.zip);
      console.log(
        `${id}: starter "${built.name}" (${built.packages.join(" + ")}) → ${relative(repoRoot, zipPath)} (${(built.zip.length / 1024).toFixed(1)} kB)`,
      );
    }
    results.push({ ...built, zip: zipPath });
  }
  return results;
}

const isCli = process.argv[1] !== undefined && resolve(process.argv[1]).endsWith("buildStarterWorlds.mjs");
if (isCli) {
  const argv = process.argv.slice(2);
  const argOf = (flag) => {
    const i = argv.indexOf(flag);
    return i === -1 ? null : (argv[i + 1] ?? null);
  };
  const only = argOf("--only");
  const out = argOf("--out");
  const systemsDir = argOf("--systems-dir");
  try {
    const built = await buildStarterWorlds({
      dryRun: argv.includes("--dry-run"),
      ...(only !== null ? { only } : {}),
      ...(out !== null ? { outDir: resolve(repoRoot, out) } : {}),
      ...(systemsDir !== null ? { systemsDir: resolve(repoRoot, systemsDir) } : {}),
    });
    if (built.length === 0) {
      console.error("no strategic ruleset packages found under systems/");
      process.exit(1);
    }
  } catch (e) {
    console.error(`buildStarterWorlds: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  }
}
